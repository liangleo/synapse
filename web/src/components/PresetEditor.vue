<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { api } from '../conn'

interface RoleConfig {
  provider: string
  model: string
  label?: string
  prompt?: string
}
interface PresetView extends RolePresetShape {
  builtin?: boolean
  overridden?: boolean // 内置预设存在本地覆盖
}
interface RolePresetShape {
  roles: Record<string, RoleConfig>
  pipeline: string[]
}

const loading = ref(false)
const msg = ref('')
const presets = ref<Record<string, PresetView>>({})
const activeName = ref('')
const editingName = ref('')
const newPresetName = ref('')
const newRoleName = ref('')

// 编辑草稿（深拷贝，改完点保存才落盘）
const draft = reactive<RolePresetShape>({ roles: {}, pipeline: [] })
const expanded = ref('') // 当前展开提示词的角色名

const builtin = computed(() => presets.value[editingName.value]?.builtin ?? false)
// 角色库按字母排序展示
const sortedRoles = computed(() =>
  Object.entries(draft.roles).sort(([a], [b]) => a.localeCompare(b)),
)

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await api('/presets')
    const data = (await r.json()) as { active: string; presets: Record<string, PresetView> }
    presets.value = data.presets ?? {}
    activeName.value = data.active ?? ''
    if (!editingName.value) edit(data.active || Object.keys(data.presets)[0] || '')
  } catch (err) {
    msg.value = `加载失败：${(err as Error).message}`
  } finally {
    loading.value = false
  }
}

function edit(name: string): void {
  editingName.value = name
  const p = presets.value[name]
  draft.roles = JSON.parse(JSON.stringify(p?.roles ?? {}))
  draft.pipeline = [...(p?.pipeline ?? [])]
  expanded.value = ''
  msg.value = ''
}

async function save(asNew = false): Promise<void> {
  const name = (asNew ? newPresetName.value : editingName.value).trim()
  if (!name) {
    msg.value = '请填写预设名'
    return
  }
  try {
    const r = await api(`/presets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ roles: draft.roles, pipeline: draft.pipeline }),
    })
    msg.value = r.ok ? `已保存并持久化：${name}` : `保存失败：${await r.text()}`
    if (r.ok) {
      if (asNew) newPresetName.value = ''
      await load()
      edit(name)
    }
  } catch (err) {
    msg.value = `保存失败：${(err as Error).message}`
  }
}

async function activate(): Promise<void> {
  try {
    const r = await api('/preset/active', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: editingName.value }),
    })
    msg.value = r.ok
      ? `已激活 ${editingName.value}（下次派发生效，重启后仍生效）`
      : `激活失败：${await r.text()}`
    if (r.ok) activeName.value = editingName.value
  } catch (err) {
    msg.value = `激活失败：${(err as Error).message}`
  }
}

async function remove(name: string): Promise<void> {
  try {
    const r = await api(`/presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
    msg.value = r.ok ? `已删除 ${name}` : `删除失败：${await r.text()}`
    if (r.ok) {
      editingName.value = ''
      await load()
      edit(activeName.value || Object.keys(presets.value)[0] || '')
    }
  } catch (err) {
    msg.value = `删除失败：${(err as Error).message}`
  }
}

// 恢复默认值 = 删除内置预设的本地覆盖（DELETE 对内置预设即此语义）
const canReset = computed(
  () => builtin.value && presets.value[editingName.value]?.overridden === true,
)

async function resetToDefault(): Promise<void> {
  const name = editingName.value
  try {
    const r = await api(`/presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
    msg.value = r.ok ? `已恢复出厂默认：${name}` : `恢复失败：${await r.text()}`
    if (r.ok) {
      await load()
      edit(name)
    }
  } catch (err) {
    msg.value = `恢复失败：${(err as Error).message}`
  }
}

function addRole(): void {
  const name = newRoleName.value.trim()
  if (!name) return
  if (draft.roles[name]) {
    msg.value = `角色 ${name} 已存在`
    return
  }
  draft.roles[name] = { provider: '', model: '', label: '', prompt: '' }
  newRoleName.value = ''
  expanded.value = name
}

function removeRole(name: string): void {
  delete draft.roles[name]
  draft.pipeline = draft.pipeline.filter((s) => s !== name)
}

// ---------- 拖拽：角色库 → 流水线追加；流水线内拖动排序 ----------
const dragRole = ref('') // 角色库中正在拖动的角色名
const dragIndex = ref(-1) // 流水线中正在拖动的位置

function dropAt(i: number): void {
  if (dragRole.value) {
    draft.pipeline.splice(i, 0, dragRole.value)
    dragRole.value = ''
  } else if (dragIndex.value >= 0) {
    const [moved] = draft.pipeline.splice(dragIndex.value, 1)
    draft.pipeline.splice(i > dragIndex.value ? i - 1 : i, 0, moved)
    dragIndex.value = -1
  }
}

onMounted(load)
</script>

<template>
  <div class="editor">
    <div class="ed-bar">
      <select :value="editingName" @change="edit(($event.target as HTMLSelectElement).value)">
        <option v-for="(p, name) in presets" :key="name" :value="name">
          {{ name }}{{ p.builtin ? '（内置）' : '' }}{{ name === activeName ? ' ✓激活中' : '' }}
        </option>
      </select>
      <input v-model="newPresetName" placeholder="新预设名" class="ed-name" />
      <button class="pri" @click="save()">保存</button>
      <button @click="save(true)">另存为新预设</button>
      <button @click="activate()">激活此预设</button>
      <button v-if="canReset" @click="resetToDefault()">恢复默认值</button>
      <button v-if="editingName && !builtin" @click="remove(editingName)">删除</button>
      <span class="ed-msg" :class="{ ok: msg.startsWith('已') }">{{ msg }}</span>
    </div>
    <div class="ed-body">
      <div class="ed-roles">
        <h3>角色库（拖到右侧流水线）</h3>
        <div
          v-for="[name, cfg] in sortedRoles"
          :key="name"
          class="role-chip"
          draggable="true"
          @dragstart="dragRole = String(name)"
          @dragend="dragRole = ''"
        >
          <div class="role-head">
            <b>{{ name }}</b>
            <input
              v-model="cfg.label"
              class="ed-model ed-label"
              placeholder="中文名"
              title="界面显示名"
            />
            <input v-model="cfg.provider" class="ed-model ed-provider" title="provider" />
            <input v-model="cfg.model" class="ed-model" title="模型" />
            <button class="mini" @click="expanded = expanded === name ? '' : String(name)">
              {{ expanded === name ? '收起' : '提示词' }}
            </button>
            <button class="mini danger" @click="removeRole(String(name))">✕</button>
          </div>
          <textarea
            v-if="expanded === name"
            v-model="cfg.prompt"
            rows="3"
            placeholder="角色提示词（systemPrompt persona section）"
          />
        </div>
        <div class="add-role">
          <input v-model="newRoleName" placeholder="新角色名" @keydown.enter="addRole" />
          <button @click="addRole">添加角色</button>
        </div>
      </div>
      <div class="ed-pipeline">
        <h3>流水线（拖入角色，拖动排序）</h3>
        <ol @dragover.prevent @drop="dropAt(draft.pipeline.length)">
          <li
            v-for="(step, i) in draft.pipeline"
            :key="i"
            draggable="true"
            @dragstart="dragIndex = i"
            @dragend="dragIndex = -1"
            @dragover.prevent
            @drop.stop="dropAt(i)"
          >
            <span class="step-no">{{ i + 1 }}</span>
            {{ draft.roles[step]?.label || step }}
            <button class="mini danger" @click="draft.pipeline.splice(i, 1)">✕</button>
          </li>
          <li v-if="draft.pipeline.length === 0" class="drop-tail">把角色拖到这里</li>
        </ol>
      </div>
    </div>
    <p v-if="loading" class="ed-msg">加载中…</p>
  </div>
</template>
