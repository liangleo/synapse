// M1 模拟适配器：不接任何真实 agent，把派发 → 执行 → 产出的完整事件流跑通。
// 真实 dsh / Codex / Claude Code 适配器按同一 Adapter 接口在 M2-M4 落地。
import type { Job, RoleDef } from '../types.js'
import { emitEvent } from '../bus.js'
import { addJobAction, addJobLog, setJobState } from '../jobs.js'

export interface Adapter {
  harness: string
  level: 'L1' | 'L2'
  honorsCwd?: boolean // true=子进程以 job.cwd 为工作目录（worktree 隔离依赖此能力）
  start(job: Job, role: RoleDef): void
  steer(job: Job, message: string): boolean | Promise<boolean> // L1 返回 false（不支持）；dsh 适配器经 HTTP 异步确认
  cancel(job: Job): void
}

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const STEPS = ['阅读任务与相关上下文', '规划改动范围', '执行修改', '自检并整理输出']

function agentOf(job: Job) {
  return { id: job.id, role: job.role, parent: 'master', harness: '' }
}

function emit(job: Job, type: Parameters<typeof emitEvent>[0]['type'], pl: Record<string, unknown> = {}): void {
  emitEvent({ type, t: Date.now(), agent: { ...agentOf(job), harness: `mock-${job.role}` }, pl })
}

function startRun(job: Job, role: RoleDef, instruction: string): void {
  const agent = agentOf(job)
  agent.harness = role.harness
  const steps = STEPS.map((s, i) => `${i + 1}. ${s}`)
  let i = 0

  emit(job, 'agent.registered')
  emit(job, 'agent.status', { status: 'running' })
  emit(job, 'turn.started', { turn: 1 })
  emit(job, 'task.claimed', { taskId: job.id })
  addJobAction(job.id, `开始执行（${role.harness} ${role.level}）`)

  const tick = (): void => {
    if (job.state !== 'running') return // 已被取消
    if (i < steps.length) {
      emit(job, 'step.started', { turn: 1, step: i + 1 })
      emit(job, 'tool.started', { name: 'mock', action: steps[i], turn: 1 })
      addJobAction(job.id, steps[i])
      // L1（Claude Code 形态）：中途不产生流式输出，只在结束时返回完整结果
      if (role.level === 'L2') emit(job, 'output', { text: `${steps[i]}\n` })
      i++
      timers.set(job.id, setTimeout(tick, 350))
    } else {
      const result = `【${role.label} · ${role.harness}】任务完成。\n提示词：${role.prompt || '（未配置）'}\n需求：${instruction}\n步骤：\n- ${steps.join('\n- ')}`
      clearInterval(timers.get(job.id))
      timers.delete(job.id)
      emit(job, 'output', { text: result })
      emit(job, 'turn.ended', { turn: 1, reason: { kind: 'completed' }, reasonKind: 'completed', status: 'ok' })
      emit(job, 'agent.status', { status: 'idle' })
      addJobLog(job.id, result)
      setJobState(job.id, 'completed', { result })
    }
  }
  timers.set(job.id, setTimeout(tick, 200))
}

export function createMockAdapter(role: RoleDef): Adapter {
  return {
    harness: role.harness,
    level: role.level,
    start(job, roleDef) {
      startRun(job, roleDef, job.instruction)
    },
    steer(job, message) {
      if (role.level === 'L1') return false // Claude Code 形态：不支持中途追加
      addJobLog(job.id, `steer ← ${message}`)
      return true
    },
    cancel(job) {
      const t = timers.get(job.id)
      if (t) clearInterval(t)
      timers.delete(job.id)
      if (job.state === 'running' || job.state === 'queued') {
        emit(job, 'turn.ended', { turn: 1, reason: { kind: 'aborted' }, reasonKind: 'aborted', status: 'cancelled' })
        emit(job, 'agent.status', { status: 'idle' })
        setJobState(job.id, 'cancelled')
        addJobAction(job.id, '已中断')
      }
    },
  }
}
