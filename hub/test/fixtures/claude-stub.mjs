// 模拟 `claude -p --output-format stream-json`：输出与真实 CLI 相同形状的 NDJSON 事件流。
//   指令含 "sleep" → 只发 init 然后挂住（供 cancel/超时测试）
//   否则 → assistant(text + tool_use) → user(tool_result) → result(success)
// 每次调用生成新 session UUID（计数文件递增），并把参数与 cwd 写入 last-args.json 供测试断言。
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const state = process.env.STUB_STATE ?? '.'
const argv = process.argv.slice(2)
const resumeIdx = argv.indexOf('--resume')
const resumeFlag = resumeIdx >= 0 ? argv[resumeIdx + 1] : ''
const sessionId = argv.includes('--session-id') ? argv[argv.indexOf('--session-id') + 1] : resumeFlag

let seq = 1
try {
  seq = Number(readFileSync(join(state, 'seq'), 'utf8').trim()) + 1
} catch {
  /* 首次运行 */
}
writeFileSync(join(state, 'seq'), String(seq))
writeFileSync(join(state, 'last-args.json'), JSON.stringify({ argv, resumeFlag, cwd: process.cwd() }))

const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'stub-claude' })

let instruction = ''
process.stdin.on('data', (c) => (instruction += c.toString()))
process.stdin.on('end', () => run())
setTimeout(() => process.exit(0), 10000).unref()

function run() {
  if (instruction.includes('sleep')) {
    setInterval(() => {}, 1000) // 保活，等 cancel/超时杀进程
    return
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude stub 产出' }] } })
  out({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.txt' } }] },
  })
  out({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file content' }] },
  })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'claude stub 产出', num_turns: 1, usage: { total_tokens: 42 } })
  process.exit(0)
}
