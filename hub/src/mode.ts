// dsh 接入模式的持久化：面板运行中切换后写这里，重启仍生效；环境变量只在无此文件时作初始默认。
// 文件损坏/缺失一律回退 env 行为，不影响启动。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type ModeName = 'mock' | 'headless' | 'plugin' | 'claude' | 'codex'

const MODE_FILE =
  process.env.HUB_MODE_STATE ?? join(homedir(), '.synapse-agent-panel', 'hub-mode.json')

interface SavedMode {
  mode: ModeName
  roles?: string[] // headless 模式的角色清单（"name:中文名" 或 name）
}

export function loadMode(): SavedMode | undefined {
  try {
    const d = JSON.parse(readFileSync(MODE_FILE, 'utf8')) as SavedMode
    if (['headless', 'plugin', 'mock', 'claude', 'codex'].includes(d.mode)) return d
  } catch {
    /* 无文件或坏 JSON：走 env 默认 */
  }
  return undefined
}

export function saveMode(mode: ModeName, roles?: string[]): void {
  try {
    mkdirSync(dirname(MODE_FILE), { recursive: true })
    writeFileSync(MODE_FILE, `${JSON.stringify({ mode, roles } satisfies SavedMode, null, 2)}\n`)
  } catch (err) {
    process.stderr.write(`[hub] 模式配置持久化失败：${String(err)}\n`)
  }
}
