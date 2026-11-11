// Codex 适配器（M3）：spawn `codex exec --json` 跑非交互任务。
// 事件流为 JSONL（thread.started / turn.started / item.completed / turn.completed|turn.failed），
// item.type: agent_message / reasoning / command_execution / error 等，形状按 codex CLI 实测。
// 接入配置（环境变量）：
//   CODEX_CMD  新会话启动命令（默认 `codex exec --json --skip-git-repo-check --sandbox workspace-write`）；
//              续会话固定走 `codex exec resume <thread_id> --json --skip-git-repo-check`（resume 子命令不接受 --sandbox）
//   CODEX_HEADLESS_ROLES  无预设文件时的角色兜底清单（"name:中文名,…"），同 DSH_HEADLESS_ROLES
// 会话连续：role → thread id 映射（role-sessions.ts，按 harness 'codex' 分域），续跑走 `exec resume`。
// L1 语义：无运行中 steer；cancel = 杀进程；支持 worktree（子进程 cwd）。
import { spawn, type ChildProcess } from 'node:child_process'
import type { Job, PanelEvent } from '../types.js'
import { emitEvent } from '../bus.js'
import { addJobAction, addJobLog, setJobState } from '../jobs.js'
import { roleSession, setRoleSession } from '../role-sessions.js'
import type { Adapter } from './mock.js'

export const CODEX_CMD =
  process.env.CODEX_CMD ?? 'codex exec --json --skip-git-repo-check --sandbox workspace-write'
// 续会话命令（二进制可与 CODEX_CMD 不同源，如测试 stub）；默认同为 codex CLI
export const CODEX_RESUME_CMD = process.env.CODEX_RESUME_CMD ?? 'codex exec resume'

// 运行中作业（每角色并发 1 由调度器保证）→ 子进程
const childByJob = new Map<string, ChildProcess>()

function emit(job: Job, type: PanelEvent['type'], pl: Record<string, unknown>): void {
  emitEvent({ type, t: Date.now(), agent: { id: job.id, role: job.role, parent: 'master', harness: 'codex' }, pl })
}

function startJob(job: Job): void {
  const threadId = roleSession('codex', job.role)
  // 续会话走 exec resume 子命令（不接受 --sandbox，沙箱沿用会话既有配置）
  const cmdline = threadId
    ? `${CODEX_RESUME_CMD} ${threadId} --json --skip-git-repo-check -`
    : `${CODEX_CMD} -`
  addJobLog(job.id, `派发 → codex exec（${threadId ? `续会话 ${threadId.slice(0, 12)}…` : '新建会话'}）`)
  emit(job, 'turn.started', { turn: 1 })

  let child: ChildProcess
  try {
    // worktree 隔离时 job.cwd 指向 hub 建好的 worktree；未隔离则继承 hub 进程 cwd
    child = spawn(cmdline, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: job.cwd })
  } catch (err) {
    failJob(job, `spawn 失败：${String(err)}`)
    return
  }
  childByJob.set(job.id, child)
  child.stdin?.end(job.instruction)

  let buf = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      if (!line.trim()) continue
      try {
        handleNdjson(job, JSON.parse(line) as Record<string, unknown>)
      } catch {
        /* 非 JSON 行跳过 */
      }
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8').trim()
    if (s) addJobLog(job.id, `codex: ${s.slice(0, 200)}`)
  })
  child.on('error', (err) => failJob(job, `codex 进程错误：${String(err)}`))
  child.on('exit', (code) => {
    if (!childByJob.delete(job.id)) return // 已被 turn.completed/failed/cancel 收尾
    failJob(job, `codex 进程退出（code=${code ?? 'signal'}），未收到终态事件`)
  })
}

// 已终态的作业（exit 与终态事件可能连续触发，落状态要幂等）
const finished = new Set<string>()

function failJob(job: Job, msg: string): void {
  if (!finished.add(job.id)) return
  emit(job, 'turn.ended', { turn: 1, status: 'failed', reasonKind: 'error' })
  addJobAction(job.id, msg)
  setJobState(job.id, 'failed', { error: msg })
}

// 最后一次 agent_message 文本（作业产出），turn.completed 时取走
const lastMessageByJob = new Map<string, string>()

// JSONL 事件 → PanelEvent + 作业状态迁移
function handleNdjson(job: Job, ev: Record<string, unknown>): void {
  const type = String(ev.type ?? '')
  switch (type) {
    case 'thread.started': {
      const tid = String(ev.thread_id ?? '')
      if (tid) setRoleSession('codex', job.role, tid)
      break
    }
    case 'turn.started':
      emit(job, 'step.started', { turn: 1 })
      break
    case 'item.completed': {
      const item = (ev.item ?? {}) as Record<string, unknown>
      const itemType = String(item.type ?? '')
      if (itemType === 'agent_message') {
        const t = String(item.text ?? '')
        if (t.trim()) {
          lastMessageByJob.set(job.id, t)
          emit(job, 'output', { text: t })
        }
      } else if (itemType === 'reasoning') {
        const t = String(item.text ?? '').trim()
        if (t) addJobLog(job.id, `思考：${t.slice(0, 200)}`)
      } else if (itemType === 'error') {
        // item error 多为配置告警（如未知 config 键），不据此判作业失败
        addJobLog(job.id, `codex 提示：${String(item.message ?? '').slice(0, 200)}`)
      } else if (itemType) {
        // command_execution / mcp_tool_call / file_change 等：有可读摘要就记动作
        const detail = String(item.command ?? item.tool ?? item.path ?? '')
        const action = detail ? `${itemType} ${detail.slice(0, 140)}` : itemType
        addJobAction(job.id, action)
        emit(job, 'tool.started', { action, name: itemType })
        const out = typeof item.output === 'string' ? item.output : typeof item.aggregated_output === 'string' ? item.aggregated_output : ''
        if (out.trim()) addJobLog(job.id, `↳ ${out.slice(0, 200)}`)
        emit(job, 'tool.finished', { ok: !item.exit_code, name: itemType })
      }
      break
    }
    case 'turn.completed': {
      childByJob.delete(job.id)
      if (!finished.add(job.id)) break
      const usage = ev.usage as Record<string, unknown> | undefined
      if (usage) addJobLog(job.id, `tokens=${(usage as { output_tokens?: number }).output_tokens ?? '?'}（输入 ${(usage as { input_tokens?: number }).input_tokens ?? '?'}）`)
      const text = lastMessageByJob.get(job.id) ?? ''
      lastMessageByJob.delete(job.id)
      emit(job, 'turn.ended', { turn: 1, status: 'ok', taskId: job.id })
      addJobLog(job.id, text.slice(0, 400) || '（无文本产出）')
      setJobState(job.id, 'completed', { result: text || '（无文本产出）' })
      break
    }
    case 'turn.failed': {
      childByJob.delete(job.id)
      if (!finished.add(job.id)) break
      const err = (ev.error ?? {}) as { message?: string }
      emit(job, 'turn.ended', { turn: 1, status: 'failed', reasonKind: 'error', taskId: job.id })
      setJobState(job.id, 'failed', { error: `codex turn 失败：${String(err.message ?? 'unknown')}`.slice(0, 300) })
      break
    }
  }
}

export function createCodexAdapter(): Adapter {
  return {
    harness: 'codex',
    level: 'L1',
    honorsCwd: true, // 子进程可指定工作目录 → 支持 worktree 隔离
    start(job) {
      startJob(job)
    },
    // 无头模式不支持运行中追加（L1）：MCP task_steer 会以 UNSUPPORTED 提示重新派发
    async steer() {
      return false
    },
    cancel(job) {
      const child = childByJob.get(job.id)
      if (!child) return
      childByJob.delete(job.id)
      child.kill()
      emit(job, 'turn.ended', { turn: 1, status: 'cancelled', taskId: job.id })
      addJobAction(job.id, '已中断（终止进程）')
      setJobState(job.id, 'cancelled')
    },
  }
}
