// hub 入口：面板 HTTP（SSE/静态/命令） + MCP 控制面（stdio）。
// 日志全部走 stderr——stdout 属于 MCP stdio 协议，不能污染。
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { startHttp } from './http.js'
import { startMcp } from './mcp/server.js'
import { registerAdapters } from './orchestrate.js'
import { DEFAULT_ROLES as roles } from './registry.js'

const port = Number(process.env.HUB_PORT || 3182)
const token = process.env.HUB_TOKEN || randomBytes(12).toString('hex')
// 面板静态产物：仓库根的 dist/static（pnpm build 生成）
const here = fileURLToPath(new URL('.', import.meta.url))
const panelDist = resolve(here, '../../dist/static')
const hasPanel = existsSync(panelDist)

registerAdapters(roles)
startHttp(port, token, hasPanel ? panelDist : undefined)
process.stderr.write(`[hub] synapse-hub 0.1.0  面板=${hasPanel ? `http://127.0.0.1:${port}/` : '（未找到 dist/static，先在仓库根 pnpm build）'}  token=${token}\n`)

if (!process.argv.includes('--panel-only')) {
  await startMcp()
  process.stderr.write('[hub] MCP 控制面已就绪（stdio）\n')
}
