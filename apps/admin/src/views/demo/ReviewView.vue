<template>
  <section class="page active" aria-label="审核工作台">
    <div class="page-head">
      <div>
        <p class="eyebrow">HUMAN-IN-THE-LOOP</p>
        <h1>事实审核工作台</h1>
        <p>机器负责发现候选，编辑负责作出判断。每个审核动作都会写回生产库并留下依据。</p>
      </div>
      <span class="page-head-tag warn">真实写回生产库 · 谨慎操作</span>
    </div>

    <div class="review-grid">
      <div class="panel">
        <div class="panel-heading">
          <div>
            <h3>候选审核队列</h3>
            <p class="helper">选择条目查看事实与证据</p>
          </div>
          <span class="queue-badge">{{ drafts.length }} 条待审</span>
        </div>
        <div v-if="loading" class="empty-block">加载中…</div>
        <div v-else-if="!drafts.length" class="empty-block">当前无待审核候选。可在处置后重新加载。</div>
        <template v-else>
          <button
            v-for="d in drafts"
            :key="d.id"
            class="review-choice"
            :class="{ selected: selected?.id === d.id }"
            @click="selected = d"
          >
            <h4>{{ draftTitle(d) }}</h4>
            <p>{{ d.entityName || '未匹配实体' }} · {{ d.targetType }} · #{{ d.id }}</p>
            <span class="tag orange">待人工复核</span>
          </button>
        </template>
      </div>

      <div class="panel review-inspector">
        <div v-if="!selected" class="empty-block">暂无候选事实可审核</div>
        <template v-else>
          <div class="eyebrow">CLAIM UNDER REVIEW</div>
          <h3>{{ draftTitle(selected) }}</h3>
          <div class="drawer-stat">
            <span :class="['tag', typeColor(selected.targetType)]">{{ selected.targetType }}</span>
            <span class="tag orange">待人工复核</span>
            <span class="tag gray">#{{ selected.id }}</span>
          </div>
          <div class="inspector-label">候选主张（未经批准发布）</div>
          <div class="evidence-card">
            <strong>{{ statement(selected) }}</strong>
            <p>依据说明：{{ quote(selected) || '（无引句）' }}</p>
          </div>
          <div class="inspector-label">来源及关联</div>
          <div class="drawer-fact-meta">
            <span class="tag gray">{{ selected.articleTitle || '未知文章' }}</span>
            <span class="tag blue">{{ selected.entityName || '未匹配实体' }}</span>
          </div>
          <div class="inspector-label">审核理由（必填）</div>
          <textarea
            v-model="reason"
            class="review-reason"
            placeholder="例如：已核对原始报道与发布时间，确认其适用口径……"
          ></textarea>
          <div class="review-buttons">
            <button class="decision-btn approve" :disabled="busy" @click="decide('approved')">
              {{ busy ? '处理中…' : '确认通过' }}
            </button>
            <button class="decision-btn reject" :disabled="busy" @click="decide('rejected')">驳回候选</button>
          </div>
          <p class="helper">确认通过将写入事实库；驳回将标记草稿为 rejected。操作不可撤销。</p>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { demoToast } from '@/demo/demoUi';
import { pipelineApi, type ExtractionDraft } from '@/api';

const loading = ref(true);
const busy = ref(false);
const drafts = ref<ExtractionDraft[]>([]);
const selected = ref<ExtractionDraft | null>(null);
const reason = ref('');

const draftTitle = (d: ExtractionDraft) =>
  (d.payloadJson?.statement as string) ||
  (d.payloadJson?.description as string) ||
  (d.payloadJson?.name as string) ||
  d.articleTitle ||
  `草稿 #${d.id}`;
const statement = (d: ExtractionDraft) => (d.payloadJson?.statement as string) || draftTitle(d);
const quote = (d: ExtractionDraft) => {
  // 事实草稿的引句挂在 payload_json.evidence.quote 下（spanStart/spanEnd 为其在原文中的位置）
  const ev = d.payloadJson?.evidence as { quote?: string } | undefined;
  return ev?.quote || (d.payloadJson?.quote as string) || '';
};

const typeColor = (t: string) => ({ fact: 'blue', relation: 'purple', event: 'orange', entity: 'teal' })[t] || 'gray';

const load = async (keepId?: number) => {
  loading.value = true;
  try {
    const res = await pipelineApi.listDrafts({ status: 'pending', targetType: 'fact', pageSize: 50 });
    drafts.value = res.items;
    selected.value = res.items.find((d) => d.id === keepId) ?? res.items[0] ?? null;
    reason.value = '';
  } catch {
    drafts.value = [];
    selected.value = null;
  } finally {
    loading.value = false;
  }
};

const currentId = computed(() => selected.value?.id ?? 0);

async function decide(action: 'approved' | 'rejected') {
  const d = selected.value;
  if (!d) return;
  if (!reason.value.trim()) {
    demoToast('请填写审核理由');
    return;
  }
  busy.value = true;
  try {
    if (action === 'approved') {
      await pipelineApi.approveDraft(d.id, {
        statement: (d.payloadJson?.statement as string) || undefined,
        note: reason.value.trim(),
      });
      demoToast('已通过并写回事实库');
    } else {
      await pipelineApi.rejectDraft(d.id, reason.value.trim());
      demoToast('已驳回该候选');
    }
    const next = drafts.value.filter((x) => x.id !== d.id);
    drafts.value = next;
    selected.value = next[0] ?? null;
    reason.value = '';
  } catch {
    // 拦截器已给出错误提示
  } finally {
    busy.value = false;
  }
}

onMounted(() => load(currentId.value));
</script>
