/**
 * 极简轻提示（公开前台不引 UI 库，所以自带一个 3 秒自动消失的浮层）。
 * 用法：toast('画布未就绪')
 */
export function toast(message: string): void {
  if (typeof document === 'undefined' || !message) return;
  const el = document.createElement('div');
  el.className = 'ssot-toast';
  el.textContent = message;
  el.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:72px',
    'transform:translateX(-50%)',
    'z-index:9999',
    'max-width:70vw',
    'padding:8px 14px',
    'border-radius:6px',
    'background:rgba(28,36,48,.92)',
    'color:#fff',
    'font-size:13px',
    'line-height:1.5',
    'box-shadow:0 4px 16px rgba(0,0,0,.18)',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
