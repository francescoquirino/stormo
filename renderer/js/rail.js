// Left column: changes with the mode (Workspaces / Agents / Threads) + account footer.
import { $, esc, icon, ago } from './dom.js';
import { S, R, save, invalidate, installedEngines } from './state.js';
import { mark } from './marks.js';
import { face } from './faces.js';
import { openFolder, closeWorkspace, closePane, paneName, focusTerminal } from './code.js';
import { convRunning } from './chat.js';

function workspacesHtml() {
  if (!S.workspaces.length) {
    return '<p class="rail-empty">No workspaces yet. Press + to open a folder — each workspace is a folder on your PC.</p>';
  }
  return S.workspaces.map((ws) => {
    const on = ws.id === S.activeWs;
    const open = ws.open !== false;
    const count = ws.panes.length;
    const panes = open ? ws.panes.map((p) => {
      const st = R.ptyState[p.id] || 'idle';
      const focused = on && ws.focus === p.id;
      return `<button class="row row-tab" data-pane="${p.id}" data-ws="${ws.id}" data-on="${focused}">
        <span class="dot" data-state="${st}"></span><span class="row-label">${esc(paneName(p))}</span>
        <span class="row-trailing"><span class="row-hover"><span class="row-mini" data-role="destructive" data-act="close-pane" data-tip="Close pane">${icon('x')}</span></span></span></button>`;
    }).join('') : '';
    return `<div>
      <button class="row row-ws" data-ws="${ws.id}" data-on="${on && !(open && ws.focus && ws.panes.some((p) => p.id === ws.focus))}" data-tip="${esc(ws.path)}">
        <span class="row-label">${esc(ws.name)}</span>
        <span class="row-trailing">
          <span class="row-rest">${count ? `${icon('chevron-right', 'row-caret').replace('<svg ', `<svg data-open="${open}" `)}<span class="row-badge">${count}</span>` : ''}</span>
          <span class="row-hover"><span class="row-mini" data-act="new-pane" data-tip="New pane">${icon('plus')}</span><span class="row-mini" data-role="destructive" data-act="close-ws" data-tip="Close workspace">${icon('x')}</span></span>
        </span></button>${panes}</div>`;
  }).join('');
}

function agentStatus(a) {
  const chats = a.chats || [];
  if (chats.some((c) => convRunning(c))) return 'working';
  if (chats.some((c) => c.status === 'needsYou')) return 'needsYou';
  if (chats.some((c) => c.status === 'failed' && c.unread)) return 'failed';
  return null;
}

function agentsHtml() {
  if (!S.agents.length) {
    return '<p class="rail-empty">No agents yet. Press + to name a teammate, give it a brief and a routine.</p>';
  }
  const pinned = S.agents.filter((a) => a.pinned);
  const rest = S.agents.filter((a) => !a.pinned);
  const hero = pinned.length === 1;
  const pinnedHtml = pinned.length ? `<div class="pinned" data-hero="${hero}"><div class="pinned-grid">${pinned.map((a) =>
    `<button class="pinned-cell" data-agent="${a.id}" data-on="${a.id === S.activeAgent}">${face(a.look, hero ? 57 : 40, agentStatus(a))}<span class="pinned-name">${esc(a.name)}</span></button>`).join('')}</div>
    ${rest.length ? '<span class="pinned-rule"></span>' : ''}</div>` : '';
  const roster = rest.map((a) => {
    const st = agentStatus(a);
    const chats = a.chats || [];
    const last = chats.slice().sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))[0];
    const unread = chats.filter((c) => c.unread).length;
    const rest2 = st === 'working' ? '<span class="row-status" data-state="working">Working</span>'
      : st === 'needsYou' ? '<span class="row-status" data-state="needsYou">Waiting on you</span>'
        : unread ? `<span class="row-badge" data-live>${unread}</span>`
          : last ? `<span class="row-stamp">${ago(last.updatedAt)}</span>` : '';
    const sub = last ? (last.title || 'New chat') : (a.routine && a.routine.kind !== 'off' ? routineText(a.routine) : 'No chats yet');
    return `<div class="agent-row-wrap"><button class="row row-agent" data-agent="${a.id}" data-on="${a.id === S.activeAgent}">
      ${face(a.look, 30, st)}<span class="row-lines"><span class="row-top"><span class="row-label">${esc(a.name)}</span><span class="row-rest">${rest2}</span></span>
      <span class="row-sub">${esc(sub)}</span></span></button>
      <span class="agent-row-actions"><button class="row-mini" data-act="pin-agent" data-agent="${a.id}" data-tip="Pin">${icon('pin')}</button>
      <button class="row-mini" data-role="destructive" data-act="delete-agent" data-agent="${a.id}" data-tip="Delete">${icon('trash-2')}</button></span></div>`;
  }).join('');
  return pinnedHtml + `<div class="roster">${roster}</div>`;
}

export function routineText(r) {
  if (!r || r.kind === 'off') return 'No routine';
  if (r.kind === 'daily') return `Every day at ${r.at || '09:00'}`;
  const m = +r.minutes || 60;
  return m % 60 === 0 ? `Every ${m / 60 === 1 ? 'hour' : m / 60 + ' hours'}` : `Every ${m} minutes`;
}

function threadRow(t) {
  const st = convRunning(t) ? 'working' : (t.status === 'needsYou' ? 'needsYou' : t.status === 'failed' ? 'failed' : 'idle');
  return `<button class="row row-tab" data-thread="${t.id}" data-on="${t.id === (S.ui.mode === 'auto' ? S.activeAuto : S.activeThread)}" style="padding-left:${t._group ? 28 : 8}px">
    <span class="dot" data-state="${st}"></span><span class="row-label">${esc(t.title || 'New thread')}</span>
    <span class="row-trailing"><span class="row-rest"><span class="row-stamp">${ago(t.updatedAt || t.createdAt)}</span></span>
    <span class="row-hover"><span class="row-mini" data-act="pin-thread" data-thread="${t.id}" data-tip="${t.pinned ? 'Unpin' : 'Pin'}">${icon(t.pinned ? 'pin-off' : 'pin')}</span>
    <span class="row-mini" data-role="destructive" data-act="delete-thread" data-thread="${t.id}" data-tip="Delete">${icon('trash-2')}</span></span></span></button>`;
}

function threadList() { return S.ui.mode === 'auto' ? S.autoThreads : S.threads; }

function threadsHtml() {
  const threads = threadList();
  if (!threads.length) {
    return '<p class="rail-empty">No threads yet. Press + to start one — on its own or over a workspace folder.</p>';
  }
  const byTime = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const pinned = threads.filter((t) => t.pinned).sort(byTime);
  let html = '';
  if (pinned.length) html += '<p class="caption">Pinned</p>' + pinned.map((t) => threadRow({ ...t, _group: false })).join('');
  const groups = new Map();
  for (const t of threads.filter((x) => !x.pinned).sort(byTime)) {
    const key = t.wsId && S.workspaces.find((w) => w.id === t.wsId) ? t.wsId : '_none';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [key, list] of groups) {
    const ws = S.workspaces.find((w) => w.id === key);
    const name = ws ? ws.name : 'No folder';
    html += `<div><button class="row row-ws" data-thread-ws="${key}"><span class="row-label">${esc(name)}</span>
      <span class="row-trailing"><span class="row-rest">${icon('folder', 'row-caret')}</span><span class="row-hover"><span class="row-mini" data-act="new-thread-in" data-ws="${key}" data-tip="New thread here">${icon('plus')}</span></span></span></button>
      ${list.map((t) => threadRow({ ...t, _group: true })).join('')}</div>`;
  }
  return html;
}

function footerHtml() {
  const name = (S.profile.name || 'You').trim() || 'You';
  const ready = installedEngines().length;
  const lim = R.limits;
  const meta = lim && isFinite(lim.fiveHour)
    ? `· 5h ${Math.round(lim.fiveHour * 100)}% · wk ${Math.round((lim.sevenDay || 0) * 100)}%`
    : `· ${ready} ready`;
  return `<span class="footer-rule"></span><div class="account">
    <span class="avatar">${esc(name[0].toUpperCase())}</span>
    <button class="account-lines" data-act="settings" data-tip="Your subscriptions, logins and settings"><span class="account-meta"><span class="account-tier">${esc(name.toUpperCase().slice(0, 10))}</span><span class="account-credits">${esc(meta)}</span></span></button>
    <span class="account-actions">
      <button class="chrome-btn" data-act="theme" data-tip="Appearance" aria-label="Appearance">${icon(S.ui.theme === 'light' ? 'sun' : 'moon')}</button>
      <button class="chrome-btn" data-act="settings" data-tip="Settings" aria-label="Settings">${icon('settings')}</button>
    </span></div>`;
}

export function renderRail() {
  const rail = $('#rail');
  rail.dataset.hidden = String(!!S.ui.sidebarHidden);
  const mode = S.ui.mode;
  const title = mode === 'code' ? 'Workspaces' : mode === 'agent' ? 'Agents' : mode === 'auto' ? 'Auto Mode' : 'Threads';
  const addTip = mode === 'code' ? 'Open folder' : mode === 'agent' ? 'New agent' : mode === 'auto' ? 'New Auto Mode thread' : 'New thread';
  const list = mode === 'code' ? workspacesHtml() : mode === 'agent' ? agentsHtml() : threadsHtml();
  const scroller = rail.querySelector('.rail-list');
  const prevScroll = scroller ? scroller.scrollTop : 0;
  rail.innerHTML = `<div class="list-header"><span>${title}</span><button class="chrome-btn" data-act="rail-add" data-tip="${addTip}" aria-label="${addTip}">${icon('plus')}</button></div>
    <div class="scroll rail-list">${list}</div><div class="footer">${footerHtml()}</div>`;
  rail.querySelector('.rail-list').scrollTop = prevScroll;
}

export function bindRail(actions) {
  const rail = $('#rail');
  rail.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    const a = act && act.dataset.act;
    if (a === 'rail-add') {
      if (S.ui.mode === 'code') openFolder();
      else if (S.ui.mode === 'agent') actions.newAgent();
      else (S.ui.mode === 'auto' ? actions.newAuto : actions.newThread)(null);
      return;
    }
    if (a === 'theme') { actions.toggleTheme(); return; }
    if (a === 'settings') { actions.openSettings(); return; }
    if (a === 'close-ws') { const ws = S.workspaces.find((w) => w.id === act.closest('[data-ws]').dataset.ws); if (ws) closeWorkspace(ws); return; }
    if (a === 'new-pane') { const id = act.closest('[data-ws]').dataset.ws; S.activeWs = id; R.launching = id; S.ui.mode = 'code'; save(); invalidate('all'); return; }
    if (a === 'close-pane') { const row = act.closest('[data-pane]'); const ws = S.workspaces.find((w) => w.id === row.dataset.ws); if (ws) closePane(ws, row.dataset.pane); return; }
    if (a === 'pin-agent') { const ag = S.agents.find((x) => x.id === act.dataset.agent); if (ag) { ag.pinned = !ag.pinned; save(); invalidate('rail'); } return; }
    if (a === 'delete-agent') { actions.deleteAgent(act.dataset.agent); return; }
    if (a === 'pin-thread') { const t = threadList().find((x) => x.id === act.dataset.thread); if (t) { t.pinned = !t.pinned; save(); invalidate('rail'); } return; }
    if (a === 'delete-thread') { (S.ui.mode === 'auto' ? actions.deleteAuto : actions.deleteThread)(act.dataset.thread); return; }
    if (a === 'new-thread-in') { (S.ui.mode === 'auto' ? actions.newAuto : actions.newThread)(act.dataset.ws === '_none' ? null : act.dataset.ws); return; }

    const paneRow = e.target.closest('[data-pane]');
    if (paneRow) {
      const ws = S.workspaces.find((w) => w.id === paneRow.dataset.ws);
      if (!ws) return;
      S.activeWs = ws.id;
      ws.focus = paneRow.dataset.pane;
      if (ws.zoomed && ws.zoomed !== ws.focus) ws.zoomed = ws.focus;
      R.launching = null;
      save();
      invalidate('rail', 'center');
      focusTerminal(ws.focus);
      return;
    }
    const wsRow = e.target.closest('.row-ws[data-ws]');
    if (wsRow) {
      const ws = S.workspaces.find((w) => w.id === wsRow.dataset.ws);
      if (!ws) return;
      if (S.activeWs === ws.id) ws.open = ws.open === false;
      else { S.activeWs = ws.id; ws.open = true; }
      if (R.launching && R.launching !== ws.id) R.launching = null;
      save();
      invalidate('rail', 'center');
      return;
    }
    const ag = e.target.closest('[data-agent]');
    if (ag) { S.activeAgent = ag.dataset.agent; const x = S.agents.find((q) => q.id === ag.dataset.agent); if (x) { const c = x.chats.find((cc) => cc.id === x.activeChat); if (c) c.unread = false; } save(); invalidate('rail', 'center', 'side'); return; }
    const th = e.target.closest('[data-thread]');
    if (th) { if (S.ui.mode === 'auto') S.activeAuto = th.dataset.thread; else S.activeThread = th.dataset.thread; save(); invalidate('rail', 'center'); return; }
  });
}
