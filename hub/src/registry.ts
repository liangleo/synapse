// 角色注册表：M1 用内置默认角色（模拟适配器）；后续从配置文件加载。
import type { RoleDef } from './types.js'

export const DEFAULT_ROLES: RoleDef[] = [
  { name: 'architect', harness: 'mock-dsh', level: 'L2', label: '架构师' },
  { name: 'dev-a', harness: 'mock-codex', level: 'L2', label: '开发 A' },
  { name: 'dev-b', harness: 'mock-codex', level: 'L2', label: '开发 B' },
  { name: 'reviewer', harness: 'mock-claude', level: 'L1', label: '评审' },
  { name: 'tester', harness: 'mock-claude', level: 'L1', label: '测试' },
]
