// Right sidebar: built-in browser (webview) and Dashboard for every agent.
import { $, esc, icon, uid, ago } from './dom.js';
import { S, R, save, invalidate } from './state.js';
import { mark, ENGINE_NAMES } from './marks.js';
import { face } from './faces.js';
import { openMenu } from './ui.js';
import { goTo } from './nav.js';
import { paneName, paneTask } from './code.js';

const views = new Map(); // tabId -> { el, kind, webview? }
const since = {};        // key -> when the state last changed
const lastState = {};

function stamp(key, state) {
  if (lastState[key] !== state) { lastState[key] = state; since[key] = Date.now(); }
  return since[key];
}

// ——— Activity list for the Dashboard ———
export function dashboardItems() {
  const items = [];
  for (const ws of S.workspaces) {
    for (const p of ws.panes) {
      const raw = R.ptyState[p.id] || 'idle';
      const state = raw === 'working' || raw === 'needsYou' ? raw : 'idle';
      items.push({ key: 'p' + p.id, state, since: stamp('p' + p.id, state), title: paneTask(p) || paneName(p),
        detail: `${ENGINE_NAMES[p.agent] || p.agent} · ${ws.name}`, markHtml: mark(p.agent),
        target: { mode: 'code', wsId: ws.id, paneId: p.id }, exited: raw === 'exited' || raw === 'failed' });
    }
  }
  const recent = Date.now() - 3 * 86400000;
  for (const t of [...S.threads, ...S.autoThreads]) {
    const state = t.status === 'working' || t.status === 'needsYou' ? t.status : 'idle';
    if (state === 'idle' && (t.updatedAt || 0) < recent) continue;
    const ws = S.workspaces.find((w) => w.id === t.wsId);
    items.push({ key: 't' + t.id, state, since: state === 'idle' ? t.updatedAt : stamp('t' + t.id, state),
      title: t.title || 'New thread', detail: `${ENGINE_NAMES[t.routerEngine || t.engine] || t.engine} · ${ws ? ws.name : t.kind === 'auto-thread' ? 'Auto Mode' : 'Thread'}`,
      markHtml: t.kind === 'auto-thread' ? icon('waypoints') : mark(t.engine), target: { mode: t.kind === 'auto-thread' ? 'auto' : 'thread', id: t.id } });
  }
  for (const a of S.agents) {
    for (const c of a.chats || []) {
      if (!c.turns || !c.turns.length) continue;
      let state = c.status === 'working' || c.status === 'needsYou' ? c.status : 'idle';
      if (state === 'idle' && c.unread) state = 'needsYou';
      if (state === 'idle' && (c.updatedAt || 0) < recent) continue;
      items.push({ key: 'c' + c.id, state, since: state === 'idle' ? c.updatedAt : stamp('c' + c.id, state),
        title: c.title || 'New chat', detail: `${a.name} · Agent`, markHtml: face(a.look, 18),
        target: { mode: 'agent', agentId: a.id, chatId: c.id }, review: c.unread && c.status !== 'working' && c.status !== 'needsYou' });
    }
  }
  return items;
}

export function needsYouCount() {
  return dashboardItems().filter((i) => i.state === 'needsYou').length;
}

function statusHtml(it) {
  if (it.state === 'working') return `<span class="dash-status" data-state="working"><span class="dot" data-state="working"></span>Working ${ago(it.since)}</span>`;
  if (it.state === 'needsYou') return `<span class="dash-status" data-state="needsYou"><span class="dot" data-state="needsYou"></span>${it.review ? 'Review' : 'Waiting on you'} ${ago(it.since)}</span>`;
  return `<span class="dash-status"><span class="dot" data-state="idle"></span>${it.exited ? 'Exited' : 'Ready'}</span>`;
}

function renderDashboard(el) {
  const items = dashboardItems();
  const groups = { needsYou: [], working: [], idle: [] };
  for (const it of items) groups[it.state].push(it);
  groups.working.sort((a, b) => a.since - b.since);
  groups.needsYou.sort((a, b) => a.since - b.since);
  groups.idle.sort((a, b) => (b.since || 0) - (a.since || 0));
  const f = R.dashFilter;
  const tally = (state, label) => `<button class="dash-tally" data-state="${state}" data-filter="${state}" data-on="${f === state}" ${groups[state].length ? '' : 'data-zero'}>
      <span class="dash-tally-head"><span class="dash-tally-dot"></span>${label}</span><span class="dash-tally-count">${groups[state].length}</span></button>`;
  const section = (state, label) => {
    if (f && f !== state) return '';
    const list = groups[state];
    if (!list.length) return '';
    return `<div class="dash-caption">${label} <span>${list.length}</span></div>`
      + list.map((it) => `<button class="dash-row" data-key="${it.key}"><span class="dash-mark">${it.markHtml}</span>
        <span class="dash-lines"><span class="dash-title">${esc(it.title)}</span><span class="dash-detail">${esc(it.detail)}</span></span>${statusHtml(it)}</button>`).join('');
  };
  const body = section('needsYou', 'Waiting on you') + section('working', 'Flying') + section('idle', 'Ready');
  el.innerHTML = `<div class="dash-tallies">${tally('needsYou', 'Waiting on you')}${tally('working', 'Flying')}${tally('idle', 'Ready')}</div>
    <div class="dash-list scroll">${body || `<div class="dash-empty">${items.length ? 'Nothing in this group.' : 'Every agent you run — terminals, threads and teammates — shows up here with what it is doing.'}</div>`}</div>`;
  el._items = items;
}

// ——— Browser ———
function normalizeUrl(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(s)) return 'http://' + s;
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(s) && !/\s/.test(s)) return 'https://' + s;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(s);
}

function browserView(tab) {
  const el = document.createElement('div');
  el.className = 'side-view';
  el.innerHTML = `<div class="side-toolbar">
      <span class="phead-nav"><button class="pbtn" data-b="back" data-tip="Back" aria-label="Back">${icon('arrow-left')}</button><button class="pbtn" data-b="fwd" data-tip="Forward" aria-label="Forward">${icon('arrow-right')}</button></span>
      <form class="url" data-b="go">${icon('globe')}<input spellcheck="false" placeholder="Search or enter address" value="${esc(tab.url || '')}"><button type="button" class="pbtn" data-b="reload" data-tip="Reload" aria-label="Reload">${icon('rotate-cw')}</button></form>
      <button class="pbtn" data-b="device" data-tip="Device: ${tab.device === 'mobile' ? 'Phone' : 'Desktop'}" aria-label="Device">${icon(tab.device === 'mobile' ? 'smartphone' : 'monitor')}</button>
      <button class="pbtn" data-b="external" data-tip="Open in your browser" aria-label="Open externally">${icon('external-link')}</button>
    </div><div class="web" data-device="${tab.device || 'desktop'}"></div>`;
  const v = { el, kind: 'browser', webview: null };
  const web = el.querySelector('.web');
  const input = el.querySelector('input');

  const showStart = () => {
    web.innerHTML = `<div class="side-start" style="background:var(--pane);height:100%">
      <strong>Preview your app</strong><p>Open a page next to your terminals — your dev server, docs, anything.</p>
      <div class="side-cards">
        ${[['http://localhost:3000', 'Next.js, React, Express'], ['http://localhost:5173', 'Vite'], ['http://localhost:8080', 'Other dev servers']]
          .map(([u, b]) => `<button class="side-card" data-open="${u}"><span class="side-card-icon">${icon('globe')}</span><span class="side-card-lines"><span class="side-card-name">${u.replace('http://', '')}</span><span class="side-card-blurb">${b}</span></span></button>`).join('')}
      </div></div>`;
    v.webview = null;
  };
  const load = (url) => {
    tab.url = url;
    input.value = url;
    save();
    if (!url) { showStart(); return; }
    if (!v.webview) {
      web.innerHTML = '';
      const wv = document.createElement('webview');
      wv.setAttribute('partition', 'persist:stormo-browser');
      wv.setAttribute('src', url);
      wv.addEventListener('did-navigate', (e) => { tab.url = e.url; if (document.activeElement !== input) input.value = e.url; save(); });
      wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { tab.url = e.url; if (document.activeElement !== input) input.value = e.url; save(); } });
      wv.addEventListener('page-title-updated', (e) => { tab.title = e.title; save(); renderStrip(); });
      wv.addEventListener('did-start-loading', () => { const f = web.querySelector('.web-fail'); if (f) f.remove(); });
      wv.addEventListener('did-fail-load', (e) => {
        if (!e.isMainFrame || e.errorCode === -3) return;
        const f = document.createElement('div');
        f.className = 'web-fail';
        const local = /localhost|127\.0\.0\.1/.test(e.validatedURL || '');
        f.innerHTML = `${icon('globe', 'empty-glyph')}<strong>${local ? 'Nothing is running here yet' : 'This page did not load'}</strong>
          <p>${local ? 'Start your dev server in a terminal pane, then reload.' : esc(e.errorDescription || 'Check the address and your connection.')}</p>
          <button class="ghost-btn" data-b="reload">${icon('rotate-cw')}Reload</button>`;
        web.appendChild(f);
      });
      web.appendChild(wv);
      v.webview = wv;
    } else {
      v.webview.loadURL(url).catch(() => {});
    }
  };
  el.addEventListener('submit', (e) => { e.preventDefault(); load(normalizeUrl(input.value)); input.blur(); });
  el.addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) { load(open.dataset.open); return; }
    const b = e.target.closest('[data-b]');
    if (!b || b.dataset.b === 'go') return;
    const wv = v.webview;
    const act = b.dataset.b;
    if (act === 'back' && wv && wv.canGoBack()) wv.goBack();
    else if (act === 'fwd' && wv && wv.canGoForward()) wv.goForward();
    else if (act === 'reload') { if (wv) wv.reload(); else if (tab.url) load(tab.url); }
    else if (act === 'external' && tab.url) window.fm.shell.openExternal(tab.url);
    else if (act === 'device') {
      tab.device = tab.device === 'mobile' ? 'desktop' : 'mobile';
      web.dataset.device = tab.device;
      b.innerHTML = icon(tab.device === 'mobile' ? 'smartphone' : 'monitor');
      b.dataset.tip = 'Device: ' + (tab.device === 'mobile' ? 'Phone' : 'Desktop');
      save();
    }
  });
  if (tab.url) load(tab.url); else showStart();
  v.load = load;
  return v;
}

// ——— Rendering ———
function renderStrip() {
  const strip = $('#side .side-pills');
  if (!strip) return;
  const count = needsYouCount();
  strip.innerHTML = S.side.tabs.map((t) => {
    const on = t.id === S.side.active;
    const title = t.kind === 'dashboard' ? 'Dashboard' : (t.title && t.title !== 'Browser' ? t.title : (t.url ? t.url.replace(/^https?:\/\//, '').replace(/\/$/, '') : 'Browser'));
    return `<div class="side-pill" data-tab="${t.id}" data-on="${on}" data-tip="${esc(t.kind === 'browser' ? (t.url || 'New browser') : 'Every agent, at a glance')}">
      <button class="side-pill-main">${icon(t.kind === 'dashboard' ? 'layout-grid' : 'globe')}<span class="side-pill-title">${esc(title)}</span>
      ${t.kind === 'dashboard' && count ? `<span class="side-count">${count}</span>` : ''}</button>
      <button class="pbtn side-pill-close" data-close-tab="${t.id}" aria-label="Close ${esc(title)}">${icon('x')}</button></div>`;
  }).join('');
}

export function renderSide() {
  const side = $('#side');
  side.dataset.hidden = String(!!S.ui.sideHidden);
  if (!side.querySelector('.side-strip')) {
    side.innerHTML = `<div class="side-strip"><div class="side-pills"></div>
      <button class="pbtn side-add" data-act="side-add" data-tip="Open in sidebar" aria-label="Open in sidebar">${icon('plus')}</button></div>
      <div class="side-body"></div>`;
  }
  renderStrip();
  const body = side.querySelector('.side-body');
  if (!S.side.tabs.find((t) => t.id === S.side.active)) S.side.active = S.side.tabs[0] ? S.side.tabs[0].id : null;
  for (const t of S.side.tabs) {
    if (!views.has(t.id)) {
      const v = t.kind === 'browser' ? browserView(t) : { el: Object.assign(document.createElement('div'), { className: 'side-view' }), kind: 'dashboard' };
      views.set(t.id, v);
      body.appendChild(v.el);
    }
  }
  for (const [id, v] of views) {
    if (!S.side.tabs.find((t) => t.id === id)) { v.el.remove(); views.delete(id); continue; }
    v.el.classList.toggle('hidden', id !== S.side.active);
  }
  const active = views.get(S.side.active);
  if (active && active.kind === 'dashboard') renderDashboard(active.el);
  if (!S.side.tabs.length) {
    body.innerHTML = `<div class="side-start"><strong>Nothing docked</strong><p>Open a browser or the dashboard beside your work.</p>
      <div class="side-cards"><button class="side-card" data-new="browser"><span class="side-card-icon">${icon('globe')}</span><span class="side-card-lines"><span class="side-card-name">Browser</span><span class="side-card-blurb">Preview localhost next to the code</span></span></button>
      <button class="side-card" data-new="dashboard"><span class="side-card-icon">${icon('layout-grid')}</span><span class="side-card-lines"><span class="side-card-name">Dashboard</span><span class="side-card-blurb">Every agent, and who needs you</span></span></button></div></div>`;
  } else {
    const empty = body.querySelector(':scope > .side-start');
    if (empty) empty.remove();
  }
}

function addTab(kind) {
  if (kind === 'dashboard') {
    const existing = S.side.tabs.find((t) => t.kind === 'dashboard');
    if (existing) { S.side.active = existing.id; save(); invalidate('side'); return; }
  }
  const t = { id: uid('side'), kind, url: '', title: kind === 'dashboard' ? 'Dashboard' : 'Browser' };
  S.side.tabs.push(t);
  S.side.active = t.id;
  S.ui.sideHidden = false;
  save();
  invalidate('side', 'titlebar');
}

export function openInBrowser(url) {
  let t = S.side.tabs.find((x) => x.kind === 'browser');
  if (!t) { addTab('browser'); t = S.side.tabs.find((x) => x.kind === 'browser'); }
  S.side.active = t.id;
  S.ui.sideHidden = false;
  renderSide();
  const v = views.get(t.id);
  if (v && v.load) v.load(url);
  invalidate('titlebar');
}

export function bindSide() {
  const side = $('#side');
  side.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close-tab]');
    if (close) {
      S.side.tabs = S.side.tabs.filter((t) => t.id !== close.dataset.closeTab);
      if (S.side.active === close.dataset.closeTab) S.side.active = S.side.tabs.length ? S.side.tabs[S.side.tabs.length - 1].id : null;
      save();
      invalidate('side');
      return;
    }
    const pill = e.target.closest('[data-tab]');
    if (pill) { S.side.active = pill.dataset.tab; save(); invalidate('side'); return; }
    const nw = e.target.closest('[data-new]');
    if (nw) { addTab(nw.dataset.new); return; }
    const add = e.target.closest('[data-act="side-add"]');
    if (add) {
      openMenu(add, [
        { label: 'New Browser', icon: 'globe', action: () => addTab('browser') },
        { label: 'Dashboard', icon: 'layout-grid', action: () => addTab('dashboard') },
      ], { align: 'right' });
      return;
    }
    const filter = e.target.closest('[data-filter]');
    if (filter) { R.dashFilter = R.dashFilter === filter.dataset.filter ? null : filter.dataset.filter; invalidate('side'); return; }
    const row = e.target.closest('.dash-row');
    if (row) {
      const view = views.get(S.side.active);
      const it = view && view.el._items && view.el._items.find((x) => x.key === row.dataset.key);
      if (it) goTo(it.target);
    }
  });
}

// The Dashboard shows "4m": we refresh it every 20 seconds.
setInterval(() => {
  const active = S.side && S.side.tabs && S.side.tabs.find((t) => t.id === S.side.active);
  if (active && active.kind === 'dashboard' && !S.ui.sideHidden) invalidate('side');
}, 20000);
