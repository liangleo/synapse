# synapse-agent-panel

多 agent 协作的可视化面板 + MCP 控制面 hub：一个不依赖特定 harness 的本地 Web 面板（Vue 3 + Vite + Sass）、一个把 DeepSeek Harness（dsh）事件桥接到面板的插件（`dsh-panel-bridge`），以及一个让 LLM master 经 MCP 工具编排多 harness 子 agent 的控制面 hub（`hub/`）。内置 mock server，可脱离 dsh 单独演示与开发界面。

- **面板**：卡片式实时展示每个 agent 的状态、工具调用与流式输出；支持派发、评审、打回、中断。
- **插件**：以 dsh bundle 形式安装，订阅 dsh 事件转成统一格式的 SSE，把面板指令翻译成 Agent API 调用。
- **编排（插件侧）**：内置两套游戏开发角色预设（`client` / `server`），master 派发任务后按流水线串行创建子 agent，并把上游产出传给下游。
- **控制面 hub（`hub/`）**：MCP stdio 服务器 + 面板 HTTP（:3182）。LLM master 通过 `task_dispatch` / `task_wait` / `task_result` 等工具派发与跟踪异步作业；适配器接入 mock / dsh desktop 插件/ dsh-headless（无桌面，`dsh --profile headless --json`）/ claude（无头，`claude -p --output-format stream-json`）/ codex（无头，`codex exec --json`），运行中可切换接入模式；支持 worktree 隔离、SQLite 作业持久化、单作业超时。详见下文[「控制面 hub」](#控制面-hub)与 `hub/AGENTS.md`。
- **可独立测试**：`pnpm mock` 假后端跑界面，`pnpm host` 用真实 cordis 加载插件跑全链路，`pnpm smoke` 用真实事件形状做断言；hub 有独立的端到端断言（`hub/test/`）。
- **多后端切换**：顶栏下拉可切「当前后端 / mock(:3180) / host(:3181) / 自定义」，选择与 token 存 localStorage，切换即重载；跨端口访问靠插件对本机 Origin 的 CORS 支持。
- **界面看日志**：顶栏「服务端日志」按钮唤出右侧抽屉（默认隐藏），3 秒轮询 `GET /logs`（token 保护），内容是插件 debug 日志的环形缓冲（与 panel.log 落盘同源，最多 800 行）。
- **历史对话**：顶栏「会话管理」按钮唤出右侧抽屉——从会话日志解析用户/Agent 对话序列，下拉选会话即可查看。hub 自管模式下覆盖三个 harness 的会话目录：dsh（`$DSH_HOME/sessions`，zstd 多帧）/ claude（`~/.claude/projects`）/ codex（`~/.codex/sessions`）；带来源筛选（默认跟随当前接入模式，可手改），支持按角色绑定 session.id 精确过滤（「已绑定」档位 + ★角色标注）。接口 `GET /history/sessions`、`GET /history?session=<id>`（token 保护）。
- **会话持久化与恢复**：流水线角色的 `role → session` 映射持久化到 `panel-state.json`（`stateFile` 可改路径）。dsh/插件重启后第一次派发某个角色时走 `agents.resume` 恢复原会话上下文（失败自动回退新建并清理映射）；面板角色的历史日志在 `~/.dsh/sessions/` 的 JSONL 里，不会丢。想把角色绑定到任意已有 dsh 会话（如主对话 `session-xxxx`）：手动编辑 `panel-state.json` 的 `sessions` 映射指向该 id，重启插件后即 resume 生效；也可在界面用「会话 xxx」下拉直发到已有会话。

## 30 秒上手

```bash
pnpm install
pnpm build      # node 侧 tsc → dist/*.js；Vite → dist/static/
```

三个后端选一个，用浏览器打开对应地址即可看到面板：

| 后端      | 命令                            | 测什么                                      | 端口 | 读取                |
| --------- | ------------------------------- | ------------------------------------------- | ---- | ------------------- |
| mock      | `pnpm mock`                     | 只测界面：假事件回放，**不经过插件**        | 3180 | `dist/static/`      |
| mock host | `pnpm host`                     | 测插件本体：真 cordis 宿主 + 假 agents 服务 | 3181 | 整个 `dist/`        |
| 真实 dsh  | `pnpm dsh:push`（开发）/ `pnpm dsh:add`（装快照） | 完整链路（真实 agent、真实模型）；`dsh:push` = build 后 desktop HMR 自动重载实时链接的 dist | 3180 | `dist/` 作为 bundle |

`pnpm dev` 是前端热更新服（Vite，5173），只在你改界面时用，默认把接口代理到 `pnpm mock`。

想看 hub 编排（MCP master + 多适配器）时另起一节：

```bash
pnpm -C hub install && pnpm -C hub build && pnpm -C hub start
# 面板 http://127.0.0.1:3182/（token 见启动 stderr），MCP stdio 供 LLM master 挂载
```

### 只看界面

```bash
pnpm mock
# 打开 http://127.0.0.1:3180/
```

会自动回放当前预设前两个角色的示例会话，也可以在页面向任意角色派发任务或中断。

### 测插件本体

```bash
pnpm host                          # 默认 3181，激活预设的流水线
PORT=3181 pnpm host                # 换端口
PRESET=server pnpm host            # 换预设（client / server / 本地自定义预设名）
PORT=3181 PRESET=server pnpm host  # 端口 + 预设组合
# 打开控制台打印的地址（含 token）
```

注意：预设优先级是「面板里激活过的（持久化在 `~/.synapse-agent-panel/presets.json`）」> `PRESET` 环境变量 > 默认 `client`。改了 `PRESET` 没生效时，先在面板「预设编辑」里激活对应预设，或把该文件的 `active` 置空。

mock host 用真实 cordis 加载 `dist/dsh-panel-bridge.js`，注入假的 `agents`/`sessions` 服务，并**按真实 dsh 事件形状**（`agent/*` 单 payload、`assistant-stream` 帧、`TurnEndReason` 对象）回放一轮完整 turn；控制台同步打印 `agents.create`、`followup` 的调用参数。接入真机前先用它回归事件与命令链路。

### 前端热更新

```bash
pnpm mock     # 终端 A：后端事件源（3180）
pnpm dev      # 终端 B：Vite dev server（5173）
```

dev 模式下页面拿不到注入 token，由代理统一补发；默认指向 `pnpm mock`（token 固定 `mock`）。对接其它后端时用环境变量：

| 变量                | 默认                    | 说明                                    |
| ------------------- | ----------------------- | --------------------------------------- |
| `VITE_PANEL_TARGET` | `http://127.0.0.1:3180` | 后端地址（mock / host / 真实 dsh desktop 插件） |
| `VITE_PANEL_TOKEN`  | `mock`                  | 后端 token（host 与插件在启动时打印）   |

```bash
VITE_PANEL_TARGET=http://127.0.0.1:3181 VITE_PANEL_TOKEN=<host 打印的 token> pnpm dev  # 对接 pnpm host
VITE_PANEL_TARGET=http://127.0.0.1:3180 VITE_PANEL_TOKEN=<插件 token> pnpm dev        # 对接真实 dsh
```

> 真实 dsh 面板的 token 由服务端注入页面（`window.PANEL_TOKEN`），浏览器直接开 `http://127.0.0.1:3180/` 不需要手动带；只有写代码直接调 HTTP API 时才需要它，可在页面源码或 `~/.synapse-agent-panel/panel.log` 的启动行里找。

## 架构

先分清两个"东西"：**插件**（`src/*.ts` 编译出的 `dist/dsh-panel-bridge.js`，负责 dsh 事件 ↔ 面板）和**面板前端**（`web/src` 编译出的 `dist/static/`）。四个开发命令围绕它们各管一段：

```
 源码                          pnpm build                        产物
 web/src  ──────┐          ┌─────────────────┐          ┌─────────────────────────┐
                ├──────────> tsc(node 侧)    ├──────────> dist/dsh-panel-bridge.js   ──┐
 src/*.ts ──────┘          │ vite(前端)      │          │ dist/static/（前端产物） │   │
                           └─────────────────┘          └─────────────────────────┘   │
                                                                                       │
 pnpm mock ─── 面板演示服务（假事件，完全绕过插件）→ :3180 ── 读取 dist/static/           │
 pnpm host ─── dsh 宿主桩（真实 cordis 加载插件做端到端测试）→ :3181 ── 读取整个 dist/ <─┘
 pnpm dev  ─── 前端热更新开发服（Vite，源码直出，不读 dist）→ :5173，/events /command /meta
               代理到 mock(:3180) / host(:3181) / 真实 dsh desktop 插件，由 VITE_PANEL_TARGET 决定
```

一句话：**build 产 dist；mock 和 host 是两个不同的"后端"（一个假的、一个半真）；dev 是绕过 dist 的前端开发服**。真实 dsh 是第三个后端——加载同一个 `dist/dsh-panel-bridge.js`，只是宿主换成了 dsh 本体。hub 是第四个面板入口（:3182）——它自己不产事件，而是经适配器接入上面三个后端（mock 适配器 / dsh 插件 / dsh-headless），把事件合流给面板、把 master 的 MCP 调用翻译成作业派发。

### 数据流

```
dsh 会话事件 ──> 插件（session/event、agent/*）──> PanelEvent ──SSE /events──> 面板
面板指令   ──POST /command（x-panel-token）──> 插件 ──> agents.create / followup / steer / cancel
```

面板与 harness 之间只有 `src/panel-event.ts` 的 `PanelEvent` / `PanelCommand` 两种结构，所以换 harness 只需要换适配器（见「扩展：多 harness」）。

### HTTP 接口

插件和 mock/mock-host 共用同一套面板协议（只监听 `127.0.0.1`，拒绝非本机 `Origin`）：

| 方法 | 路径                         | 鉴权                   | 说明                                         |
| ---- | ---------------------------- | ---------------------- | -------------------------------------------- |
| GET  | `/`                          | 无（token 注入页面）   | 面板 HTML，服务端把 `__PANEL_TOKEN__` 替换掉 |
| GET  | `/static/*`                  | 无                     | Vite 产物                                    |
| GET  | `/events?token=`             | `token` 查询参数       | SSE 事件流（重连时回放 backlog）             |
| GET  | `/meta`                      | 无                     | 预设、master、流水线、角色列表               |
| POST | `/command`                   | `x-panel-token` 请求头 | 指令入口，204 = 已接收                       |
| GET  | `/logs`                      | `x-panel-token` 请求头 | 最近 debug 日志的环形缓冲（最多 800 行）     |
| —    | `/presets`、`/preset/active` | `x-panel-token` 请求头 | 预设读写（见「编排模式」）                   |

### 事件与指令

事件类型（`src/panel-event.ts`）：

| 类型                  | `pl` 关键字段                            | 说明                              |
| --------------------- | ---------------------------------------- | --------------------------------- |
| `agent.registered`    | —                                        | 新 agent 出现（含启动时已存在的） |
| `agent.status`        | `status`                                 | `running` / `idle` 等             |
| `agent.ended`         | —                                        | agent 释放                        |
| `turn.started`        | `turn`                                   | 一轮开始                          |
| `step.started`        | `turn`、`step`                           | 一轮内的一步                      |
| `turn.ended`          | `turn`、`status`、`reasonKind`、`taskId` | 结束原因来自 `TurnEndReason.kind` |
| `tool.started`        | `name`、`action`、`callId`               | 工具调用开始                      |
| `tool.finished`       | `ok`、`callId`                           | 工具调用结束                      |
| `output`              | `text`                                   | 流式文字增量（`text-delta`）      |
| `task.claimed`        | `taskId`、`turn`                         | 任务被某个 agent 接手             |
| `workflow.done`       | `taskId`、`status`、`steps`              | 流水线结束（`done` / `failed`）   |
| `approval.requested`  | `approvalId`、`tool`、`input`            | 权限审批请求（claude headless 审批通道） |
| `approval.resolved`   | `approvalId`、`decision`、`via`          | 裁决结果（面板 / master / 超时自动拒绝） |
| `command.unsupported` | —                                        | 适配器不支持该指令                |

指令类型（`PanelCommand`）：`task.assigned` / `review.requested` / `task.rejected` / `task.cancel`，字段 `{ type, to, taskId?, text? }`，`to` 是角色名。

## 接入真实 dsh

### 前置

- Node.js ≥ 24.9（dsh 硬性要求；本仓库自身编译用 Node 22+ 也能跑，两者可并存）
- 已安装并登录 dsh：`npm i -g @deepseek-ai/dsh`，配好 API Key，`dsh` 命令可用
- 当前插件按 **dsh 0.2.2-rc.1** 的运行期 API 实测核对（`session/event` 签名、`agent/*` 单 payload、`TurnEndReason` 对象、`agents.create`/`setup`/`systemPrompt`、`tools.restrict`）

### 1. 构建

```bash
pnpm install
pnpm build          # → dist/（插件 + 前端 + bundle 清单 + locale/icon）
pnpm pack:plugin    # 可选：在 dist/ 里再打一个 dsh-panel-bridge-0.1.0.tgz
```

### 2. 安装到 profile

桌面版与 CLI 统一使用 `web` profile（`~/.dsh/profiles/web`）。先确认插件装在了实际生效的 profile：

```bash
grep -H '"dsh-panel-bridge"' ~/.dsh/profiles/*/package.json   # 已装在哪些 profile
dsh --profile web --dump-config | grep panel-bridge           # web profile 的组合树里有它
```

- **CLI / dsh web**：开发期推荐 `dsh plugin --profile web add <dist 绝对路径>`（目录 link 实时链接，`pnpm build` 后重启 dsh 即生效）；`pnpm dsh:add`（= build + tgz + 离线安装）适合锁版本的固定安装；`DSH_ADD=link pnpm dsh:add` 则直接安装 dist 目录的实时链接（等价于上面的目录 add，之后 `pnpm build` + 重启 dsh 即生效）。 快捷指令：`pnpm dsh:add:link`。
- **桌面版**：侧边栏 **Plugins** 页面安装，目标填 `link:<本仓库绝对路径>/dist`（开发期推荐：之后 `pnpm build` + 重启桌面版即生效），或粘贴 `.tgz` 绝对路径；部分 rc 版本的 Add plugin 不支持原地升级，换版本先卸载旧包再装。

若你的桌面版实际使用独立的 `desktop` profile（CLI 操作会报 managed exclusively），则只能从应用内 Plugins 页面安装；`presets.json` / `panel-state.json` / `panel.log` 都在 `~/.synapse-agent-panel/`，与 profile 无关，切换 profile 不需要迁移。

### 3. 启动与验证

1. 启动桌面版或 `dsh web`（终端启动时控制台打印 `[dsh-panel-bridge] http://127.0.0.1:3180/ token=…`）
2. 浏览器打开面板地址 → 顶部显示「已连接」
3. 在 dsh 里发一句普通对话 → 面板出现卡片和实时文字
4. 向 **master** 派发任务 → 预设流水线依次建卡、事件流推进、最后 `workflow.done`

### 4. 日志

地址、token 与派发细节默认落盘到 `~/.synapse-agent-panel/panel.log`（`logFile` 可改路径，设为 `''` 或 `off` 关闭；超过 1MB 自动轮转成 `panel.log.1`）。

**桌面版从 Finder 启动时没有终端，console 输出拿不到，只能看这个文件**：

```bash
tail -f ~/.synapse-agent-panel/panel.log
```

想直接看 stdout，先完全退出桌面版（Cmd+Q），再从终端启动：

```bash
"/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
```

## 配置参考

插件激活前会用 schemastery `Config` 校验已知字段并补默认值。字段由 bundle 的 `cordis.patch.yml` 声明默认值，插件启动后会在日志里打印地址与 token。

| 字段                    | 类型                        | 默认                                      | 说明                                         |
| ----------------------- | --------------------------- | ----------------------------------------- | -------------------------------------------- |
| `port`                  | number                      | `3180`                                    | 面板 HTTP 端口（仅监听 `127.0.0.1`）         |
| `panelHtml`             | string                      | 插件同目录 `static/index.html`            | 自定义面板入口 HTML 绝对路径                 |
| `preset`                | string                      | —                                         | 启动激活的预设名；持久化的激活状态优先       |
| `presetsFile`           | string                      | `~/.synapse-agent-panel/presets.json`     | 预设覆盖与激活状态的持久化文件               |
| `stateFile`             | string                      | `~/.synapse-agent-panel/panel-state.json` | role→session 映射；重启后据此恢复面板会话    |
| `roles`                 | Record<string, RoleConfig\> | —                                         | 手工角色；配置 `preset` 时作为预置角色的覆盖 |
| `orchestrator.master`   | string                      | `master`                                  | 触发编排的角色名                             |
| `orchestrator.pipeline` | string[]                    | 预设流水线                                | 覆盖预设的执行顺序                           |
| `debug`                 | boolean                     | `true`                                    | 打印请求/指令处理日志                        |
| `logFile`               | string                      | `~/.synapse-agent-panel/panel.log`        | 日志落盘路径；`''` 或 `off` 关闭             |

`RoleConfig`：`{ provider?, model?, label?, prompt?, toolsRestrict?: { allow?: string[], deny?: string[] } }`——`provider`/`model` 可省略，缺省继承部署默认路由。

要覆盖配置，编辑 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/<name>/`），按 id **整行替换**（不做深合并，必须重述该行全部键）：

```yaml
- id: panel-bridge
  name: dsh-panel-bridge
  config:
    port: 3189
    preset: server
    orchestrator:
      master: master
    # logFile: ~/.synapse-agent-panel/panel.log   # 默认值；设为 '' 关闭落盘
```

## 编排模式（多 agent）

插件内置游戏开发的两套角色预设（`GAME_PRESETS`），配置 `preset` 即可整套装载——角色、提示词、流水线、模型分配全内置；`roles` 可对预置角色做覆盖（如换模型）：

| 预设                     | 流水线                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `client`（客户端玩法向） | `game-designer` → `game-architect` → `gameplay-dev` → `level-designer` → `code-reviewer` → `game-qa`        |
| `server`（服务端逻辑向） | `system-designer` → `server-architect` → `server-dev` → `code-reviewer` → `security-reviewer` → `server-qa` |

```ts
{
  preset: 'client',            // 或 'server'；省略 orchestrator.pipeline 时使用预设流水线
  orchestrator: { master: 'master' },
  // roles: { 'code-reviewer': { model: 'deepseek-flash' } },   // 可选：覆盖预设中的单个角色
}
```

模型约定：角色的 `provider` / `model` 可留空，**缺省继承部署默认路由**（推荐——避免硬编码路由名；你环境的实测路由为 `deepseek-account` / `deepseek-flash`）；显式填写则按角色覆盖。

### 预设的修改与持久化

内置 `GAME_PRESETS` 只读，但可通过面板顶部「预设编辑」可视化界面（或 HTTP API）修改角色（名称/模型/提示词）、拖拽组建流水线，保存到本地 `presetsFile`，重启后仍生效。同名修改与内置预设按角色合并（本地优先）；内置预设不可删除但可覆盖，「恢复默认值」（`DELETE /presets/<name>`）会移除本地覆盖、回到出厂角色与流水线。

优先级：**界面激活过的预设（持久化）> 启动配置 `preset` > 手工 `roles`**。

预设 API（均需 `x-panel-token`）：

| 方法   | 路径              | 说明                                                    |
| ------ | ----------------- | ------------------------------------------------------- |
| GET    | `/presets`        | 全量视图（内置 + 本地，合并后形态，含激活状态）         |
| PUT    | `/presets/<name>` | 创建/覆盖预设 `{ roles, pipeline }`，立即持久化         |
| DELETE | `/presets/<name>` | 删除本地预设；内置预设 = 移除本地覆盖（无覆盖返回 400） |
| POST   | `/preset/active`  | `{ name }` 切换激活预设，下次派发即用新流水线           |

### 执行流程

master 收到任务 → 依次创建各角色为运行时子 agent（`parentAgent` 指向 master）→ 每个角色的提示词（`prompt`）通过 `agents.create` 的 **`setup` 回调**注入：setup 收到该 agent 私有的作用域上下文 `agentCtx`，调用 `agentCtx.systemPrompt.section({ name, order: 0, text })` 注册 persona section（order 0 是模型最先读到的槽位，且只对该 agent 生效；类型见 `@deepseek-ai/dsh-agent` 的 `CreateAgentOptions.setup` 与 `@deepseek-ai/dsh-system-prompt` 的 `PromptSection`）→ 某角色 turn 结束后，其本轮文字产出被自动收集，作为【上游产出】附加给下一角色 → 全部完成后插件发出 `workflow.done` 事件，任一步失败/被中断则编排中止。

面板上能看到整条流水线：每个角色一张卡片、同一个 taskId 串联、事件流里可查每步反馈的传递。不想用预置流水线时，可用 `orchestrator.pipeline` 自定义顺序，或搭配手工配置的 `roles`。

### 工具限制

需要按角色限制工具（例如评审只读）时，在预设角色的 `toolsRestrict: { allow?: string[], deny?: string[] }` 里配置，插件会通过该 agent 私有的 `agentCtx.tools.restrict()` 生效。写了未知工具名会抛错，只记日志、不阻止 agent 创建。

### 当前限制

- 确定性 pipeline（顺序固定），同一时间只跑一条流水线：并发向 master 派发返回 400「已有流水线正在执行」。
- LLM 驱动的 master（主 agent 自己决定下一步派给谁、可打回重做）由控制面 hub 承担，见下一节。

中断、工具限制等语义细节见「已知局限」。

## 控制面 hub（MCP 编排多 harness）

`hub/` 是独立子工程（`hub/AGENTS.md` 有完整的结构、环境变量与测试说明）：一个 MCP stdio 服务器，同时伺服面板 HTTP（:3182）。LLM master 把 hub 的 MCP 工具挂进自己的会话，即可编排任意 harness 的子 agent——面板变成观测面，master 不需要碰面板协议。

**MCP 工具**（7 个 + 资源 + prompt 模板）：

| 工具 | 说明 |
| ---- | ---- |
| `team_list` | 列出当前角色与能力分级 |
| `task_dispatch` | 派发异步作业，返回 jobId（`clientRequestId` 去重；`worktree: true` 在仓库分支 worktree 里隔离执行） |
| `task_status` / `task_wait` | 查询状态 / 阻塞等待（≤120s） |
| `task_result` | 取产出（summary 截断，完整日志走 `panel://jobs/{id}/log` 资源） |
| `task_steer` / `task_cancel` | 中途改向 / 取消（L1 角色 steer 返回 UNSUPPORTED，只能重新 dispatch） |
| `approval_respond` | 对子 agent 的权限审批作出裁决（allow / deny；无人裁决超时自动拒绝，也可在面板点允许/拒绝） |

- **fromJobs 交接**：派发时声明上游 jobId，hub 自动把上游产出注入 instruction（带不可信输入边界标记），LLM 不搬运文本。
- **prompt 模板** `orchestrate-feature`：功能需求 → 拆解并行派发 → worktree 隔离 → 评审 → 测试 → 汇总分支清单。
- **作业持久化**：node:sqlite 写穿（默认 `~/.synapse-agent-panel/hub-jobs.db`），重启恢复历史作业与日志；`HUB_JOB_TIMEOUT_SEC` 超时自动 cancel。
- **审批通道**（claude 模式，`CLAUDE_APPROVAL=0` 关闭）：子 claude 以 `--permission-prompt-tool` 挂伴生 MCP 服务（`approval-mcp.ts`），权限门回调 → hub `/approval/request` → 面板审批条「允许/拒绝」或 master `approval_respond` 裁决 → 长轮询取回决定。`HUB_APPROVAL_TIMEOUT_SEC`（默认 120s）无人裁决自动拒绝；作业取消/结束也自动拒绝。codex exec 与 dsh headless 无审批回调，需要审批的调用维持自动拒绝语义。

**接入模式**（面板下拉或 `GET/POST /mode` 运行中切换，有在途作业时拒绝）：

| 模式 | 接入方式 | steer |
| ---- | -------- | ----- |
| `mock` | 内置模拟角色（mock-dsh / mock-codex 为 L2，mock-claude 为 L1） | L2 可 |
| `plugin` | 转 dsh desktop 插件 HTTP（`DSH_PANEL_URL` + `DSH_PANEL_TOKEN`，角色从插件 /meta 自动发现） | 可 |
| `headless` | spawn `dsh --profile headless --json`（本机或 `ssh` 远机，`DSH_HEADLESS_CMD`），无 desktop 参与，L1 | 不可 |
| `claude` | spawn `claude -p --output-format stream-json`（`CLAUDE_CMD` 可换绝对路径），L1；需本机 claude CLI 已登录；审批通道默认开启（见下） | 不可 |
| `codex` | spawn `codex exec --json --sandbox workspace-write`（`CODEX_CMD` 可换），L1；产出=最后一次 agent_message | 不可 |

headless / claude / codex 模式下 hub 自管 role→session 映射（按 harness 分域，`HUB_ROLE_SESSIONS`）实现会话连续、自服务 `/history` `/role-session` `/presets`（预设与 dsh desktop 插件共用 `presets.json`，角色统一从激活预设维护）。

**测试**：`node hub/test/mcp-e2e.mjs`（MCP 全链路 16 项）、`hub/test/dsh-e2e.mjs`（插件适配器 12 项）、`hub/test/headless-e2e.mjs`（headless 44 项）、`hub/test/headless-real.mjs`（真机验收，需 headless 凭据）、`hub/test/claude-e2e.mjs`（claude 适配器 11 项）、`hub/test/claude-real.mjs`（真机验收）、`hub/test/codex-e2e.mjs`（codex 适配器 11 项）、`hub/test/codex-real.mjs`（真机验收）。

## 面板功能

- **初始化元信息**：页面加载时请求 `GET /meta`，顶部显示当前预设与流水线，预置角色自动进入角色下拉建议。
- **卡片动态生成**：每个新 agent 一张卡；无父 agent 显示为 master，有父 agent 显示为 sub agent。
- **状态由事件推导**：`turn.started` → 思考；`tool.started` / `output` → 执行（显示动作与实时文字）；`turn.ended` → 完成 / 失败 / 待机。
- **指令栏**：派发任务、请求评审、打回、中断；点击卡片可自动填角色名并过滤事件流。
- **卡片内操作**：每个角色卡片底部有「打回 / 中断」按钮，直接对它发指令（master 卡除外，编排中止通过卡住的那一步）。
- **session 选择**：指令栏的目标 session 下拉按后端独立记忆，新流水线自动切到最新；`initialSession` 配置可让角色恢复到已有会话作为初始上下文（多角色共享，真机需核对同 session 多 agent 绑定）。
- **断线重连**：重连时清空后接收 backlog 回放，避免重复。
- **预设编辑器**：编辑角色 provider/模型/提示词、拖拽角色组建流水线、保存/另存/激活/删除预设；内置预设改过后可「恢复默认值」移除本地覆盖（走 `/presets` API，持久化到本地）。
- **会话管理**：各角色当前绑定的会话 id（带 harness 徽标）与「重置会话」入口（`DELETE /role-session/<role>`，清绑定后下次派发自动新建会话）；历史对话下拉带 harness 标识与来源筛选（默认跟随接入模式），「已绑定」档位按绑定 session.id 精确过滤并标注所属角色。

## 开发

### 仓库结构

```
.
├── src/                      # node 侧源码
│   ├── game-presets.ts       # 内置角色预设数据（插件 / mock-server / mock-host 共用）
│   ├── panel-event.ts        # 通用事件/指令类型（适配器与前端共用）
│   ├── dsh-panel-bridge.ts   # dsh 插件：事件 → SSE，面板指令 → Agent API
│   └── mock-server.mjs       # 独立演示服务：回放会话 + 接收指令
├── web/                      # Vue 3 前端子工程（Vite 根）
│   ├── index.html            # 入口页（token 注入点 __PANEL_TOKEN__）
│   ├── vite.config.ts        # base=/static/，产物输出 ../dist/static/
│   └── src/
│       ├── main.ts           # createApp + 全局样式
│       ├── App.vue           # 布局 + SSE 连接
│       ├── store.ts          # 响应式状态：agent 表、事件流、指令栏草稿
│       ├── conn.ts           # 后端连接与切换（同源 / mock / host / 自定义，存 localStorage）
│       ├── util.ts           # 配色、名称、时间工具
│       ├── styles/           # 全局样式（Sass，亮/暗双色）
│       └── components/       # AgentCard / EventLog / CommandBar / PresetEditor
├── hub/                      # MCP 控制面子工程（pnpm -C hub 独立 install/build/start）
│   ├── AGENTS.md             # 子工程文档：结构 / 环境变量 / 接入模式 / 测试
│   ├── src/
│   │   ├── index.ts          # 入口：面板 HTTP(:3182) + MCP stdio（--panel-only 跳过 MCP）
│   │   ├── jobs.ts           # 作业状态机 queued→running→completed/failed/cancelled/blocked
│   │   ├── orchestrate.ts    # dispatch（去重 / fromJobs 注入 / 排队调度）、steer、cancel
│   │   ├── mcp/server.ts     # 7 个 MCP 工具 + panel://jobs/{id}/log 资源 + orchestrate-feature prompt
│   │   ├── adapters/         # mock.ts / dsh.ts（转插件 HTTP）/ dsh-headless.ts（spawn dsh CLI）/ claude.ts（spawn claude CLI）
│   │   ├── role-sessions.ts  # 角色→会话映射（headless 与 claude 共用，按 harness 分域）
│   │   ├── http.ts           # 面板 HTTP + /mode 模式切换 + headless 本地 API
│   │   ├── presets.ts        # 预设管理（与插件共用 presets.json，角色从激活预设解析）
│   │   └── mode.ts / bus.ts / registry.ts / dsh-logs.ts / types.ts
│   └── test/                 # mcp-e2e / dsh-e2e / headless-e2e / headless-real / integ-drive
├── scripts/                  # 构建与测试辅助
│   ├── clean.mjs             # 清空 dist/
│   ├── after-build.mjs       # 构建后组装 bundle（清单/patch/locale/icon → dist）
│   ├── mock-host.mjs         # dsh 宿主桩：真实 cordis 加载插件做端到端模拟
│   ├── dsh-add.mjs           # 一键部署：build + tgz + dsh plugin add
│   ├── smoke.mjs             # 冒烟测试：真实事件形状驱动插件并断言关键行为
│   ├── cordis.patch.yml      # bundle 的 profile 层声明（挂载行 + 默认 config）
│   ├── dist-package.json     # dist/package.json 模板（bundle 包描述）
│   ├── icon.svg              # 插件图标
│   └── locale/               # 插件显示元数据（en/zh）
├── dist/                     # 编译产物（pnpm build 生成）：可直接安装的 dsh bundle
├── package.json              # 依赖与脚本（pnpm）
├── tsconfig.json             # node 侧类型检查（noEmit）
├── tsconfig.build.json       # node 侧编译配置：dsh 插件输出到 dist/
├── eslint.config.js          # ESLint 9 扁平配置（typescript-eslint + eslint-plugin-vue）
└── .prettierrc.json          # Prettier 风格（无分号、单引号、100 列）
```

### 脚本

| 脚本                | 说明                                                                    |
| ------------------- | ----------------------------------------------------------------------- |
| `pnpm build`        | 清空并重建 `dist/`（插件、前端、bundle 清单）                           |
| `pnpm clean`        | 只清空 `dist/`                                                          |
| `pnpm mock`         | 构建 + 启动演示服务（3180）                                             |
| `pnpm host`         | 构建 + 启动 dsh 宿主桩（3181）                                          |
| `pnpm dev`          | Vite dev server（5173，HMR）                                            |
| `pnpm watch:node`   | tsc 增量编译插件，配合 `pnpm host` 自动重启                             |
| `pnpm typecheck`    | tsc（node 侧）+ vue-tsc（SFC）                                          |
| `pnpm lint`         | ESLint（typescript-eslint + eslint-plugin-vue）                         |
| `pnpm format`       | Prettier 统一格式                                                       |
| `pnpm smoke`        | 构建 + 冒烟测试（真实事件形状驱动插件：事件形状、SSE、命令、预设、日志落盘） |
| `pnpm dsh:add`      | 一键部署到 dsh profile（build + tgz + `dsh plugin add`）                |
| `pnpm dsh:add:link` | 一键部署（link 模式）：安装 `dist/` 目录实时链接，改完 build 重启即生效 |
| `pnpm pack:plugin`  | 在 `dist/` 里打 tgz 包                                                  |
| `pnpm -C hub build` | 编译 hub 子工程（`pnpm -C hub install` 装依赖）                         |
| `pnpm -C hub start` | 启动 hub（面板 :3182 + MCP stdio；`--panel-only` 只伺服面板）           |

### 热重载

| 改什么                 | 怎么跑                                                  | 生效方式                                   |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------ |
| `web/src/**`（界面）   | `pnpm dev`                                              | Vite HMR，保存即刷新，无需重启             |
| `src/mock-server.mjs`  | `pnpm mock`                                             | node `--watch`，保存后自动重启 mock server |
| `src/*.ts`（插件）     | 终端 A `pnpm host` + 终端 B `pnpm watch:node`           | tsc 增量编译 → dist 变化触发 host 自动重启 |
| `web/src` + 插件一起改 | `pnpm host`、`pnpm watch:node`、`pnpm dev` 各占一个终端 | 前端 HMR + 插件自动重启组合                |

已装进真实 dsh 时：`link:` 安装指向 `dist/`，改前端后 `pnpm build` + 刷新页面即可（静态文件按请求读取）；改插件 TS 需要重启 dsh。

## 排错

- **插件加载报错**：看 `~/.synapse-agent-panel/panel.log`（桌面版）或终端 stdout；常见原因是 `inject`/事件名与 dsh 版本不匹配。
- **端口冲突**：3180 被占用时只记日志（`panel.log`），dsh 继续运行但面板不可用；改 `config.port` 或释放端口。
- **实时输出不显示**：DevTools 网络面板复制 `/events` 原始 SSE，确认 `agent/assistant-stream` 的 `frame.chunk.type === 'text-delta'`（其他 chunk 不会进面板输出）。
- **派发失败**：查日志里 `agents.create`、`followup` 的调用参数与报错；`/command` 返回 403 说明 token 不对（用服务启动时的地址打开面板）。
- **父子层级不对**：`dsh --profile <name> --dump-config` 输出 + `agents.list()` 的返回样本。
- **复现与回归**：拿到上面的样本后，在 `pnpm host` 里复现并修正，不需要反复连真实 dsh 调试。

## 已知局限

插件运行期 API 已对照 dsh 0.2.2-rc.1 真机实现核对（`session/event` 签名、turn/step/tool 事件字段、`TurnEndReason` 对象、`agent/*` 单 payload 形状、`agents.create`/setup/systemPrompt、`roots()`/`list()` 返回 `Agent[]`、`isOwnedBy` owner 语义、`tools.restrict({ allow, deny })`），代码里已没有 `TODO(待核对)`。仍有这些工程限制：

- **流水线串行**：同一时间只允许一条 workflow；并发派发返回 400，不会排队。同一角色的多次派发会按 dsh inbox 顺序排队执行。
- **中断语义**：`task.cancel` 只对已创建的角色生效；取消会清空该角色待处理队列。
- **Reviewer 只读需显式配置**：内置预设没有开 `toolsRestrict`；配置后若写了未知工具名，`tools.restrict` 会抛错，只记日志、不阻止 agent 创建。
- **配置校验范围**：插件导出 schemastery `Config`，激活前会校验已知字段的类型并补默认值；未知 key 仍会透传，`panelHtml`、`preset` 之类的拼写错误不会报错，需对照 `Config` 接口检查。
- **日志默认落盘**：`logFile` 默认 `~/.synapse-agent-panel/panel.log`，debug 日志也写入；不需要时设 `logFile: ''` 关闭。
- **端口冲突不致命但面板不可用**：3180 被占用时只记日志，dsh 继续运行。
- **模型路由**：预设里的 `provider: deepseek` + `DeepSeek-V4.1-Flash` 需与 dsh 实际可用模型核对（实测环境可用 `deepseek-account` / `deepseek-flash`），真实派发前在预设编辑器里调整。
- `/meta` 显示的 preset 以本地持久化的激活状态优先，可能不同于启动配置（设计如此）。
- mock-server 的演示角色随激活预设变化；`architect`/`developer-a` 仅在无预设时兜底。

## 扩展：多 harness

面板与 harness 解耦：事件与指令走统一格式（`src/panel-event.ts` 的 `PanelEvent`/`PanelCommand`），每条事件带 `agent.harness` 标记，卡片右上角徽章显示来源。切换 harness = 切换后端适配器：

- **dsh**：已实现，两条路——dsh desktop 插件（`src/dsh-panel-bridge.ts`，cordis 宿主内）与 headless 无桌面接入（`hub/src/adapters/dsh-headless.ts`，spawn `dsh --profile headless --json`）。
- **claude-code**：已实现（`hub/src/adapters/claude.ts`，模式切到 `claude`）。
- **codex**：已实现（`hub/src/adapters/codex.ts`，模式切到 `codex`，续跑 `codex exec resume <thread_id>`）。

两种切换方式：**部署期**——同一时刻跑一个适配器，面板用 `VITE_PANEL_TARGET`/`panelHtml` 指向对应端口；**运行时并存**——多个适配器接入控制面 hub（已实现），`/events` 合流、`/command` 按 `agent.harness` 路由，面板无需改动。

写新适配器的四个映射点：CLI 生命周期事件 → `turn.started/step.started/turn.ended`；工具调用 → `tool.started/finished`；输出流 → `output`（建议 150ms 合并）；消息归属 → message→taskId 映射出 `task.claimed`。有实时审批回调的 harness（如 claude 的 `--permission-prompt-tool`）映射到 `approval.requested` + hub `/approval/*` 端点；无回调的 harness 维持自动拒绝语义。
