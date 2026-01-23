
export function el(tag, className, html) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (html !== undefined) n.innerHTML = html;
  return n;
}

export function qs(root, sel) {
  return root.querySelector(sel);
}

export function toast(root, text, ms=2200) {
  const t = root.querySelector('.toast');
  if (!t) return;
  t.textContent = text;
  t.style.opacity = '1';
  window.clearTimeout(toast._to);
  toast._to = window.setTimeout(()=>{ t.style.opacity='0'; }, ms);
}
