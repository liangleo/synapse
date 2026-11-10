<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AgentCard from './components/AgentCard.vue'
import CommandBar from './components/CommandBar.vue'
import EventLog from './components/EventLog.vue'
import HistoryPanel from './components/HistoryPanel.vue'
import LogPanel from './components/LogPanel.vue'
import PresetEditor from './components/PresetEditor.vue'
import { displayName, handleEvent, resetStore, store } from './store'
import { api, apiBase, apiToken, BACKENDS, conn, saveConn } from './conn'

let es: EventSource | undefined
const showEditor = ref(false)
// dsh 接入模式（hub /mode）：运行中切换会重注册角色，切换成功后整页重载。
// headless 角色不在这里维护——与 desktop 插件一样从激活预设读取（预设编辑器是角色的唯一维护入口）。
const mode = ref('mock')

async function switchMode(value: string): Promise<void> {
  const r = await api('/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: value }),
  })
  if (!r.ok) {
    store.status = `模式切换失败：${await r.text()}`
    store.statusOk = false
    return
  }
  location.reload()
}

// 后端模式切换：选择后保存并整页重载（SSE 随页面重建）
function switchBackend(value: string): void {
  if (value === '__custom') {
    const base = window.prompt('后端地址（含 http://，如 http://127.0.0.1:3181）', conn.base || 'http://127.0.0.1:3181')
    if (!base) return
    const token = window.prompt('该后端的 token（启动日志里 token= 后的值）', conn.token) ?? ''
    conn.base = base.trim()
    conn.token = token.trim()
  } else {
    conn.base = value
    conn.token = value ? window.prompt('该后端的 token', conn.token || 'mock') ?? '' : ''
  }
  saveConn()
  location.reload()
}

// 卡片排序：进行中（thinking/working）在前，已结束（done/idle/failed）下沉且弱化
const RANK: Record<string, number> = { thinking: 0, working: 0, idle: 1, done: 2, failed: 2 }
const agentList = computed(() =>
  [...store.agents.values()].sort(
    (a, b) => (RANK[a.s] ?? 3) - (RANK[b.s] ?? 3) || (a.t ?? 0) - (b.t ?? 0),
  ),
)

onMounted(() => {
  // 初始化元信息：当前预设、流水线、预置角色（失败不影响主流程）
  fetch(apiBase() + '/meta')
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (m) Object.assign(store.meta, m)
    })
    .catch(() => {})

  // 当前 dsh 接入模式（失败不阻塞）
  api('/mode')
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d) mode.value = d.mode
    })
    .catch(() => {})

  let TOKEN = apiToken()
  if (TOKEN.startsWith('__')) {
    store.status = '未取得 token：请通过插件提供的地址打开本页'
    return
  }
  es = new EventSource(`${conn.base.replace(/\/$/, '')}/events?token=${encodeURIComponent(TOKEN)}`)
  es.onopen = () => {
    resetStore() // 重连时服务端会回放最近事件，先清空避免重复
    store.status = '已连接'
    store.statusOk = true
  }
  es.onerror = () => {
    store.status = '连接中断，正在重试…'
    store.statusOk = false
  }
  es.onmessage = (m) => {
    try {
      handleEvent(JSON.parse(m.data))
    } catch (err) {
      console.error(err)
    }
  }
})

onUnmounted(() => es?.close())
</script>

<template>
  <header>
    <h1>
      多 Agent 控制面板
      <span id="st" :class="{ ok: store.statusOk }">{{ store.status }}</span>
      <button class="ed-toggle" @click="showEditor = !showEditor">
        {{ showEditor ? '关闭预设编辑' : '预设编辑' }}
      </button>
      <select
        class="ed-toggle"
        :value="mode"
        title="dsh 接入模式：模拟角色 / dsh CLI（headless）/ desktop 插件；切换会重注册角色"
        @change="switchMode(($event.target as HTMLSelectElement).value)"
      >
        <option value="mock">模拟角色（无 dsh）</option>
        <option value="headless">dsh CLI（headless）</option>
        <option value="plugin">desktop 插件</option>
      </select>
      <select
        class="ed-toggle"
        :value="conn.base"
        title="切换后端：mock / host / 真实 dsh 插件"
        @change="switchBackend(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="b in BACKENDS" :key="b.value" :value="b.value">{{ b.label }}</option>
        <option v-if="conn.base && !BACKENDS.some((b) => b.value === conn.base)" :value="conn.base">
          自定义 {{ conn.base }}
        </option>
        <option value="__custom">自定义后端…</option>
      </select>
    </h1>
    <CommandBar />
    <p v-if="store.meta.pipeline.length" class="pipeline">
      预设 <b>{{ store.meta.preset || '—' }}</b
      >：{{ store.meta.pipeline.join(' → ') }}
    </p>
    <p v-if="Object.keys(store.meta.roleSessions).length" class="pipeline">
      会话绑定：
      <span v-for="(sid, role) in store.meta.roleSessions" :key="role" class="sess">
        {{ displayName(role) || role }} → {{ sid.slice(0, 14) }}…
      </span>
    </p>
  </header>
  <PresetEditor v-if="showEditor" class="editor-slot" />
  <main>
    <section>
      <div class="grid">
        <AgentCard v-for="x in agentList" :key="x.id" :agent="x" />
      </div>
      <p v-if="store.agents.size === 0" class="empty">
        等待事件。在 dsh 里发起一次对话，或向某个角色派发任务。
      </p>
    </section>
    <EventLog />
  </main>
  <section class="panels">
    <LogPanel />
    <HistoryPanel />
  </section>
</template>
