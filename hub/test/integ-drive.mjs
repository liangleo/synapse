// M2 集成验证驱动：对运行中的 hub（stdio MCP）派发任务到真实插件（mock-host 宿主）的角色，
// 验证 派发 → 插件 ensure/agent → 回放 turn → 事件映射 → task_result 全链路。
// 任意目录可运行：hub 产物按本文件位置解析；DSH_PANEL_URL/DSH_PANEL_TOKEN/HUB_PORT 由环境变量给出。
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const proc = spawn('node', [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env, // 继承 DSH_PANEL_URL / DSH_PANEL_TOKEN / HUB_PORT
})
const pending = new Map()
let buf = ''
let nextId = 1
proc.stdout.on('data', (d) => {
  buf += d.toString()
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
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
  return new Promise((r) => {
    pending.set(id, r)
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}
const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'integ', version: '0' } })
proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

const team = await call('team_list', {})
console.log('team_list dsh 角色：', team.structuredContent.team.filter((r) => r.harness === 'dsh').map((r) => r.role).join(', '))

const d = await call('task_dispatch', {
  role: process.env.DRIVE_ROLE ?? 'system-designer',
  instruction: process.env.DRIVE_TASK ?? '设计一个登录系统的核心玩法',
})
console.log('dispatch →', JSON.stringify(d.structuredContent))
const jobId = d.structuredContent.jobId

// 真实模型 turn 可能远超单次 task_wait 上限（120s，尤其 agent 自发拉团队时）：
// 循环等待直到终态，每轮打印一次进度
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'blocked'])
let w
let round = 0
for (;;) {
  round++
  w = await call('task_wait', { jobIds: [jobId], until: 'all', timeoutSec: 120 })
  const job = w.structuredContent?.jobs?.[0]
  console.log(`wait 第 ${round} 轮 → ${job?.state}（动作 ${job?.recentActions?.length ?? 0} 条，最近：${job?.recentActions?.slice(-1)[0] ?? '—'}）`)
  if (TERMINAL.has(job?.state)) break
}
console.log('wait →', JSON.stringify(w.structuredContent.jobs))

const r = await call('task_result', { jobId, detail: 'summary' })
console.log('result →', r.content?.[0]?.text?.slice(0, 200))

const log = await rpc('resources/read', { uri: `panel://jobs/${jobId}/log` })
console.log('--- 作业日志 ---')
console.log(log.result?.contents?.[0]?.text)
proc.kill()
process.exit(0)
