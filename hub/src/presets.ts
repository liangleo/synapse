// hub 侧预设管理（headless 模式）：与 desktop 插件读写同一个 presets.json，角色维护口径统一——
// 预设是角色清单的唯一维护入口，headless 角色从激活预设解析（切换预设/保存预设后重注册角色）。
// 内置预设（dist/game-presets.js，仓库根构建产物）存在则合并展示；文件里的本地预设优先。
// API 契约与插件一致：GET /presets、PUT /presets/{name}、DELETE /presets/{name}（内置=恢复默认）、POST /preset/active。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hubLog } from './bus.js'

export interface PresetDef {
  roles: Record<string, { label?: string; prompt?: string }>
  pipeline: string[]
}

const PRESETS_FILE = process.env.HUB_PRESETS_FILE ?? resolve(homedir(), '.synapse-agent-panel', 'presets.json')

interface PresetState {
  active: string
  presets: Record<string, PresetDef>
}

// 内置预设：从仓库根 dist/game-presets.js 惰性加载（不存在则只有本地预设）
let builtin: Record<string, PresetDef> = {}
try {
  const p = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../dist/game-presets.js')
  if (existsSync(p)) builtin = (await import(pathToFileURL(p).href)).GAME_PRESETS ?? {}
} catch (err) {
  hubLog('ERROR', `内置预设加载失败：${String(err)}`)
}

function readState(): PresetState {
  try {
    const d = JSON.parse(readFileSync(PRESETS_FILE, 'utf8')) as Partial<PresetState>
    return { active: String(d.active ?? ''), presets: d.presets ?? {} }
  } catch {
    return { active: '', presets: {} }
  }
}

function writeState(state: PresetState): void {
  mkdirSync(dirname(PRESETS_FILE), { recursive: true })
  writeFileSync(PRESETS_FILE, `${JSON.stringify(state, null, 2)}\n`)
}

export function presetsFile(): string {
  return PRESETS_FILE
}

export function activePresetName(): string {
  return readState().active
}

// headless 角色来源：激活预设的 roles（没有激活预设或预设不存在 → 空，由调用方回退）
export function activePresetRoles(): { name: string; label: string }[] {
  const state = readState()
  const p = state.presets[state.active]
  return Object.entries(p?.roles ?? {}).map(([name, r]) => ({ name, label: r.label || name }))
}

export function activePipeline(): string[] {
  const state = readState()
  return state.presets[state.active]?.pipeline ?? []
}

function validatePreset(p: unknown): PresetDef {
  const d = p as PresetDef
  if (!d || typeof d !== 'object' || typeof d.roles !== 'object' || d.roles === null)
    throw new Error('预设必须包含 roles（name → {label, prompt}）')
  if (!Object.keys(d.roles).length) throw new Error('roles 不能为空')
  for (const step of d.pipeline ?? [])
    if (!d.roles[step]) throw new Error(`pipeline 引用了未定义的角色：${step}`)
  return { roles: d.roles, pipeline: d.pipeline ?? [] }
}

// 预设 API 处理；返回是否已处理（调用方随后决定是否重注册角色）
export async function handlePresetsApi(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  url: URL,
  readBody: (req: import('node:http').IncomingMessage) => Promise<string>,
): Promise<boolean> {
  if (url.pathname === '/preset/active') {
    if (req.method !== 'POST') return false
    try {
      const { name } = JSON.parse(await readBody(req)) as { name?: string }
      const state = readState()
      if (!state.presets[String(name ?? '')] && !builtin[String(name ?? '')]) throw new Error(`预设不存在：${name}`)
      state.active = String(name ?? '')
      writeState(state)
      res.writeHead(204).end()
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err instanceof Error ? err.message : err))
    }
    return true
  }

  const rest = url.pathname === '/presets' ? '' : url.pathname.match(/^\/presets\/(.+)$/)?.[1]
  if (rest === undefined) return false
  const name = rest ? decodeURIComponent(rest) : ''

  if (req.method === 'GET') {
    const state = readState()
    const all: Record<string, unknown> = {}
    for (const n of Object.keys({ ...builtin, ...state.presets })) {
      const p = state.presets[n] ?? builtin[n]
      if (p) all[n] = { ...p, builtin: Boolean(builtin[n]), overridden: Boolean(state.presets[n]) }
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({ active: state.active, file: PRESETS_FILE, presets: all }),
    )
    return true
  }

  if (req.method === 'PUT' && name) {
    try {
      const p = validatePreset(JSON.parse(await readBody(req)))
      const state = readState()
      state.presets[name] = p
      writeState(state)
      res.writeHead(204).end()
    } catch (err) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err instanceof Error ? err.message : err))
    }
    return true
  }

  if (req.method === 'DELETE' && name) {
    const state = readState()
    if (builtin[name] && !state.presets[name]) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('内置预设无本地覆盖，无需恢复默认；可用 PUT 覆盖其角色与流水线')
      return true
    }
    delete state.presets[name]
    if (!builtin[name] && state.active === name) state.active = ''
    writeState(state)
    res.writeHead(204).end()
    return true
  }
  return false
}
