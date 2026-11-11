// dsh-headless 适配器：不经 dsh desktop，直接 spawn `dsh --profile headless --json` 跑一次性任务。
// 事件流为 NDJSON（session / status / text / thinking / tool_call / tool_result / final），
// 真实形状见 @deepseek-ai/dsh-headless（final.reason.kind: completed/aborted/error）。
// 接入配置（环境变量）：
//   DSH_HEADLESS_ROLES  角色清单，"name:中文名,name2:中文名2"，缺中文名用原名；设置即启用本适配器
//   DSH_HEADLESS_CMD    启动命令（默认 `dsh --profile headless --json`）；远程机器写
//                       `ssh <host> dsh --profile headless --json`，事件流走 ssh stdout
//   DSH_SESSIONS_DIR    dsh 会话目录（默认 ~/.dsh/sessions，历史会话 API 用，测试可覆盖）
// 会话连续：role → sessionId 映射由 hub 自管（role-sessions.ts，与 Claude Code 适配器共用），
// 派发时若有映射则追加 --session-id 续话（headless 校验 cwd 一致，远程模式会话不落本机则首跑即建）。
// L1 语义：one-shot 无运行中 steer；cancel = 杀进程。
import { spawn, type ChildProcess } from 'node:child_process'
import type { Job, PanelEvent } from '../types.js'
import { emitEvent } from '../bus.js'
import { addJobAction, addJobLog, setJobState } from '../jobs.js'
import { roleSession, setRoleSession } from '../role-sessions.js'
import type { Adapter } from './mock.js'

export const CMD = process.env.DSH_HEADLESS_CMD ?? 'dsh --profile headless --json'

// "a:甲,b:乙,b2" → [{name,label}]，缺中文名用原名
export function parseHeadlessRoles(raw: string): { name: string; label: string }[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':')
      return i > 0 ? { name: s.slice(0, i), label: s.slice(i + 1) } : { name: s, label: s }
    })
}

// 运行中作业（每角色并发 1 由调度器保证）→ 子进程；cancel 时杀
const childByJob = new Map<string, ChildProcess>()

function emit(job: Job, type: PanelEvent['type'], pl: Record<string, unknown>): void {
  emitEvent({ type, t: Date.now(), agent: { id: job.id, role: job.role, parent: 'master', harness: 'dsh' }, pl })
}

function startJob(job: Job): void {
  const sid = roleSession(job.role)
  // 指令走 stdin（headless 的 `-` 标记），--session-id 续历史会话；命令串由运营者配置，属可信输入
  const cmdline = `${CMD}${sid ? ` --session-id ${sid}` : ''} --approval-policy never -`
  addJobLog(job.id, `派发 → dsh headless（${sid ? `续会话 ${sid.slice(0, 22)}…` : '新建会话'}）`)
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
        /* 非 JSON 行（如 ssh 前缀噪音）跳过 */
      }
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8').trim()
    if (s) addJobLog(job.id, `dsh: ${s.slice(0, 200)}`)
  })
  child.on('error', (err) => failJob(job, `dsh 进程错误：${String(err)}`))
  child.on('exit', (code) => {
    if (!childByJob.delete(job.id)) return // 已被 final/cancel 收尾
    // 走到这里说明没收到 final（无论 exit code 是什么）：落 failed，避免作业永远 running
    failJob(job, `dsh 进程退出（code=${code ?? 'signal'}），未收到 final 事件`)
  })
}

// 已终态的作业（error+exit 可能连续触发，落状态要幂等）
const finished = new Set<string>()

function failJob(job: Job, msg: string): void {
  if (!finished.add(job.id)) return
  emit(job, 'turn.ended', { turn: 1, status: 'failed', reasonKind: 'error' })
  addJobAction(job.id, msg)
  setJobState(job.id, 'failed', { error: msg })
}

// headless --json 事件 → PanelEvent + 作业状态迁移
function handleNdjson(job: Job, ev: Record<string, unknown>): void {
  const type = String(ev.type ?? '')
  const reason = ev.reason as { kind?: string; error?: { message?: string } } | undefined
  switch (type) {
    case 'session': {
      const sid = String(ev.sessionId ?? '')
      if (sid) setRoleSession(job.role, sid)
      break
    }
    case 'status': {
      const phase = String(ev.phase ?? '')
      if (phase === 'step_start') emit(job, 'step.started', { turn: ev.turn, step: ev.step })
      else if (phase === 'step_end' && ev.usage) addJobLog(job.id, `step ${ev.step} 完成（tokens=${(ev.usage as { totalTokens?: number }).totalTokens ?? '?'}）`)
      // turn_start/turn_end 不单独转发：turn.started 在派发时发，终态由 final 统一落
      break
    }
    case 'thinking': {
      // CLI 的思考内容：进作业日志（截断），卡片日志不混入（output 只留给正式回答文本）
      const t = String(ev.text ?? '').trim()
      if (t) addJobLog(job.id, `思考：${t.slice(0, 200)}`)
      break
    }
    case 'text':
      emit(job, 'output', { text: String(ev.text ?? '') })
      break
    case 'tool_call': {
      // 工具调用带参数预览，卡片与作业日志都能看到 CLI 在做什么
      const name = String(ev.name ?? '工具调用')
      const raw = ev.arguments ?? ev.args ?? ev.input ?? ''
      const args = typeof raw === 'string' ? raw : JSON.stringify(raw)
      const action = args.trim() && args !== '{}' ? `${name} ${args.slice(0, 160)}` : name
      addJobAction(job.id, action)
      emit(job, 'tool.started', { action, name })
      break
    }
    case 'tool_result': {
      const name = String(ev.name ?? '')
      const err = ev.error as { message?: string } | undefined
      const out = typeof ev.output === 'string' ? ev.output : typeof ev.result === 'string' ? ev.result : ''
      if (err) addJobLog(job.id, `↳ ${name} 失败：${String(err.message ?? '').slice(0, 200)}`)
      else if (out.trim()) addJobLog(job.id, `↳ ${name} 结果：${out.slice(0, 200)}`)
      emit(job, 'tool.finished', { ok: !ev.error, name: ev.name })
      break
    }
    case 'error':
      failJob(job, `dsh runner 错误：${String((ev as { message?: string }).message ?? 'unknown')}`)
      break
    case 'final': {
      childByJob.delete(job.id)
      if (!finished.add(job.id)) break // error/cancel 已收尾，迟到的 final 不覆盖
      const kind = String(reason?.kind ?? '')
      const text = String(ev.text ?? '')
      addJobLog(job.id, `final ${kind}`)
      if (kind === 'completed') {
        emit(job, 'turn.ended', { turn: 1, status: 'ok', taskId: job.id })
        addJobLog(job.id, text.slice(0, 400) || '（无文本产出）')
        setJobState(job.id, 'completed', { result: text || '（无文本产出）' })
      } else if (kind === 'aborted') {
        emit(job, 'turn.ended', { turn: 1, status: 'cancelled', taskId: job.id })
        addJobAction(job.id, '已中断')
        setJobState(job.id, 'cancelled')
      } else {
        emit(job, 'turn.ended', { turn: 1, status: 'failed', reasonKind: kind, reason: ev.reason, taskId: job.id })
        setJobState(job.id, 'failed', { error: `turn 失败（${kind}）：${reason?.error?.message ?? kind}` })
      }
      break
    }
  }
}

export function createDshHeadlessAdapter(): Adapter {
  return {
    harness: 'dsh',
    level: 'L1',
    honorsCwd: true, // 子进程可指定工作目录 → 支持 worktree 隔离
    start(job) {
      startJob(job)
    },
    // one-shot 模式不支持运行中追加（L1）：MCP task_steer 会以 UNSUPPORTED 提示重新派发
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
