// hub 的面板 HTTP：SSE 事件流 / meta / logs / command / 静态面板，全部只监听 127.0.0.1。
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { backlogSince, subscribe, logTail, hubLog } from './bus.js'
import { DEFAULT_ROLES as roles } from './registry.js'
import { listJobs, getJob } from './jobs.js'
import { steer, cancel, dispatch, applyMode, currentMode, isSelfServeMode } from './orchestrate.js'
import { clearRoleSession, listRoleSessions } from './role-sessions.js'
import { dshSessionsDir, listAllSessions, readSession } from './history.js'
import { handlePresetsApi, activePipeline } from './presets.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

function isLocal(origin: string | undefined): boolean {
  if (!origin) return true
  try {
    const h = new URL(origin).hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '::1'
  } catch {
    return false
  }
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((ok, fail) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => ok(b))
    req.on('error', fail)
  })
}

// 会话管理/预设代理：历史对话、角色会话绑定、预设编辑转发给 dsh 插件（配置 DSH_PANEL_URL 时可用）
async function proxyPlugin(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, path: string): Promise<void> {
  const base = process.env.DSH_PANEL_URL
  if (!base) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未配置 dsh 插件（DSH_PANEL_URL）')
    return
  }
  try {
    const hasBody = !['GET', 'HEAD'].includes(req.method ?? 'GET')
    let body: string | undefined
    if (hasBody) {
      body = await new Promise<string>((ok, fail) => {
        let b = ''
        req.on('data', (c) => (b += c))
        req.on('end', () => ok(b))
        req.on('error', fail)
      })
    }
    const up = await fetch(`${base}${path}`, {
      method: req.method,
      headers: {
        'x-panel-token': process.env.DSH_PANEL_TOKEN ?? '',
        ...(body !== undefined ? { 'content-type': req.headers['content-type'] ?? 'application/json' } : {}),
      },
      body,
    })
    res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json; charset=utf-8' })
    res.end(Buffer.from(await up.arrayBuffer()))
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`dsh 插件不可达：${String(err)}`)
  }
}

export function startHttp(port: number, token: string, panelDist?: string): void {
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const origin = req.headers.origin
    if (origin && isLocal(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-headers', 'content-type, x-panel-token')
      res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    }
    if (req.method === 'OPTIONS') return res.writeHead(204).end()

    const authed = req.headers['x-panel-token'] === token || u.searchParams.get('token') === token

    // 静态面板（panelDist 存在时伺服 web 构建产物）
    if (panelDist && req.method === 'GET') {
      let file: string | undefined
      if (u.pathname === '/') file = join(panelDist, 'index.html')
      else if (u.pathname.startsWith('/static/')) {
        const f = resolve(panelDist, u.pathname.slice('/static/'.length))
        if (f.startsWith(resolve(panelDist) + sep) && existsSync(f)) file = f
      }
      if (file) {
        try {
          const body = readFileSync(file).toString('utf8').replaceAll('__PANEL_TOKEN__', token)
          res
            .writeHead(200, {
              'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
              // HTML 入口必须每次回源校验，否则发版后浏览器拿旧壳加载旧资源哈希
              'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
            })
            .end(body)
        } catch {
          res.writeHead(404).end()
        }
        return
      }
    }

    if (u.pathname === '/events' && authed && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const e of backlogSince()) res.write(`data: ${JSON.stringify(e)}\n\n`)
      const unsub = subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`))
      const ping = setInterval(() => res.write(': ping\n\n'), 15000)
      req.on('close', () => {
        unsub()
        clearInterval(ping)
      })
      return
    }

    if (u.pathname === '/meta' && req.method === 'GET') {
      // 角色会话绑定随派发动态变化，实时从 dsh 插件查询合并（插件不可达时不阻塞基础 meta）
      void (async () => {
        let roleSessions: Record<string, { id: string; harness: string }> = {}
        if (isSelfServeMode()) {
          // 自管模式：角色会话映射由 hub 维护（按 harness 分域存储，展示按角色名合并）
          roleSessions = listRoleSessions()
        } else {
          const base = process.env.DSH_PANEL_URL
          if (base) {
            try {
              const r = await fetch(`${base}/meta`, { headers: { 'x-panel-token': process.env.DSH_PANEL_TOKEN ?? '' } })
              if (r.ok) {
                // 插件模式的会话一定是 dsh harness：归一成 {id, harness} 与自管模式同形（面板统一渲染）
                const raw = ((await r.json()) as { roleSessions?: Record<string, string> }).roleSessions ?? {}
                roleSessions = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, { id: v, harness: 'dsh' }]))
              }
            } catch {
              /* 插件不可达，绑定为空 */
            }
          }
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
          JSON.stringify({
            preset: 'hub',
            // 流水线来自激活预设（与 dsh desktop 插件共用同一份），所有模式都展示
            pipeline: activePipeline(),
            roles: roles.map((r) => ({ name: r.name, label: r.label })),
            roleSessions,
          }),
        )
      })()
      return
    }

    if (u.pathname === '/logs' && authed && req.method === 'GET') {
      return res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ lines: logTail.slice(-500) }))
    }

    // 会话管理与预设：历史对话、角色会话绑定、预设编辑（代理到 dsh 插件，含 PUT/POST 请求体）
    const isPluginApi =
      u.pathname === '/history/sessions' ||
      u.pathname === '/history' ||
      u.pathname.startsWith('/role-session/') ||
      u.pathname.startsWith('/presets') ||
      u.pathname === '/preset/active'
    if (isPluginApi && authed) {
      void (async () => {
      // 自管模式与 mock：预设/历史/会话绑定由 hub 自服务（预设文件与 desktop 插件共用同一份；
      // mock 也读预设——模拟角色从激活预设注册，编辑器里能看到 server/client 内置预设）
      if (isSelfServeMode() || currentMode() === 'mock') {
        if (req.method === 'GET' && u.pathname === '/history/sessions') {
          return res
            .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ dir: dshSessionsDir(), sessions: listAllSessions() }))
        }
        if (req.method === 'GET' && u.pathname === '/history') {
          try {
            return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
              JSON.stringify({ session: u.searchParams.get('session') ?? '', items: readSession(u.searchParams.get('session') ?? '') }),
            )
          } catch (err) {
            return res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`会话日志不可读：${String(err)}`)
          }
        }
        const role = u.pathname.startsWith('/role-session/') ? decodeURIComponent(u.pathname.slice('/role-session/'.length)) : ''
        if (req.method === 'DELETE' && role) {
          clearRoleSession(role)
          return res.writeHead(204).end()
        }
        // 预设是角色的唯一维护入口：保存/切换预设会重注册 headless 角色，有活动作业时直接拒绝变更
        const mutatesPreset = ['PUT', 'DELETE'].includes(req.method ?? '') || (req.method === 'POST' && u.pathname === '/preset/active')
        if (mutatesPreset && listJobs().some((j) => j.state === 'running' || j.state === 'queued')) {
          return res.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' }).end('存在 running/queued 作业，等作业收尾后再改预设（改预设会重注册角色）')
        }
        if (await handlePresetsApi(req, res, u, readBody)) {
          if (mutatesPreset) void applyMode({ mode: currentMode() }).catch((err) => hubLog('ERROR', `预设变更后重注册角色失败：${String(err)}`))
          return
        }
      }
      await proxyPlugin(req, res, `${u.pathname}${u.search}`)
      })()
      return
    }

    // dsh 接入模式：查询 / 运行中切换（mock / headless / plugin）；切换会重注册角色，有活动作业时拒绝
    if (u.pathname === '/mode' && authed) {
      if (req.method === 'GET') {
        return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
          JSON.stringify({
            mode: currentMode(),
            roles: roles.filter((r) => r.harness === 'dsh').map((r) => ({ name: r.name, label: r.label, level: r.level })),
          }),
        )
      }
      if (req.method === 'POST') {
        void (async () => {
          const body = await readBody(req)
          try {
            const out = await applyMode(JSON.parse(body) as { mode: 'mock' | 'headless' | 'plugin'; roles?: string[] })
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(out))
          } catch (err) {
            res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err instanceof Error ? err.message : err))
          }
        })()
        return
      }
    }

    if (u.pathname === '/command' && authed && req.method === 'POST') {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        try {
          const cmd = JSON.parse(b) as { type: string; to: string; text?: string; taskId?: string }
          // 人工派发新任务：与 MCP task_dispatch 同路（排队/去重语义一致）
          if (cmd.type === 'task.assigned' || cmd.type === 'review.requested') {
            dispatch({ role: cmd.to, instruction: cmd.text ?? '', taskId: cmd.taskId })
            return res.writeHead(204).end()
          }
          // 其余人工操作：to 为角色名 → 作用于该角色最近的活动作业
          const job = listJobs(cmd.to).find((j) => j.state === 'running' || j.state === 'queued')
          if (!job) return res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`角色 ${cmd.to} 没有活动作业`)
          if (cmd.type === 'task.cancel') {
            cancel(job.id, job.role)
            return res.writeHead(204).end()
          }
          if (cmd.type === 'task.rejected') {
            steer(job.id, cmd.text ?? '', job.role).catch((err) =>
              process.stderr.write(`[hub] steer 失败：${String(err)}\n`),
            )
            return res.writeHead(204).end()
          }
          res.writeHead(204).end()
        } catch (err) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
        }
      })
      return
    }

    res.writeHead(404).end()
  })
  // 面板端口被占（如已有一个 hub 实例）只降级为 MCP-only,不让整个进程崩掉
  server.on('error', (err) => hubLog('ERROR', `面板 HTTP 监听失败（MCP 不受影响）：${String(err)}`))
  server.listen(port, '127.0.0.1', () =>
    process.stderr.write(`[hub] 面板 http://127.0.0.1:${port}/  token=${token}\n`),
  )
}

export { getJob, listJobs }
