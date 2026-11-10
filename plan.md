# plan.md — 里程碑与执行计划

来源：`docs/MCP 控制面 hub 设计方案.md`。本文是执行跟踪版，完成即打勾。

## 已完成

- [x] 面板 v1：卡片/事件流/指令栏/预设编辑器/后端切换/日志视图（Vue 3 + Vite + Sass）
- [x] dsh-panel-bridge 插件：bundle 规范、事件桥接、指令分发、预设 API、session 持久化 + resume
- [x] 真机核对：dsh 0.2.2-rc.1 运行期 API（事件形状/单 payload/TurnEndReason/setup/systemPrompt/tools.restrict）
- [x] mock host + smoke 断言（真实事件形状回归）

## M1 — hub 骨架 + 模拟适配器 ✅（本轮完成）

- [x] `hub/` 子工程：bus / jobs（状态机 + waiter）/ registry / orchestrate（去重、fromJobs 注入、排队调度）
- [x] mock 适配器 ×3：mock-dsh(L2)、mock-codex(L2)、mock-claude(L1)——验证能力差异语义
- [x] MCP stdio 服务：team_list / task_dispatch / task_status / task_wait / task_result / task_steer / task_cancel + instructions + panel://jobs/{id}/log 资源
- [x] clientRequestId 去重、fromJobs 交接注入、每角色并发 1 排队调度、L1 steer UNSUPPORTED
- [x] 面板接入 hub：SSE /events、/meta、/logs、静态伺服、人工 /command
- [x] 端到端验证：`hub/test/mcp-e2e.mjs` 16 项断言全过（握手/工具/去重/并行/wait/结果/L1 语义/cancel/资源）
- [x] `pnpm dsh:add:link`、AGENTS.md ×3

## M2 — dsh 真实适配器（下一步）

- [ ] hub/src/adapters/dsh.ts：转发现有插件 HTTP（POST /command 派发、SSE /events 订阅、resume 透传）
- [ ] dsh 插件瘦身：HTTP 壳抽成共享模块（`src/server/`），插件只留 dsh 桥接 + hub 转发
- [ ] 事件映射核对：dsh 事件 → PanelEvent 的 reasonKind/status 语义对齐
- [ ] 验收：面板连 hub，master（Claude Code）经 MCP 派发 → dsh 角色（真实模型）执行 → task_result 取回

## M3 — Codex 适配器

- [ ] 实测 `codex app-server` 的事件输出（thread/start、turn/start、item.started、turn.completed）
- [ ] 适配器：thread/start 派发、turn/start 追加（steer）、取消方式待核对
- [ ] 验收：codex 角色在面板上呈现完整生命周期

## M4 — Claude Code 适配器

- [ ] 实测无头会话流式输出（或 HTTP hooks）
- [ ] 适配器：每作业一个无头会话；steer 不支持 → 重新 dispatch；cancel = 结束进程
- [ ] 验收：L1 语义（卡片角标、steer UNSUPPORTED）真机呈现

## M5 — 强化

- [ ] worktree 隔离（并行开发作业各用 git worktree，结果返回分支名）
- [ ] SQLite 作业存储（hub 重启不丢）
- [ ] approval_respond 审批工具 + `approval.requested` 事件打通
- [ ] orchestrate-feature 的 MCP prompt 模板
- [ ] 限制强化：cwd 白名单、单作业超时、输出包装防注入提示

## 遗留待核对清单（真机验证时逐项清掉）

1. `agents.resume(ctx, {...})` 签名（ownerCtx 形态、是否自动重启循环）
2. `agents.list()` 返回的 Agent 对象上 followup/steer/cancel 的位置（自身 or .agent）
3. 面板指令 `source.kind`（暂按 user）
4. `message.id` 取值位置（影响 task.claimed 的 taskId 归属）
5. 同 session 多 agent 绑定是否允许（initialSession 已移除，panel-state.json 手动绑定时可能触发）
6. 模型路由名（预设留空继承部署默认；显式指定需用实际路由如 deepseek-account/deepseek-flash）
