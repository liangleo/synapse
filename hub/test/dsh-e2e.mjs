// dsh 适配器端到端冒烟：起一个同插件 HTTP 契约（/meta、/events SSE、/command）的假 dsh 后端，
// hub 配置 DSH_PANEL_URL/DSH_PANEL_TOKEN 后经 MCP 全链路验证派发 → 事件映射 → 取回结果。
// 运行：node test/dsh-e2e.mjs（在 hub/ 目录下，先 pnpm build）
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'

const BACKEND_PORT = 3187
const TOKEN = 'dsh-e2e'

// ---------- 假 dsh 后端：与 src/dsh-panel-bridge.ts 相同的 HTTP 契约 ----------
const clients = new Set()
const received = { assigned: [], rejected: [], cancel: [] }
const send = (type, agent, pl = {}) => {
  const e = { type, t: Date.now(), agent, pl }
  for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`)
}
const sub = (role) => ({ id: `agent-${role}`, role, parentId: 'main', harness: 'dsh' })

function react(cmd) {
  const { type, to, taskId } = cmd
  if (type === 'task.assigned') received.assigned.push(cmd)
  if (type === 'task.rejected') {
    received.rejected.push(cmd)
    return
  }
  if (type === 'task.cancel') {
    received.cancel.push(cmd)
    setTimeout(() => send('turn.ended', sub(to), { turn: 1, reason: 'interrupted', reasonKind: 'interrupted', status: 'cancelled', taskId }), 80)
    return
  }
  if (type !== 'task.assigned') return
  if (to === 'tester') {
    // blocked 语义：reasonKind=blocked（插件把 blocked/max-tokens 归为 failed 状态）
    setTimeout(() => {
      send('output', sub(to), { text: '等待审批' })
      send('turn.ended', sub(to), { turn: 1, reason: { kind: 'blocked' }, reasonKind: 'blocked', status: 'failed', taskId })
    }, 150)
    return
  }
  // architect：完整生命周期 + 文本产出
  setTimeout(() => {
    send('agent.registered', sub(to))
    send('task.claimed', sub(to), { taskId, turn: 1 })
    send('turn.started', sub(to), { turn: 1 })
    send('tool.started', sub(to), { name: 'edit', action: '读取需求', turn: 1 })
    send('output', sub(to), { text: '架构方案完成' })
    send('turn.ended', sub(to), { turn: 1, reason: { kind: 'completed' }, reasonKind: 'completed', status: 'ok', taskId })
  }, 150)
}

createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (u.pathname === '/meta') {
    return res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ roles: [{ name: 'architect', label: '架构师' }, { name: 'tester', label: '测试' }] }))
  }
  if (u.pathname === '/events' && u.searchParams.get('token') === TOKEN) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.write(':\n\n')
    clients.add(res)
    return void req.on('close', () => clients.delete(res))
  }
  if (req.method === 'POST' && u.pathname === '/command' && req.headers['x-panel-token'] === TOKEN) {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      try {
        react(JSON.parse(b))
        res.writeHead(204).end()
      } catch (err) {
        res.writeHead(400).end(String(err))
      }
    })
    return
  }
  res.writeHead(404).end()
}).listen(BACKEND_PORT, '127.0.0.1')

// ---------- hub（stdio MCP） ----------
await new Promise((r) => setTimeout(r, 200)) // 后端先就绪
const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: {
    ...process.env,
    HUB_PORT: '3192',
    DSH_PANEL_URL: `http://127.0.0.1:${BACKEND_PORT}`,
    DSH_PANEL_TOKEN: TOKEN,
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

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'dsh-e2e', version: '0' },
})
check('initialize 握手', Boolean(init.result?.serverInfo?.name === 'synapse-hub'))
proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

// 1. 角色自动发现：team_list 含 /meta 里的 dsh 角色
const team = await callTool('team_list', {})
const dshTeam = (team.structuredContent?.team ?? []).filter((r) => r.harness === 'dsh')
check('dsh 角色自动发现', dshTeam.some((r) => r.role === 'architect' && r.level === 'L2'), JSON.stringify(dshTeam))

// 2. 派发 → 假后端收到 task.assigned → 事件回流 → completed + 产出
const d1 = await callTool('task_dispatch', { role: 'architect', instruction: '设计登录模块' })
const jobId = d1.structuredContent?.jobId
check('task_dispatch 返回 jobId', Boolean(jobId))
const wait = await callTool('task_wait', { jobIds: [jobId], until: 'all', timeoutSec: 10 })
check('dsh 作业 completed', wait.structuredContent?.jobs?.[0]?.state === 'completed', JSON.stringify(wait.structuredContent?.jobs))
check('假后端收到 task.assigned', received.assigned.some((c) => c.to === 'architect' && c.taskId === jobId && c.text?.includes('设计登录模块')))
const result = await callTool('task_result', { jobId, detail: 'summary' })
check('task_result 取回 dsh 产出', result.content?.[0]?.text?.includes('架构方案完成') === true, result.content?.[0]?.text)

// 3. 事件映射：动作日志含认领与工具动作（资源读取验证）
const logRes = await rpc('resources/read', { uri: `panel://jobs/${jobId}/log` })
const logText = logRes.result?.contents?.[0]?.text ?? ''
check('task.claimed → 作业动作', logText.includes('认领任务'), logText)
check('tool.started → 作业动作', logText.includes('读取需求'), logText)

// 4. steer 透传：task.rejected 到达假后端
const d2 = await callTool('task_dispatch', { role: 'architect', instruction: '第二个任务' })
const jobId2 = d2.structuredContent?.jobId
const steer = await callTool('task_steer', { jobId: jobId2, message: '补充鉴权流程' })
check('task_steer 透传（L2）', steer.structuredContent?.delivered === true, JSON.stringify(steer))
check('假后端收到 task.rejected', received.rejected.some((c) => c.to === 'architect' && c.text === '补充鉴权流程'))
await callTool('task_wait', { jobIds: [jobId2], until: 'all', timeoutSec: 10 })

// 5. cancel：假后端回放 turn.ended(cancelled) → 作业 cancelled
const d3 = await callTool('task_dispatch', { role: 'architect', instruction: '会被中断的任务' })
const jobId3 = d3.structuredContent?.jobId
const cancel = await callTool('task_cancel', { jobId: jobId3 })
check('task_cancel 下发', cancel.structuredContent?.cancelled === true)
const wait3 = await callTool('task_wait', { jobIds: [jobId3], until: 'all', timeoutSec: 10 })
check('cancel → 作业 cancelled', wait3.structuredContent?.jobs?.[0]?.state === 'cancelled', JSON.stringify(wait3.structuredContent?.jobs))
check('假后端收到 task.cancel', received.cancel.some((c) => c.taskId === jobId3))

// 6. blocked 映射：reasonKind=blocked → 作业 blocked（不是 failed/completed）
const d4 = await callTool('task_dispatch', { role: 'tester', instruction: '需要审批的任务' })
const jobId4 = d4.structuredContent?.jobId
const wait4 = await callTool('task_wait', { jobIds: [jobId4], until: 'all', timeoutSec: 10 })
check('blocked → 作业 blocked', wait4.structuredContent?.jobs?.[0]?.state === 'blocked', JSON.stringify(wait4.structuredContent?.jobs))

// 7. 派发失败语义：/command 401（token 错）不在这里模拟；插件不可达分支由 cancel 兜底路径覆盖（略）

console.log(errors ? `\n${errors} 项失败` : '\ndsh 适配器端到端全部通过')
proc.kill()
process.exit(errors ? 1 : 0)
