<script setup lang="ts">
import { computed } from 'vue'
import { displayName, store } from '../store'
import { col, hm } from '../util'

// 选中某个 agent 时只显示它的事件；时间倒序（最新在上，不用滚动就能看到新事件）
const shown = computed(() => {
  const list = store.sel ? store.events.filter((e) => e.agentId === store.sel) : store.events
  return [...list].reverse()
})
const title = computed(() => {
  const base = `事件流（${shown.value.length}）`
  const sel = store.sel && store.agents.get(store.sel)
  return sel ? `${base} · ${displayName(sel.role) || sel.id.slice(0, 12)}` : base
})

</script>

<template>
  <aside>
    <h2>
      <span>{{ title }}</span>
      <button v-if="store.sel" @click="store.sel = null">显示全部</button>
    </h2>
    <div id="ev">
      <div v-for="e in shown" :key="e.key" class="ev">
        <span class="tm">{{ hm(e.t) }}</span>
        <span class="tt" :style="{ color: col(e.agentId) }">{{ e.type }}</span>
        {{ e.agentName }}
        <span class="pl">{{ e.outputOnly ? '（输出中，内容见卡片）' : e.sum }}</span>
      </div>
    </div>
  </aside>
</template>
