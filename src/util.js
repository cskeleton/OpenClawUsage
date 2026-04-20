/**
 * 前端共享工具：HTML 转义、Toast 提示。
 * 仪表盘与价格页共用，避免重复实现。
 */

/**
 * 将任意值转为 HTML 安全字符串（textContent 语义）。
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

/**
 * 转义可直接用于 HTML attribute 的字符串。
 * @param {unknown} s
 * @returns {string}
 */
export function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

let toastTimer = null;

/**
 * 显示短暂 toast。variant 控制视觉强调（默认 info）。
 * @param {string} message
 * @param {{ variant?: 'info' | 'error' | 'success', duration?: number }} [options]
 */
export function showToast(message, options = {}) {
  const el = document.getElementById('pricing-toast');
  if (!el) return;
  const { variant = 'info', duration = 2200 } = options;
  el.textContent = message;
  el.classList.remove('pricing-toast--error', 'pricing-toast--success');
  if (variant === 'error') el.classList.add('pricing-toast--error');
  if (variant === 'success') el.classList.add('pricing-toast--success');
  el.hidden = false;
  el.classList.add('pricing-toast--visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('pricing-toast--visible');
    el.hidden = true;
  }, duration);
}
