<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { displayName, store } from '../store'
import { col, hm } from '../util'

const box = ref<HTMLElement | null>(null)

// 选中某个 agent 时只显示它的事件
const shown = computed(() =>
  store.sel ? store.events.filter((e) => e.agentId === store.sel) : store.events,
)
const title = computed(() => {
  const base = `事件流（${shown.value.length}）`
  const sel = store.sel && store.agents.get(store.sel)
  return sel ? `${base} · ${displayName(sel.role) || sel.id.slice(0, 12)}` : base
})

watch(
  () => shown.value.length,
  () => nextTick(() => box.value?.scrollTo({ top: 1e9 })),
)
</script>

<template>
  <aside>
    <h2>
      <span>{{ title }}</span>
      <button v-if="store.sel" @click="store.sel = null">显示全部</button>
    </h2>
    <div id="ev" ref="box">
      <div v-for="e in shown" :key="e.key" class="ev">
        <span class="tm">{{ hm(e.t) }}</span>
        <span class="tt" :style="{ color: col(e.agentId) }">{{ e.type }}</span>
        {{ e.agentName }}
        <span class="pl">{{ e.outputOnly ? '（输出中，内容见卡片）' : e.sum }}</span>
      </div>
    </div>
  </aside>
</template>
