// 角色 → 子 agent 会话 id 映射（跨适配器共用：dsh-headless / Claude Code）。
// 持久化到单文件，重启不丢；面板 /meta roleSessions 与解绑（DELETE /role-session）走这里。
// 同一角色只会属于一种 harness，键直接用角色名。
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

export function roleSession(role: string): string {
  return sessions[role] ?? ''
}

export function setRoleSession(role: string, sid: string): void {
  if (sessions[role] !== sid) {
    sessions[role] = sid
    save()
  }
}

export function clearRoleSession(role: string): void {
  if (sessions[role]) {
    delete sessions[role]
    save()
    hubLog('INFO', `角色 ${role} 会话绑定已清除（下次派发新建会话）`)
  }
}
