<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api } from '../conn'
import { displayName, normalizeRoleSessions } from '../store'

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
const unbinding = ref('')

// 角色会话绑定（来自 /meta 的 roleSessions，值含 harness 标识）：blocked 等异常状态时的自救入口
interface Binding {
  id: string
  harness: string
}
const bindings = ref<Record<string, Binding>>({})

async function loadBindings(): Promise<void> {
  try {
    const r = await api('/meta')
    if (r.ok) {
      const d = (await r.json()) as { roleSessions?: unknown }
      bindings.value = normalizeRoleSessions(d.roleSessions)
    }
  } catch {
    /* 后端不可达 */
  }
}

// 解绑角色会话：清 hub 侧映射，下次派发自动新建会话（历史数据仍保留在对应 harness 的会话目录）
async function unbind(role: string): Promise<void> {
  if (!confirm(`解除角色「${displayName(role) || role}」的会话绑定？\n下次派发将新建会话；历史对话仍保留在对应 harness 的会话目录。`)) return
  unbinding.value = role
  try {
    const r = await api(`/role-session/${encodeURIComponent(role)}`, { method: 'DELETE' })
    if (r.ok) delete bindings.value[role]
  } finally {
    unbinding.value = ''
  }
}

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

function refreshAll(): void {
  void loadBindings()
  void loadSessions().then(() => {
    if (sel.value) pick(sel.value)
  })
}

onMounted(refreshAll)
</script>

<template>
  <section class="panel-box">
    <h2>
      会话管理
      <button class="mini" @click="refreshAll">刷新</button>
    </h2>

    <div class="hist-bindings">
      <div v-if="Object.keys(bindings).length === 0" class="empty">无角色会话绑定。</div>
      <div v-for="(b, role) in bindings" :key="role" class="binding">
        <span class="binding-role">{{ displayName(String(role)) || role }}</span>
        <span v-if="b.harness" class="binding-harness">{{ b.harness }}</span>
        <span class="binding-sid" :title="b.id">{{ b.id.slice(0, 18) }}…</span>
        <button class="mini" :disabled="unbinding === role" @click="unbind(String(role))">
          {{ unbinding === role ? '解绑中…' : '重置会话' }}
        </button>
      </div>
    </div>

    <h3>历史对话</h3>
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
