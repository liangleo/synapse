// dsh 会话日志读取（headless 模式下 hub 自己做，不再依赖插件代理）：
// 真实 dsh 的会话是 zstd 多帧拼接的 session.v4.jsonl.zstd（按 flush 追加帧，
// zlib 的 zstdDecompressSync 只解第一帧），按帧魔数切分逐帧解码。
// 事件溯源 JSONL → 对话序列：user/message 的 content 直接在 data 上（无 message 包裹），
// assistant/message 包在 data.message 里；未知事件跳过。
// 另外接入 claude（~/.claude/projects/**.jsonl）与 codex（~/.codex/sessions/**.jsonl）的历史，
// id 加 claude:/codex: 前缀区分；无前缀 = dsh（兼容旧客户端与既有测试断言）。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { hubLog } from './bus.js'

const sessionsDir = process.env.DSH_SESSIONS_DIR ?? join(homedir(), '.dsh', 'sessions')
const claudeDir = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), '.claude', 'projects')
const codexDir = process.env.CODEX_SESSIONS_DIR ?? join(homedir(), '.codex', 'sessions')

export function dshSessionsDir(): string {
  return resolve(sessionsDir)
}

export interface HistSession {
  id: string
  mtime: number
  size: number
  harness: string
}

export function listDshSessions(): HistSession[] {
  const base = dshSessionsDir()
  if (!existsSync(base)) return []
  const list: HistSession[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zstd')) {
        const st = statSync(full)
        // id 不含扩展名（相对 sessions 目录的路径），两条命名都收
        const id = full.slice(base.length + 1, e.name.endsWith('.zstd') ? -11 : -6)
        list.push({ id, mtime: st.mtimeMs, size: st.size, harness: 'dsh' })
      }
    }
  }
  try {
    walk(base)
  } catch (err) {
    hubLog('ERROR', `会话目录扫描失败：${String(err)}`)
  }
  return list
}

// claude/codex 的会话都是普通 .jsonl 树（claude 按项目目录分组、codex 按日期分组），同一套扫描
function scanPlainJsonl(base: string, harness: string): HistSession[] {
  if (!existsSync(base)) return []
  const list: HistSession[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl')) {
        const st = statSync(full)
        list.push({ id: `${harness}:${full.slice(base.length + 1, -6)}`, mtime: st.mtimeMs, size: st.size, harness })
      }
    }
  }
  try {
    walk(base)
  } catch (err) {
    hubLog('ERROR', `${harness} 会话目录扫描失败：${String(err)}`)
  }
  return list
}

export function listAllSessions(): HistSession[] {
  return [...listDshSessions(), ...scanPlainJsonl(claudeDir, 'claude'), ...scanPlainJsonl(codexDir, 'codex')].sort(
    (a, b) => b.mtime - a.mtime,
  )
}

export interface HistItem {
  kind: string
  turn?: number
  text: string
}

export function readDshSession(sid: string): HistItem[] {
  if (!sid || sid.includes('..')) throw new Error('非法 session id')
  const base = dshSessionsDir()
  const file = [`${sid}.jsonl`, `${sid}.jsonl.zstd`].map((f) => resolve(base, f)).find((f) => existsSync(f))
  if (!file || !file.startsWith(base + sep)) throw new Error('会话日志不存在')
  const raw = file.endsWith('.zstd') ? zstdDecodeAll(readFileSync(file)) : readFileSync(file, 'utf8')
  const textOf = (content: unknown): string =>
    Array.isArray(content)
      ? content
          .filter((p) => (p as { type?: string })?.type === 'text')
          .map((p) => String((p as { text?: string }).text ?? ''))
          .join('')
      : ''
  const items: HistItem[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: { type?: string; data?: Record<string, unknown> }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const type = String(obj?.type ?? '')
    const d = (obj?.data ?? {}) as { content?: unknown; message?: { content?: unknown }; turn?: number }
    if (type === 'user/message')
      items.push({ kind: 'user', turn: d.turn, text: textOf(d.content ?? d.message?.content).slice(0, 4000) })
    else if (type === 'assistant/message')
      items.push({ kind: 'assistant', turn: d.turn, text: textOf(d.message?.content).slice(0, 8000) })
    else if (type === 'turn/start' && items.length) items.push({ kind: 'turn', turn: d.turn, text: '' })
  }
  return items.slice(-500)
}

// 按 id 前缀分发历史读取：claude:/codex: 前缀走各自格式，无前缀 = dsh
export function readSession(sid: string): HistItem[] {
  if (sid.startsWith('claude:')) return readClaudeSession(sid.slice('claude:'.length))
  if (sid.startsWith('codex:')) return readCodexSession(sid.slice('codex:'.length))
  return readDshSession(sid)
}

function readPlainJsonl(base: string, rel: string): string {
  if (!rel || rel.includes('..')) throw new Error('非法 session id')
  const file = resolve(base, `${rel}.jsonl`)
  if (!file.startsWith(resolve(base) + sep) || !existsSync(file)) throw new Error('会话日志不存在')
  return readFileSync(file, 'utf8')
}

// claude stream-jsonl：{type:'user'|'assistant', isSidechain?, message:{content: string | [{type:'text'|'tool_use'|...}]}}
function readClaudeSession(rel: string): HistItem[] {
  const raw = readPlainJsonl(claudeDir, rel)
  const items: HistItem[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: { type?: string; isSidechain?: boolean; message?: { content?: unknown } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    if ((obj.type !== 'user' && obj.type !== 'assistant') || obj.isSidechain) continue
    const c = obj.message?.content
    const text =
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c
              .filter((p) => (p as { type?: string })?.type === 'text')
              .map((p) => String((p as { text?: string }).text ?? ''))
              .join('')
          : ''
    if (!text.trim()) continue
    items.push({ kind: obj.type, text: text.slice(0, obj.type === 'assistant' ? 8000 : 4000) })
  }
  return items.slice(-500)
}

// codex rollout JSONL：{type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
function readCodexSession(rel: string): HistItem[] {
  const raw = readPlainJsonl(codexDir, rel)
  const items: HistItem[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: { type?: string; payload?: { type?: string; role?: string; content?: { type?: string; text?: string }[] } }
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const p = obj.payload
    if (obj.type !== 'response_item' || p?.type !== 'message') continue
    const role = p.role
    if (role !== 'user' && role !== 'assistant') continue // developer/系统注入不展示
    const text = (p.content ?? [])
      .filter((b) => b.type === 'input_text' || b.type === 'output_text')
      .map((b) => b.text ?? '')
      .join('')
    if (!text.trim()) continue
    // ponytail: 以 < 或 "# AGENTS.md" 开头的 user 消息视为 CLI 注入上下文，不展示
    if (role === 'user' && (text.startsWith('<') || text.startsWith('# AGENTS.md'))) continue
    items.push({ kind: role, text: text.slice(0, role === 'assistant' ? 8000 : 4000) })
  }
  return items.slice(-500)
}

// zstd 帧魔数 0x28B52FFD：按帧切分逐帧解码；压缩数据里可能出现伪魔数，解码失败跳过该切分点
function zstdDecodeAll(buf: Buffer): string {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const parts: Buffer[] = []
  let start = 0
  let idx = buf.indexOf(magic, 1)
  for (;;) {
    const end = idx === -1 ? buf.length : idx
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      if (idx === -1) throw new Error('会话 zstd 数据无法解码')
    }
    if (idx === -1) return Buffer.concat(parts).toString('utf8')
    start = idx
    idx = buf.indexOf(magic, idx + 1)
  }
}
