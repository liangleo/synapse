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

## M2 — dsh 真实适配器（真机已跑通）

- [x] hub/src/adapters/dsh.ts：转发现有插件 HTTP（POST /command 派发、SSE /events 订阅自动重连、resume 由插件 panel-state.json 透传）
- [x] dsh 插件瘦身：HTTP 壳抽成共享模块（`src/server/http-shell.ts`：SSE 扇出/静态/请求体/来源校验），插件只留 dsh 桥接与路由；新增固定 token 配置供 hub 接入
- [x] 事件映射核对：turn.ended status/reasonKind → completed/failed/cancelled/blocked（blocked/max-tokens → blocked）；插件 statusOf 修正 max-tokens 误判为 ok；状态迁移只信任 pl.taskId 事件
- [x] hub 角色自动发现：启动拉插件 /meta 注册 dsh 角色（DSH_PANEL_URL + DSH_PANEL_TOKEN）
- [x] 集成验证：hub/test/dsh-e2e.mjs 12 项断言 + mock-host 真实插件全链路（test/integ-drive.mjs）
- [x] 真机验收：hub 经 MCP 派发 → dsh 角色（DeepSeek 真实模型）执行 → task_result 取回真实产出（integ-drive 2026-11-10 通过；Claude Code 挂 hub MCP 的 master 编排为可选人工步）
- [x] 真机核对补遗：agents.resume 单参数签名（遗留清单 #1）；resume 不自动应用 agentOptions 路由 → setup 里 agent.model.select 固定（对齐 applyConfiguredRoute）；角色未配路由时经 agentDefaultModel 服务继承部署默认；插件日志改本地时区；`pnpm dsh:push` = build 触发 desktop HMR
- [x] 面板收尾：会话管理（绑定/解绑/历史对话，解析真实 dsh 的 zstd 多帧 session.v4.jsonl.zstd）、角色下拉剔除 master、hub /meta 合并插件 roleSessions、预设经 hub 代理可编辑

### M2.5 — dsh-headless 适配器（无 desktop 接入，真机已跑通）

- [x] hub/src/adapters/dsh-headless.ts：spawn `dsh --profile headless --json`（本机或 ssh 远机，DSH_HEADLESS_CMD），NDJSON 事件流映射 PanelEvent（final.reason.kind completed/aborted/error → completed/cancelled/failed），cancel = 杀进程，L1 语义（steer UNSUPPORTED）
- [x] 角色→session 映射由 hub 自管（HUB_HEADLESS_STATE），`--session-id` 实现会话连续；hub 吸收 /history、/role-session API（dsh-logs.ts：zstd 多帧解码搬进 hub）
- [x] 角色来源：DSH_HEADLESS_ROLES 配置声明（同名 mock 角色就地升级为真实 harness）；优先级高于插件接入
- [x] 凭据：headless profile 恢复 GUI 登录（credentials/authorization/deepseek-account + agent-default-model 改 deepseek-account 路由）
- [x] 验收：test/headless-e2e.mjs 16 项断言全过 + test/headless-real.mjs 真机（无 desktop 参与，真实 DeepSeek 模型完成作业取回产出）
- [x] 运行中切换接入模式：GET/POST /mode（mock / headless / plugin），选择持久化（hub-mode.json，env 降级为初始默认）；有 running/queued 作业时拒绝切换；不在新清单的 dsh 角色回退默认 mock 定义
- [x] 角色统一从预设维护：headless 角色来自激活预设（与 desktop 插件共用 presets.json），hub 自服务 /presets、/preset/active，保存/切换预设自动重注册角色；/meta 展示预设流水线

## M3 — Codex 适配器（按需启动：暂跳过，需要时回到此节）

- [ ] 实测 `codex app-server` 的事件输出（thread/start、turn/start、item.started、turn.completed）
- [ ] 适配器：thread/start 派发、turn/start 追加（steer）、取消方式待核对
- [ ] 验收：codex 角色在面板上呈现完整生命周期

## M4 — Claude Code 适配器（按需启动：暂跳过，需要时回到此节）

- [ ] 实测无头会话流式输出（或 HTTP hooks）
- [ ] 适配器：每作业一个无头会话；steer 不支持 → 重新 dispatch；cancel = 结束进程
- [ ] 验收：L1 语义（卡片角标、steer UNSUPPORTED）真机呈现

## M5 — 强化（M3/M4 跳过，先做本节）

- [x] worktree 隔离：task_dispatch `worktree: true` → 仓库根建 `synapse/<jobId>` 分支 worktree，headless 子进程以 worktree 为 cwd，作业回传 worktreeBranch；SYNAPSE_REPO_ROOT / SYNAPSE_ALLOWED_CWDS 白名单
- [x] SQLite 作业存储：node:sqlite 写穿（jobs/job_lines），重启恢复历史作业与日志，running/queued 重启标记 failed（HUB_JOBS_DB）
- [x] 限制强化：单作业超时 HUB_JOB_TIMEOUT_SEC（到时自动 cancel）；fromJobs 上游产出加不可信输入边界包装；空指令入口拒绝
- [x] MCP prompt 模板：`orchestrate-feature`（拆解 → 并行派发 → worktree → 评审 → 测试 → 汇总分支清单）
- [ ] approval_respond + approval.requested：**延后**——headless 无实时审批通道（dsh README 明确 "Headless has no live approval-response channel"），desktop 插件审批桥接需 dsh user-approval 服务方案，待适配模式稳定后评估

## 遗留待核对清单（真机验证时逐项清掉）

1. ~~`agents.resume(ctx, {...})` 签名~~ 已核对：真机为单参数 `agents.resume(options)`，ownerCtx 由服务内部持有（mock-host 假实现曾掩盖差异）
2. ~~followup/steer/cancel 位置~~ 已核对（2026-11-11 读 asar 源码）：`agents.list()/roots()` 返回 Agent 实例本身（方法直接挂实例）；`resume/create` 返回 `{agent, dispose}` 包装（方法在 `handle.agent`）；`cancel(cause, {keepInbox?})`。插件 callOn 两种位置均兼容，无需改代码
3. ~~面板指令 `source.kind`~~ 已核对（真机会话 JSONL 实证）：用户消息即 `{kind:'user'}`（系统注入用 runtime-context 等），插件转发用 user 正确
4. ~~`message.id` 取值位置~~ 已核对（源码 + 真机）：`createUserMessage` 自动分配 UUID；`agent/inbox/claimed` 事件为 `{message, turn}`，`p.message.id` 与创建侧 `msg.id` 一致，taskOfMessage 关联成立
5. ~~同 session 多 agent 绑定是否允许~~ 已核对（2026-11-11 真机实验）：**不允许**——dsh JSONL 持久层单写者锁，第二个角色 resume 同 session 报 `SessionAlreadyOwnedError`；插件 ensure() 回退新建会话兜底（后绑角色拿新会话，先绑角色不受影响）
6. ~~模型路由名~~ 已核对（headless 真机实证）：路由为 `deepseek-account` / `deepseek-flash`；预设角色 provider/model 留空即继承部署默认
