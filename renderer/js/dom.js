// Small helpers for building the UI without a framework.
import { ICONS } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

export function icon(name, cls = '') {
  const inner = ICONS[name];
  if (!inner) return '';
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
}

export function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// "now", "3m", "2h", "1d" like in the demo.
export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 86400 * 30) return Math.round(s / 86400) + 'd';
  return Math.round(s / (86400 * 30)) + 'mo';
}

export function tokensLabel(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function basename(p) {
  if (!p) return '';
  const parts = String(p).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

// Lightweight tooltip for buttons with data-tip.
let tipEl = null;
let tipTarget = null;
let tipTimer = null;
export function installTooltips(root) {
  root.addEventListener('mouseover', (e) => {
    const t = e.target.closest('[data-tip]');
    clearTimeout(tipTimer);
    if (!t) { hideTip(); return; }
    tipTimer = setTimeout(() => showTip(t), 450);
  });
  root.addEventListener('mousedown', hideTip, true);
  root.addEventListener('mouseleave', hideTip);
}
function showTip(target) {
  hideTip();
  if (!document.body.contains(target)) return;
  tipTarget = target;
  tipEl = document.createElement('div');
  tipEl.className = 'tip';
  tipEl.textContent = target.getAttribute('data-tip');
  document.querySelector('.stage').appendChild(tipEl);
  const r = target.getBoundingClientRect();
  const tr = tipEl.getBoundingClientRect();
  let x = r.left + r.width / 2 - tr.width / 2;
  x = Math.max(6, Math.min(window.innerWidth - tr.width - 6, x));
  let y = r.bottom + 6;
  if (y + tr.height > window.innerHeight - 6) y = r.top - tr.height - 6;
  tipEl.style.left = x + 'px';
  tipEl.style.top = y + 'px';
}
function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) { tipEl.remove(); tipEl = null; }
  tipTarget = null;
}
// A button's text changed while its tooltip was open: fix it back up.
export function refreshTip(target) {
  if (tipEl && tipTarget === target && tipEl.textContent !== target.getAttribute('data-tip')) showTip(target);
}

export function toast(text, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.querySelector('.stage').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
