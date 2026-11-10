# AGENTS.md — web 面板子工程（Vue 3 + Vite + Sass）

面板是纯静态观测端：SSE 收事件渲染卡片/事件流，fetch 发指令。**不直接依赖任何 harness**——通过 `conn.ts` 指向任意后端（dsh 插件 :3180 / hub :3182 / mock :3180）。

## 结构

```
src/
  main.ts           createApp + 全局样式
  App.vue           布局：顶栏（状态/预设/后端切换）+ 卡片 + 侧栏 + 底部面板行
  store.ts          全局响应式状态：agents/sessions/events/meta/cmd；handleEvent 是唯一事件入口
  conn.ts           后端连接：base/token 按 localStorage 记忆，api()/sendCommand() 统一前缀与鉴权
  util.ts           col（按 id 稳定配色）/nm/hm
  components/
    AgentCard.vue       agent 卡片（状态/进度/卡片级打回中断按钮）
    CommandBar.vue      指令栏（角色下拉 + session 下拉 + 动作按钮）
    EventLog.vue        事件流侧栏
    LogPanel.vue        服务端日志面板（3s 轮询 /logs，最新置顶）
    HistoryPanel.vue    历史对话面板（/history/sessions + /history）
    PresetEditor.vue    预设编辑器（角色编辑 + 拖拽流水线 + 恢复默认）
  styles/panel.scss  全部样式（参考稿风格：浅色优先、系统字体、紫主操作）
```

## 约定

- **事件入口唯一**：所有 SSE 消息走 `store.handleEvent(e)`；带 `taskId` 的事件自动登记进 session 下拉并默认选中最新。
- **样式全在 panel.scss**，组件内不写样式；Sass 自定义属性值必须 `#{}` 插值（否则整个主题失效——踩过）。
- **面板协议**在根 `src/panel-event.ts`，改事件类型先改那里。
- 长文本容器必须 `overflow-wrap: anywhere` + flex 子元素 `min-width: 0`（pre/日志曾撑出面板框）。
- 事件流上限 800 条（防长跑内存增长）。
