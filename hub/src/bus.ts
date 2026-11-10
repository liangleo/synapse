// 事件总线：hub 内部所有事件汇聚于此，扇出给 SSE（面板）与作业状态机。
import type { PanelEvent } from './types.js'

type Listener = (e: PanelEvent) => void
const listeners = new Set<Listener>()
const backlog: PanelEvent[] = [] // 面板重连回放（最多 500 条）

export function subscribe(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitEvent(e: PanelEvent): void {
  backlog.push(e)
  if (backlog.length > 500) backlog.shift()
  for (const fn of listeners) fn(e)
}

export function backlogSince(): PanelEvent[] {
  return [...backlog]
}

// hub 自身日志（stderr + 环形缓冲，供 /logs 与 MCP 资源查看）
export const logTail: string[] = []
export function hubLog(level: string, ...a: unknown[]): void {
  const line = `${new Date().toISOString().slice(11, 19)} ${level} ${a.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' ')}`
  logTail.push(line)
  if (logTail.length > 800) logTail.shift()
  process.stderr.write(`[hub] ${line}\n`)
}
