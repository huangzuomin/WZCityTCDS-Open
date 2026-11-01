/** 前端导出工具（图谱页 PNG / JSON / CSV）——与后台同源实现，前台单独一份以免跨 app 耦合 */

/** 触发浏览器下载：把字符串内容作为文件保存 */
export function download(filename: string, content: string, mime = 'text/plain;charset=utf-8'): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const csvCell = (v: unknown): string => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** 导出 CSV（带表头），Excel 中文不乱码需加 BOM */
export function toCsv(filename: string, headers: string[], rows: unknown[][]): void {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  download(filename, `\uFEFF${lines.join('\r\n')}`, 'text/csv;charset=utf-8');
}

/**
 * 导出画布为 PNG。
 * vis-network 的画面来自 canvas，先铺一层白底再绘制，避免透明背景看起来是黑的。
 */
export function toPng(canvas: HTMLCanvasElement, filename: string): void {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  const url = out.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
