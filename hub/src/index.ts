// hub 入口：面板 HTTP（SSE/静态/命令） + MCP 控制面（stdio）。
// 日志全部走 stderr——stdout 属于 MCP stdio 协议，不能污染。
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { startHttp } from './http.js'
import { startMcp } from './mcp/server.js'
import { registerAdapters, registerDshRoles, registerHeadlessRoles, applyMode } from './orchestrate.js'
import { startDshEvents } from './adapters/dsh.js'
import { parseHeadlessRoles, CMD as HEADLESS_CMD } from './adapters/dsh-headless.js'
import { CLAUDE_CMD } from './adapters/claude.js'
import { registerClaudeRoles } from './orchestrate.js'
import { DEFAULT_ROLES as roles } from './registry.js'
import { hubLog } from './bus.js'
import { loadMode } from './mode.js'

const port = Number(process.env.HUB_PORT || 3182)
const token = process.env.HUB_TOKEN || randomBytes(12).toString('hex')
// 面板静态产物：仓库根的 dist/static（pnpm build 生成）
const here = fileURLToPath(new URL('.', import.meta.url))
const panelDist = resolve(here, '../../dist/static')
const hasPanel = existsSync(panelDist)

registerAdapters(roles)

const dshUrl = process.env.DSH_PANEL_URL
// dsh 接入模式优先级：面板切换持久化的配置（mode.ts 文件，重启仍生效）> DSH_HEADLESS_ROLES > DSH_PANEL_URL。
// env 可同时配置 headless 与插件：headless 优先；持久化模式恢复失败时也回落到这段 env 逻辑。
async function applyEnvMode(): Promise<void> {
  const claudeRoles = process.env.CLAUDE_HEADLESS_ROLES
  if (!process.env.DSH_HEADLESS_ROLES && claudeRoles) {
    const list = parseHeadlessRoles(claudeRoles)
    registerClaudeRoles(list)
    hubLog('INFO', `claude headless 已接入：${CLAUDE_CMD}（角色 ${list.map((r) => r.name).join(' / ')}）`)
    return
  }
  const headlessRoles = process.env.DSH_HEADLESS_ROLES
  if (headlessRoles) {
    if (dshUrl) hubLog('INFO', 'DSH_HEADLESS_ROLES 与 DSH_PANEL_URL 同时配置：headless 优先生效，插件接入跳过')
    const list = parseHeadlessRoles(headlessRoles)
    registerHeadlessRoles(list)
    hubLog('INFO', `dsh-headless 已接入：${HEADLESS_CMD}（角色 ${list.map((r) => r.name).join(' / ')}）`)
    return
  }
  if (!dshUrl) return
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

const savedMode = loadMode()
if (savedMode) {
  try {
    await applyMode(savedMode)
  } catch (err) {
    hubLog('ERROR', `恢复上次模式失败（${JSON.stringify(savedMode)}）：${String(err)}——改用环境变量`)
    await applyEnvMode()
  }
} else {
  await applyEnvMode()
}

startHttp(port, token, hasPanel ? panelDist : undefined)
process.stderr.write(`[hub] synapse-hub 0.1.0  面板=${hasPanel ? `http://127.0.0.1:${port}/` : '（未找到 dist/static，先在仓库根 pnpm build）'}  token=${token}\n`)

if (!process.argv.includes('--panel-only')) {
  await startMcp()
  process.stderr.write('[hub] MCP 控制面已就绪（stdio）\n')
}
