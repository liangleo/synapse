// 模拟 `codex exec --json`：输出与真实 CLI 相同形状的 JSONL 事件流。
//   指令含 "sleep" → 只发 thread.started 然后挂住（供 cancel 测试）
//   否则 → item.completed(agent_message) → turn.completed
// 首跑新生成 thread id（计数递增）；收到 resume 子命令时回用该 thread id，写入 last-args.json 供断言。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = process.env.STUB_STATE ?? '.'
const argv = process.argv.slice(2)
// resume 路径的 argv 形如 [<thread-id>, '--json', ...]；首参为非 flag 即视为 thread id
const threadIn = argv[0] && !argv[0].startsWith('-') && argv[0] !== '-' ? argv[0] : ''

let seq = 1
try {
  seq = Number(readFileSync(join(state, 'seq'), 'utf8').trim()) + 1
} catch {
  /* 首次运行 */
}
writeFileSync(join(state, 'seq'), String(seq))
writeFileSync(join(state, 'last-args.json'), JSON.stringify({ argv, threadIn, cwd: process.cwd() }))

const threadId = threadIn || `thread-stub-${seq}`
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

out({ type: 'thread.started', thread_id: threadId })

let instruction = ''
process.stdin.on('data', (c) => (instruction += c.toString()))
process.stdin.on('end', () => run())
setTimeout(() => process.exit(0), 10000).unref()

function run() {
  if (instruction.includes('sleep')) {
    setInterval(() => {}, 1000)
    return
  }
  out({ type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'ls -la', exit_code: 0, output: 'file list' } })
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'codex stub 产出' } })
  out({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })
  process.exit(0)
}
