// hub 的面板 HTTP：SSE 事件流 / meta / logs / command / 静态面板，全部只监听 127.0.0.1。
import { createServer, type IncomingMessage } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { backlogSince, subscribe, logTail } from './bus.js'
import { DEFAULT_ROLES as roles } from './registry.js'
import { listJobs, getJob } from './jobs.js'
import { steer, cancel } from './orchestrate.js'

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
            .writeHead(200, { 'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' })
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
      return res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
        JSON.stringify({
          preset: 'hub',
          master: 'master',
          pipeline: [],
          roles: roles.map((r) => ({ name: r.name, label: r.label })),
        }),
      )
    }

    if (u.pathname === '/logs' && authed && req.method === 'GET') {
      return res
        .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        .end(JSON.stringify({ lines: logTail.slice(-500) }))
    }

    if (u.pathname === '/command' && authed && req.method === 'POST') {
      let b = ''
      req.on('data', (c) => (b += c))
      req.on('end', () => {
        try {
          const cmd = JSON.parse(b) as { type: string; to: string; text?: string }
          // 人工操作：to 为角色名 → 作用于该角色最近的活动作业
          const job = listJobs(cmd.to).find((j) => j.state === 'running' || j.state === 'queued')
          if (!job) return res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`角色 ${cmd.to} 没有活动作业`)
          if (cmd.type === 'task.cancel') {
            cancel(job.id, job.role)
            return res.writeHead(204).end()
          }
          if (cmd.type === 'task.rejected') {
            steer(job.id, cmd.text ?? '', job.role)
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
  server.listen(port, '127.0.0.1', () =>
    process.stderr.write(`[hub] 面板 http://127.0.0.1:${port}/  token=${token}\n`),
  )
}

export { getJob, listJobs }
