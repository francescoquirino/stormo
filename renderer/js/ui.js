// Dropdown menus, popovers and modal windows.
import { esc, icon, h } from './dom.js';

let openLayer = null;

export function closeMenus() {
  if (openLayer) { openLayer.remove(); openLayer = null; }
}

// items: [{label, icon?, markHtml?, kbd?, role?, on?, action}] | {sep:true} | {heading:'...'}
export function openMenu(anchor, items, { align = 'left', width } = {}) {
  closeMenus();
  const stage = document.querySelector('.stage');
  const layer = document.createElement('div');
  layer.className = 'layer';
  const menu = document.createElement('div');
  menu.className = 'menu';
  if (width) menu.style.width = width + 'px';
  menu.innerHTML = items.map((it, i) => {
    if (it.sep) return '<div class="menu-sep"></div>';
    if (it.heading) return `<div class="menu-label">${esc(it.heading)}</div>`;
    return `<button class="menu-item" data-i="${i}" ${it.role ? `data-role="${it.role}"` : ''} ${it.on ? 'data-on="true"' : ''} ${it.disabled ? 'disabled' : ''}>`
      + (it.markHtml || (it.icon ? icon(it.icon) : ''))
      + `<span>${esc(it.label)}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</button>`;
  }).join('');
  layer.appendChild(menu);
  stage.appendChild(layer);
  openLayer = layer;

  const r = anchor.getBoundingClientRect();
  const mr = menu.getBoundingClientRect();
  let x = align === 'right' ? r.right - mr.width : r.left;
  x = Math.max(8, Math.min(window.innerWidth - mr.width - 8, x));
  let y = r.bottom + 6;
  if (y + mr.height > window.innerHeight - 8) y = Math.max(8, r.top - mr.height - 6);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  layer.addEventListener('mousedown', (e) => { if (e.target === layer) closeMenus(); });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('.menu-item');
    if (!b) return;
    const it = items[+b.dataset.i];
    closeMenus();
    if (it && it.action) it.action();
  });
  return menu;
}

export function openPopover(anchor, html, { align = 'right', onMount } = {}) {
  closeMenus();
  const stage = document.querySelector('.stage');
  const layer = document.createElement('div');
  layer.className = 'layer';
  const pop = h(`<div class="popover">${html}</div>`);
  layer.appendChild(pop);
  stage.appendChild(layer);
  openLayer = layer;
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let x = align === 'right' ? r.right - pr.width : r.left;
  x = Math.max(8, Math.min(window.innerWidth - pr.width - 8, x));
  pop.style.left = x + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) closeMenus(); });
  if (onMount) onMount(pop);
  return pop;
}

// Modal window. Returns { el, close }.
export function openModal({ title, body, foot = '', wide = false, onMount, onClose, cls = '' }) {
  closeMenus();
  const stage = document.querySelector('.stage');
  const back = h(`<div class="modal-back"><div class="modal ${wide ? 'wide' : ''} ${cls}" role="dialog" aria-modal="true">
    ${title !== null ? `<div class="modal-head"><h2>${esc(title)}</h2><button class="chrome-btn" data-close aria-label="Close">${icon('x')}</button></div>` : ''}
    <div class="modal-body scroll">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </div></div>`);
  stage.appendChild(back);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  const api = { el: back.querySelector('.modal'), back, close };
  if (onMount) onMount(api);
  return api;
}

export function confirmBox({ title, text, ok = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const m = openModal({
      title,
      body: `<p style="font-size:12.5px;line-height:1.5;color:var(--ink-2)">${esc(text)}</p>`,
      foot: `<span class="spacer"></span><button class="ghost-btn" data-close>Cancel</button>`
        + `<button class="${danger ? 'ghost-btn' : 'primary-btn'}" ${danger ? 'data-role="destructive"' : ''} data-ok>${esc(ok)}</button>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    m.el.querySelector('[data-ok]').addEventListener('click', () => { answered = true; m.close(); resolve(true); });
  });
}
