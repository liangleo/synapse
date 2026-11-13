<script setup lang="ts">
import { computed } from 'vue'
import { sendCommand } from '../conn'
import { STATUS_LABEL, displayName, store, type AgentView } from '../store'
import { col, nm } from '../util'

const props = defineProps<{ agent: AgentView; step?: number }>()

const cls = computed(() => [
  'card',
  `s-${props.agent.s}`,
  {
    m: !props.agent.parent,
    sel: store.sel === props.agent.id,
    // 终态（ended/done/failed/idle）卡片弱化显示，视觉焦点留给进行中的作业
    end: Boolean(props.agent.ended || props.agent.s === 'done' || props.agent.s === 'failed' || props.agent.s === 'idle'),
  },
])
const pct = computed(() =>
  props.agent.steps < 0 ? 100 : Math.round(100 * (1 - 1 / (1 + props.agent.steps * 0.5))),
)
const recentLog = computed(() => props.agent.log.slice(-4))
// master 卡不显示操作按钮（编排中止通过卡住的那一步操作）；
// 只有忙碌中的作业可打回/中断——终态（idle/done/failed）没有活动作业，操作只会得到 hub 报错
const actionable = computed(
  () =>
    Boolean(props.agent.role) &&
    props.agent.role !== store.meta.master &&
    (props.agent.s === 'thinking' || props.agent.s === 'working'),
)

function act(type: string): void {
  void sendCommand(type, props.agent.role!)
}

function toggleSel(): void {
  store.sel = store.sel === props.agent.id ? null : props.agent.id
  if (props.agent.role) store.cmd.to = props.agent.role
}
</script>

<template>
  <div
    :class="cls"
    :style="{ '--c': col(agent.id) }"
    role="button"
    tabindex="0"
    @click="toggleSel"
    @keydown.enter.prevent="toggleSel"
    @keydown.space.prevent="toggleSel"
  >
    <div class="top">
      <span class="bot">
        <svg viewBox="0 0 28 28" width="30" height="30" aria-hidden="true">
          <line x1="14" y1="3" x2="14" y2="7" stroke="currentColor" stroke-width="2" />
          <circle cx="14" cy="3" r="2" fill="currentColor" />
          <rect x="3" y="7" width="22" height="17" rx="5" fill="currentColor" />
          <circle cx="10" cy="15" r="2.6" fill="#fff" />
          <circle cx="18" cy="15" r="2.6" fill="#fff" />
        </svg>
      </span>
      <b :title="agent.role">{{ displayName(agent.role) || nm(agent) }}</b>
      <span v-if="step" class="hb" title="流水线步骤">#{{ step }}</span>
      <span v-if="agent.h && !agent.h.startsWith('mock')" class="hb" :title="agent.h">{{ agent.h }}</span>
      <span class="pill" :data-s="agent.s">{{ STATUS_LABEL[agent.s] }}</span>
    </div>
    <div class="job">{{ agent.job }}</div>
    <div class="bar"><i :style="{ transform: `scaleX(${pct / 100})` }" /></div>
    <div class="out" :hidden="!agent.out">{{ agent.out }}</div>
    <div class="lg">
      <div v-for="(l, i) in recentLog" :key="i">{{ l }}</div>
    </div>
    <div v-if="actionable" class="card-actions" @click.stop>
      <button class="mini" @click="act('task.rejected')">打回</button>
      <button class="mini" @click="act('task.cancel')">中断</button>
    </div>
  </div>
</template>
