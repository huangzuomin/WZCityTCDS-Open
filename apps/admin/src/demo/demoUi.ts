import { ref } from 'vue';

/** 演示后台的轻量 toast（与 docs/demo 的 toast 行为一致） */
export const toastText = ref('');
let toastTimer: number | undefined;

export function demoToast(msg: string, ms = 2300) {
  toastText.value = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastText.value = '';
  }, ms);
}

/** 抽屉内容按 demo 的 HTML 片段渲染，转义后再拼串 */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

