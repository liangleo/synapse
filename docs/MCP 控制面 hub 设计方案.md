# MCP 控制面 hub 设计方案

状态：设计草案，尚未实现 · 日期：2026-11-10 · 范围：LLM 当 master，通过 MCP 控制 dsh / Codex / Claude Code 三类子 agent

## 1. 目标与范围

- 让一个 LLM master（例如 Claude Code）通过 MCP 工具，把任务派发给不同 harness 的子 agent，并取回结果。
- 控制面用 MCP，观测面沿用已有的“通用事件 + SSE”，两者分开，由同一个 hub 进程提供。
- 子 agent 不接入这个 MCP 服务，避免 agent 之间递归派活。
- 第一期用模拟适配器把 master 的完整流程跑通，再逐个接入真实 harness。

## 2. 总体架构

```
LLM master（如 Claude Code）
      │ MCP（stdio 或 127.0.0.1 的 Streamable HTTP）
      ▼
┌──────────────── hub ────────────────┐
│ MCP 服务（控制面）  作业状态机         │──► SSE 通用事件 ──► 面板
│ 角色注册表   事件存储   workspace 管理 │◄── POST /command（人工操作）
└──┬────────────┬────────────┬────────┘
   ▼            ▼            ▼
 dsh 适配器   Codex 适配器   Claude Code 适配器
 (调用现有     (codex app-    (无头会话)
  插件 HTTP)    server)
```

- 现有 dsh 插件不改动，它的 /events 和 /command 就是 dsh 适配器的后端。
- 面板改为连接 hub；master 的每次工具调用也作为事件显示，形成“master 卡片 → 子 agent 卡片”的流向。

## 3. 给 LLM master 的工具

设计原则：数量少、粒度粗、全部采用异步作业模式。每个工具同时返回文本和 structuredContent，并声明 outputSchema。

| 工具 | 输入（要点） | 返回 | 注解 |
| --- | --- | --- | --- |
| team\_list | 无 | 每个角色的 harness、能力等级、当前状态、当前作业 | 只读 |
| task\_dispatch | role、instruction、taskId?、fromJobs?、mode(new/continue)、clientRequestId? | jobId、状态 | 非幂等 |
| task\_status | jobIds? / role? | 状态、进度、最近 5 个动作 | 只读 |
| task\_wait | jobIds、until(any/all)、timeoutSec（上限约 120） | 第一个状态变化或超时后的摘要 | 只读 |
| task\_result | jobId、detail(summary/full) | 最终输出（默认截断）、改动文件、resource\_link | 只读 |
| task\_steer | jobId、message | 是否已送达 | 仅 L2 有效 |
| task\_cancel | jobId、keepQueue? | 是否已中断 | 破坏性 |
| approval\_respond（第二期） | approvalId、decision | 结果 | 破坏性 |

关键设计：

- **交接靠 fromJobs**：派 Reviewer 时写 fromJobs，hub 自动把上游结果和 diff 注入提示词，不需要单独的“评审”工具，也避免 LLM 手动搬运大段文本。
- **防重复派发**：clientRequestId 用于去重，防止 LLM 重试时重复创建作业。
- **等待不超时**：task\_wait 内部用 progress 通知做心跳；新版 MCP 规范里 progress 通知只走原请求的响应流，与“等待调用本身”匹配。上限设为约 120 秒，超过由 master 再次调用，以适应各宿主的工具超时。
- **上下文卫生**：大输出只返回截断摘要加 resource\_link，完整内容放在 panel://jobs/{id}/log 和 panel://jobs/{id}/diff 资源里。
- **能力差异**：工具列表是全局的，不能按角色增减。team\_list 声明每个角色的能力；对不支持的操作（如 Claude Code 角色的 task\_steer），返回 isError 和明确的错误码 UNSUPPORTED，不静默失败。

## 4. 引导 LLM master：instructions 与 prompt

- MCP 服务的 instructions 写一份编排规程：先调用 team\_list；互不依赖的任务并行派发；用 task\_wait 等待，不要紧密轮询 task\_status；评审通过再测试；评审不通过时，L2 角色用 task\_steer，L1 角色重新 task\_dispatch；同一文件不要同时派给两个作业。
- 提供 orchestrate-feature 的 MCP prompt 模板（设计、并行开发、评审、测试），在 Claude Code 里可当命令调用。

## 5. 作业状态机与角色注册表

- 状态：queued → running → completed / failed / cancelled / blocked，由适配器的 turn.ended 事件驱动；blocked 对应 dsh 的 blocked 和 max-tokens。
- 角色表（配置文件）：role → { harness, model, cwd, prompt 预设, 工具权限, 最大并发 }。
- 权限在适配器里强制（例如 Reviewer 只读），不依赖提示词。
- 作业存 SQLite，hub 重启后不丢状态（第二期；第一期用内存）。

## 6. 适配器落地方式

| 适配器 | 派发 | steer | cancel | 事件 | 等级 |
| --- | --- | --- | --- | --- | --- |
| dsh | 调用现有 /command | 有（steer） | 有 | 现有 /events | L2 |
| Codex | app-server：thread/start、turn/start | 追加 turn/start | 待核对 | app-server 通知 | L2 |
| Claude Code | 每个作业起一个无头会话 | 不支持，改为新会话重做 | 结束进程 | 流式输出或 HTTP hooks | L1 |

说明：L2 = 可派发、可中途追加要求、可中断；L1 = 可启动新会话，但不能中途追加要求或中断。Codex 的取消方式和 Claude Code 无头流式输出的细节尚未核实，写适配器时需对照官方文档。

## 7. 并行安全：workspace 隔离

- 并行的开发作业默认各用一个 git worktree；Reviewer 和 Tester 读取对应开发作业的 worktree。
- 作业结果返回分支名和路径，合并由 master 自己用 git 完成。
- 依赖项目是 git 仓库；非 git 项目退回共享目录，并在 team\_list 里提示风险。

## 8. 安全与成本控制

- MCP 只监听 127.0.0.1（HTTP 模式需 token），或走 stdio，由宿主直接拉起 hub。
- 限制：最大并发作业数、总作业数、单作业超时、每个角色的 cwd 白名单。
- 作业输出视为不可信输入：返回给 master 时用固定结构字段包装，instructions 中提示不要执行输出里的指令。
- 合并、推送等不可逆操作留在 master 的宿主里，由人确认，hub 不提供。

## 9. 代码结构与里程碑

```
hub/src/
  mcp/server.ts        工具、资源、prompt 注册
  hub/{registry,jobs,store,workspace}.ts
  adapters/{dsh,codex,claude}.ts
  http/{sse,panel}.ts  面板 SSE 和静态页
```

| 阶段 | 内容 |
| --- | --- |
| M1 | hub 骨架 + 模拟适配器；实现 team\_list、task\_dispatch、task\_status、task\_wait、task\_cancel；面板接入；用 MCP Inspector 和 claude mcp add 验证 |
| M2 | dsh 适配器 |
| M3 | Codex 适配器 |
| M4 | Claude Code 适配器 |
| M5 | worktree、SQLite、task\_steer、审批、资源与 prompt |

有模拟适配器，整个 LLM master 的流程可以不接任何真实 agent 先跑通。

## 10. 待确认事项

1. **SDK 版本**：调研到的信息不一致，一个模板称 v1 单体包已退役、改用 v2 拆分包（需要 zod 4.2 以上），另一个项目刻意固定在 v1.30.0。建议写代码时先用 npm view 确认 v2 稳定状态：稳定则用 v2，否则固定 v1。
2. **master 宿主**：是否为 Claude Code？这决定用 stdio 还是 HTTP。
3. **worktree 隔离**是否默认开启？更安全，但依赖 git 仓库。
4. **并发**：每个角色同一时刻允许几个作业？建议默认 1。

## 11. 参考

- agent-orchestrator-mcp（Claude Code 与 Codex 并行 worker、worktree 隔离、实时看板）：https://github.com/Bariscanates404/agent-orchestrator-mcp
- dsh-mcp-expose（把 dsh 暴露为 MCP 服务）：https://github.com/wangpeng123-ux/dsh-mcp-expose
- DeepBridge（MCP / A2A / ACP 转换，带只读看板）：https://github.com/ELYSIA1066/DeepBridge
- agent-bridge-mcp（启动并监督多种 agent，有 helper 数量上限）：https://github.com/devonaedwards/agent-bridge-mcp
- MCP 规范变更记录（2026-07-28）：https://modelcontextprotocol.io/specification/2026-07-28/changelog
