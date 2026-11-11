// Claude Code 适配器端到端冒烟：stub 模拟 `claude -p --output-format stream-json` 的 NDJSON 事件流，
// 验证派发 → 事件映射 → 会话续挂（--session-id / --resume）→ cancel → L1 steer UNSUPPORTED。
// 运行：node test/claude-e2e.mjs（在 hub/ 目录下，先 pnpm build）
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'cl-state-'))
const stub = new URL('./fixtures/claude-stub.mjs', import.meta.url).pathname

const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    HUB_PORT: '3197',
    CLAUDE_HEADLESS_ROLES: 'writer:写手',
    CLAUDE_CMD: `node ${stub}`,
    HUB_ROLE_SESSIONS: join(stateDir, 'sessions.json'),
    HUB_MODE_STATE: join(stateDir, 'mode.json'),
    HUB_PRESETS_FILE: join(stateDir, 'presets.json'),
    HUB_JOBS_DB: join(stateDir, 'jobs.db'),
    STUB_STATE: stateDir,
  },
})

const pending = new Map()
let buf = ''
let nextId = 1
process.on('uncaughtException', (err) => {
  proc.kill()
  console.error(err)
  process.exit(1)
})
proc.stdout.on('data', (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
})

let errors = 0
function check(name, cond, extra = '') {
  if (cond) console.log(`ok   ${name}`)
  else {
    errors++
    console.log(`FAIL ${name} ${extra}`)
  }
}
function rpc(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
async function callTool(name, args) {
  const res = await rpc('tools/call', { name, arguments: args })
  return res.result
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-e2e', version: '0' } })
check('initialize 握手', init.result?.serverInfo?.name === 'synapse-hub')
proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

// 1. 角色注册（CLAUDE_HEADLESS_ROLES）
const team = await callTool('team_list', {})
const w = (team.structuredContent?.team ?? []).find((r) => r.role === 'writer')
check('claude 角色注册（L1, harness=claude）', w?.harness === 'claude' && w?.level === 'L1', JSON.stringify(w))

// 2. 派发 → stub 事件流 → completed + 产出 + 工具动作
const d1 = await callTool('task_dispatch', { role: 'writer', instruction: '写一段话' })
const jobId = d1.structuredContent?.jobId
const w1 = await callTool('task_wait', { jobIds: [jobId], until: 'all', timeoutSec: 15 })
check('claude 作业 completed', w1.structuredContent?.jobs?.[0]?.state === 'completed', JSON.stringify(w1.structuredContent?.jobs))
const lg = await rpc('resources/read', { uri: `panel://jobs/${jobId}/log` })
const lgText = lg.result?.contents?.[0]?.text ?? ''
check('tool_use → 动作日志带参数', lgText.includes('Read') && lgText.includes('a.txt'), lgText)
check('tool_result → 结果预览', lgText.includes('file content'), lgText)
const lg2 = await callTool('task_result', { jobId, detail: 'summary' })
check('result → 产出', lg2.content?.[0]?.text?.includes('claude stub 产出') === true, lg2.content?.[0]?.text)

// 3. 会话连续：首跑 --session-id，次跑 --resume
await sleep(150)
const last1 = JSON.parse(readFileSync(join(stateDir, 'last-args.json'), 'utf8'))
check('首跑带 --session-id（UUID）', last1.argv?.includes('--session-id') && last1.argv?.[last1.argv.indexOf('--session-id') + 1]?.length === 36, JSON.stringify(last1.argv))
const sid1 = last1.argv[last1.argv.indexOf('--session-id') + 1]
const d2 = await callTool('task_dispatch', { role: 'writer', instruction: '再写一段' })
await callTool('task_wait', { jobIds: [d2.structuredContent?.jobId], until: 'all', timeoutSec: 15 })
await sleep(150)
const last2 = JSON.parse(readFileSync(join(stateDir, 'last-args.json'), 'utf8'))
check('续跑 --resume 同一会话', last2.resumeFlag === sid1, JSON.stringify(last2))

// 4. L1 steer + cancel（sleep 任务挂住）
const d3 = await callTool('task_dispatch', { role: 'writer', instruction: 'sleep 等中断' })
const jobId3 = d3.structuredContent?.jobId
await sleep(300)
const steer = await callTool('task_steer', { jobId: jobId3, message: '改需求' })
check('L1 steer → UNSUPPORTED', String(steer.content?.[0]?.text ?? '').includes('UNSUPPORTED'), JSON.stringify(steer))
const cancel = await callTool('task_cancel', { jobId: jobId3 })
check('task_cancel 下发', cancel.structuredContent?.cancelled === true)
const w3 = await callTool('task_wait', { jobIds: [jobId3], until: 'all', timeoutSec: 10 })
check('cancel → 作业 cancelled', w3.structuredContent?.jobs?.[0]?.state === 'cancelled', JSON.stringify(w3.structuredContent?.jobs))

console.log(errors ? `\n${errors} 项失败` : '\nclaude 适配器端到端全部通过')
proc.kill()
rmSync(stateDir, { recursive: true, force: true })
process.exit(errors ? 1 : 0)
