// 不依赖 dsh 的模拟服务：用同样的 /events、/command 接口回放一段示例会话，用来先验证面板。
// 运行：pnpm mock（会先构建前端）  然后打开 http://127.0.0.1:3180/
// 静态来源：/ 与 /static/* 都指向 Vite 产物 dist/static/（Sass 已编译进 bundle）。
// 预设 API 与真实插件同款：直接 import 编译产物里的 GAME_PRESETS，持久化共用 ~/.synapse-agent-panel/presets.json。
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url)) // …/src/
const root = resolve(here, '..') // 工程根目录
const PAGES = { '/': 'dist/static/index.html' }
const STATIC = { '/static/': 'dist/static/' } // URL 前缀 → 根目录下子目录
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

// 只允许读取对应目录内的文件，拒绝 .. 穿越与未知路径
function fileFor(urlPath) {
  if (PAGES[urlPath]) return { file: join(root, PAGES[urlPath]) }
  for (const [prefix, dir] of Object.entries(STATIC)) {
    if (!urlPath.startsWith(prefix)) continue
    const rel = urlPath.slice(prefix.length)
    const rootDir = resolve(root, dir)
    const file = resolve(rootDir, rel)
    if (file === rootDir || file.startsWith(rootDir + sep)) return { file }
  }
  return null
}

const TOKEN = 'mock',
  port = 3180
const logTail = []
const mlog = (...a) => {
  logTail.push(`[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`)
  if (logTail.length > 800) logTail.shift()
  console.log('[mock]', ...a)
}
const clients = new Set(),
  backlog = []
const M = { id: 'main', harness: 'dsh' }
const sub = (role) => ({ id: 'agent-' + role, role, parentId: 'main', harness: 'dsh' })

// ---------- 预设（与插件同一份数据与持久化文件） ----------
let GAME_PRESETS = {}
try {
  ;({ GAME_PRESETS } = await import(new URL('../dist/game-presets.js', import.meta.url).href))
} catch (err) {
  console.error('[mock] 读取内置预设失败（先 pnpm build）：', err)
}
const PRESETS_FILE = join(homedir(), '.synapse-agent-panel', 'presets.json')
const loadState = () => {
  try {
    const raw = JSON.parse(readFileSync(PRESETS_FILE, 'utf8'))
    return { active: raw.active ?? '', presets: raw.presets ?? {} }
  } catch {
    return { active: '', presets: {} }
  }
}
const saveState = (s) => {
  mkdirSync(dirname(PRESETS_FILE), { recursive: true })
  writeFileSync(PRESETS_FILE, `${JSON.stringify(s, null, 2)}\n`)
}
const state = loadState()
const presetNow = (name) => {
  const builtin = GAME_PRESETS[name]
  const local = state.presets[name]
  if (!builtin && !local) return null
  return {
    roles: { ...builtin?.roles, ...local?.roles },
    pipeline: local?.pipeline ?? builtin?.pipeline ?? [],
  }
}
let activeName = state.active || Object.keys(GAME_PRESETS)[0] || ''

const readBody = (req) =>
  new Promise((ok, fail) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > 262144) req.destroy()
    })
    req.on('end', () => ok(b))
    req.on('error', fail)
  })

const validatePreset = (p) => {
  const { roles, pipeline } = p ?? {}
  if (!roles || typeof roles !== 'object' || !Array.isArray(pipeline) || pipeline.length === 0)
    throw new Error(
      '预设需要 { roles: Record<name, { provider, model, prompt? }>, pipeline: string[] }',
    )
  for (const [k, v] of Object.entries(roles)) {
    if (!v || (v.provider !== undefined && typeof v.provider !== 'string'))
      throw new Error(`角色 ${k} 的 provider 需为字符串（或省略以继承默认路由）`)
    if (v.model !== undefined && typeof v.model !== 'string')
      throw new Error(`角色 ${k} 的 model 需为字符串（或省略以继承默认路由）`)
    if (v.toolsRestrict !== undefined) {
      const tr = v.toolsRestrict
      const okArray = (x) => Array.isArray(x) && x.every((n) => typeof n === 'string')
      if (
        typeof tr !== 'object' ||
        tr === null ||
        (!okArray(tr.allow) && tr.allow !== undefined) ||
        (!okArray(tr.deny) && tr.deny !== undefined)
      )
        throw new Error(`角色 ${k} 的 toolsRestrict 需要 { allow?: string[], deny?: string[] }`)
    }
  }
  for (const step of pipeline)
    if (!roles[step]) throw new Error(`pipeline 引用了未定义的角色：${step}`)
  return { roles, pipeline }
}

const handlePresets = async (req, res, u) => {
  if (u.pathname === '/preset/active') {
    if (req.method !== 'POST') return false
    try {
      const { name } = JSON.parse(await readBody(req))
      if (!presetNow(String(name))) throw new Error(`未知预设：${name}`)
      state.active = String(name)
      activeName = String(name)
      saveState(state)
      mlog(`激活预设 → ${name}`)
      res.writeHead(204).end()
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
    }
    return true
  }
  const rest = u.pathname === '/presets' ? '' : u.pathname.match(/^\/presets\/(.+)$/)?.[1]
  if (rest === undefined) return false
  const name = rest ? decodeURIComponent(rest) : ''
  if (req.method === 'GET') {
    const all = {}
    for (const n of Object.keys({ ...GAME_PRESETS, ...state.presets })) {
      const p = presetNow(n)
      if (p)
        all[n] = { ...p, builtin: Boolean(GAME_PRESETS[n]), overridden: Boolean(state.presets[n]) }
    }
    return res
      .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ active: activeName, file: PRESETS_FILE, presets: all }))
  }
  if (req.method === 'PUT' && name) {
    try {
      state.presets[name] = validatePreset(JSON.parse(await readBody(req)))
      saveState(state)
      mlog(`预设 ${name} 已保存`)
      res.writeHead(204).end()
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
    }
    return true
  }
  if (req.method === 'DELETE' && name) {
    if (GAME_PRESETS[name]) {
      // 内置预设：DELETE = 恢复默认（移除本地覆盖）
      if (!state.presets[name])
        return res
          .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
          .end('内置预设无本地覆盖，无需恢复默认；可用 PUT 覆盖其角色与流水线')
      delete state.presets[name]
      saveState(state)
      mlog(`预设 ${name} 已恢复内置默认`)
      return res.writeHead(204).end()
    }
    delete state.presets[name]
    // 删除的是当前激活的本地预设：回退到第一个内置预设，避免 active 指向已删除项
    if (activeName === name) {
      activeName = Object.keys(GAME_PRESETS)[0] || ''
      state.active = activeName
      console.log(`[mock] 激活预设 ${name} 已删除，回退到 ${activeName || '（无预设）'}`)
    }
    saveState(state)
    res.writeHead(204).end()
    return true
  }
  return false
}

function send(type, agent, pl = {}) {
  const e = { type, t: Date.now(), agent, pl }
  backlog.push(e)
  if (backlog.length > 500) backlog.shift()
  for (const c of clients) c.write(`data: ${JSON.stringify(e)}\n\n`)
}

const timers = new Map() // agentId → 回放定时器，cancel 时清掉

function run(role, task, actions) {
  const a = sub(role)
  let i = 0
  send('agent.registered', a)
  if (task) send('task.claimed', a, { taskId: task })
  send('turn.started', a, { turn: 1 })
  const prev = timers.get(a.id)
  if (prev) clearInterval(prev)
  const t = setInterval(() => {
    if (i < actions.length) {
      send('tool.started', a, { name: 'edit', action: actions[i++] })
      send('output', a, { text: '处理中… ' })
    } else {
      clearInterval(t)
      timers.delete(a.id)
      send('turn.ended', a, { turn: 1, reason: 'completed', status: 'ok', taskId: task })
    }
  }, 900)
  timers.set(a.id, t)
}

send('agent.registered', M)
// 演示回放使用激活预设的前两个角色，与面板看到的预设保持一致
const demoRoles = presetNow(activeName)?.pipeline.slice(0, 2) ?? ['architect', 'developer-a']
setTimeout(() => run(demoRoles[0], 't-1', ['读取需求', '输出 tasks.md']), 800)
setTimeout(() => run(demoRoles[1], 't-2', ['创建 src/auth/login.ts', '补充 login.test.ts']), 4500)

createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type, x-panel-token')
  res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const u = new URL(req.url, 'http://127.0.0.1')
  const hit = fileFor(u.pathname)
  if (hit) {
    try {
      const body = readFileSync(hit.file).toString('utf8').replaceAll('__PANEL_TOKEN__', TOKEN) // 对不含占位符的 css/js 无副作用
      return res
        .writeHead(200, {
          'content-type':
            MIME[u.pathname.slice(u.pathname.lastIndexOf('.'))] ?? 'application/octet-stream',
        })
        .end(body)
    } catch {
      return res.writeHead(404).end()
    }
  }
  if (u.pathname === '/history/sessions') {
    return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({
        sessions: [
          { id: 'mock-session-1', mtime: Date.now(), size: 1024 },
          { id: 'mock-session-2', mtime: Date.now() - 86400000, size: 512 },
        ],
      }),
    )
  }
  if (u.pathname === '/history') {
    return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({
        session: u.searchParams.get('session'),
        items: [
          { kind: 'user', turn: 1, text: '为后台系统新增登录与权限模块' },
          { kind: 'turn', turn: 1, text: '' },
          { kind: 'assistant', turn: 1, text: '好的，我来拆分任务：登录接口与权限数据模型两个模块并行开发。' },
        ],
      }),
    )
  }
  if (u.pathname === '/logs') {
    if (req.headers['x-panel-token'] !== TOKEN) return res.writeHead(403).end()
    return res
      .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      .end(JSON.stringify({ lines: logTail.slice(-500) }))
  }
  if (u.pathname.startsWith('/presets') || u.pathname === '/preset/active') {
    if (req.headers['x-panel-token'] !== TOKEN)
      return res
        .writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        .end('token 校验失败')
    if (await handlePresets(req, res, u)) return
  }
  if (u.pathname === '/meta') {
    const p = presetNow(activeName)
    return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({
        preset: activeName || 'mock',
        master: 'master',
        pipeline: p?.pipeline ?? ['architect', 'developer-a'],
        roles: p
          ? Object.entries(p.roles).map(([n, r]) => ({ name: n, label: r.label ?? n }))
          : ['master', 'architect', 'developer-a'],
        presets: Object.keys({ ...GAME_PRESETS, ...state.presets }),
      }),
    )
  }
  if (u.pathname === '/events' && u.searchParams.get('token') === TOKEN) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const e of backlog) res.write(`data: ${JSON.stringify(e)}\n\n`)
    clients.add(res)
    return void req.on('close', () => clients.delete(res))
  }
  if (
    req.method === 'POST' &&
    u.pathname === '/command' &&
    req.headers['x-panel-token'] === TOKEN
  ) {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => {
      try {
        const c = JSON.parse(b)
        mlog(`指令 ← ${c.type} → ${c.to}${c.taskId ? `（task ${c.taskId}）` : ''}`)
        if (c.type === 'task.cancel') {
          const timer = timers.get('agent-' + c.to)
          if (timer) {
            clearInterval(timer)
            timers.delete('agent-' + c.to)
          }
          send('turn.ended', sub(c.to), { turn: 1, reason: 'cancelled', status: 'cancelled' })
        } else run(c.to, c.taskId, ['执行：' + (c.text || c.type)])
        res.writeHead(204).end()
      } catch (err) {
        console.error('[mock] 指令处理失败：', err)
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
      }
    })
    return
  }
  if (req.method === 'POST' && u.pathname === '/command') {
    console.error('[mock] /command token 校验失败（请用启动时打印的地址打开面板）')
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('token 校验失败')
    return
  }
  mlog(`404 ${req.method} ${u.pathname}`)
  res.writeHead(404).end()
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/`))
