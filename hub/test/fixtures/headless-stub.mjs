// 模拟 `dsh --profile headless --json`：输出与真实 bundle 相同形状的 NDJSON 事件流。
// 行为由指令文本与参数控制：
//   指令含 "sleep" → 只发 session 然后挂住（供 cancel 测试杀进程）
//   否则 → 完整生命周期后 final(completed)，text 固定 "stub 产出:OK"
// 每次调用生成新 sessionId（计数文件递增），并把收到的 --session-id 参数写入 last-args.json 供测试断言。
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const state = process.env.STUB_STATE ?? '.'
const argv = process.argv.slice(2)
const sidIdx = argv.indexOf('--session-id')
const passedSid = sidIdx >= 0 ? argv[sidIdx + 1] : ''

let seq = 1
try {
  seq = Number(readFileSync(join(state, 'seq'), 'utf8').trim()) + 1
} catch {
  /* 首次运行 */
}
writeFileSync(join(state, 'seq'), String(seq))
writeFileSync(join(state, 'last-args.json'), JSON.stringify({ argv, passedSid, cwd: process.cwd() }))

const sessionId = `session-stub-${seq}`
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

out({ type: 'session', sessionId, cwd: process.cwd() })

let instruction = ''
process.stdin.on('data', (c) => (instruction += c.toString()))
process.stdin.on('end', () => run())

function run() {
  if (instruction.includes('sleep')) {
    setInterval(() => {}, 1000) // 保活句柄：模拟长跑任务，直到被 cancel 杀掉
    return
  }
  out({ type: 'status', phase: 'turn_start', turn: 1 })
  out({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
  out({ type: 'tool_call', name: 'read_file', callId: 'c1' })
  out({ type: 'tool_result', callId: 'c1', status: 'completed' })
  out({ type: 'text', text: 'stub 产出:OK' })
  out({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
  out({ type: 'final', sessionId, reason: { kind: 'completed' }, text: 'stub 产出:OK' })
  appendFileSync(join(state, 'done'), `${sessionId}\n`)
  process.exit(0)
}

// 指令可能晚于事件循环就绪：stdin 立刻 end 时 end 事件照常触发；兜底 10s 超时退出避免悬挂
setTimeout(() => process.exit(0), 10000).unref()
