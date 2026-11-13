// 通用事件格式：三个 harness 的适配器（dsh / Codex / Claude Code）共用。
export type Harness = 'dsh' | 'codex' | 'claude-code'

export interface PanelAgent {
  id: string
  role?: string
  parentId?: string
  parent?: string // hub 适配器的父节点字段（与插件桥的 parentId 同义，store 两者都认）
  harness: Harness
}

export type PanelEventType =
  | 'agent.registered'
  | 'agent.status'
  | 'agent.ended'
  | 'turn.started'
  | 'step.started'
  | 'turn.ended'
  | 'tool.started'
  | 'tool.finished'
  | 'output'
  | 'task.claimed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'command.unsupported'
  | 'workflow.done'

export interface PanelEvent {
  type: PanelEventType
  t: number // 毫秒时间戳
  agent: PanelAgent
  pl: Record<string, unknown> // 摘要：tool 名、动作、reason、taskId 等
  raw?: unknown // 原始 payload，排错用
}

// 面板（master）发给适配器的指令。to 是角色名，如 'developer-a'
export type PanelCommandType =
  'task.assigned' | 'review.requested' | 'task.rejected' | 'task.cancel'

export interface PanelCommand {
  type: PanelCommandType
  to: string
  taskId?: string
  text?: string // 要交给该 agent 的提示词或评审意见
}

export interface Adapter {
  harness: Harness
  level: 'L0' | 'L1' | 'L2'
  start(emit: (e: PanelEvent) => void): Promise<void> | void
  dispatch?(cmd: PanelCommand): Promise<void> // 仅 L1/L2 实现
}
