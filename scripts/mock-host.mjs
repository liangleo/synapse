// dsh 宿主桩：用真实的 cordis 宿主框架加载编译产物里的 dsh-panel-bridge 插件，
// 注入假的 agents/sessions 服务并回放脚本化会话，用于在不安装 dsh 的情况下端到端测试插件。
//
// 与 src/mock-server.mjs 的区别：mock-server 直接模拟"面板后端"（完全绕过插件），
// 本文件测试的是插件本身——加载、依赖注入、事件桥接、指令分发全链路。
//
// 运行：pnpm host   （先构建，再启动；默认端口 3181）
// 打开控制台打印的地址（token 会打印在控制台），页面上应看到 master 与预设前两个角色的卡片；
// 向某角色派发任务，假 agent 会回放一段 turn 事件，面板状态随之变化。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'

const PRESET_NAME = process.env.PRESET || 'client'
const INITIAL_SESSION = process.env.INITIAL_SESSION || ''
const PRESETS_FILE = join(homedir(), '.synapse-agent-panel', 'presets.json')

const pluginFile = new URL('../dist/dsh-panel-bridge.js', import.meta.url)
const panelHtml = new URL('../dist/static/index.html', import.meta.url)

if (!existsSync(fileURLToPath(pluginFile)) || !existsSync(fileURLToPath(panelHtml))) {
  console.error('[host] 请先运行 pnpm build 生成 dist/ 产物')
  process.exit(1)
}

const port = Number(process.env.PORT || 3181)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log('[host]', ...a)

// ---------- 假 agents 服务 ----------
// 注册表持久化到 ~/.synapse-agent-panel/mock-registry.json：重启 mock-host 后
// 插件的 agents.resume 才能找到历史 session，完整演示「持久化 + 启动恢复」。
const REGISTRY_FILE = join(homedir(), '.synapse-agent-panel', 'mock-registry.json')
const registry = new Map()
try {
  const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8'))
  for (const [id, v] of Object.entries(raw.registry ?? {})) registry.set(id, v)
  log(`已加载 mock 注册表：${registry.size} 个 agent（${REGISTRY_FILE}）`)
} catch {
  /* 首次运行 */
}
const persistRegistry = () => {
  mkdirSync(dirname(REGISTRY_FILE), { recursive: true })
  writeFileSync(
    REGISTRY_FILE,
    `${JSON.stringify({ registry: Object.fromEntries(registry) }, null, 2)}\n`,
  )
}
const agentsService = {
  register(id, parent, role) {
    registry.set(String(id), { parent: parent ? String(parent) : undefined, role })
    persistRegistry()
  },
  list: () => [...registry.keys()].map((id) => handles.get(id) ?? { id }),
  roots: () => [{ id: 'master' }],
  isOwnedBy: (child, parent) =>
    registry.get(String(child))?.parent === String(parent?.id ?? parent),
  async create({ sessionId, agentOptions, parentAgent, setup }) {
    const id = String(sessionId)
    registry.set(id, {
      parent: parentAgent ? String(parentAgent.id ?? parentAgent) : undefined,
      role: agentOptions?.role,
    })
    persistRegistry()
    log(
      `agents.create → ${id}（model=${agentOptions?.model ?? '?'}，parent=${registry.get(id).parent ?? '无'}）`,
    )
    // 模拟 dsh 的 setup 语义：agent 发布前执行，收到该 agent 私有作用域的 agentCtx
    if (setup) {
      setup({
        systemPrompt: {
          section: (s) =>
            log(
              `  systemPrompt.section ← ${s.name}（order ${s.order}）"${String(s.text).slice(0, 24)}…"（仅本 agent 生效）`,
            ),
        },
      })
    }
    return makeHandle(id)
  },

  // dsh 的恢复语义：按 resumeSessionId 找回已持久化的 agent；不存在则抛错（插件会回退 create）。
  // 例外：INITIAL_SESSION 环境变量视为外部已存在的会话，未注册时自动接纳（模拟 dsh 的历史会话，供 resume 测试）。
  async resume(o, { resumeSessionId, agentOptions, setup }) {
    const rid = String(resumeSessionId)
    if (!registry.has(rid)) {
      if (rid !== INITIAL_SESSION) throw new Error(`mock-host：session ${rid} 不存在`)
      registry.set(rid, { parent: undefined })
      persistRegistry()
      log(`（模拟）接纳初始 session ${rid}`)
    }
    log(`agents.resume → ${rid}（model=${agentOptions?.model ?? '?'}）`)
    const handle = makeHandle(rid)
    if (setup) {
      setup({
        systemPrompt: {
          section: (sec) =>
            log(
              `  systemPrompt.section ← ${sec.name}（order ${sec.order}）"${String(sec.text).slice(0, 24)}…"（仅本 agent 生效）`,
            ),
        },
      })
    }
    ctx.emit('agent/created', { agent: { id: rid } })
    return handle
  },
}

const handles = new Map()

function makeHandle(agentId) {
  const handle = {
    id: agentId,
    disposed: false,
    agent: {
      async cancel(opts) {
        log(`agent[${agentId}].cancel(${JSON.stringify(opts ?? {})})`)
        ctx.emit(
          'session/event',
          { id: agentId },
          {
            type: 'turn/end',
            data: { turn: turnNo.get(agentId) ?? 1, reason: { kind: 'aborted' } },
          },
        )
      },
      steer(msg) {
        log(
          `agent[${agentId}].steer ← "${msg?.content?.[0]?.text ?? ''}"（source=${msg?.source?.kind}）`,
        )
        return runTurn(agentId, String(msg?.content?.[0]?.text ?? ''), msg)
      },
      followup(msg) {
        log(
          `agent[${agentId}].followup ← "${msg?.content?.[0]?.text ?? ''}"（source=${msg?.source?.kind}）`,
        )
        return runTurn(agentId, String(msg?.content?.[0]?.text ?? ''), msg)
      },
    },
    async dispose() {
      handle.disposed = true
      ctx.emit('agent/disposed', { agent: { id: agentId } })
      log(`agent[${agentId}].dispose()`)
    },
  }
  ctx.emit('agent/created', { agent: { id: agentId } })
  handles.set(agentId, handle)
  return handle
}

// ---------- 假 sessions 服务 ----------
const sessionsService = {
  // 插件当前只注入未使用；留个钩子便于以后扩展
}

// ---------- 事件回放 ----------
const ctx = new Context()
ctx.provide('agents', agentsService)
ctx.provide('sessions', sessionsService)

const turnNo = new Map()

// 回放一轮 turn：claimed → start → step/tool/chunk → end
async function runTurn(agentId, taskText, msg) {
  const turn = (turnNo.get(agentId) ?? 0) + 1
  turnNo.set(agentId, turn)
  const msgId = msg?.id ?? `m-${Date.now()}`
  const send = (type, data) => ctx.emit('session/event', { id: agentId }, { type, data })

  ctx.emit('agent/inbox/claimed', { agent: { id: agentId }, message: { id: msgId }, turn })
  await sleep(300)
  send('turn/start', { turn })
  await sleep(400)
  send('step/start', { turn, step: 1 })
  // 实时文本与真实 dsh 一致：agent/assistant-stream 单 payload { agent, frame }
  const stream = (text) =>
    ctx.emit('agent/assistant-stream', {
      agent: { id: agentId },
      frame: { type: 'chunk', chunk: { type: 'text-delta', index: 0, text } },
    })
  stream(`收到任务：${taskText || '（无内容）'}。`)
  await sleep(600)
  send('tool/call', {
    turn,
    step: 1,
    callId: 'c1',
    name: 'edit',
    arguments: JSON.stringify({ path: `src/${agentId}/task-${turn}.ts` }),
  })
  await sleep(700)
  send('tool/result', { turn, callId: 'c1' })
  send('step/start', { turn, step: 2 })
  stream('任务完成，已提交。')
  await sleep(500)
  send('turn/end', { turn, reason: { kind: 'completed' } })
  log(`agent[${agentId}] turn ${turn} 回放完毕`)
}

// ---------- 初始脚本场景：master + 激活预设的前两个角色 ----------
async function demoAgent(role) {
  await agentsService.create({ sessionId: `agent-${role}`, parentAgent: { id: 'master' } })
  const id = `agent-${role}`
  ctx.emit('agent/inbox/claimed', { agent: { id }, message: { id: `m-${role}` }, turn: 1 })
  ctx.emit('session/event', { id }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id }, { type: 'step/start', data: { turn: 1, step: 1 } })
  ctx.emit(
    'session/event',
    { id },
    {
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'read',
        arguments: JSON.stringify({ path: 'requirements.md' }),
      },
    },
  )
  await sleep(900)
  ctx.emit('session/event', { id }, { type: 'tool/result', data: { turn: 1, callId: 'c1' } })
  ctx.emit('agent/assistant-stream', {
    agent: { id },
    frame: {
      type: 'chunk',
      chunk: { type: 'text-delta', index: 0, text: `${role} 完成了一轮演示任务。` },
    },
  })
  ctx.emit(
    'session/event',
    { id },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  )
}

async function scenario() {
  await sleep(200)
  await agentsService.create({ sessionId: 'master' })
  await sleep(300)
  // 演示角色取激活预设流水线的前两步，与面板看到的预设保持一致
  const roles = Object.keys(preset.roles).length
    ? preset.pipeline.slice(0, 2)
    : ['architect', 'developer-a']
  await demoAgent(roles[0])
  await sleep(800)
  await demoAgent(roles[1])
  log(
    `初始场景回放完毕（${roles.join(' → ')}）；向 master 派发任务可演示完整流水线（PRESET=${process.env.PRESET || 'client'}）`,
  )
}

// ---------- 加载插件 ----------
const pluginModule = await import(pluginFile.href)
const { GAME_PRESETS } = await import(new URL('../dist/game-presets.js', import.meta.url).href)
const plugin = pluginModule
// 与插件相同的激活预设解析（简化版）：持久化 active 优先，其次 PRESET 环境变量
const persisted = (() => {
  try {
    return JSON.parse(readFileSync(PRESETS_FILE, 'utf8')).active || ''
  } catch {
    return ''
  }
})()
const preset = {
  roles: GAME_PRESETS[persisted || PRESET_NAME]?.roles ?? {},
  pipeline: GAME_PRESETS[persisted || PRESET_NAME]?.pipeline ?? [],
}
ctx.plugin(plugin, {
  port,
  panelHtml: fileURLToPath(panelHtml),
  // 游戏开发内置预设：'client'（客户端玩法）或 'server'（服务端逻辑），角色/提示词/流水线全内置
  preset: process.env.PRESET || 'client',
  initialSession: INITIAL_SESSION || undefined,
  orchestrator: { master: 'master' }, // pipeline 取自预设
  // mock 宿主只看终端输出即可；落盘默认关闭，需要时 PANEL_LOG=<路径> 打开
  logFile: process.env.PANEL_LOG || '',
})

scenario()
log(`面板地址见上一行插件输出（token 以 dsh-panel-bridge 开头的行）；按 Ctrl+C 退出`)
