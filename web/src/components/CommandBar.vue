<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { store } from '../store'
import { conn, sendCommand, setTaskId } from '../conn'
import { hm } from '../util'

// 已知 session 按最后活动时间倒序
const sessions = computed(() =>
  Object.entries(store.sessions).sort((a, b) => b[1] - a[1]),
)

// session 选择随 agent 工具（后端）各自记忆：挂载时恢复该后端上次的选择，变化即持久化
onMounted(() => {
  if (conn.taskId) store.cmd.taskId = conn.taskId
})
watch(
  () => store.cmd.taskId,
  (id) => setTaskId(id),
)

const ACTIONS = [
  { c: 'task.assigned', label: '派发', pri: true },
  { c: 'review.requested', label: '请求评审', pri: false },
  { c: 'task.rejected', label: '打回', pri: false },
  { c: 'task.cancel', label: '中断', pri: false },
] as const

// 自定义下拉：原生 <datalist> 的弹出位置在某些环境下会渲染到视口外
const open = ref(false)
// 建议列表 = 服务端预置角色（/meta，含中文名）+ master + 已出现过的 agent 角色
const roles = computed(() => {
  const seen = new Set<string>()
  if (store.meta.master) seen.add(store.meta.master)
  for (const r of store.meta.roles) seen.add(r.name)
  for (const x of store.agents.values()) if (x.role) seen.add(x.role)
  return [...seen].sort((a, b) => a.localeCompare(b))
})
const labelOf = (name: string): string => {
  if (name === store.meta.master) return `${name}（编排入口）`
  return store.meta.roles.find((r) => r.name === name)?.label ?? name
}
const filtered = computed(() => {
  const q = store.cmd.to.trim()
  if (!q) return roles.value
  return roles.value.filter((r) => r.includes(q) || labelOf(r).includes(q))
})

function pick(r: string): void {
  store.cmd.to = r
  open.value = false
}

async function send(c: string): Promise<void> {
  const to = store.cmd.to.trim()
  if (!to) {
    store.status = '请先填写角色名'
    store.statusOk = false
    return
  }
  await sendCommand(c, to)
}
</script>

<template>
  <div class="ctl">
    <div class="role-wrap">
      <input
        id="role"
        v-model="store.cmd.to"
        placeholder="角色名"
        aria-label="角色名"
        autocomplete="off"
        @focus="open = true"
        @input="open = true"
        @blur="open = false"
        @keydown.escape="open = false"
        @keydown.enter.prevent="filtered.length > 0 && pick(filtered[0]!)"
      />
      <ul v-if="open && filtered.length > 0" class="suggest">
        <li v-for="r in filtered" :key="r">
          <button type="button" @mousedown.prevent="pick(r)">{{ labelOf(r) }}</button>
        </li>
      </ul>
    </div>
    <select id="tid" v-model="store.cmd.taskId" aria-label="目标 session" title="目标 session：新流水线出现时自动切到最新">
      <option value="">（默认 / 不指定）</option>
      <option v-for="[id, t] in sessions" :key="id" :value="id">{{ id }}（{{ hm(t) }}）</option>
    </select>
    <input id="txt" v-model="store.cmd.text" placeholder="任务内容或评审意见" aria-label="内容" />
    <button v-for="a in ACTIONS" :key="a.c" :class="{ pri: a.pri }" @click="send(a.c)">
      {{ a.label }}
    </button>
  </div>
</template>
