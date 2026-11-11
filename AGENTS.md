# AGENTS.md — 仓库总览（面向 AI 编码代理与协作者）

多 agent 协作可视化面板 + MCP 控制面 hub。三个进程角色：

| 位置 | 是什么 | 怎么跑 |
|------|--------|--------|
| 根 `src/` | **dsh-panel-bridge** 插件：跑在 dsh 宿主内，把 dsh 事件转成面板 SSE；**无头 API**（不伺服面板页面，面板由 hub 伺服） | 安装到 dsh profile（`pnpm dsh:add`） |
| `web/` | **面板前端**：Vue 3 + Vite + Sass，纯静态产物，任何后端都能伺服 | `pnpm dev`（5173）/ 由后端伺服 |
| `hub/` | **MCP 控制面 hub**：LLM master 经 MCP 工具编排多 harness，自带面板 HTTP | `pnpm -C hub build && pnpm -C hub start`（3182） |

hub 子工程的结构、环境变量、dsh 三种接入模式与测试见 `hub/AGENTS.md`（根仓库文档只列跨工程约定）。

辅助进程：`src/mock-server.mjs`（`pnpm mock`，纯假面板后端）、`scripts/mock-host.mjs`（`pnpm host`，真实 cordis 宿主桩）。

## 常用命令

```bash
pnpm install          # 根依赖；hub 依赖需 pnpm -C hub install
pnpm build            # 编译插件（tsc）+ 面板（vite）→ dist/
pnpm typecheck        # 根 tsc + vue-tsc -p web
pnpm lint             # ESLint 9（typescript-eslint + vue）
pnpm format           # Prettier（semi:false, singleQuote, 100 列）
pnpm smoke            # 端到端断言（真实事件形状驱动插件）
pnpm mock / host      # 面板演示 / 插件宿主桩（均带 --watch）
pnpm dsh:add          # 插件装进 dsh profile（tgz 快照）
pnpm dsh:add:link     # 同上，但装 dist 目录实时链接（开发推荐）
pnpm dsh:push         # 开发迭代：build 后 desktop HMR 自动重载（依赖 dsh:add:link 的实时链接）
pnpm -C hub build && pnpm -C hub start   # 启动 hub（面板 :3182 + MCP stdio；--panel-only 跳过 MCP）
node hub/test/mcp-e2e.mjs                # hub 端到端：另有 dsh-e2e / headless-e2e / headless-real（真机）/ integ-drive（手动集成）
```

## 关键约定（违反会出真 bug，见「踩坑」）

1. **事件形状必须与真实 dsh 一致**：`agent/*` 是单 payload（`p.agent.id`）；`TurnEndReason` 是对象（读 `.kind`）；实时文本走 `agent/assistant-stream`；`isOwnedBy(id, owner)` 的 owner 是 Agent 对象。改动 mock/适配器前先读 `docs/MCP 控制面 hub 设计方案.md`。
2. **Sass 自定义属性**：`--x: #{map.get(...)}` 必须用 `#{}` 插值——CSS 自定义属性值不做 Sass 求值。
3. **MCP stdio 的 stdout 是协议**：hub 里所有日志必须走 stderr（`bus.ts` 的 `hubLog`）或写文件，禁止 console.log。
4. **dsh bundle patch 按行整行替换**：改 profile 的 `cordis.patch.yml` 时要重述整行，不做深合并。
5. **跨 harness 兼容**：`src/panel-event.ts` 的 `PanelEvent`/`PanelCommand` 是面板与所有适配器的唯一协议，新增事件类型先改这里。
6. **hub 作业语义**：适配器按能力分级——L1（dsh-headless、mock-claude）不支持 steer，`task_steer` 返回 UNSUPPORTED、要改产出只能重新 dispatch；`turn.ended` 的 status/reasonKind 映射到作业状态机（completed/failed/cancelled/blocked），映射改动先看 `hub/src/orchestrate.ts` 与适配器。
7. **fromJobs 注入的是不可信输入**：hub 自动把上游作业产出注入下一个作业的 instruction，产出会被不可信输入边界标记包裹——适配器/编排侧改这段逻辑时不要拆掉边界。

## 目录速查

```
src/           插件源码（dsh-panel-bridge.ts / game-presets.ts / panel-event.ts / mock-server.mjs）
web/src/       面板源码（App.vue + components/ + store.ts + conn.ts + styles/panel.scss）
hub/           MCP 控制面子工程（src/ 见 hub/AGENTS.md，test/ 为各适配器端到端断言）
scripts/       构建与部署辅助（clean / after-build / dsh-add / mock-host / smoke / dist-package / cordis.patch / locale / icon）
docs/          设计文档与执行计划（MCP 控制面 hub 设计方案.md / plan.md）
dist/          编译产物（gitignore，pnpm build 生成）
```

## 数据与状态文件（都在 `~/.synapse-agent-panel/`，与 git 无关）

- `presets.json` 预设与激活状态（插件与 hub 共用同一份）· `panel-state.json` role→session 映射 · `panel.log` 插件日志 · `mock-registry.json` mock 注册表 · `hub-jobs.db` hub 作业 SQLite（重启恢复历史）· `hub-mode.json` hub 的 dsh 接入模式持久化 · headless 角色会话映射见 `HUB_HEADLESS_STATE`

## 注释与文档引用规范

- 代码注释必须自含具体内容：禁止出现「见设计文档 §2」「详见 xxx.md §3-4」这类编号式引用——把被引用的语义直接写进注释（例如「fromJobs 自动把上游产出注入 instruction」「patch 按 id 整行替换不做深合并」）。
- 指向设计/方案文档的链接只允许出现在文件头部的说明注释和 README/AGENTS 里，且必须写全文件路径。

## 踩坑史（改代码前先读）

- mock/模拟器的事件形状与真实宿主不一致会掩盖插件 bug——改形状前对照真机核对结论（见 `docs/` 与 git 历史）。
- 多源 `cp` 到同一目录会夹带杂物文件（曾有 src/*.ts 混进 web/src/components）；双向 `cp -r` 覆盖会回退新组件，同步后必须核对。
- `pnpm build` 只能在与 node_modules 匹配的平台上跑（rollup 原生模块按平台安装）。
- `desktop` profile 曾被 Electron 独占管理（CLI 报 managed exclusively）；本机现统一 web profile，以 `grep -H dsh-panel-bridge ~/.dsh/profiles/*/package.json` 为准。
