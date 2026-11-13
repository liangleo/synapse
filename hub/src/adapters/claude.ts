// Claude Code 适配器（M4）：spawn `claude -p --output-format stream-json` 跑无头会话。
// 事件流为 NDJSON（system init / assistant / user(tool_result) / result），
// 文档见 claude CLI --help（headless/print 模式）。
// 接入配置（环境变量）：
//   CLAUDE_CMD  启动命令（默认 `claude -p --output-format stream-json --verbose`）；hub 由 MCP 拉起时
//               PATH 可能缺 claude（如 nvm 路径），写成绝对路径即可
//   CLAUDE_HEADLESS_ROLES  无预设文件时的角色兜底清单（"name:中文名,…"），同 DSH_HEADLESS_ROLES
// 会话连续：role → session UUID 映射（role-sessions.ts，与 dsh-headless 共用）；
// 首跑生成 UUID 以 --session-id 固定，续跑用 --resume <uuid> 继承同一会话上下文。
// L1 语义：无头模式不支持运行中 steer（重新 dispatch）；cancel = 杀进程；
// 审批通道（默认开启，CLAUDE_APPROVAL=0 关闭）：需要审批的工具调用经 --permission-prompt-tool
// 转给伴生 MCP 服务（approval-mcp.ts）→ hub /approval/* → 面板或 master 裁决；超时自动拒绝。
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Job, PanelEvent } from '../types.js'
import { emitEvent } from '../bus.js'
import { addJobAction, addJobLog, setJobState } from '../jobs.js'
import { roleSession, setRoleSession } from '../role-sessions.js'
import type { Adapter } from './mock.js'

export const CLAUDE_CMD = process.env.CLAUDE_CMD ?? 'claude -p --output-format stream-json --verbose'

// 嵌套会话变量净化：hub 常被 Claude Code 经 MCP 拉起，CLAUDECODE/CLAUDE_CODE_* 是父会话专有的，
// 原样传给子 claude 会报 Not logged in / 行为异常；凭据走 ~/.claude，不受影响。
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^CLAUDE(CODE|_CODE_)/.test(k)) env[k] = v
  }
  return env
}

// 运行中作业（每角色并发 1 由调度器保证）→ 子进程
const childByJob = new Map<string, ChildProcess>()

// 审批通道：伴生 MCP 服务（编译产物与适配器同目录）+ 每作业临时 --mcp-config（退出时清理）
const APPROVAL_ON = process.env.CLAUDE_APPROVAL !== '0'
const APPROVAL_MCP_JS = fileURLToPath(new URL('approval-mcp.js', import.meta.url))

function emit(job: Job, type: PanelEvent['type'], pl: Record<string, unknown>): void {
  emitEvent({ type, t: Date.now(), agent: { id: job.id, role: job.role, parent: 'master', harness: 'claude' }, pl })
}

function startJob(job: Job): void {
  const sid = roleSession('claude', job.role)
  // 首跑用 --session-id 固定身份（claude 要求 UUID），续跑用 --resume 继承会话上下文
  const sessionFlag = sid ? `--resume ${sid}` : `--session-id ${sid || randomUUID()}`
  let cmdline = `${CLAUDE_CMD} ${sessionFlag}`
  const env = cleanEnv()
  let approvalCfg: string | undefined
  if (APPROVAL_ON) {
    approvalCfg = join(tmpdir(), `synapse-approval-${job.id}.json`)
    writeFileSync(
      approvalCfg,
      JSON.stringify({
        mcpServers: {
          synapse_approval: {
            command: 'node',
            args: [APPROVAL_MCP_JS],
            env: {
              HUB_APPROVAL_URL: `http://127.0.0.1:${process.env.HUB_PORT || 3182}`,
              HUB_APPROVAL_TOKEN: process.env.HUB_TOKEN ?? '',
              HUB_APPROVAL_TIMEOUT_SEC: process.env.HUB_APPROVAL_TIMEOUT_SEC ?? '',
              JOB_ID: job.id,
              JOB_ROLE: job.role,
            },
          },
        },
      }),
    )
    cmdline += ` --mcp-config ${approvalCfg} --permission-prompt-tool mcp__synapse_approval__request_permission`
    addJobLog(job.id, '审批通道已开启（面板/MCP approval_respond 裁决，超时自动拒绝）')
  }
  addJobLog(job.id, `派发 → claude headless（${sid ? `续会话 ${sid.slice(0, 12)}…` : '新建会话'}）`)
  emit(job, 'turn.started', { turn: 1 })

  let child: ChildProcess
  try {
    // worktree 隔离时 job.cwd 指向 hub 建好的 worktree；未隔离则继承 hub 进程 cwd
    child = spawn(cmdline, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: job.cwd, env })
  } catch (err) {
    if (approvalCfg) rmSync(approvalCfg, { force: true })
    failJob(job, `spawn 失败：${String(err)}`)
    return
  }
  childByJob.set(job.id, child)
  child.stdin?.end(job.instruction)
  child.on('exit', () => rmSync(approvalCfg ?? '', { force: true }))

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
    if (s) addJobLog(job.id, `claude: ${s.slice(0, 200)}`)
  })
  child.on('error', (err) => failJob(job, `claude 进程错误：${String(err)}`))
  child.on('exit', (code) => {
    if (!childByJob.delete(job.id)) return // 已被 result/cancel 收尾
    failJob(job, `claude 进程退出（code=${code ?? 'signal'}），未收到 result 事件`)
  })
}

// 已终态的作业（exit 与 result 可能连续触发，落状态要幂等）
const finished = new Set<string>()

function failJob(job: Job, msg: string): void {
  if (!finished.add(job.id)) return
  emit(job, 'turn.ended', { turn: 1, status: 'failed', reasonKind: 'error' })
  addJobAction(job.id, msg)
  setJobState(job.id, 'failed', { error: msg })
}

// stream-json 事件 → PanelEvent + 作业状态迁移
function handleNdjson(job: Job, ev: Record<string, unknown>): void {
  const type = String(ev.type ?? '')
  switch (type) {
    case 'system': {
      if (String(ev.subtype ?? '') === 'init') {
        const sid = String(ev.session_id ?? '')
        if (sid) setRoleSession('claude', job.role, sid)
        addJobLog(job.id, `会话 ${sid.slice(0, 12)}…（model=${String(ev.model ?? '?')}）`)
      }
      break
    }
    case 'assistant': {
      // message.content 是块数组：text → 输出流；tool_use → 工具动作
      const blocks = ((ev.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[]
      for (const b of blocks) {
        if (b.type === 'text') {
          const t = String(b.text ?? '')
          if (t.trim()) emit(job, 'output', { text: t })
        } else if (b.type === 'tool_use') {
          const name = String(b.name ?? '工具调用')
          const args = JSON.stringify(b.input ?? {})
          const action = args !== '{}' ? `${name} ${args.slice(0, 160)}` : name
          addJobAction(job.id, action)
          emit(job, 'tool.started', { action, name })
        }
      }
      break
    }
    case 'user': {
      // tool_result 回传
      const blocks = ((ev.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[]
      for (const b of blocks) {
        if (b.type !== 'tool_result') continue
        const err = Boolean(b.is_error)
        const out = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
        if (err) addJobLog(job.id, `↳ 工具失败：${out.slice(0, 200)}`)
        else if (out.trim()) addJobLog(job.id, `↳ 结果：${out.slice(0, 200)}`)
        emit(job, 'tool.finished', { ok: !err })
      }
      break
    }
    case 'result': {
      childByJob.delete(job.id)
      if (!finished.add(job.id)) break // cancel/exit 已收尾
      const subtype = String(ev.subtype ?? '')
      const usage = ev.usage as Record<string, unknown> | undefined
      if (usage) addJobLog(job.id, `tokens=${(usage as { total_tokens?: number }).total_tokens ?? '?'} 轮次=${String(ev.num_turns ?? '?')}`)
      if (subtype === 'success' && !ev.is_error) {
        const text = String(ev.result ?? '')
        emit(job, 'turn.ended', { turn: 1, status: 'ok', taskId: job.id })
        addJobLog(job.id, text.slice(0, 400) || '（无文本产出）')
        setJobState(job.id, 'completed', { result: text || '（无文本产出）' })
      } else {
        emit(job, 'turn.ended', { turn: 1, status: 'failed', reasonKind: subtype, taskId: job.id })
        setJobState(job.id, 'failed', { error: `claude 结果异常（${subtype}）：${String(ev.result ?? '')}`.slice(0, 300) })
      }
      break
    }
  }
}

export function createClaudeAdapter(): Adapter {
  return {
    harness: 'claude',
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
