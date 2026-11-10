// 真机验收：不开 dsh desktop，hub 配 DSH_HEADLESS_ROLES + 真 dsh CLI，经 MCP 派发真实作业取回真实产出。
// 运行：node test/headless-real.mjs（在 hub/ 目录下；要求 dsh CLI 可用且 headless 凭据已恢复）
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stateDir = mkdtempSync(join(tmpdir(), 'hl-real-'))
// 隔离模式/预设/会话映射状态文件，避免读到机器上面板保存的真实配置
const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    HUB_PORT: '3196',
    DSH_HEADLESS_ROLES: 'researcher:研究员',
    HUB_MODE_STATE: join(stateDir, 'mode.json'),
    HUB_PRESETS_FILE: join(stateDir, 'presets.json'),
    HUB_HEADLESS_STATE: join(stateDir, 'sessions.json'),
  },
})
const pending = new Map()
let buf = ''
let nextId = 1
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
const rpc = (method, params) => {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const callTool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hl-real', version: '0' } })
proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

const d = await callTool('task_dispatch', {
  role: 'researcher',
  instruction: '运行 ls 看当前目录有哪些文件，然后用一句话报告看到了什么。', // 触发工具调用，验证交互内容进作业日志
})
const jobId = d.structuredContent?.jobId
console.log('jobId:', jobId)
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked'])
let job
for (let i = 0; i < 20; i++) {  // 兜底上限，避免作业卡死时测试挂住
  const w = await callTool('task_wait', { jobIds: [jobId], until: 'all', timeoutSec: 30 })
  job = w.structuredContent?.jobs?.[0]
  console.log('state:', job?.state)
  if (job && TERMINAL.has(job.state)) break
}
const lg = await rpc('resources/read', { uri: `panel://jobs/${jobId}/log` })
console.log('--- 作业日志（CLI 交互内容） ---')
console.log(lg.result?.contents?.[0]?.text)
const r = await callTool('task_result', { jobId, detail: 'full' })
console.log('--- 产出 ---')
console.log(r.content?.[0]?.text)
const ok = job?.state === 'completed' && String(r.content?.[0]?.text ?? '').length > 5
console.log(ok ? '\n真机验收通过' : '\n真机验收失败')
proc.kill()
rmSync(stateDir, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
