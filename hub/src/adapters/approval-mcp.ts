// 伴生 MCP 服务（stdio）：claude --permission-prompt-tool 的回调端点。
// 由子 claude 经 --mcp-config 拉起，env 注入 hub 地址 / token / 作业身份（见 claude.ts）。
// 链路：claude 权限门 → 本进程 tools/call(request_permission) → hub /approval/request →
// 面板或 master 裁决 → /approval/wait 长轮询 → allow/deny JSON 回给 claude。
// 独立进程：只依赖 node stdlib，不 import hub 模块；tsc 编译产物 dist/adapters/approval-mcp.js
// 由 claude.ts 生成的 --mcp-config 以 `node <dist路径>` 拉起。
import { createInterface } from 'node:readline'

const HUB = process.env.HUB_APPROVAL_URL ?? 'http://127.0.0.1:3182'
const TOKEN = process.env.HUB_APPROVAL_TOKEN ?? ''
const JOB_ID = process.env.JOB_ID ?? ''
const ROLE = process.env.JOB_ROLE ?? ''

// 总时限：hub 侧审批超时 + 15s 兜底，保证伴生进程等到 hub 的超时拒绝而不是自己先猜
const DEADLINE = Date.now() + (Number(process.env.HUB_APPROVAL_TIMEOUT_SEC ?? 120) + 15) * 1000

const TOOLS = [
  {
    name: 'request_permission',
    description: '权限审批回调：等待面板/审批人裁决，allow=放行该次工具调用',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: '待审批的工具名' },
        input: { type: 'object', description: '待审批的工具入参（allow 时原样回传 updatedInput）' },
      },
      required: ['tool_name', 'input'],
    },
  },
]

// 向 hub 登记审批并等裁决，返回 claude --permission-prompt-tool 约定的 JSON
async function ask(toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r0 = await fetch(`${HUB}/approval/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-panel-token': TOKEN },
    body: JSON.stringify({ jobId: JOB_ID, role: ROLE, tool: toolName, input }),
  })
  const reg = (await r0.json()) as { id: string; decision?: 'allow' | 'deny' }
  if (!reg.id) return { behavior: 'deny', message: '作业不在运行中，审批通道关闭' }
  while (Date.now() < DEADLINE) {
    const r = await fetch(`${HUB}/approval/wait?id=${encodeURIComponent(reg.id)}&timeout=20`, {
      headers: { 'x-panel-token': TOKEN },
    })
    const { decision } = (await r.json()) as { decision: 'allow' | 'deny' | 'timeout' }
    if (decision === 'allow') return { behavior: 'allow', updatedInput: input }
    if (decision === 'deny') return { behavior: 'deny', message: '审批被拒绝（面板/审批人/超时）' }
  }
  return { behavior: 'deny', message: '审批超时未响应' }
}

// JSON-RPC over stdio（MCP 最小实现：initialize / tools/list / tools/call）
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }
  const id = msg.id
  const method = String(msg.method ?? '')
  void (async () => {
    let result: Record<string, unknown> = {}
    if (method === 'initialize') {
      const p = msg.params as { protocolVersion?: string } | undefined
      result = {
        protocolVersion: p?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'synapse-approval', version: '0.1.0' },
      }
    } else if (method === 'tools/list') {
      result = { tools: TOOLS }
    } else if (method === 'tools/call') {
      const p = msg.params as { name: string; arguments: Record<string, unknown> } | undefined
      const toolName = String(p?.arguments?.tool_name ?? p?.arguments?.name ?? 'tool')
      const input = (p?.arguments?.input ?? {}) as Record<string, unknown>
      const verdict = await ask(toolName, input)
      result = { content: [{ type: 'text', text: JSON.stringify(verdict) }] }
    }
    if (id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
  })()
})
