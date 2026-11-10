// dsh 真实适配器：转发现有插件（src/dsh-panel-bridge.ts）的 HTTP ——
// POST /command 派发指令，SSE /events 订阅事件。角色会话 resume 由插件的
// panel-state.json 透传（hub 不经手，插件按 role 自动恢复/新建）。
// 插件侧需配置固定 token（config.token），hub 侧用环境变量接入：
//   DSH_PANEL_URL（默认 http://127.0.0.1:3180）、DSH_PANEL_TOKEN
// 事件映射（语义对齐，设计文档 §5/§6）：
//   task.claimed / tool.started → 作业动作日志
//   output                      → 累积为本作业产出，turn.ended ok 时写入 job.result
//   turn.ended status=ok        → completed；cancelled → cancelled；failed → failed
//   turn.ended reasonKind=blocked/max-tokens → blocked
//   其余事件原样转发到 hub 事件总线（agent 身份重写为 hub 作业视角）
// 状态迁移只信任 pl.taskId === job.id 的事件，防止同角色手工对话干扰作业状态。
import type { Job, PanelEvent } from '../types.js'
import { emitEvent, hubLog } from '../bus.js'
import { addJobAction, addJobLog, getJob, setJobState } from '../jobs.js'
import type { Adapter } from './mock.js'

const BASE = process.env.DSH_PANEL_URL ?? 'http://127.0.0.1:3180'
const TOKEN = process.env.DSH_PANEL_TOKEN ?? ''

// 每角色并发 1（调度器保证），角色 → 运行中作业；output 文本按作业累积
const runningByRole = new Map<string, Job>()
const textByJob = new Map<string, string>()

async function command(cmd: {
  type: string
  to: string
  taskId?: string
  text?: string
}): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-panel-token': TOKEN },
      body: JSON.stringify(cmd),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`)
    return true
  } catch (err) {
    hubLog('ERROR', `dsh /command ${cmd.type} → ${cmd.to} 失败：${String(err)}`)
    return false
  }
}

function onTurnEnded(job: Job, e: PanelEvent): void {
  if (e.pl.taskId !== job.id) return // 非 hub 派发的 turn：只转发，不动作业状态
  const status = String(e.pl.status ?? 'ok')
  const kind = String(e.pl.reasonKind ?? '')
  const text = textByJob.get(job.id) ?? ''
  textByJob.delete(job.id)
  runningByRole.delete(job.role)
  addJobLog(job.id, `turn 结束 status=${status} reasonKind=${kind}`)
  if (status === 'ok') {
    addJobLog(job.id, text || '（本轮无文本产出）')
    setJobState(job.id, 'completed', { result: text || `（turn ${e.pl.turn ?? '?'} 无文本产出）` })
  } else if (status === 'cancelled') {
    addJobAction(job.id, '已中断')
    setJobState(job.id, 'cancelled')
  } else if (kind === 'blocked' || kind === 'max-tokens') {
    setJobState(job.id, 'blocked', { error: `turn blocked（${kind}）` })
  } else {
    const msg = (e.pl.reason as { error?: { message?: string } } | undefined)?.error?.message
    setJobState(job.id, 'failed', { error: `turn 失败（${kind}）：${msg ?? kind}` })
  }
}

// 插件 SSE 帧解析：data: {...}\n\n，心跳帧（: ...）无 data 行则跳过；断线 2s 重连
async function consumeEvents(): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/events?token=${encodeURIComponent(TOKEN)}`, {
        headers: { accept: 'text/event-stream' },
      })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      hubLog('INFO', `已订阅 dsh 插件事件流 ${BASE}/events`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i)
          buf = buf.slice(i + 2)
          const data = frame.split('\n').find((l) => l.startsWith('data: '))
          if (data) {
            try {
              handlePanelEvent(JSON.parse(data.slice(6)) as PanelEvent)
            } catch {
              /* 坏帧跳过 */
            }
          }
        }
      }
      throw new Error('事件流关闭')
    } catch (err) {
      hubLog('ERROR', `dsh 事件流断开：${String(err)}（2s 后重连）`)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
}

function handlePanelEvent(e: PanelEvent): void {
  const taskId = typeof e.pl?.taskId === 'string' ? e.pl.taskId : ''
  const job = (taskId && getJob(taskId)) || runningByRole.get(String(e.agent.role ?? ''))
  if (!job || job.state !== 'running') return
  // agent 身份重写为 hub 作业视角：面板与 mock 适配器口径一致（id=jobId, parent=master）
  emitEvent({
    ...e,
    agent: { id: job.id, role: job.role, parent: 'master', harness: 'dsh' },
  })
  switch (e.type) {
    case 'task.claimed':
      addJobAction(job.id, `dsh agent 已认领任务（turn=${e.pl.turn ?? '?'}）`)
      break
    case 'tool.started':
      addJobAction(job.id, String(e.pl.action ?? e.pl.name ?? '工具调用'))
      break
    case 'output':
      textByJob.set(job.id, (textByJob.get(job.id) ?? '') + String(e.pl.text ?? ''))
      break
    case 'turn.ended':
      onTurnEnded(job, e)
      break
  }
}

export function createDshAdapter(): Adapter {
  return {
    harness: 'dsh',
    level: 'L2',
    start(job) {
      runningByRole.set(job.role, job)
      addJobLog(job.id, `派发 → dsh 插件（${BASE}，role=${job.role}）`)
      void command({ type: 'task.assigned', to: job.role, taskId: job.id, text: job.instruction }).then(
        (ok) => {
          if (ok) return // 生命周期由插件事件驱动
          runningByRole.delete(job.role)
          setJobState(job.id, 'failed', { error: 'dsh 插件不可达或拒绝派发（见 hub 日志）' })
        },
      )
    },
    async steer(job, message) {
      // 透传为 task.rejected：插件侧 steer（下一 step 输入；agent 空闲时在下一边界唤醒）
      return command({ type: 'task.rejected', to: job.role, taskId: job.id, text: message })
    },
    cancel(job) {
      void command({ type: 'task.cancel', to: job.role, taskId: job.id }).then((ok) => {
        // 成功则等插件的 turn.ended(cancelled) 落状态；失败（如角色尚未创建）直接本地取消
        if (ok) return
        runningByRole.delete(job.role)
        addJobAction(job.id, '已中断')
        setJobState(job.id, 'cancelled')
      })
    },
  }
}

// 启动事件订阅（整进程一份，2s 断线重连）
let consuming = false
export function startDshEvents(): void {
  if (consuming) return
  consuming = true
  void consumeEvents()
}
