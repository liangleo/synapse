<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../conn'

interface HistSession {
  id: string
  mtime: number
  size: number
}
interface HistItem {
  kind: string
  turn?: number
  text: string
}

const sessions = ref<HistSession[]>([])
const sel = ref('')
const items = ref<HistItem[]>([])
const body = ref<HTMLElement | null>(null)
const loading = ref(false)

async function loadSessions(): Promise<void> {
  try {
    const r = await api('/history/sessions')
    if (r.ok) {
      const d = (await r.json()) as { sessions?: HistSession[] }
      sessions.value = d.sessions ?? []
      if (!sel.value && sessions.value.length) pick(sessions.value[0].id)
    }
  } catch {
    /* 后端不可达 */
  }
}

async function pick(id: string): Promise<void> {
  sel.value = id
  if (!id) {
    items.value = []
    return
  }
  loading.value = true
  try {
    const r = await api(`/history?session=${encodeURIComponent(id)}`)
    if (r.ok) {
      const d = (await r.json()) as { items?: HistItem[] }
      items.value = d.items ?? []
    } else {
      items.value = [{ kind: 'error', text: await r.text() }]
    }
  } catch (err) {
    items.value = [{ kind: 'error', text: (err as Error).message }]
  } finally {
    loading.value = false
  }
}

onMounted(loadSessions)
</script>

<template>
  <section class="panel-box">
    <h2>
      历史对话
      <button class="mini" @click="loadSessions().then(() => { if (sel) pick(sel) })">刷新</button>
    </h2>
    <div class="hist-bar">
      <select v-model="sel" @change="pick(sel)">
        <option value="" disabled>选择会话…</option>
        <option v-for="s in sessions" :key="s.id" :value="s.id">
          {{ s.id.slice(0, 22) }}…（{{ new Date(s.mtime).toLocaleString() }}）
        </option>
      </select>
    </div>
    <div ref="body" class="hist-body">
      <div v-for="(it, i) in items" :key="i" class="hist-item" :class="'hist-' + it.kind">
        <template v-if="it.kind === 'turn'">— 第 {{ it.turn }} 轮 —</template>
        <template v-else>
          <span class="hist-kind">{{ it.kind === 'user' ? '你' : it.kind === 'error' ? '错误' : 'Agent' }}</span>
          <span class="hist-text">{{ it.text || '（空）' }}</span>
        </template>
      </div>
      <div v-if="!loading && items.length === 0" class="empty">选择会话后显示历史对话。</div>
    </div>
  </section>
</template>
