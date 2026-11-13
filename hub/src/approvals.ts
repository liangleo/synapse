// 审批通道：headless harness 的实时权限审批。当前 claude 经 --permission-prompt-tool 接入
// （伴生 MCP 服务见 adapters/approval-mcp.ts）；codex exec 与 dsh headless 无审批回调，不产生审批。
// 生命周期：伴生服务 POST /approval/request → 面板 POST /approval 或 master MCP approval_respond 裁决 →
// 长轮询 /approval/wait 取回决定；超时 / 作业终态自动 deny（安全默认）。
import { randomBytes } from 'node:crypto'
import { emitEvent, hubLog } from './bus.js'
import { getJob, onJobStateChange, addJobAction } from './jobs.js'
import { DEFAULT_ROLES as roles } from './registry.js'

export interface PendingApproval {
  id: string
  jobId: string
  role: string
  tool: string
  input: unknown
  t: number
}

type Decision = 'allow' | 'deny'

const pending = new Map<string, PendingApproval>()
const waiters = new Map<string, ((d: Decision) => void)[]>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

// 审批超时：默认 120 秒自动拒绝（防无人值守时作业卡死在权限门）
function timeoutMs(): number {
  return Number(process.env.HUB_APPROVAL_TIMEOUT_SEC ?? 120) * 1000
}

function agentOf(a: PendingApproval) {
  const harness = roles.find((r) => r.name === a.role)?.harness ?? ''
  return { id: a.jobId, role: a.role, parent: 'master', harness }
}

function finish(a: PendingApproval, decision: Decision, via: string): void {
  pending.delete(a.id)
  clearTimeout(timers.get(a.id))
  timers.delete(a.id)
  for (const w of waiters.get(a.id) ?? []) w(decision)
  waiters.delete(a.id)
  emitEvent({ type: 'approval.resolved', t: Date.now(), agent: agentOf(a), pl: { approvalId: a.id, decision, via } })
  addJobAction(a.jobId, `审批 ${a.tool}：${decision === 'allow' ? '允许' : '拒绝'}（${via}）`)
}

// 登记审批请求；作业不在运行/排队（或已终态）时直接拒绝，不产生事件
export function requestApproval(req: { jobId: string; role: string; tool: string; input: unknown }): { id: string; decision?: Decision } {
  const job = getJob(req.jobId)
  if (!job || (job.state !== 'running' && job.state !== 'queued')) return { id: '', decision: 'deny' }
  const rec: PendingApproval = { ...req, id: `ap-${randomBytes(6).toString('hex')}`, t: Date.now() }
  pending.set(rec.id, rec)
  emitEvent({ type: 'approval.requested', t: rec.t, agent: agentOf(rec), pl: { approvalId: rec.id, tool: req.tool, input: req.input } })
  addJobAction(req.jobId, `等待审批：${req.tool}`)
  timers.set(
    rec.id,
    setTimeout(() => {
      if (pending.has(rec.id)) resolveApproval(rec.id, 'deny', `超时（${timeoutMs() / 1000}s）自动拒绝`)
    }, timeoutMs()),
  )
  hubLog('INFO', `审批请求：${req.role} → ${req.tool}（${rec.id}）`)
  return { id: rec.id }
}

// 裁决：面板 / master / 超时 / 作业终态共用入口；幂等（已裁决返回 false）
export function resolveApproval(id: string, decision: Decision, via: string): boolean {
  const a = pending.get(id)
  if (!a) return false
  finish(a, decision, via)
  return true
}

// 长轮询：等 ms 内的裁决；返回 'timeout' 表示仍在待审批（调用方可继续轮询）
export function waitApproval(id: string, ms: number): Promise<Decision | 'timeout'> {
  const a = pending.get(id)
  if (!a) return Promise.resolve('deny') // 已裁决（waiters 已清空）或不存在
  return new Promise((ok) => {
    let done = false
    const settle = (d: Decision | 'timeout'): void => {
      if (!done) {
        done = true
        clearTimeout(timer)
        ok(d)
      }
    }
    const list = waiters.get(id) ?? []
    list.push(settle as (d: Decision) => void)
    waiters.set(id, list)
    const timer = setTimeout(() => settle('timeout'), ms)
  })
}

export function pendingApprovals(): PendingApproval[] {
  return [...pending.values()]
}

// 作业终态：该作业的所有待审批自动拒绝（cancel/超时/完成都不该留悬挂审批）
onJobStateChange((job) => {
  if (!['completed', 'failed', 'cancelled', 'blocked'].includes(job.state)) return
  for (const a of pending.values()) {
    if (a.jobId === job.id) resolveApproval(a.id, 'deny', '作业结束自动拒绝')
  }
})
