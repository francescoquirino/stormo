// Title bar (brand, command bar, window buttons) and the mode icon column.
import { $, esc, icon, ago } from './dom.js';
import { S, R, save, invalidate, activeWs } from './state.js';
import { brandMark } from './marks.js';
import { openMenu, openPopover, closeMenus } from './ui.js';
import { goTo } from './nav.js';
import { voiceSnapshot, stopAllVoice } from './voice.js';

const MODES = [
  { id: 'agent', label: 'Agent', icon: 'users', tip: 'Agent — teammates with their own chats, memory and routines · Ctrl+1' },
  { id: 'code', label: 'Code', icon: 'square-terminal', tip: 'Code — real terminals inside a folder · Ctrl+2' },
  { id: 'thread', label: 'Thread', icon: 'messages-square', tip: 'Thread — a coding conversation over a folder · Ctrl+3' },
  { id: 'auto', label: 'Auto', icon: 'sparkles', tip: 'Auto Mode — the director delegates on its own through the model router · Ctrl+4' },
];

export function setMode(mode) {
  if (S.ui.mode === mode) return;
  S.ui.mode = mode;
  save();
  invalidate('all');
}

export function renderTitlebar() {
  const el = $('#titlebar');
  const unread = S.notifications.some((n) => !n.read);
  el.innerHTML = `
    <div class="sidebar-band" data-hidden="${S.ui.sidebarHidden}">
      <span class="brand">${brandMark()}<span class="brand-name">Stormo</span></span>
    </div>
    <span class="titlebar-spacer"></span>
    <button class="command-bar" data-act="palette" data-tip="Commands and search (Ctrl+K)" aria-label="Command palette">
      ${icon('search')}<span class="command-text">Search or run a command…</span><kbd>Ctrl K</kbd>
    </button>
    <span class="titlebar-spacer"></span>
    <span class="chrome-band">
      ${(() => { const v = voiceSnapshot(); return `<button class="voice-live" id="voice-live" data-act="voice-stop" data-state="${v ? v.state : 'off'}" data-tip="Microphone on: click to stop" ${v ? '' : 'hidden'}><span class="voice-live-dot"></span><span class="voice-live-text">${v && v.state === 'loading' ? 'Loading voice…' : v && v.state === 'transcribing' ? 'Transcribing…' : 'Listening'}</span></button>`; })()}
      ${S.ui.mode === 'code' ? `<button class="chrome-btn" data-act="layout" data-tip="Pane layout" aria-label="Change pane layout">${icon('layout-grid')}</button>` : ''}
      <button class="chrome-btn" data-act="notifications" data-tip="Notifications" aria-label="Notifications">${icon('bell')}${unread ? '<span class="chrome-dot"></span>' : ''}</button>
      <button class="chrome-btn" data-act="toggle-side" data-on="${!S.ui.sideHidden}" data-tip="${S.ui.sideHidden ? 'Show' : 'Hide'} right panel (Ctrl+Shift+B)" aria-label="Toggle right sidebar">${icon('panel-right')}</button>
      <span class="win-sep"></span>
      <button class="win-btn" data-act="win-min" aria-label="Minimize">${icon('minus')}</button>
      <button class="win-btn" data-act="win-max" aria-label="Maximize">${icon('square')}</button>
      <button class="win-btn" data-role="close" data-act="win-close" aria-label="Close">${icon('x')}</button>
    </span>`;
  renderDock();
}

// Left icon column: the four modes, and the left panel toggle at the bottom.
function renderDock() {
  const el = $('#dock');
  if (!el) return;
  el.innerHTML = `
    <div class="dock-modes" role="radiogroup" aria-label="Mode">
      ${MODES.map((m) => `<button class="dock-mode" role="radio" aria-checked="${m.id === S.ui.mode}" data-on="${m.id === S.ui.mode}" data-mode="${m.id}" data-tip="${esc(m.tip)}">
        <span class="dock-icon">${icon(m.icon)}</span><span class="dock-label">${m.label}</span></button>`).join('')}
    </div>
    <span class="dock-spacer"></span>
    <button class="dock-mode dock-small" data-act="toggle-sidebar" data-on="${!S.ui.sidebarHidden}" data-tip="${S.ui.sidebarHidden ? 'Show' : 'Hide'} sidebar (Ctrl+B)" aria-label="Toggle sidebar"><span class="dock-icon">${icon('panel-left')}</span></button>`;
}

export function bindTitlebar(actions) {
  const el = $('#titlebar');
  const dock = $('#dock');
  if (dock) dock.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { setMode(m.dataset.mode); return; }
    if (e.target.closest('[data-act="toggle-sidebar"]')) actions.toggleSidebar();
  });
  el.addEventListener('dblclick', (e) => {
    if (e.target === el || e.target.classList.contains('titlebar-spacer')) window.fm.win.toggleMaximize();
  });
  el.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]');
    if (m) { setMode(m.dataset.mode); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'win-close') window.fm.win.close();
    else if (act === 'win-min') window.fm.win.minimize();
    else if (act === 'win-max') window.fm.win.toggleMaximize();
    else if (act === 'voice-stop') stopAllVoice();
    else if (act === 'toggle-sidebar') actions.toggleSidebar();
    else if (act === 'toggle-side') actions.toggleSide();
    else if (act === 'palette') actions.openPalette();
    else if (act === 'layout') layoutMenu(b);
    else if (act === 'notifications') notificationsPopover(b);
  });
}

function layoutMenu(anchor) {
  const ws = activeWs();
  if (!ws) { openMenu(anchor, [{ heading: 'Open a workspace first' }], { align: 'right' }); return; }
  const set = (layout) => { ws.layout = layout; ws.zoomed = null; save(); invalidate('center'); };
  openMenu(anchor, [
    { heading: 'Pane layout' },
    { label: 'Grid', icon: 'grid-2x2', on: ws.layout === 'grid' || !ws.layout, action: () => set('grid') },
    { label: 'Columns', icon: 'columns-2', on: ws.layout === 'columns', action: () => set('columns') },
    { label: 'Rows', icon: 'rows-2', on: ws.layout === 'rows', action: () => set('rows') },
    { label: 'Focus pane', icon: 'maximize-2', on: !!ws.zoomed, action: () => { ws.zoomed = ws.focus || (ws.panes[0] && ws.panes[0].id) || null; save(); invalidate('center'); } },
    { sep: true },
    { label: 'Tidy', icon: 'wand-sparkles', kbd: 'squares it up', action: () => set('grid') },
  ], { align: 'right' });
}

function notificationsPopover(anchor) {
  const list = S.notifications;
  const html = `<div class="popover-head"><span>Notifications</span>${list.length ? '<button data-clear>Clear all</button>' : ''}</div>
    <div class="popover-list scroll">${list.length ? list.map((n) => `
      <button class="notif" data-id="${n.id}" data-read="${n.read}"><span class="dot" data-state="needsYou"></span>
        <span class="notif-lines"><span class="notif-title">${esc(n.title)}</span><span class="notif-body">${esc(n.body || '')}</span></span>
        <span class="notif-at">${ago(n.at)}</span></button>`).join('')
      : '<div class="dash-empty">Nothing yet. When an agent finishes or needs you, it shows up here.</div>'}</div>`;
  openPopover(anchor, html, {
    onMount: (pop) => {
      pop.addEventListener('click', (e) => {
        if (e.target.closest('[data-clear]')) { S.notifications = []; save(); closeMenus(); invalidate('titlebar'); return; }
        const b = e.target.closest('.notif');
        if (!b) return;
        const n = S.notifications.find((x) => x.id === b.dataset.id);
        if (!n) return;
        n.read = true;
        closeMenus();
        if (n.target) goTo(n.target);
        save();
        invalidate('titlebar');
      });
      // Opening the list = having seen them.
      setTimeout(() => { S.notifications.forEach((n) => { n.read = true; }); save(); invalidate('titlebar'); }, 1500);
    },
  });
  R.lastNotifOpen = Date.now();
}
