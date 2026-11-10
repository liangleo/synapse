// 编排服务：把 MCP 工具调用接到作业状态机 + 适配器。
// 关键语义：fromJobs 自动把上游作业产出注入 instruction；clientRequestId 去重防 LLM 重试重复派发；
// 每角色默认并发 1，多余作业排队、前序结束自动启动；L1 角色 steer 返回 UNSUPPORTED 而非静默失败。
import { createJob, getJob, listJobs, findByClientRequestId, setJobState, addJobLog, onJobStateChange } from './jobs.js'
import { createMockAdapter, type Adapter } from './adapters/mock.js'
import { createDshAdapter, startDshEvents } from './adapters/dsh.js'
import { createDshHeadlessAdapter, parseHeadlessRoles } from './adapters/dsh-headless.js'
import { defaultRoleOf } from './registry.js'
import { saveMode, type ModeName } from './mode.js'
import { activePresetRoles } from './presets.js'
import { DEFAULT_ROLES as roles } from './registry.js'
import { hubLog } from './bus.js'
import type { Job, RoleDef } from './types.js'

const adapters = new Map<string, Adapter>()
const maxConcurrentPerRole = 1

export function registerAdapters(roleList: RoleDef[]): void {
  for (const role of roleList) adapters.set(role.name, createMockAdapter(role))
}

// 真实角色注册：同名默认 mock 角色就地升级为真实 harness（mcp/server 持有同一数组引用），适配器覆盖
function upsertRole(role: RoleDef, adapter: Adapter): void {
  const i = roles.findIndex((r) => r.name === role.name)
  if (i >= 0) roles[i] = role
  else roles.push(role)
  adapters.set(role.name, adapter)
  hubLog('INFO', `注册 ${role.harness} 角色：${role.name}（${role.label}，${role.level}）`)
}

// dsh 真实角色：来自插件 /meta 的角色列表
export function registerDshRoles(list: { name: string; label?: string }[]): void {
  for (const r of list) upsertRole({ name: r.name, harness: 'dsh', level: 'L2', label: r.label ?? r.name }, createDshAdapter())
  if (list.length) mode = 'plugin'
}

// dsh-headless 角色：无 desktop，spawn `dsh --profile headless --json` 跑一次性任务（L1，无运行中 steer）
export function registerHeadlessRoles(list: { name: string; label?: string }[]): void {
  for (const r of list) upsertRole({ name: r.name, harness: 'dsh', level: 'L1', label: r.label ?? r.name }, createDshHeadlessAdapter())
  if (list.length) mode = 'headless'
}

// ---------- dsh 接入模式（运行中可切换，面板 POST /mode 驱动） ----------
// mock=纯模拟；headless=spawn dsh CLI；plugin=desktop 插件。选择持久化到 mode.ts 的配置文件。
let mode: ModeName = 'mock'
export function currentMode(): ModeName {
  return mode
}

// 切换模式：重建 harness=dsh 的真实角色（不在新清单的回退默认 mock 定义，无默认则移除）。
// 有 running/queued 作业时拒绝——切换会换掉适配器，在途作业没人收尾。
export async function applyMode(opts: { mode: ModeName; roles?: string[] }): Promise<{ mode: ModeName; roles: { name: string; label: string }[] }> {
  if (listJobs().some((j) => j.state === 'running' || j.state === 'queued'))
    throw new Error('存在 running/queued 作业，请等作业收尾后再切换模式')
  let targets: { name: string; label: string }[] = []
  if (opts.mode === 'headless') {
    // 角色维护口径统一在预设：优先激活预设的 roles，无预设文件时回退 DSH_HEADLESS_ROLES
    targets = activePresetRoles()
    if (!targets.length) targets = parseHeadlessRoles(process.env.DSH_HEADLESS_ROLES ?? '')
    if (!targets.length) throw new Error('headless 模式需要角色：在预设编辑里维护角色并激活预设（或设 DSH_HEADLESS_ROLES）')
  } else if (opts.mode === 'plugin') {
    const base = process.env.DSH_PANEL_URL
    if (!base) throw new Error('未配置 DSH_PANEL_URL，无法接入 desktop 插件')
    const res = await fetch(`${base}/meta`)
    if (!res.ok) throw new Error(`dsh 插件不可达（HTTP ${res.status}）：desktop 开着吗？`)
    const meta = (await res.json()) as { roles?: { name: string; label?: string }[] }
    targets = (meta.roles ?? [])
      .filter((r) => r.name && r.name !== 'master')
      .map((r) => ({ name: r.name, label: r.label ?? r.name }))
  }
  const names = new Set(targets.map((t) => t.name))
  for (let i = roles.length - 1; i >= 0; i--) {
    const r = roles[i]
    if (r.harness !== 'dsh' || names.has(r.name)) continue
    const def = defaultRoleOf(r.name)
    if (def) {
      roles[i] = { ...def }
      adapters.set(def.name, createMockAdapter(def))
    } else {
      roles.splice(i, 1)
      adapters.delete(r.name)
    }
  }
  mode = opts.mode
  if (opts.mode === 'headless') registerHeadlessRoles(targets)
  else if (opts.mode === 'plugin') {
    registerDshRoles(targets)
    startDshEvents()
  }
  saveMode(opts.mode)
  hubLog('INFO', `dsh 接入模式 → ${opts.mode}（角色 ${targets.map((t) => t.name).join(' / ') || '无'}）`)
  return { mode: opts.mode, roles: targets }
}

// 作业结束（终态）后启动该角色队列中的下一个排队作业
onJobStateChange((job) => {
  if (job.state !== 'completed' && job.state !== 'failed' && job.state !== 'cancelled') return
  const queued = listJobs(job.role).filter((j) => j.state === 'queued')
  if (!queued.length) return
  const adapter = adapters.get(job.role)
  const running = listJobs(job.role).filter((j) => j.state === 'running').length
  if (adapter && running < maxConcurrentPerRole) {
    hubLog('INFO', `调度：${job.role} 队列启动 ${queued[0].id}`)
    startJob(queued[0], adapter)
  }
})

function startJob(job: Job, adapter: Adapter): void {
  const role = roles.find((r) => r.name === job.role) as RoleDef
  setJobState(job.id, 'running')
  adapter.start(job, role)
}

function buildInstruction(instruction: string, fromJobs?: string[]): string {
  let text = instruction
  for (const jid of fromJobs ?? []) {
    const job = getJob(jid)
    if (!job) throw new Error(`fromJobs 引用了不存在的作业：${jid}`)
    const out = job.result ?? job.error ?? `（该作业状态 ${job.state}，暂无产出）`
    text += `\n\n【上游产出 · ${jid}（${job.role}）】\n${out.slice(0, 2000)}`
  }
  return text
}

export function dispatch(opts: {
  role: string
  instruction: string
  taskId?: string
  fromJobs?: string[]
  clientRequestId?: string
}): { jobId: string; state: string } {
  // 面板 /command 允许空文本进来，空任务对所有 harness 都是必败作业，入口直接拒绝
  if (!opts.instruction.trim()) throw new Error('任务内容为空：派发需要 instruction（面板“任务内容”输入框）')
  const adapter = adapters.get(opts.role)
  if (!adapter) throw new Error(`未注册的角色：${opts.role}`)

  if (opts.clientRequestId) {
    const dup = findByClientRequestId(opts.clientRequestId)
    if (dup) {
      hubLog('INFO', `clientRequestId ${opts.clientRequestId} 重复，返回已有作业 ${dup.id}`)
      return { jobId: dup.id, state: dup.state }
    }
  }

  const instruction = buildInstruction(opts.instruction, opts.fromJobs)
  const job = createJob(opts.role, instruction, opts.clientRequestId)
  if (opts.taskId) addJobLog(job.id, `关联任务 ${opts.taskId}`)

  const running = listJobs(opts.role).filter((j) => j.state === 'running').length
  if (running >= maxConcurrentPerRole) {
    setJobState(job.id, 'queued')
    addJobLog(job.id, '排队中：该角色已有作业在跑（maxConcurrent=1）')
  } else {
    startJob(job, adapter)
  }
  return { jobId: job.id, state: job.state }
}

export async function steer(jobId: string, message: string, role: string): Promise<boolean> {
  const adapter = adapters.get(role)
  const job = getJob(jobId)
  if (!adapter || !job) throw new Error(`未找到作业：${jobId}`)
  if (job.state !== 'running') return false
  return adapter.steer(job, message)
}

export function cancel(jobId: string, role: string): boolean {
  const adapter = adapters.get(role)
  const job = getJob(jobId)
  if (!adapter || !job) throw new Error(`未找到作业：${jobId}`)
  adapter.cancel(job)
  return true
}

export function summaryOf(job: Job): Record<string, unknown> {
  return {
    jobId: job.id,
    role: job.role,
    state: job.state,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    recentActions: job.actions.slice(-5),
  }
}
