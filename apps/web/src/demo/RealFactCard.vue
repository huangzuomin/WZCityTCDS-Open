<template>
  <article class="panel proto-fact-card">
    <div class="proto-card-head">
      <span class="proto-id">{{ fact.code || `F-${fact.id}` }}</span>
      <ProtoChip :text="fact.dimension" kind="outline" />
    </div>
    <h3>{{ fact.statement }}</h3>
    <p>
      事实类型：{{ typeText(fact.factType) }} · 模型置信度（非可信度）{{ fact.confidence }}<br />
      时间语义：首次知悉 {{ fact.firstSeenAt || '—' }} · 最近核验 {{ fact.lastVerifiedAt || '—' }}<br />
      来源：{{ fact.evidences?.[0]?.sourceOrg || '—' }}
    </p>
    <span v-if="quote" class="proto-quote">引句：{{ quote }}</span>
    <div class="proto-card-foot">
      <ProtoChip :text="statusText(fact.status)" :kind="statusKind(fact.status)" />
      <slot name="foot" />
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ProtoChip from '@/demo/ProtoChip.vue';
import type { FactItem } from '@/api';

const props = defineProps<{ fact: FactItem }>();

type ChipKind = 'world' | 'knowledge' | 'warn' | 'blue' | 'note' | 'outline';

const typeText = (t: string) =>
  ({ current_state: '现行状态', source_claim: '来源主张', occurred: '发生事件' })[t] || t;
const statusText = (s: string) =>
  ({ active: '已生效', review: '待复核', superseded: '已被替换', disputed: '争议中', retired: '已退役' })[s] || s;
const statusKind = (s: string): ChipKind =>
  ({ active: 'world', review: 'warn', superseded: 'note', disputed: 'warn', retired: 'note' } as Record<
    string,
    ChipKind
  >)[s] ?? 'note';

/** 列表内联展示首条引句（无抽屉时用），超长截断 */
const quote = computed(() => {
  const q = props.fact.evidences?.[0]?.quote;
  if (!q) return '';
  return q.length > 120 ? `${q.slice(0, 120)}…` : q;
});
</script>
