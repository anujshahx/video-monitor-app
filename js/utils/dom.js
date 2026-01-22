export function el(tag, className, html) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

export function qs(root, sel) {
  return root.querySelector(sel);
}

export function toast(root, text, ms=3000) {
  const t = root.querySelector('.toast');
  if (!t) return;
  t.textContent = text;
  t.classList.add('show');
  window.clearTimeout(toast._to);
  toast._to = window.setTimeout(()=>t.classList.remove('show'), ms);
}
