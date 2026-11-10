// 编排服务：把 MCP 工具调用接到作业状态机 + 适配器。
// 关键语义：fromJobs 自动把上游作业产出注入 instruction；clientRequestId 去重防 LLM 重试重复派发；
// 每角色默认并发 1，多余作业排队、前序结束自动启动；L1 角色 steer 返回 UNSUPPORTED 而非静默失败。
import { createJob, getJob, listJobs, findByClientRequestId, setJobState, addJobLog, onJobStateChange } from './jobs.js'
import { createMockAdapter, type Adapter } from './adapters/mock.js'
import { DEFAULT_ROLES as roles } from './registry.js'
import { hubLog } from './bus.js'
import type { Job, RoleDef } from './types.js'

const adapters = new Map<string, Adapter>()
const maxConcurrentPerRole = 1

export function registerAdapters(roleList: RoleDef[]): void {
  for (const role of roleList) adapters.set(role.name, createMockAdapter(role))
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

export function steer(jobId: string, message: string, role: string): boolean {
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
