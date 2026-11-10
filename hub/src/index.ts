// hub 入口：面板 HTTP（SSE/静态/命令） + MCP 控制面（stdio）。
// 日志全部走 stderr——stdout 属于 MCP stdio 协议，不能污染。
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { startHttp } from './http.js'
import { startMcp } from './mcp/server.js'
import { registerAdapters, registerDshRoles } from './orchestrate.js'
import { startDshEvents } from './adapters/dsh.js'
import { DEFAULT_ROLES as roles } from './registry.js'
import { hubLog } from './bus.js'

const port = Number(process.env.HUB_PORT || 3182)
const token = process.env.HUB_TOKEN || randomBytes(12).toString('hex')
// 面板静态产物：仓库根的 dist/static（pnpm build 生成）
const here = fileURLToPath(new URL('.', import.meta.url))
const panelDist = resolve(here, '../../dist/static')
const hasPanel = existsSync(panelDist)

registerAdapters(roles)

// dsh 真实角色：配置 DSH_PANEL_URL（+ DSH_PANEL_TOKEN）时从插件 /meta 自动发现并注册
const dshUrl = process.env.DSH_PANEL_URL
if (dshUrl) {
  try {
    const res = await fetch(`${dshUrl}/meta`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const meta = (await res.json()) as { roles?: { name: string; label?: string }[] }
    const dshRoles = (meta.roles ?? []).filter((r) => r.name && r.name !== 'master')
    registerDshRoles(dshRoles)
    startDshEvents()
    hubLog('INFO', `dsh 插件已接入：${dshUrl}（角色 ${dshRoles.map((r) => r.name).join(' / ') || '无'}）`)
  } catch (err) {
    hubLog('ERROR', `dsh 插件 /meta 拉取失败（${dshUrl}）：${String(err)}——只保留模拟角色`)
  }
}

startHttp(port, token, hasPanel ? panelDist : undefined)
process.stderr.write(`[hub] synapse-hub 0.1.0  面板=${hasPanel ? `http://127.0.0.1:${port}/` : '（未找到 dist/static，先在仓库根 pnpm build）'}  token=${token}\n`)

if (!process.argv.includes('--panel-only')) {
  await startMcp()
  process.stderr.write('[hub] MCP 控制面已就绪（stdio）\n')
}
