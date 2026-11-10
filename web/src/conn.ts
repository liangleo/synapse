import { store } from './store'
// 后端连接：模式切换（同源 / mock / host / 自定义），选择持久化在 localStorage。
// 切换后整页重载，SSE 与所有 fetch 统一走这里的前缀和 token。
import { reactive } from 'vue'

const KEY = 'panel.conn'

function load(): { base: string; token: string; tasks: Record<string, string> } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return { base: raw.base ?? '', token: raw.token ?? '', tasks: raw.tasks ?? {} }
  } catch {
    return { base: '', token: '', tasks: {} }
  }
}

const saved = load()

export const conn = reactive({
  base: saved.base, // '' = 同源（当前后端）；否则如 http://127.0.0.1:3181
  token: saved.token, // 远端后端的 token；同源时用页面注入的 window.PANEL_TOKEN
  taskId: saved.tasks[saved.base] ?? '', // 该后端上选中的 session（切换后端时跟随）
})

// 每个 base 各自记住选中的 session
function loadTasks(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}').tasks ?? {}
  } catch {
    return {}
  }
}

export function saveConn(): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({ base: conn.base, token: conn.token, tasks: loadTasks() }),
  )
}

export function setTaskId(id: string): void {
  conn.taskId = id
  const tasks = loadTasks()
  if (id) tasks[conn.base] = id
  else delete tasks[conn.base]
  localStorage.setItem(
    KEY,
    JSON.stringify({ base: conn.base, token: conn.token, tasks }),
  )
}

export const apiBase = (): string => conn.base.replace(/\/$/, '')

export function apiToken(): string {
  if (conn.base) return conn.token
  // dev 模式下 index.html 不会被服务端注入 token；vite 代理指向本地 mock（token 固定为 mock）
  const t = window.PANEL_TOKEN ?? ''
  return t.startsWith('__') && import.meta.env.DEV ? 'mock' : t
}

// 统一的 fetch：自动带前缀与 token
export async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(apiBase() + path, {
    ...init,
    headers: { 'x-panel-token': apiToken(), ...(init.headers ?? {}) },
  })
}

// 预设的后端选项（自定义走 prompt）
export const BACKENDS = [
  { value: '', label: '当前后端（同源）' },
  { value: 'http://127.0.0.1:3180', label: 'mock（:3180）' },
  { value: 'http://127.0.0.1:3181', label: 'host（:3181）' },
]

// 统一指令发送：卡片按钮与指令栏共用
export async function sendCommand(type: string, to: string): Promise<void> {
  try {
    const r = await api('/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type, to, taskId: conn.taskId || undefined }),
    })
    store.status = r.ok ? `指令已发送：${type} → ${to}` : `指令失败：${await r.text()}`
    store.statusOk = r.ok
  } catch (err) {
    store.status = `指令失败：${(err as Error).message}`
    store.statusOk = false
  }
}
