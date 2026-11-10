// dsh 会话日志读取（headless 模式下 hub 自己做，不再依赖插件代理）：
// 真实 dsh 的会话是 zstd 多帧拼接的 session.v4.jsonl.zstd（按 flush 追加帧，
// zlib 的 zstdDecompressSync 只解第一帧），按帧魔数切分逐帧解码。
// 事件溯源 JSONL → 对话序列：user/message 的 content 直接在 data 上（无 message 包裹），
// assistant/message 包在 data.message 里；未知事件跳过。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { hubLog } from './bus.js'

const sessionsDir = process.env.DSH_SESSIONS_DIR ?? join(homedir(), '.dsh', 'sessions')

export function dshSessionsDir(): string {
  return resolve(sessionsDir)
}

export interface HistSession {
  id: string
  mtime: number
  size: number
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
        list.push({ id, mtime: st.mtimeMs, size: st.size })
      }
    }
  }
  try {
    walk(base)
  } catch (err) {
    hubLog('ERROR', `会话目录扫描失败：${String(err)}`)
  }
  return list.sort((a, b) => b.mtime - a.mtime)
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
