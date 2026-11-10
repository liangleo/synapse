// MCP 端到端冒烟：以 stdio 子进程方式启动 hub，走完整 JSONRPC 流程验证工具。
// 运行：node test/mcp-e2e.mjs（在 hub/ 目录下）
import { spawn } from 'node:child_process'

const proc = spawn('node', ['dist/index.js'], { stdio: ['pipe', 'pipe', 'inherit'] })
const pending = new Map()
let buf = ''
let nextId = 1

proc.stdout.on('data', (d) => {
  buf += d.toString()
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx)
    buf = buf.slice(idx + 1)
    if (!line.trim() || line.startsWith('[hub]')) continue // stderr 混入时不该出现，防御
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

// 1. initialize
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'e2e-test', version: '0' },
})
check('initialize 协议握手', Boolean(init.result?.serverInfo?.name === 'synapse-hub'))
proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

// 2. tools/list
const tools = await rpc('tools/list', {})
const names = tools.result.tools.map((t) => t.name)
for (const t of ['team_list', 'task_dispatch', 'task_status', 'task_wait', 'task_result', 'task_cancel'])
  check(`工具注册 ${t}`, names.includes(t))

// 3. team_list
const team = await callTool('team_list', {})
check('team_list 返回角色', team.structuredContent?.team?.length === 5)

// 4. task_dispatch + 去重
const d1 = await callTool('task_dispatch', {
  role: 'architect',
  instruction: '实现登录模块',
  clientRequestId: 'e2e-c1',
})
const jobId = d1.structuredContent?.jobId
check('task_dispatch 返回 jobId', Boolean(jobId))
const d2 = await callTool('task_dispatch', { role: 'architect', instruction: '实现登录模块', clientRequestId: 'e2e-c1' })
check('clientRequestId 去重', d2.structuredContent?.jobId === jobId)

// 5. 并行派发 dev（验证并发调度）
const d3 = await callTool('task_dispatch', { role: 'dev-a', instruction: '开发登录页' })
const d4 = await callTool('task_dispatch', { role: 'dev-b', instruction: '开发权限模型' })
check('并行派发 dev-a/dev-b', Boolean(d3.structuredContent?.jobId && d4.structuredContent?.jobId))

// 6. task_wait 全部完成
const wait = await callTool('task_wait', {
  jobIds: [jobId, d3.structuredContent.jobId, d4.structuredContent.jobId],
  until: 'all',
  timeoutSec: 30,
})
const states = wait.structuredContent?.jobs?.map((j) => `${j.state}`) ?? []
check('task_wait 全部 completed', states.every((st) => st === 'completed'), states.join(','))

// 7. task_result（含 fromJobs 注入验证）
const review = await callTool('task_dispatch', {
  role: 'reviewer',
  instruction: '评审登录模块',
  fromJobs: [d3.structuredContent.jobId],
})
const rJobId = review.structuredContent?.jobId
await callTool('task_wait', { jobIds: [rJobId], until: 'all', timeoutSec: 30 })
const result = await callTool('task_result', { jobId: rJobId, detail: 'summary' })
check('task_result 返回产出', result.content?.[0]?.text?.includes('【评审 · mock-claude】') === true)
// 8. task_steer 对 L1 → UNSUPPORTED
const steerJob = await callTool('task_dispatch', { role: 'reviewer', instruction: '另一个评审' })
await callTool('task_wait', { jobIds: [steerJob.structuredContent.jobId], until: 'any', timeoutSec: 10 })
const steer = await callTool('task_steer', { jobId: steerJob.structuredContent.jobId, message: '改一下' })
check('L1 steer 返回 UNSUPPORTED', steer.isError === true && steer.content?.[0]?.text?.startsWith('UNSUPPORTED'))

// 9. task_cancel 运行中作业
const cJob = await callTool('task_dispatch', { role: 'dev-a', instruction: '会被中断的任务' })
const cancel = await callTool('task_cancel', { jobId: cJob.structuredContent.jobId })
check('task_cancel 中断', cancel.structuredContent?.cancelled === true)

// 10. 资源读取：panel://jobs/{id}/log
const res = await rpc('resources/read', { uri: `panel://jobs/${rJobId}/log` })
check('资源读取作业日志', res.result?.contents?.[0]?.text?.includes('【指令】') === true)

console.log(errors ? `\n${errors} 项失败` : '\nMCP 端到端全部通过')
proc.kill()
process.exit(errors ? 1 : 0)

