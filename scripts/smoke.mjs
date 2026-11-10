// 冒烟测试：加载 dist/ 的插件，用真实 dsh 0.2.2-rc.1 的事件形状驱动，断言关键行为。
// 覆盖：插件导出、agent/* 单 payload、turn 状态、实时输出、SSE 响应头、命令编排并发、删除激活预设。
// 运行：pnpm smoke（会先 build）
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'

const root = new URL('..', import.meta.url)
const plugin = await import(new URL('dist/dsh-panel-bridge.js', root).href)
const tmp = mkdtempSync(join(tmpdir(), 'synapse-smoke-'))
const presetsFile = join(tmp, 'presets.json')
const logFile = join(tmp, 'panel.log')
const stateFile = join(tmp, 'panel-state.json')
const port = Number(process.env.SMOKE_PORT || 3290)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (err) {
    failures.push(`${name}: ${err.message}`)
    console.error(`FAIL ${name}: ${err.message}`)
  }
}

// ---------- 假 agents 服务 ----------
const rootAgent = { id: 'root' }
const childAgent = { id: 'child' }
const handles = new Map()
const agents = {
  list: () => [rootAgent, childAgent],
  roots: () => [rootAgent],
  isOwnedBy: (id, owner) => id === 'child' && owner === rootAgent,
  async create({ sessionId }) {
    const id = String(sessionId)
    handles.set(id, { id })
    return {
      agent: { followup() {}, steer() {}, cancel() {} },
      dispose: async () => {},
    }
  },
}

const logs = []
const origLog = console.log
console.log = (...a) => {
  logs.push(a.map(String).join(' '))
  origLog(...a)
}
const ctx = new Context()
ctx.provide('agents', agents)
ctx.provide('sessions', {})
ctx.plugin(plugin, {
  port,
  presetsFile,
  preset: 'client',
  orchestrator: { master: 'master' },
  debug: false,
  logFile,
  stateFile,
})

for (let i = 0; i < 100 && !logs.some((l) => l.includes(`:${port}/`)); i++) await sleep(25)
console.log = origLog
const startLine = logs.find((l) => l.includes(`:${port}/`))
if (!startLine) {
  console.error('FAIL 插件没有启动（无监听日志）')
  process.exit(1)
}
const token = /token=([a-f0-9]+)/.exec(startLine)?.[1]

// 桌面版 dsh 看不到 console，日志落盘是唯一的排查入口：启动行与 token 必须在文件里
check('日志落盘包含地址与 token', () => {
  const body = readFileSync(logFile, 'utf8')
  assert.match(body, new RegExp(`127\\.0\\.0\\.1:${port}/`))
  assert.ok(token && body.includes(token), '日志文件应包含 token')
  assert.match(body, /日志文件：/)
})

// 真实 dsh 的 agentEvents.emit：args=[carrier, name, {...payload, agent: carrier}]，listener 只收到 payload
const emitAgentReal = (carrier, name, payload = {}) => {
  const args = [carrier, name, { ...payload, agent: carrier }]
  for (const cb of ctx.events.dispatch('emit', args)) cb(...args)
}
const sendSession = (id, type, data) => ctx.emit('session/event', { id }, { type, data })

// ---------- 导出 ----------
check('导出 name/inject/apply/Config', () => {
  assert.equal(plugin.name, 'dsh-panel-bridge')
  assert.deepEqual(plugin.inject, ['agents', 'sessions'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config?.['~standard']?.validate, 'function')
})

check('Config schema 校验并补默认值', () => {
  const ok = plugin.Config['~standard'].validate({ preset: 'client' })
  assert.equal(ok.issues, undefined)
  assert.equal(ok.value.port, 3180)
  const bad = plugin.Config['~standard'].validate({ port: 'not-a-number' })
  assert.ok(bad.issues?.length > 0, '非法 port 应被拒绝')
})

// ---------- /events 无 backlog 时也应立即返回响应头（flushHeaders） ----------
let sseRes = null
try {
  sseRes = await fetch(`http://127.0.0.1:${port}/events?token=${token}`, {
    signal: AbortSignal.timeout(1500),
  })
} catch {
  sseRes = null
}
check('/events 空 backlog 时响应头立即返回', () => {
  assert.ok(sseRes, '1.5s 内没有收到响应头（EventSource onopen 不会触发）')
  assert.equal(sseRes.status, 200)
})

// ---------- 真实形状事件 → 面板事件 ----------
let sse = ''
const ac = new AbortController()
if (sseRes) {
  const reader = sseRes.body.getReader()
  const dec = new TextDecoder()
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        sse += dec.decode(value, { stream: true })
      }
    } catch {
      /* aborted */
    }
  })()
}
emitAgentReal(rootAgent, 'agent/created', { source: 'startup' })
emitAgentReal(rootAgent, 'agent/status', { status: 'running' })
sendSession('child', 'turn/start', { turn: 3 })
sendSession('root', 'turn/start', { turn: 1 })
emitAgentReal(childAgent, 'agent/assistant-stream', {
  frame: {
    type: 'chunk',
    attemptId: 'a',
    revision: 1,
    index: 0,
    chunk: { type: 'text-delta', index: 0, text: 'HELLO' },
  },
})
sendSession('root', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'X' } } })
emitAgentReal(rootAgent, 'agent/disposed', {})
await sleep(500)
ac.abort()

const events = sse
  .split('\n\n')
  .filter((b) => b.startsWith('data: '))
  .map((b) => JSON.parse(b.slice(6)))
const pick = (t) => events.filter((e) => e.type === t)

check('agent/created → agent.registered 使用真实 agentId', () => {
  assert.deepEqual(
    pick('agent.registered').map((e) => e.agent.id),
    ['root'],
  )
})
check('agent/status payload 正确', () => {
  const e = pick('agent.status')[0]
  assert.equal(e?.agent.id, 'root')
  assert.equal(e?.pl.status, 'running')
})
check('assistant-stream text-delta → output', () => {
  assert.deepEqual(
    pick('output').map((e) => e.pl.text),
    ['HELLO'],
  )
})
check('TurnEndReason 对象 → status=failed、reasonKind=error', () => {
  const e = pick('turn.ended')[0]
  assert.equal(e?.pl.status, 'failed')
  assert.equal(e?.pl.reasonKind, 'error')
})
check('父 agent 关系正确', () => {
  const e = pick('turn.started').find((x) => x.agent.id === 'child')
  assert.equal(e?.agent.parentId, 'root')
})
check('agent/disposed → agent.ended', () => {
  assert.deepEqual(
    pick('agent.ended').map((e) => e.agent.id),
    ['root'],
  )
})

// ---------- 命令编排：并发派发应被拒绝 ----------
const post = (body) =>
  fetch(`http://127.0.0.1:${port}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-token': token },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, text: await r.text() }))
const first = await post({ type: 'task.assigned', to: 'master', taskId: 'wf-1', text: '任务一' })
const second = await post({ type: 'task.assigned', to: 'master', taskId: 'wf-2', text: '任务二' })
await sleep(100)
check('第一条编排被接受', () => assert.equal(first.status, 204))
check('role→session 映射落盘到 stateFile', () => {
  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.ok(Object.keys(state.sessions ?? {}).length > 0, 'stateFile 应记录角色会话映射')
})
check('并发编排被明确拒绝', () => {
  assert.equal(second.status, 400)
  assert.match(second.text, /流水线/)
})

// ---------- 删除激活中的本地预设：回退而不是留下脏状态 ----------
const req = async (method, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-panel-token': token },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, text: await r.text() }))
const putStatus = await req('PUT', '/presets/smoke-preset', {
  roles: { a: { provider: 'p', model: 'm' } },
  pipeline: ['a'],
})
const actStatus = await req('POST', '/preset/active', { name: 'smoke-preset' })
const delStatus = await req('DELETE', '/presets/smoke-preset')
const view = JSON.parse((await req('GET', '/presets')).text)
check('PUT/activate/DELETE 自定义预设', () => {
  assert.equal(putStatus.status, 204)
  assert.equal(actStatus.status, 204)
  assert.equal(delStatus.status, 204)
})
check('删除激活预设后回退到启动配置', () => {
  assert.equal(view.active, 'client')
  assert.equal(view.presets['smoke-preset'], undefined)
})

rmSync(tmp, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log('\n冒烟测试全部通过')
process.exit(0)
