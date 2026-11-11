// 角色 → 子 agent 会话 id 映射（跨适配器共用：dsh-headless / Claude Code）。
// 持久化到单文件，重启不丢；面板 /meta roleSessions 与解绑（DELETE /role-session）走这里。
// 键按 harness 分域（"dsh:角色名" / "claude:角色名"）——两种 harness 的会话互不相通，
// 切换模式后各自起新会话；无前缀的旧键视为 dsh 的遗留绑定（历史文件兼容），仅 dsh 查询时可命中。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { hubLog } from './bus.js'

const STATE_FILE =
  process.env.HUB_ROLE_SESSIONS ?? join(homedir(), '.synapse-agent-panel', 'hub-headless-sessions.json')

const sessions: Record<string, string> = (() => {
  try {
    return (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { sessions?: Record<string, string> }).sessions ?? {}
  } catch {
    return {}
  }
})()

function save(): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true })
    writeFileSync(STATE_FILE, `${JSON.stringify({ sessions }, null, 2)}\n`)
  } catch (err) {
    hubLog('ERROR', `角色会话映射持久化失败：${String(err)}`)
  }
}

// 某 harness 下角色的会话 id；dsh 额外兼容无前缀遗留键
export function roleSession(harness: string, role: string): string {
  return sessions[`${harness}:${role}`] ?? (harness === 'dsh' ? (sessions[role] ?? '') : '')
}

export function setRoleSession(harness: string, role: string, sid: string): void {
  const key = `${harness}:${role}`
  if (sessions[key] !== sid) {
    sessions[key] = sid
    save()
  }
}

// 解绑角色的全部 harness 绑定（含遗留无前缀键）
export function clearRoleSession(role: string): void {
  let changed = false
  for (const k of Object.keys(sessions)) {
    if (k === role || k.endsWith(`:${role}`)) {
      delete sessions[k]
      changed = true
    }
  }
  if (changed) {
    save()
    hubLog('INFO', `角色 ${role} 会话绑定已清除（下次派发新建会话）`)
  }
}

// 面板展示用：按角色名合并各 harness 的绑定（同角色多 harness 时后写者胜）
export function listRoleSessions(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, sid] of Object.entries(sessions)) {
    const role = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k
    if (role) out[role] = sid
  }
  return out
}
