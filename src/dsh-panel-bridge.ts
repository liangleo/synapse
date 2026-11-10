// dsh 插件：把 session/agent 事件转换为通用面板事件（SSE），并把面板指令转换为 Agent API 调用。
// 运行期 API 已对照 dsh 0.2.2-rc.1 真机实现核对（session/event、agent/* 单 payload、agents.create/setup、tools.restrict）。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

// dsh 会话日志按 flush 追加 zstd 帧（多帧拼接），zstdDecompressSync 只解第一帧，需逐帧解码
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
      // 压缩数据里可能出现伪魔数：跳过这个切分点继续找（末尾仍失败则整体报错）
      if (idx === -1) throw new Error('会话 zstd 数据无法解码')
    }
    if (idx === -1) return Buffer.concat(parts).toString('utf8')
    start = idx
    idx = buf.indexOf(magic, idx + 1)
  }
}
import { dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  GAME_PRESETS,
  type OrchestratorConfig,
  type RoleConfig,
  type RolePreset,
} from './game-presets.js'
import type { PanelCommand, PanelEvent, PanelEventType } from './panel-event.js'
import { createSseHub, isLocalOrigin, readBody } from './server/http-shell.js'

export { GAME_PRESETS }

export const name = 'dsh-panel-bridge'
export const inject = ['agents', 'sessions', 'agentDefaultModel'] // 部署默认路由（角色未显式配置 provider/model 时继承）

export interface Config {
  port?: number // 默认 3180，只监听 127.0.0.1
  token?: string // 固定 token：供 hub 等本机服务接入 /command 与 /events；省略时每次启动随机生成
  roles?: Record<string, RoleConfig> // 角色 → 模型；配置 preset 后此项作为对预置角色的覆盖
  preset?: string // 启动时激活的预设（'client' | 'server' 或本地自定义预设名），见 GAME_PRESETS
  presetsFile?: string // 预设覆盖与激活状态的持久化文件；默认 ~/.synapse-agent-panel/presets.json
  orchestrator?: OrchestratorConfig // 编排模式：派发到 master 的任务按 pipeline 自动流转
  stateFile?: string // role→session 映射的持久化文件；默认 ~/.synapse-agent-panel/panel-state.json
  sessionsDir?: string // dsh 会话日志目录；默认 $DSH_HOME/sessions（~/.dsh/sessions），历史对话从这里解析
  debug?: boolean // 打印请求/指令处理日志，默认 true
  logFile?: string // 日志落盘路径；默认 ~/.synapse-agent-panel/panel.log，'' 或 'off' 关闭
}

// 运行时配置 schema：dsh 激活插件前用它校验/补默认值，插件管理和 Config Editor 也据此生成 JSON Schema
export const Config: Schema<Config> = Schema.object({
  port: Schema.natural().default(3180).description('面板 HTTP 端口（仅监听 127.0.0.1）'),
  token: Schema.string().description(
    '固定 token（供 hub 等本机服务接入 /command 与 /events）；省略时每次启动随机生成，从启动日志/panel.log 查',
  ),
  preset: Schema.string().description(
    "启动时激活的预设名（内置 'client'/'server' 或本地预设）；持久化的激活状态优先",
  ),
  presetsFile: Schema.string().description(
    '预设覆盖与激活状态的持久化 JSON 路径；默认 ~/.synapse-agent-panel/presets.json',
  ),
  roles: Schema.dict(
    Schema.object({
      provider: Schema.string().description(
        '模型 provider；省略时继承部署默认路由（如 deepseek-account）',
      ),
      model: Schema.string().description('模型 id；省略时同上（如 deepseek-flash）'),
      label: Schema.string().description('界面显示名'),
      prompt: Schema.string().description(
        '角色 persona 提示词（注入该 agent 的 systemPrompt section）',
      ),
      toolsRestrict: Schema.object({
        allow: Schema.array(Schema.string()).description('只保留这些全局工具'),
        deny: Schema.array(Schema.string()).description('屏蔽这些全局工具（如评审只读）'),
      }).description('该 agent 的工具白/黑名单，经 agentCtx.tools.restrict() 生效'),
    }),
  ).description('角色 → 配置；配置 preset 时作为预置角色的覆盖'),
  orchestrator: Schema.object({
    master: Schema.string().default('master').description('触发编排的角色名'),
    pipeline: Schema.union([Schema.array(Schema.string()), Schema.const(undefined)]).description(
      '顺序执行的角色列表；省略时用预设流水线',
    ),
  }).description('编排配置：派发到 master 的任务按 pipeline 顺序执行'),
  debug: Schema.boolean().default(true).description('打印请求/指令处理日志'),
  logFile: Schema.string().description(
    "日志落盘路径；默认 ~/.synapse-agent-panel/panel.log（桌面版没有终端时可从这里查）。设为 '' 或 'off' 关闭",
  ),
  stateFile: Schema.string().description(
    'role→session 映射持久化路径；默认 ~/.synapse-agent-panel/panel-state.json，重启后按它恢复面板 agent 会话',
  ),
  sessionsDir: Schema.string().description(
    'dsh 会话日志目录（JSONL）；默认 $DSH_HOME/sessions 或 ~/.dsh/sessions，历史对话视图从这里解析',
  ),
})

// ---------- 预设的动态修改与本地持久化 ----------
// 内置 GAME_PRESETS 只读；本地覆盖与激活状态存 JSON 文件，通过 /presets API 修改，重启后仍生效。
// 同名覆盖与内置预设按角色合并（本地优先），pipeline 用本地版或内置版。
export interface PresetState {
  active: string // 持久化的激活预设名（空 = 未选择，用手工 roles）
  presets: Record<string, RolePreset> // 本地自定义/覆盖的预设
}

function loadPresetState(file: string): PresetState {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PresetState>
    return { active: raw.active ?? '', presets: raw.presets ?? {} }
  } catch {
    return { active: '', presets: {} }
  }
}

function savePresetState(file: string, state: PresetState): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

export function apply(ctx: Context, config: Config = {}) {
  const port = config.port ?? 3180
  const token = config.token || randomBytes(16).toString('hex') // 防止任意网页向本地端口发指令

  // 日志：桌面版 dsh 由 Finder 启动，宿主子进程 stdout 是 /dev/null，console 输出看不到；
  // 因此除 console 外再落盘一份，地址/token/派发细节都能在文件里翻。logFile: '' / 'off' 关闭。
  const logPath = (() => {
    const raw = config.logFile ?? join(homedir(), '.synapse-agent-panel', 'panel.log')
    if (!raw || raw === 'off') return ''
    return raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw
  })()
  const fmtArg = (v: unknown): string => {
    if (typeof v === 'string') return v
    if (v instanceof Error) return v.stack ?? v.message
    try {
      return JSON.stringify(v) ?? String(v)
    } catch {
      return String(v)
    }
  }
  // 本地时区时间戳：panel.log 与 /logs 视图统一用它（ISO UTC 在日志里不好对照）
  const localStamp = (): string => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  const logTail: string[] = [] // 环形缓冲：供 /logs 在界面查看（panel.log 的内存镜像）
  const appendLog = (level: string, args: unknown[]): void => {
    const line = `${localStamp().slice(11)} ${level} ${args.map(fmtArg).join(' ')}`
    logTail.push(line)
    if (logTail.length > 800) logTail.shift()
    if (!logPath) return
    try {
      appendFileSync(
        logPath,
        `${localStamp()} ${level} [${name}] ${args.map(fmtArg).join(' ')}\n`,
      )
    } catch {
      /* 落盘失败不能影响插件本身 */
    }
  }
  const log = (...a: unknown[]): void => {
    console.log(`[${name}]`, ...a)
    appendLog('INFO', a)
  }
  const logError = (...a: unknown[]): void => {
    console.error(`[${name}]`, ...a)
    appendLog('ERROR', a)
  }
  const dbg = (...a: unknown[]): void => {
    if (config.debug ?? true) log(...a)
  }
  if (logPath) {
    try {
      mkdirSync(dirname(logPath), { recursive: true })
      // 超过 1MB 就轮转一次，避免长期运行无限增长
      if (statSync(logPath).size > 1_000_000) renameSync(logPath, `${logPath}.1`)
    } catch {
      /* 首次运行（文件不存在）或目录不可写：跳过，后续 append 失败也会被吞掉 */
    }
  }

  // ---------- 预设解析：内置 + 本地持久化覆盖 ----------
  const presetsFile = config.presetsFile ?? join(homedir(), '.synapse-agent-panel', 'presets.json')
  const presetState = loadPresetState(presetsFile)
  const isKnownPreset = (n: string): boolean =>
    Boolean(n && (GAME_PRESETS[n] || presetState.presets[n]))
  // 优先级：界面激活过的预设（持久化）> 启动配置 preset > 无（手工 roles）。
  // 持久化的 active 可能指向已被删除的本地预设：回退到启动配置，不让插件加载失败。
  if (presetState.active && !isKnownPreset(presetState.active)) {
    logError(`持久化的激活预设 ${presetState.active} 已不存在，回退到启动配置`)
    presetState.active = ''
  }
  if (config.preset && !isKnownPreset(config.preset))
    throw new Error(
      `未知预设：${config.preset}（可选：${Object.keys(GAME_PRESETS).join(' / ')}，或先通过 /presets API 创建）`,
    )
  let activePreset = presetState.active || config.preset || ''

  // 某个名字的生效预设：本地覆盖与内置按角色合并（本地优先）
  const presetNow = (presetName?: string): RolePreset | undefined => {
    const n = presetName ?? activePreset
    if (!n) return undefined
    const builtin = GAME_PRESETS[n]
    const local = presetState.presets[n]
    if (!builtin && !local) return undefined
    return {
      roles: { ...builtin?.roles, ...local?.roles },
      pipeline: local?.pipeline ?? builtin?.pipeline ?? [],
    }
  }
  const rolesNow = (): Record<string, RoleConfig> => ({ ...presetNow()?.roles, ...config.roles })
  const pipelineNow = (): string[] => {
    const explicit = config.orchestrator?.pipeline
    // 空数组视为未配置：显式 pipeline 优先，否则用预设流水线
    return explicit && explicit.length > 0 ? explicit : (presetNow()?.pipeline ?? [])
  }

  function setActivePreset(presetName: string): void {
    if (!isKnownPreset(presetName)) throw new Error(`未知预设：${presetName}`)
    activePreset = presetName
    presetState.active = presetName
    savePresetState(presetsFile, presetState)
    dbg(`激活预设 → ${presetName}（已持久化到 ${presetsFile}）`)
  }

  const roleOf = new Map<string, string>() // agentId → 角色
  const handleOf = new Map<string, any>() // 角色 → AgentHandle（只有创建者能 dispose）
  const taskOfMessage = new Map<string, string>() // messageId → taskId
  const taskOfTurn = new Map<string, string>() // `${agentId}:${turn}` → taskId

  // ---------- 编排：派发到 master 的任务按 pipeline 顺序流转，上游 turn 产出作为反馈传给下游 ----------
  const orch = { master: config.orchestrator?.master ?? 'master' }

  // ---------- 事件输出 ----------
  // agents 服务由 dsh 运行时注入，类型包里未导出对应声明，这里按 any 取用
  const agents = (ctx as any).agents
  const parentOf = (id: string): string | undefined => {
    try {
      for (const p of agents.list?.() ?? []) {
        // isOwnedBy(id, owner) 的 owner 是 Agent 对象（store.get(id)?.owner === owner）
        if (String(p.id) !== id && agents.isOwnedBy(id, p)) return String(p.id)
      }
    } catch {
      /* 取不到父子关系时留空 */
    }
  }

  // 根 agent（真实 dsh 里通常是 main）在面板上显示为 orchestrator.master，与派发口径一致
  const rootIdOf = (): string => {
    try {
      return String(agents.roots?.()[0]?.id ?? '')
    } catch {
      return ''
    }
  }

  // SSE 广播与 backlog 回放由共享 HTTP 壳提供
  const hub = createSseHub()
  // 心跳：保持 SSE 连接（浏览器/代理不会因长时间无数据断开）
  const heartbeat = setInterval(() => hub.broadcast(':\n\n'), 15000)
  heartbeat.unref?.()

  const emit = (type: PanelEventType, agentId: string, pl: Record<string, unknown> = {}) => {
    const e: PanelEvent = {
      type,
      t: Date.now(),
      pl,
      agent: {
        id: agentId,
        role: roleOf.get(agentId) ?? (agentId === rootIdOf() ? orch.master : undefined),
        parentId: parentOf(agentId),
        harness: 'dsh',
      },
    }
    hub.push(e)
  }

  // 文字增量先合并，每 150ms 发一次，避免刷屏
  const buf = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    for (const [id, text] of buf) emit('output', id, { text })
    buf.clear()
    timer = undefined
  }

  const describe = (tool: string, args: string): string => {
    try {
      const a = JSON.parse(args)
      const target = a.path ?? a.file_path ?? a.command ?? a.url ?? ''
      return `${tool} ${String(target)}`.slice(0, 80)
    } catch {
      return tool
    }
  }

  // TurnEndReason = { kind: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted' | 'forked' }
  const statusOf = (reason: unknown): 'ok' | 'failed' | 'cancelled' => {
    const kind =
      typeof reason === 'object' && reason !== null
        ? String((reason as any).kind)
        : String(reason ?? '')
    if (/cancel|abort|interrupt/i.test(kind)) return 'cancelled'
    if (/error|block|max-tokens/i.test(kind)) return 'failed' // max-tokens 不是正常结束
    return 'ok'
  }

  // ---------- 观测：dsh 事件 → 面板事件 ----------
  // agent 与 session 同一个 identity，所以 session.id 即 agentId
  ctx.on('session/event', (session: any, event: any) => {
    const id = String(session.id)
    const d = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        turnText.set(id, '') // 开始收集本轮产出（作为编排反馈）
        emit('turn.started', id, { turn: d.turn })
        break
      case 'step/start':
        emit('step.started', id, { turn: d.turn, step: d.step })
        break
      case 'assistant/message':
        // 兜底：实时流（agent/assistant-stream）没捕获到时，用落盘消息补齐编排反馈
        if (!turnText.get(id)) {
          const text = Array.isArray(d.message?.content)
            ? d.message.content
                .filter((p: any) => p?.type === 'text')
                .map((p: any) => p.text)
                .join('')
            : ''
          if (text) turnText.set(id, text.slice(-2000))
        }
        break
      case 'tool/call':
        emit('tool.started', id, {
          turn: d.turn,
          step: d.step,
          callId: d.callId,
          name: d.name,
          action: describe(d.name, d.arguments),
        })
        break
      case 'tool/result':
        emit('tool.finished', id, { turn: d.turn, callId: d.callId, ok: !d.error })
        break
      case 'turn/end': {
        flush()
        const result = turnText.get(id) ?? ''
        turnText.delete(id)
        const status = statusOf(d.reason)
        const reasonKind =
          typeof d.reason === 'object' && d.reason !== null
            ? String((d.reason as any).kind ?? '')
            : String(d.reason ?? '')
        const turnKey = `${id}:${d.turn}`
        const taskId = taskOfTurn.get(turnKey)
        if (taskId) taskOfTurn.delete(turnKey)
        if (status !== 'ok')
          logError(
            `turn 失败 agent=${id} turn=${d.turn} reasonKind=${reasonKind}` +
              (taskId ? ` taskId=${taskId}` : '') +
              (d.reason?.error?.message ? ` error=${String(d.reason.error.message)}` : ''),
          )
        emit('turn.ended', id, {
          turn: d.turn,
          reason: d.reason,
          reasonKind,
          status,
          taskId,
        })
        // 编排：本 agent 属于某个流水线且本轮结束 → 收集反馈并推进
        const wfId = wfOfAgent.get(id)
        if (wfId) {
          wfOfAgent.delete(id)
          void advanceWorkflow(wfId, id, status, result)
        }
        break
      }
    }
  })

  // agent/* 事件是单 payload（agentEvents 已把 agent 融合进 payload），不是 (agent, payload) 两参数
  ctx.on('agent/assistant-stream' as any, (p: any) => {
    const frame = p.frame
    if (frame?.type !== 'chunk') return
    const chunk = frame.chunk
    // 只取正文 text-delta；reasoning-delta 等不进面板输出与编排反馈
    const text = chunk?.type === 'text-delta' ? chunk.text : (frame.text ?? frame.delta ?? '')
    if (!text) return
    const id = String(p.agent.id)
    buf.set(id, (buf.get(id) ?? '') + text)
    turnText.set(id, (turnText.get(id) ?? '') + text)
    timer ??= setTimeout(flush, 150)
  })

  ctx.on('agent/created' as any, (p: any) => emit('agent.registered', String(p.agent.id)))
  ctx.on('agent/status' as any, (p: any) =>
    emit('agent.status', String(p.agent.id), { status: p.status }),
  )
  ctx.on('agent/disposed' as any, (p: any) => {
    const id = String(p.agent.id)
    roleOf.delete(id)
    turnText.delete(id)
    buf.delete(id)
    for (const [role, handle] of handleOf)
      if (String(handle.__agentId ?? '') === id) handleOf.delete(role)
    emit('agent.ended', id)
  })
  // 用 inbox 通知把「消息」和「turn」关联起来，从而把 turn 结束对应回 taskId
  ctx.on('agent/inbox/claimed' as any, (p: any) => {
    const agentId = String(p.agent.id)
    const messageId = String(p.message?.id ?? '')
    const taskId = messageId ? taskOfMessage.get(messageId) : undefined
    if (!taskId) return
    taskOfMessage.delete(messageId)
    taskOfTurn.set(`${agentId}:${p.turn}`, taskId)
    emit('task.claimed', agentId, { taskId, turn: p.turn })
  })

  // ---------- 历史对话：从 dsh 会话日志（JSONL）解析，供面板「历史」视图 ----------
  const sessionsDir = (() => {
    if (config.sessionsDir) return config.sessionsDir
    const home = process.env.DSH_HOME?.replace(/^~/, homedir()) ?? join(homedir(), '.dsh')
    return join(home, 'sessions')
  })()

  // ---------- 会话持久化：role→session 映射落盘，重启后 resume 而不是开新会话 ----------
  const stateFile = config.stateFile ?? join(homedir(), '.synapse-agent-panel', 'panel-state.json')
  const agentSessions = (() => {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as {
        sessions?: Record<string, string>
      }
      return raw.sessions ?? {}
    } catch {
      return {}
    }
  })()
  const persistSession = (role: string, sessionId: string): void => {
    agentSessions[role] = sessionId
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify({ sessions: agentSessions }, null, 2)}\n`)
    } catch (err) {
      logError('会话映射持久化失败：', err)
    }
  }

  // ---------- 指令：面板指令 → dsh Agent API ----------
  // 部署默认路由：agentDefaultModel 服务的 currentSelection()（已声明 inject，经 ctx 属性访问，
  // 与 dsh-headless 的用法一致）。取不到/抛错都记日志，路由缺失时 setup 跳过固定、保持原 selection。
  const deploymentRoute = (): { provider?: string; model?: string } | undefined => {
    const svc = (ctx as any).agentDefaultModel ?? (ctx as any).reflect?.get?.('agentDefaultModel')
    if (!svc) {
      dbg('agentDefaultModel 服务不可用（inject 未解析）')
      return undefined
    }
    try {
      const sel = svc.currentSelection?.()
      dbg(`agentDefaultModel → ${sel?.provider}/${sel?.model}`)
      return sel?.provider && sel?.model ? sel : undefined
    } catch (err) {
      dbg(`agentDefaultModel.currentSelection 失败：${String(err)}`)
      return undefined
    }
  }

  async function ensure(role: string): Promise<{ handle: any; agentId: string }> {
    const existing = handleOf.get(role)
    if (existing) return { handle: existing, agentId: existing.__agentId }
    const rc = rolesNow()[role]
    if (!rc) throw new Error(`未配置的角色：${role}`)
    const agentOptions = {
      ...(rc.provider ? { provider: rc.provider } : {}),
      ...(rc.model ? { model: rc.model } : {}),
    }
    // 显式路由：角色未配 provider/model 时取部署默认（agentDefaultModel 服务），不交空 agentOptions。
    // 新建会话没有 recorded selection，空 options 会在 turn 期落到不可用的默认提案（如 provider "deepseek"）。
    if (!agentOptions.provider || !agentOptions.model) {
      const def = deploymentRoute()
      if (def?.provider && def?.model) {
        if (!agentOptions.provider) agentOptions.provider = def.provider
        if (!agentOptions.model) agentOptions.model = def.model
        dbg(`角色 ${role} 继承部署默认路由 ${def.provider}/${def.model}`)
      }
    }
    // 角色级 setup：路由固定 + 提示词 persona section + 可选的工具白/黑名单（resume 与 create 都接受）。
    // 真机 dsh 不自动应用 agentOptions 路由（尤其 resume 会沿用会话里记录的旧 selection），
    // 与 dsh-agent-loop 的 applyConfiguredRoute 对齐：setup 里用 agent.model.select 显式固定。
    const hasRoute = Boolean(agentOptions.provider && agentOptions.model)
    const setup =
      rc.prompt || rc.toolsRestrict || hasRoute
        ? (agentCtx: any, agent: any) => {
            if (hasRoute && agent?.model?.select) {
              try {
                agent.model.select({ provider: agentOptions.provider, model: agentOptions.model })
              } catch (err) {
                logError(`角色 ${role} 的路由固定失败（${agentOptions.provider}/${agentOptions.model}）：`, err)
              }
            }
            if (rc.prompt)
              agentCtx.systemPrompt.section({
                name: `panel:role-${role}`,
                order: 0, // persona 槽位：模型最先读到
                text: rc.prompt,
              })
            if (rc.toolsRestrict) {
              try {
                agentCtx.tools.restrict(rc.toolsRestrict)
              } catch (err) {
                // 工具名写错时 restrict 会抛错：只记日志，不影响该 agent 正常创建
                logError(`角色 ${role} 的 toolsRestrict 应用失败：`, err)
              }
            }
            dbg(
              `已配置角色 ${role}（prompt=${Boolean(rc.prompt)}，toolsRestrict=${Boolean(rc.toolsRestrict)}）`,
            )
          }
        : undefined

    // 已有持久化 session → 优先 resume（真机签名 agents.resume(options)，ownerCtx 由服务内部持有；
    // 想把角色绑定到任意已有 dsh 会话：手动编辑 panel-state.json 的 sessions 映射指向该 session id 即可）。
    const known = agentSessions[role]
    if (known) {
      try {
        const handle = await agents.resume({
          resumeSessionId: SessionId(known),
          agentOptions,
          setup,
        })
        handle.__agentId = known
        roleOf.set(known, role)
        handleOf.set(role, handle)
        persistSession(role, known) // resume 成功也落盘，之后按角色自身的映射 resume
        dbg(`已恢复角色 ${role} 的会话 ${known}`)
        return { handle, agentId: known }
      } catch (err) {
        logError(`恢复角色 ${role} 的会话 ${known} 失败，回退新建：`, err)
        delete agentSessions[role]
      }
    }

    const sessionId = SessionId(`panel-${role}-${Date.now()}`)
    const master = agents.roots?.()[0] // roots() 返回 Agent[]
    const handle = await agents.create({
      sessionId,
      // provider/model 省略时继承部署默认路由；显式配置则覆盖
      agentOptions: {
        ...(rc.provider ? { provider: rc.provider } : {}),
        ...(rc.model ? { model: rc.model } : {}),
      },
      parentAgent: master, // 设置后该 agent 成为运行时子 agent
      ...(setup ? { setup } : {}),
    })
    handle.__agentId = String(sessionId)
    roleOf.set(String(sessionId), role)
    handleOf.set(role, handle)
    persistSession(role, String(sessionId))
    return { handle, agentId: String(sessionId) }
  }

  // pipeline 动态解析：显式配置 > 当前激活预设（可在运行中经 /preset/active 切换）
  interface Workflow {
    id: string
    steps: string[]
    i: number
    task: string
    lastResult: string
  }
  const workflows = new Map<string, Workflow>()
  const wfOfAgent = new Map<string, string>() // agentId → 正在执行的 workflow id
  const turnText = new Map<string, string>() // agentId → 当前 turn 的输出累积（作为反馈）

  function composeStepText(wf: Workflow): string {
    // 角色提示词已通过 setup/systemPrompt 注入，这里只传任务与上游产出
    const parts = [`总体任务：${wf.task}`]
    if (wf.lastResult) parts.push(`【上游产出】\n${wf.lastResult.slice(-2000)}`)
    return parts.join('\n\n')
  }

  // 某个 workflow 结束时清掉它留下的 agent → workflow 映射
  function clearWorkflowAgents(wfId: string): void {
    for (const [agentId, id] of wfOfAgent) if (id === wfId) wfOfAgent.delete(agentId)
  }

  async function sendToRole(role: string, text: string, taskId?: string): Promise<void> {
    const { handle, agentId } = await ensure(role)
    if (taskId) wfOfAgent.set(agentId, taskId)
    const msg = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    if (taskId) taskOfMessage.set(String(msg.id), taskId)
    handle.agent.followup(msg)
    dbg(`已派发 → ${role}（${taskId ?? '无 taskId'}，agentId=${agentId}）`)
  }

  async function startWorkflow(taskId: string, task: string): Promise<void> {
    // 单条流水线按角色复用 agent，多 workflow 并发会互相覆盖 wfOfAgent；这里直接拒绝并发
    if (workflows.size > 0) throw new Error('已有流水线正在执行，请等待完成或先中断当前任务')
    const steps = pipelineNow()
    if (steps.length === 0)
      throw new Error('未配置流水线：请设置 orchestrator.pipeline 或激活一个预设')
    const id = taskId || `wf-${Date.now()}`
    dbg(`编排开始 ${id}：${steps.join(' → ')}`)
    const wf: Workflow = { id, steps, i: 0, task, lastResult: '' }
    workflows.set(id, wf)
    try {
      await sendToRole(steps[0]!, composeStepText(wf), id)
    } catch (err) {
      workflows.delete(id)
      clearWorkflowAgents(id)
      throw err
    }
  }

  // 收集到某步的反馈后推进流水线；失败/取消则中止
  async function advanceWorkflow(
    wfId: string,
    agentId: string,
    status: 'ok' | 'failed' | 'cancelled',
    result: string,
  ) {
    const wf = workflows.get(wfId)
    if (!wf) return
    if (status !== 'ok') {
      logError(`编排中止 ${wfId}：step=${wf.steps[wf.i]} status=${status}`)
      workflows.delete(wfId)
      clearWorkflowAgents(wfId)
      emit('workflow.done', agentId, { taskId: wfId, status: 'failed', step: wf.steps[wf.i] })
      return
    }
    wf.lastResult = result
    wf.i++
    if (wf.i >= wf.steps.length) {
      workflows.delete(wfId)
      clearWorkflowAgents(wfId)
      dbg(`编排完成 ${wfId}`)
      emit('workflow.done', agentId, { taskId: wfId, status: 'done', steps: wf.steps.join(' → ') })
      return
    }
    const next = wf.steps[wf.i]!
    dbg(`编排推进 ${wfId}：${wf.steps[wf.i - 1]} → ${next}（反馈 ${result.length} 字）`)
    try {
      await sendToRole(next, composeStepText(wf), wfId)
    } catch (err) {
      logError(`编排推进失败（→ ${next}）：`, err)
      workflows.delete(wfId)
      clearWorkflowAgents(wfId)
      emit('workflow.done', agentId, { taskId: wfId, status: 'failed', step: next })
    }
  }

  async function dispatch(cmd: PanelCommand) {
    // 编排模式：派发到 master 的任务不创建 master agent，直接进入流水线
    if (pipelineNow().length > 0 && cmd.to === orch.master && cmd.type === 'task.assigned') {
      await startWorkflow(cmd.taskId ?? '', cmd.text ?? '')
      return
    }
    dbg(
      `指令 ← ${cmd.type} → ${cmd.to}${cmd.taskId ? `（task ${cmd.taskId}）` : ''}${cmd.text ? `：“${String(cmd.text).slice(0, 40)}”` : ''}`,
    )
    try {
      // 直发：目标已是存在的 dsh 会话/agent（agents.list() 里找得到，如用户新开的会话）→ 直接操作
      const live = agents.list?.().find((a: any) => String(a.id) === cmd.to)
      if (live) {
        const callOn = (method: string, ...args: any[]) => {
          const host = typeof live[method] === 'function' ? live : live.agent
          if (!host || typeof host[method] !== 'function')
            throw new Error(`agent 对象缺少 ${method} 方法`)
          return host[method](...args)
        }
        if (cmd.type === 'task.cancel') {
          await callOn('cancel', { kind: 'user' })
          dbg(`已直发 cancel → ${cmd.to}`)
          return
        }
        const msg = createUserMessage({
          content: [{ type: 'text', text: cmd.text ?? '' }],
          source: { kind: 'user' },
        })
        callOn(cmd.type === 'task.rejected' ? 'steer' : 'followup', msg)
        dbg(`已直发 ${cmd.type} → ${cmd.to}`)
        return
      }
      if (cmd.type === 'task.cancel') {
        // 中断只作用于已创建的 agent：不存在时直接报错，不为了取消而新建一个 agent
        const handle = handleOf.get(cmd.to)
        if (!handle) throw new Error(`角色 ${cmd.to} 尚未创建，无需中断`)
        await handle.agent.cancel({ kind: 'user' })
        dbg(`已取消 ${cmd.to} 的当前任务`)
        return
      }
      const { handle } = await ensure(cmd.to)
      const agent = handle.agent
      const msg = createUserMessage({
        content: [{ type: 'text', text: cmd.text ?? '' }], // 角色提示词已通过 setup/systemPrompt 注入
        // 面板指令按用户输入进入对话（MessageSource 合法集合里 user 是唯一合适的来源）
        source: { kind: 'user' },
      })
      if (cmd.taskId) taskOfMessage.set(String(msg.id), cmd.taskId)
      if (cmd.type === 'task.rejected')
        agent.steer(msg) // 下一 step 输入；agent 已空闲时由 loop 在下一边界唤醒
      else agent.followup(msg) // task.assigned / review.requested：下一轮提示
      dbg(`已投递给 ${cmd.to}（${cmd.type === 'task.rejected' ? 'steer' : 'followup'}）`)
    } catch (err) {
      logError(`指令处理失败（${cmd.type} → ${cmd.to}）：`, err)
      throw err
    }
  }

  // ---------- 本地 HTTP：API + SSE 事件流 + 指令入口（无头：不伺服面板页面） ----------
  // 面板由 hub（:3182）伺服；本服务的 /events、/command、/history、/role-session 等接口
  // 供 hub 代理与面板"后端切换"直连使用。壳设施（SSE/请求体）来自共享模块 src/server/。
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const origin = req.headers.origin
    // 允许本机其他端口的面板（如 hub :3182 连插件 :3180）跨源访问
    if (origin && isLocalOrigin(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-allow-headers', 'content-type, x-panel-token')
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    if (origin && !isLocalOrigin(origin)) {
      dbg(`拒绝跨源请求 ${req.method} ${url.pathname} origin=${origin}`)
      res.writeHead(403).end()
      return
    }
    // 根路径：无头服务提示（面板在 hub 上）
    if (req.method === 'GET' && url.pathname === '/') {
      res
        .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end('dsh-panel-bridge API（无头服务）。面板请使用 hub（默认 :3182），或经面板"后端切换"直连本地址。')
      return
    }
    if (
      req.method === 'GET' &&
      url.pathname === '/events' &&
      url.searchParams.get('token') === token
    ) {
      dbg(`面板已连接 ${url.pathname}（当前客户端 ${hub.clients.size + 1}）`)
      hub.attach(req, res)
      req.on('close', () => dbg(`面板断开（剩余 ${hub.clients.size}）`))
      return
    }
    if (
      req.method === 'POST' &&
      url.pathname === '/command' &&
      req.headers['x-panel-token'] === token
    ) {
      const body = await readBody(req, 65536)
      try {
        await dispatch(JSON.parse(body) as PanelCommand)
        res.writeHead(204).end()
      } catch (err) {
        res.writeHead(400).end(String(err))
      }
      return
    }

    // 校验预设结构：roles 每项要有 provider/model，pipeline 非空且每个角色都已定义
    function validatePreset(p: unknown): RolePreset {
      const { roles, pipeline } = (p ?? {}) as Partial<RolePreset>
      if (!roles || typeof roles !== 'object' || !Array.isArray(pipeline) || pipeline.length === 0)
        throw new Error(
          '预设需要 { roles: Record<name, { provider, model, prompt? }>, pipeline: string[] }',
        )
      for (const [k, v] of Object.entries(roles)) {
        if (!v || (v.provider !== undefined && typeof v.provider !== 'string'))
          throw new Error(`角色 ${k} 的 provider 需为字符串（或省略以继承默认路由）`)
        if (v.model !== undefined && typeof v.model !== 'string')
          throw new Error(`角色 ${k} 的 model 需为字符串（或省略以继承默认路由）`)
        if (v.toolsRestrict !== undefined) {
          const tr = v.toolsRestrict
          const okArray = (x: unknown): x is string[] =>
            Array.isArray(x) && x.every((n) => typeof n === 'string')
          if (
            typeof tr !== 'object' ||
            tr === null ||
            (!okArray(tr.allow) && tr.allow !== undefined) ||
            (!okArray(tr.deny) && tr.deny !== undefined)
          )
            throw new Error(`角色 ${k} 的 toolsRestrict 需要 { allow?: string[], deny?: string[] }`)
        }
      }
      for (const step of pipeline)
        if (!roles[step]) throw new Error(`pipeline 引用了未定义的角色：${step}`)
      return { roles, pipeline }
    }

    // ---------- 预设管理 API（与 /command 同样受 token 保护） ----------
    const handlePresets = async (
      req: ServerResponse['req'],
      res: ServerResponse,
      url: URL,
    ): Promise<boolean> => {
      // 激活切换：POST /preset/active { name }
      if (url.pathname === '/preset/active') {
        if (req.method !== 'POST') return false
        try {
          const { name } = JSON.parse(await readBody(req)) as { name?: string }
          setActivePreset(String(name ?? ''))
          res.writeHead(204).end()
        } catch (err) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
        }
        return true
      }

      const rest = url.pathname === '/presets' ? '' : url.pathname.match(/^\/presets\/(.+)$/)?.[1]
      if (rest === undefined) return false
      let presetName = ''
      try {
        presetName = rest ? decodeURIComponent(rest) : ''
      } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('预设名编码非法')
        return true
      }

      if (req.method === 'GET') {
        // 全量视图：内置 + 本地覆盖（合并后的生效形态）+ 激活状态
        const all: Record<string, unknown> = {}
        for (const n of Object.keys({ ...GAME_PRESETS, ...presetState.presets })) {
          const p = presetNow(n)
          if (p)
            all[n] = {
              ...p,
              builtin: Boolean(GAME_PRESETS[n]),
              overridden: Boolean(presetState.presets[n]),
            }
        }
        res
          .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ active: activePreset, file: presetsFile, presets: all }))
        return true
      }

      if (req.method === 'PUT' && presetName) {
        try {
          const p = validatePreset(JSON.parse(await readBody(req)))
          presetState.presets[presetName] = p
          savePresetState(presetsFile, presetState)
          dbg(`预设 ${presetName} 已保存（本地覆盖）`)
          res.writeHead(204).end()
        } catch (err) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
        }
        return true
      }

      if (req.method === 'DELETE' && presetName) {
        // 内置预设不支持删除，但支持“恢复默认值”：DELETE = 移除它的本地覆盖
        if (GAME_PRESETS[presetName] && !presetState.presets[presetName]) {
          res
            .writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
            .end('内置预设无本地覆盖，无需恢复默认；可用 PUT 覆盖其角色与流水线')
          return true
        }
        delete presetState.presets[presetName]
        // 删除的是当前激活的本地预设：清掉持久化的 active，回退到启动配置（避免重启后加载失败）
        if (!GAME_PRESETS[presetName] && activePreset === presetName) {
          activePreset = config.preset && isKnownPreset(config.preset) ? config.preset : ''
          presetState.active = activePreset
          dbg(`激活预设 ${presetName} 已删除，回退到 ${activePreset || '（无预设）'}`)
        }
        savePresetState(presetsFile, presetState)
        dbg(
          GAME_PRESETS[presetName] ? `预设 ${presetName} 已恢复默认` : `预设 ${presetName} 已删除`,
        )
        res.writeHead(204).end()
        return true
      }
      return false
    }

    // 预设管理 API：与 /command 同级保护（token 校验）
    if (
      url.pathname.startsWith('/presets') ||
      url.pathname === '/preset/active' ||
      url.pathname.startsWith('/role-session/') ||
      url.pathname === '/logs' ||
      url.pathname === '/history' ||
      url.pathname === '/history/sessions'
    ) {
      if (req.headers['x-panel-token'] !== token) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('token 校验失败')
        return
      }
      // 解绑角色会话：dispose 当前 handle + 清 panel-state 映射，下次派发自动新建干净会话
      // （会话被 blocked 等异常状态污染时的自救入口，历史对话数据仍保留在 dsh 会话目录）
      if (req.method === 'DELETE' && url.pathname.startsWith('/role-session/')) {
        const role = decodeURIComponent(url.pathname.slice('/role-session/'.length))
        if (!role) {
          res.writeHead(400).end()
          return
        }
        const handle = handleOf.get(role)
        if (handle) {
          handleOf.delete(role)
          void handle.dispose().catch((err: unknown) => logError(`释放角色 ${role} 的 agent 失败：`, err))
        }
        if (agentSessions[role]) {
          delete agentSessions[role]
          try {
            mkdirSync(dirname(stateFile), { recursive: true })
            writeFileSync(stateFile, `${JSON.stringify({ sessions: agentSessions }, null, 2)}\n`)
          } catch (err) {
            logError('会话映射持久化失败：', err)
          }
        }
        dbg(`角色 ${role} 的会话绑定已解除（下次派发新建会话）`)
        res.writeHead(204).end()
        return
      }
      if (await handlePresets(req, res, url)) return
      if (req.method === 'GET' && url.pathname === '/history/sessions') {
        // 列出可查看的历史会话：递归扫描（真实 dsh 按工作区分子目录），id 为相对路径
        try {
          const base = resolve(sessionsDir)
          const list: Array<{ id: string; mtime: number; size: number }> = []
          const walk = (dir: string): void => {
            for (const e of readdirSync(dir, { withFileTypes: true })) {
              const full = join(dir, e.name)
              if (e.isDirectory()) walk(full)
              else if (e.name.endsWith('.jsonl') || e.name.endsWith('.jsonl.zstd')) {
                const st = statSync(full)
                // 真实 dsh 的会话是 zstd 压缩的 session.v4.jsonl.zstd；id 不含扩展名，两条路径都收
                const id = full.slice(base.length + 1, e.name.endsWith('.zstd') ? -11 : -6)
                list.push({ id, mtime: st.mtimeMs, size: st.size })
              }
            }
          }
          walk(base)
          list.sort((a, b) => b.mtime - a.mtime)
          res
            .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ dir: base, sessions: list }))
        } catch (err) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`会话目录不可读：${String(err)}`)
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/history') {
        const sid = url.searchParams.get('session') ?? rootIdOf()
        if (!sid || sid.includes('..')) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('非法 session id')
          return
        }
        try {
          const base = resolve(sessionsDir)
          // sid 可含子目录（相对路径）；真实 dsh 会话是 zstd 压缩的 .jsonl.zstd，解压后解析
          const file = [`${sid}.jsonl`, `${sid}.jsonl.zstd`]
            .map((f) => resolve(base, f))
            .find((f) => existsSync(f))
          if (!file || !file.startsWith(base + sep)) throw new Error('会话日志不存在')
          const raw = file.endsWith('.zstd') ? zstdDecodeAll(readFileSync(file)) : readFileSync(file, 'utf8')
          // 事件溯源 JSONL → 对话序列；字段名按 0.2.2-rc.1 类型，未知事件跳过
          const textOf = (content: any): string =>
            Array.isArray(content)
              ? content
                  .filter((p: any) => p?.type === 'text')
                  .map((p: any) => String(p.text ?? ''))
                  .join('')
              : ''
          const items: Array<{ kind: string; turn?: number; text: string }> = []
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue
            let obj: any
            try {
              obj = JSON.parse(line)
            } catch {
              continue
            }
            const type = String(obj?.type ?? '')
            const d = obj?.data ?? {}
            // user/message 的 content 直接在 data 上（无 message 包裹），assistant 包在 message 里
            if (type === 'user/message')
              items.push({ kind: 'user', turn: d.turn, text: textOf(d.content ?? d.message?.content).slice(0, 4000) })
            else if (type === 'assistant/message')
              items.push({ kind: 'assistant', turn: d.turn, text: textOf(d.message?.content).slice(0, 8000) })
            else if (type === 'turn/start' && items.length)
              items.push({ kind: 'turn', text: `— 第 ${d.turn} 轮 —` })
          }
          res
            .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            .end(JSON.stringify({ session: sid, items: items.slice(-500) }))
        } catch (err) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`会话日志不可读：${String(err)}`)
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/logs') {
        res
          .writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          .end(JSON.stringify({ lines: logTail.slice(-500) }))
        return
      }
    }
    // 面板初始化时拉取：当前预设、流水线与角色列表（无敏感信息，供界面预填与流程提示）
    if (req.method === 'GET' && url.pathname === '/meta') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }).end(
        JSON.stringify({
          preset: activePreset || null,
          master: orch.master,
          roleSessions: Object.fromEntries(
            Object.keys(rolesNow())
              .map((r) => [r, agentSessions[r] ?? ''])
              .filter(([, v]) => v),
          ),
          dshSessions: (agents.roots?.() ?? [])
            .map((a: any) => String(a.id))
            .filter((id: string) => !id.startsWith('panel-'))
            .map((id: string) => ({ name: id, label: `会话 ${id.slice(0, 16)}` })),
          pipeline: pipelineNow(),
          roles: Object.entries(rolesNow()).map(([n, r]) => ({ name: n, label: r.label ?? n })),
          presets: Object.keys({ ...GAME_PRESETS, ...presetState.presets }),
        }),
      )
      return
    }
    // 走到这里说明路径不对，或 token 校验失败——区分打印便于排查“指令失败”
    if (req.method === 'POST' && url.pathname === '/command') {
      logError(
        `/command token 校验失败（收到 ${String(req.headers['x-panel-token']).slice(0, 6)}…，期望 ${token.slice(0, 6)}…）`,
      )
      res
        .writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        .end('token 校验失败：请用服务启动时打印的地址打开面板')
      return
    }
    dbg(`404 ${req.method} ${url.pathname}`)
    res.writeHead(404).end()
  }

  // 请求处理兜底：任何未捕获异常都转成 500，不能让 async handler 的 rejection 冒成进程级 fatal
  const server = createServer((req, res) => {
    void serve(req, res).catch((err) => {
      logError(`请求处理失败 ${req.method} ${req.url}：`, err)
      if (res.headersSent) res.destroy()
      else
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('面板服务内部错误')
    })
  })
  // listen 失败（如端口被占用）只记录错误，不能以未处理的 'error' 事件杀死整个 dsh 进程
  server.on('error', (err) => {
    logError(`面板服务异常（127.0.0.1:${port}）：`, err)
  })
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  // 注册为 effect：插件卸载时自动关闭服务并释放自己创建的 agent
  ctx.effect(() => {
    server.listen(port, '127.0.0.1', () => {
      log(`API http://127.0.0.1:${port}  token=${token}（build route-pin-5；无头服务，面板在 hub 上）`)
      if (logPath) log(`日志文件：${logPath}`)
    })
    return () => {
      clearInterval(heartbeat)
      if (timer) clearTimeout(timer)
      for (const c of hub.clients) c.end()
      hub.clients.clear()
      server.close()
      for (const h of handleOf.values()) void h.dispose()
      handleOf.clear()
      roleOf.clear()
      workflows.clear()
      wfOfAgent.clear()
      taskOfMessage.clear()
      taskOfTurn.clear()
      turnText.clear()
      buf.clear()
    }
  })
}
