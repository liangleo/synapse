// dsh-headless 适配器端到端冒烟：stub 模拟 `dsh --profile headless --json` 的 NDJSON 事件流，
// hub 配置 DSH_HEADLESS_ROLES 后经 MCP 全链路验证派发 → 事件映射 → 会话续挂 → cancel → L1 语义，
// 以及 headless 模式下 hub 自服务的 /meta roleSessions、/history、/role-session API。
// 运行：node test/headless-e2e.mjs（在 hub/ 目录下，先 pnpm build）
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const stateDir = mkdtempSync(join(tmpdir(), 'hl-state-'))
const sessDir = mkdtempSync(join(tmpdir(), 'hl-sess-'))
const stub = new URL('./fixtures/headless-stub.mjs', import.meta.url).pathname

// 预设文件（headless 角色的唯一维护入口，与 desktop 插件共用同一格式）
const presets = {
  active: 'p1',
  presets: { p1: { roles: { 'dev-b': { label: '开发乙' } }, pipeline: ['dev-b'] } },
}
writeFileSync(join(stateDir, 'presets.json'), JSON.stringify(presets))

// ---------- 假会话目录：一条纯 JSONL + 一条 zstd 多帧（模拟真实 dsh 的追加帧写法） ----------
writeFileSync(
  join(sessDir, 'plain.jsonl'),
  `${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '你好' }] } })}\n${JSON.stringify({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回答' }] } } })}\n`,
)
const frame1 = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '第一帧' }] } })}\n`))
const frame2 = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二帧' }] } } })}\n`))
writeFileSync(join(sessDir, 'comp.jsonl.zstd'), Buffer.concat([frame1, frame2]))

// ---------- hub（stdio MCP + 面板 HTTP） ----------
const proc = spawn('node', ['dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    HUB_PORT: '3194',
    DSH_HEADLESS_ROLES: 'architect:架构师,dev-a',
    DSH_HEADLESS_CMD: `node ${stub}`,
    DSH_SESSIONS_DIR: sessDir,
    HUB_HEADLESS_STATE: join(stateDir, 'sessions.json'),
    HUB_MODE_STATE: join(stateDir, 'mode.json'),
    HUB_PRESETS_FILE: join(stateDir, 'presets.json'),
    STUB_STATE: stateDir,
  },
})
let hubToken = ''
proc.stderr.on('data', (d) => {
  const m = /token=([0-9a-f]+)/.exec(d.toString())
  if (m) hubToken = m[1]
})

const pending = new Map()
let buf = ''
let nextId = 1
// 崩溃时也杀掉 hub，避免孤儿进程占用端口污染下一次运行
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
async function api(path, init = {}) {
  // headers 合并写法：init 在前，避免调用方带 content-type 时覆盖掉 token
  return fetch(`http://127.0.0.1:3194${path}`, {
    ...init,
    headers: { 'x-panel-token': hubToken, ...(init.headers ?? {}) },
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'headless-e2e', version: '0' },
})
check('initialize 握手', init.result?.serverInfo?.name === 'synapse-hub')
proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

// 1. 角色注册：DSH_HEADLESS_ROLES 生效，L1
const team = await callTool('team_list', {})
const hl = (team.structuredContent?.team ?? []).find((r) => r.role === 'architect')
check('headless 角色注册（L1）', hl?.harness === 'dsh' && hl?.level === 'L1', JSON.stringify(hl))

// 2. 派发 → stub 事件流 → completed + 产出
const d1 = await callTool('task_dispatch', { role: 'architect', instruction: '做一个事' })
const jobId = d1.structuredContent?.jobId
const w1 = await callTool('task_wait', { jobIds: [jobId], until: 'all', timeoutSec: 15 })
check('headless 作业 completed', w1.structuredContent?.jobs?.[0]?.state === 'completed', JSON.stringify(w1.structuredContent?.jobs))
const r1 = await callTool('task_result', { jobId, detail: 'summary' })
check('取回 stub 产出', r1.content?.[0]?.text?.includes('stub 产出:OK') === true, r1.content?.[0]?.text)

// 3. 会话映射：首跑无 --session-id，/meta 下发 roleSessions；次跑续挂
await sleep(150)
const last1 = JSON.parse(readFileSync(join(stateDir, 'last-args.json'), 'utf8'))
check('首跑不带 --session-id', !last1.passedSid, JSON.stringify(last1))
const meta = await (await api('/meta')).json()
const sid1 = meta.roleSessions?.architect
check('/meta 下发 roleSessions', typeof sid1 === 'string' && sid1.startsWith('session-stub-'), JSON.stringify(meta.roleSessions))
const d2 = await callTool('task_dispatch', { role: 'architect', instruction: '再来一件事' })
const w2 = await callTool('task_wait', { jobIds: [d2.structuredContent?.jobId], until: 'all', timeoutSec: 15 })
check('第二单 completed', w2.structuredContent?.jobs?.[0]?.state === 'completed')
await sleep(150)
const last2 = JSON.parse(readFileSync(join(stateDir, 'last-args.json'), 'utf8'))
check('续跑带 --session-id（会话连续）', last2.passedSid === sid1, JSON.stringify(last2))

// 4. L1 steer：UNSUPPORTED 提示重新派发
const d3 = await callTool('task_dispatch', { role: 'dev-a', instruction: 'sleep 一下等中断' })
const jobId3 = d3.structuredContent?.jobId
await sleep(300)
const steer = await callTool('task_steer', { jobId: jobId3, message: '改需求' })
check('L1 steer → UNSUPPORTED', String(steer.content?.[0]?.text ?? '').includes('UNSUPPORTED'), JSON.stringify(steer))

// 5. cancel：杀进程 → cancelled
const cancel = await callTool('task_cancel', { jobId: jobId3 })
check('task_cancel 下发', cancel.structuredContent?.cancelled === true)
const w3 = await callTool('task_wait', { jobIds: [jobId3], until: 'all', timeoutSec: 10 })
check('cancel → 作业 cancelled', w3.structuredContent?.jobs?.[0]?.state === 'cancelled', JSON.stringify(w3.structuredContent?.jobs))

// 6. 解绑角色会话：清映射，下次派发新建
const del = await api(`/role-session/${encodeURIComponent('architect')}`, { method: 'DELETE' })
check('DELETE /role-session 204', del.status === 204)
const meta2 = await (await api('/meta')).json()
check('解绑后 roleSessions 不含 architect', !meta2.roleSessions?.architect, JSON.stringify(meta2.roleSessions))

// 7. 历史会话 API（hub 自服务，zstd 多帧解码）
const hs = await (await api('/history/sessions')).json()
const ids = (hs.sessions ?? []).map((s) => s.id)
check('/history/sessions 列出两个会话', ids.includes('plain') && ids.includes('comp'), JSON.stringify(ids))
const h1 = await (await api('/history?session=plain')).json()
check('纯 JSONL 解析', h1.items?.[0]?.text === '你好' && h1.items?.[1]?.text === '回答', JSON.stringify(h1.items))
const h2 = await (await api('/history?session=comp')).json()
check('zstd 多帧解析', h2.items?.[0]?.text === '第一帧' && h2.items?.[1]?.text === '第二帧', JSON.stringify(h2.items))

// 8. 模式切换与预设：headless 角色从激活预设读取；预设 API 自服务；切换预设重注册；活动作业时拒绝
const m0 = await (await api('/mode')).json()
check('GET /mode 当前 headless（env 初始）', m0.mode === 'headless' && m0.roles?.some((r) => r.name === 'architect'), JSON.stringify(m0))
const badPlugin = await api('/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'plugin' }) })
check('切 plugin 无插件 → 400', badPlugin.status === 400, String(badPlugin.status))
const sw = await api('/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'headless' }) })
const swBody = await sw.json()
check('headless 角色来自激活预设（dev-b）', sw.status === 200 && swBody.roles?.some((r) => r.name === 'dev-b' && r.label === '开发乙'), JSON.stringify(swBody))
const team2 = await callTool('team_list', {})
const t2 = team2.structuredContent?.team ?? []
check('预设角色生效（dev-b → dsh L1）', t2.some((r) => r.role === 'dev-b' && r.harness === 'dsh' && r.level === 'L1'), JSON.stringify(t2.find((r) => r.role === 'dev-b')))
check('不在预设的角色回退 mock（architect）', t2.some((r) => r.role === 'architect' && r.harness === 'mock-dsh'), JSON.stringify(t2.find((r) => r.role === 'architect')))
const persisted = JSON.parse(readFileSync(join(stateDir, 'mode.json'), 'utf8'))
check('模式选择已持久化', persisted.mode === 'headless' && persisted.roles === undefined, JSON.stringify(persisted))

// 预设 API：GET 全量视图 → PUT 新预设 → 切激活 → 角色重注册
const pv = await (await api('/presets')).json()
check('GET /presets 视图', pv.active === 'p1' && pv.presets?.p1?.roles?.['dev-b'], JSON.stringify(pv))
const put = await api('/presets/p2', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roles: { 'dev-c': { label: '开发丙' } }, pipeline: ['dev-c'] }) })
check('PUT /presets/p2 204', put.status === 204, String(put.status))
const act = await api('/preset/active', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'p2' }) })
check('POST /preset/active 204', act.status === 204, String(act.status))
await sleep(200)
const team4 = await callTool('team_list', {})
check('切换预设后角色重注册（dev-c）', (team4.structuredContent?.team ?? []).some((r) => r.role === 'dev-c' && r.harness === 'dsh'), JSON.stringify((team4.structuredContent?.team ?? []).find((r) => r.role === 'dev-c')))

// 活动作业期间拒绝预设变更与模式切换：派发 sleep 作业 → PUT/切模式 409/400 → cancel 后可切
const d5 = await callTool('task_dispatch', { role: 'dev-c', instruction: 'sleep 等切换' })
await sleep(300)
const blockedPreset = await api('/presets/p2', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roles: { 'dev-c': { label: '开发丙' } }, pipeline: [] }) })
check('活动作业时改预设被拒（409）', blockedPreset.status === 409, String(blockedPreset.status))
const blocked = await api('/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'mock' }) })
check('活动作业时切换被拒（400）', blocked.status === 400 && (await blocked.text()).includes('running/queued'), String(blocked.status))
await callTool('task_cancel', { jobId: d5.structuredContent?.jobId })
const swMock = await api('/mode', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'mock' }) })
check('cancel 后可切 mock', swMock.status === 200, String(swMock.status))
const team3 = await callTool('team_list', {})
check('mock 模式下无 dsh 角色', !(team3.structuredContent?.team ?? []).some((r) => r.harness === 'dsh'), JSON.stringify(team3.structuredContent?.team))

console.log(errors ? `\n${errors} 项失败` : '\ndsh-headless 适配器端到端全部通过')
proc.kill()
rmSync(stateDir, { recursive: true, force: true })
rmSync(sessDir, { recursive: true, force: true })
process.exit(errors ? 1 : 0)
