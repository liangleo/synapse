// 共享类型来自 node 侧的 src/panel-event.ts（适配器与前端共用同一套事件/指令定义）。
import { reactive } from 'vue'
import type { PanelAgent, PanelEvent } from '../../src/panel-event'
import { col, nm } from './util'

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'done' | 'failed'

export interface AgentView {
  id: string
  role?: string
  parent?: string
  h?: string
  s: AgentStatus
  job: string
  task?: string
  log: string[]
  steps: number
  out: string
  ended?: boolean
  t: number // 最近一次事件时间（卡片排序用）
}

export interface EvRow {
  key: number
  t: number
  type: string
  agentId: string
  agentName: string
  sum: string
  outputOnly?: boolean
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '待机',
  thinking: '思考',
  working: '执行',
  done: '完成',
  failed: '失败',
}

// ---------- 全局响应式状态 ----------
export const store = reactive({
  agents: new Map<string, AgentView>(),
  events: [] as EvRow[],
  sel: null as string | null,
  status: '连接中…',
  statusOk: false,
  // 指令栏草稿（点卡片时回填角色名）
  cmd: { to: '', taskId: '', text: '' },
  // 已知 session 清单：taskId → 最后活动时间（来自 task.claimed/turn.ended/workflow.done）
  sessions: {} as Record<string, number>,
  // 服务端元信息（GET /meta）：当前预设、流水线、预置角色（含中文名）
  meta: {
    preset: '',
    master: '', // 由 /meta 下发；hub 模式不下发（master 是编排者，不可派发）
    pipeline: [] as string[],
    roles: [] as { name: string; label: string }[],
    // 角色 → 会话绑定（id + harness 标识，由 /meta 下发；hub 自管模式下值来自 role-sessions）
    roleSessions: {} as Record<string, { id: string; harness: string }>,
  },
})

// 角色的界面显示名：预设中文名优先，未配置则回退英文角色名
export function displayName(role: string | undefined): string {
  if (!role) return ''
  return store.meta.roles.find((r) => r.name === role)?.label ?? role
}

let evKey = 0
const MAX_EVENTS = 800 // 事件流上限，避免面板长跑内存无限增长

function pushEvent(row: EvRow): void {
  store.events.push(row)
  if (store.events.length > MAX_EVENTS) store.events.splice(0, store.events.length - MAX_EVENTS)
}

// 事件摘要里可能是对象（如 TurnEndReason）：转成可读短字符串
function fmt(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined || v === null) return ''
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v).slice(0, 80)
    } catch {
      return '[object]'
    }
  }
  return String(v)
}

export function ensureAgent(a: PanelAgent): AgentView {
  let x = store.agents.get(a.id)
  if (!x) {
    x = { id: a.id, s: 'idle', job: '—', log: [], steps: 0, out: '', t: 0 }
    store.agents.set(a.id, x)
  }
  if (a.role && a.role !== x.role) x.role = a.role
  x.parent = a.parentId || x.parent
  x.h = a.harness
  return x
}

const pushLog = (x: AgentView, t: string, at?: number): void => {
  x.log.push(`${new Date(at ?? Date.now()).toTimeString().slice(0, 8)} ${t}`)
  if (x.log.length > 30) x.log.shift()
}

// 事件 → agent 状态变更
function applyEvent(e: PanelEvent, x: AgentView): void {
  const p = e.pl ?? {}
  switch (e.type) {
    case 'turn.started':
      x.s = 'thinking'
      x.steps = 0
      x.out = ''
      x.job = (x.task ? `任务 ${x.task} · ` : '') + `第 ${p.turn} 轮`
      pushLog(x, '开始新一轮', e.t)
      break
    case 'step.started':
      x.steps++
      break
    case 'tool.started':
      x.s = 'working'
      pushLog(x, String(p.action ?? p.name ?? '调用工具'), e.t)
      break
    case 'tool.finished':
      if (p.ok === false) pushLog(x, '工具调用失败', e.t)
      break
    case 'output':
      x.s = 'working'
      x.out = (x.out + p.text).slice(-160)
      break
    case 'task.claimed':
      x.task = String(p.taskId)
      x.job = `任务 ${p.taskId}`
      break
    case 'turn.ended':
      x.s = p.status === 'failed' ? 'failed' : p.status === 'cancelled' ? 'idle' : 'done'
      x.steps = -1
      if (p.taskId) x.task = String(p.taskId)
      pushLog(x, `本轮结束${p.reasonKind ? `：${fmt(p.reasonKind)}` : ''}`, e.t)
      break
    case 'agent.ended':
      x.s = 'idle'
      x.ended = true
      break
    case 'command.unsupported':
      pushLog(x, `该 harness 不支持：${String(p.cmd)}`, e.t)
      break
  }
}

// 事件 → 事件流行；连续 output 合并为一条
function addRow(e: PanelEvent, x: AgentView): void {
  if (e.type === 'output') {
    const last = store.events[store.events.length - 1]
    if (last?.outputOnly && last.agentId === x.id) return
    pushEvent({
      key: evKey++,
      t: e.t,
      type: e.type,
      agentId: x.id,
      agentName: displayName(x.role) || nm(x),
      sum: '',
      outputOnly: true,
    })
    return
  }
  const sum = Object.entries(e.pl ?? {})
    .filter(([k, v]) => k !== 'text' && v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join('  ')
  pushEvent({
    key: evKey++,
    t: e.t,
    type: e.type,
    agentId: x.id,
    agentName: displayName(x.role) || nm(x),
    sum: sum.slice(0, 120),
  })
}

// 登记出现的 session；新 session 自动成为指令栏的默认目标（最后一次）
function touchSession(taskId: unknown, t: number): void {
  const id = String(taskId ?? '')
  if (!id) return
  const isNew = !(id in store.sessions)
  store.sessions[id] = Math.max(store.sessions[id] ?? 0, t)
  if (isNew) store.cmd.taskId = id // 默认选中最后一次出现的 session
}

// 统一事件入口：SSE onmessage → 这里
export function handleEvent(e: PanelEvent): void {
  const x = ensureAgent(e.agent)
  x.t = e.t
  applyEvent(e, x)
  addRow(e, x)
  if (e.pl?.taskId) touchSession(e.pl.taskId, e.t)
}

// SSE 重连时清空（服务端会回放最近事件，避免重复）
export function resetStore(): void {
  store.agents.clear()
  store.events = []
  store.sel = null
  store.cmd.taskId = ''
}

export { col }
