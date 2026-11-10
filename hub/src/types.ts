// hub 共享类型：与面板协议（src/panel-event.ts）保持同形，但不互相依赖。
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
  | 'workflow.done'
  | 'command.unsupported'

export interface PanelAgent {
  id: string
  role?: string
  parent?: string
  harness: string
}

export interface PanelEvent {
  type: PanelEventType
  t: number
  agent: PanelAgent
  pl: Record<string, unknown>
}

export type JobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'

export interface Job {
  id: string
  clientRequestId?: string
  role: string
  instruction: string
  state: JobState
  createdAt: number
  updatedAt: number
  result?: string
  error?: string
  actions: string[]
  log: string[]
}

export interface RoleDef {
  name: string
  harness: string
  level: 'L1' | 'L2'
  label: string
  prompt?: string
}
