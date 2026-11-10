// 角色注册表：M1 用内置默认角色（模拟适配器）；后续从配置文件加载。
// 真实 dsh 角色注册会就地升级同名默认角色；模式切回时用 BY_NAME 恢复原始定义。
import type { RoleDef } from './types.js'

export const DEFAULT_ROLES: RoleDef[] = [
  { name: 'architect', harness: 'mock-dsh', level: 'L2', label: '架构师' },
  { name: 'dev-a', harness: 'mock-codex', level: 'L2', label: '开发 A' },
  { name: 'dev-b', harness: 'mock-codex', level: 'L2', label: '开发 B' },
  { name: 'reviewer', harness: 'mock-claude', level: 'L1', label: '评审' },
  { name: 'tester', harness: 'mock-claude', level: 'L1', label: '测试' },
]

// 默认角色的原始定义副本（深拷贝，升级覆盖不会污染这里）
const BY_NAME = new Map(DEFAULT_ROLES.map((r) => [r.name, { ...r }]))

export function defaultRoleOf(name: string): RoleDef | undefined {
  return BY_NAME.get(name)
}
