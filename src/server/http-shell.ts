// 面板 HTTP 壳：与具体 harness 无关的管线设施（SSE 扇出、静态文件、请求体读取、来源校验）。
// dsh-panel-bridge 等插件用它搭面板服务，自己只保留 harness 桥接与路由逻辑。
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

// 只拒绝非 localhost 来源（页面经 Vite 代理等场景下 Origin 端口不同但仍是本机）
export function isLocalOrigin(o: string): boolean {
  try {
    const h = new URL(o).hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
  } catch {
    return false
  }
}

export function readBody(req: IncomingMessage, limit = 262144): Promise<string> {
  return new Promise((ok, fail) => {
    let b = ''
    req.on('data', (c) => {
      b += c
      if (b.length > limit) req.destroy()
    })
    req.on('end', () => ok(b))
    req.on('error', fail)
  })
}

// 静态文件解析：/ → 入口 HTML（注入 __PANEL_TOKEN__），/static/* → 同目录产物（拒绝 .. 穿越）
export function createStaticResolver(panelHtml: string): {
  fileFor: (pathname: string) => string | undefined
} {
  const staticRoot = dirname(resolve(panelHtml))
  const STATIC_EXT = /\.(js|mjs|css|svg|png|woff2?|map)$/
  return {
    fileFor(pathname: string): string | undefined {
      if (pathname === '/') return resolve(panelHtml)
      if (!pathname.startsWith('/static/')) return
      const file = resolve(staticRoot, pathname.slice('/static/'.length))
      if (file.startsWith(staticRoot + sep) && STATIC_EXT.test(file)) return file
    },
  }
}

// 读取静态文件并写响应；__PANEL_TOKEN__ 占位符替换为实际 token（对资产无副作用）
export function serveStatic(res: ServerResponse, file: string, token: string): void {
  try {
    const body = readFileSync(file).toString('utf8').replaceAll('__PANEL_TOKEN__', token)
    res
      .writeHead(200, { 'content-type': MIME[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream' })
      .end(body)
  } catch {
    res.writeHead(404).end()
  }
}

// SSE 扇出：backlog 回放 + 多客户端广播 + 单连接生命周期管理
export interface SseHub {
  readonly clients: Set<ServerResponse>
  broadcast(line: string): void
  push(event: unknown): void // backlog + 广播
  attach(req: IncomingMessage, res: ServerResponse): void // /events 响应：回放后加入客户端集
}

export function createSseHub(backlogLimit = 500): SseHub {
  const clients = new Set<ServerResponse>()
  const backlog: unknown[] = []
  const broadcast = (line: string): void => {
    for (const c of clients) {
      try {
        c.write(line)
      } catch {
        clients.delete(c)
      }
    }
  }
  return {
    clients,
    broadcast,
    push(event: unknown) {
      backlog.push(event)
      if (backlog.length > backlogLimit) backlog.shift()
      broadcast(`data: ${JSON.stringify(event)}\n\n`)
    },
    attach(req, res) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      // 先 flush：backlog 为空时若一个字节都不写，浏览器收不到响应头，onopen 不会触发
      res.flushHeaders()
      res.write(':\n\n')
      for (const e of backlog) res.write(`data: ${JSON.stringify(e)}\n\n`)
      clients.add(res)
      res.on('error', () => clients.delete(res))
      req.on('close', () => clients.delete(res))
    },
  }
}
