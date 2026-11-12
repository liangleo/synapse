<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { api } from '../conn'
import { displayName, normalizeRoleSessions } from '../store'

interface HistSession {
  id: string
  mtime: number
  size: number
  harness?: string
}
interface HistItem {
  kind: string
  turn?: number
  text: string
}

const emit = defineEmits<{ close: [] }>()

// 会话内容不可信：marked 渲染后必须过 DOMPurify 净化再 v-html
const md = (src: string): string => DOMPurify.sanitize(marked.parse(src, { async: false }) as string)

const sessions = ref<HistSession[]>([])
// harness 筛选：默认跟随当前接入模式（headless/plugin/mock → dsh），可手动改；'@bound' = 只看角色绑定的会话
const filter = ref('')
const filterTouched = ref(false)
// 角色绑定 id 与会话 id 精确匹配：claude 绑定即 session uuid（文件名），codex 绑定 uuid 含在 rollout 文件名里
function boundRoles(s: HistSession): string[] {
  return Object.entries(bindings.value)
    .filter(([, b]) => b.id && (s.id === b.id || s.id.endsWith(`/${b.id}`) || s.id.endsWith(b.id)))
    .map(([r]) => r)
}
const filtered = computed(() =>
  filter.value === '@bound'
    ? sessions.value.filter((s) => boundRoles(s).length > 0)
    : filter.value
      ? sessions.value.filter((s) => s.harness === filter.value)
      : sessions.value,
)
function sessionLabel(s: HistSession): string {
  const bound = boundRoles(s).map((r) => displayName(r) || r)
  return `${s.harness ? `[${s.harness}] ` : ''}${(s.id.split('/').pop() || s.id).slice(0, 26)}…${bound.length ? ` ★${bound.join('/')}` : ''}`
}
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

function onFilter(): void {
  filterTouched.value = true
  if (!filtered.value.some((s) => s.id === sel.value)) pick(filtered.value[0]?.id ?? '')
}

function refreshAll(): void {
  void loadBindings()
  void loadSessions().then(() => {
    if (sel.value) pick(sel.value)
  })
}

onMounted(() => {
  refreshAll()
  // 当前接入模式对应的 harness 作为默认筛选（手动改过则不覆盖）
  api('/mode')
    .then(async (r) => {
      if (!r.ok || filterTouched.value) return
      const d = (await r.json()) as { mode?: string }
      filter.value = d.mode === 'claude' ? 'claude' : d.mode === 'codex' ? 'codex' : 'dsh'
      if (!filtered.value.some((s) => s.id === sel.value)) pick(filtered.value[0]?.id ?? '')
    })
    .catch(() => {})
})
</script>

<template>
  <section class="panel-box">
    <h2>
      会话管理
      <span class="h2-acts">
        <button class="mini" @click="refreshAll">刷新</button>
        <button class="mini" title="关闭" @click="emit('close')">✕</button>
      </span>
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

    <h3 class="hist-title">历史对话</h3>
    <div class="hist-bar">
      <select v-model="filter" title="历史会话来源筛选，默认跟随当前接入模式" @change="onFilter">
        <option value="">全部来源</option>
        <option value="@bound">已绑定（角色会话）</option>
        <option value="dsh">dsh</option>
        <option value="claude">claude</option>
        <option value="codex">codex</option>
      </select>
      <select v-model="sel" @change="pick(sel)">
        <option value="" disabled>选择会话…</option>
        <option v-for="s in filtered" :key="s.id" :value="s.id">
          {{ sessionLabel(s) }}（{{ new Date(s.mtime).toLocaleString() }}）
        </option>
      </select>
    </div>
    <div ref="body" class="hist-body">
      <div v-for="(it, i) in items" :key="i" class="hist-item" :class="'hist-' + it.kind">
        <template v-if="it.kind === 'turn'">— 第 {{ it.turn }} 轮 —</template>
        <template v-else>
          <span class="hist-kind">{{ it.kind === 'user' ? '你' : it.kind === 'error' ? '错误' : 'Agent' }}</span>
          <span v-if="it.kind === 'error'" class="hist-text">{{ it.text || '（空）' }}</span>
          <div v-else class="hist-md" v-html="md(it.text) || '（空）'" />
        </template>
      </div>
      <div v-if="!loading && items.length === 0" class="empty">选择会话后显示历史对话。</div>
    </div>
  </section>
</template>
