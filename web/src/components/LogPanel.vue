<script setup lang="ts">
import { onUnmounted, ref } from 'vue'
import { api } from '../conn'

const emit = defineEmits<{ close: [] }>()
const lines = ref<string[]>([])
let pollTimer: ReturnType<typeof setInterval> | undefined

async function poll(): Promise<void> {
  try {
    const r = await api('/logs')
    if (r.ok) {
      const d = (await r.json()) as { lines?: string[] }
      lines.value = [...(d.lines ?? [])].reverse() // 最新日志置顶
    }
  } catch {
    /* 后端不可达时保持上次内容 */
  }
}

poll()
pollTimer = setInterval(poll, 3000)
onUnmounted(() => clearInterval(pollTimer))
</script>

<template>
  <section class="panel-box">
    <h2>
      <span>服务端日志（panel.log）</span>
      <span class="h2-acts"><button class="mini" title="关闭" @click="emit('close')">✕</button></span>
    </h2>
    <pre ref="body" class="logview">{{ lines.join('\n') || '（暂无日志）' }}</pre>
  </section>
</template>
