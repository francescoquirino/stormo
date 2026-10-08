// Thread mode and Auto Mode: a coding conversation over a folder, read instead of watched.
// Auto Mode is the same screen: what changes is who works (Claude with the model router) and the menu in place of models.
import { esc, icon, uid, basename } from './dom.js';
import { S, R, save, invalidate, installedEngines } from './state.js';
import { mark, ENGINE_NAMES } from './marks.js';
import { registerResolver, transcriptHtml, composerHtml, bindChat, send, convRunning, ensureModels, ensureRegia, modelLabel, usageText, renderScrolled } from './chat.js';
import { openModal, confirmBox } from './ui.js';
import { stopVoice } from './voice.js';
import { routerMode } from './router-modes.js';

// Two variants of the same screen. "list", "active" and "draft" say where that variant's conversations live:
// Auto Mode conversations have a list ALL THEIR OWN (S.autoThreads), so the Thread lists stay clean.
const FLAVORS = {
  thread: { mode: 'thread', kind: 'thread', composer: 'thread', list: 'threads', active: 'activeThread', draft: 'draftThread', center: '#center-thread', name: 'Thread', idPrefix: 't' },
  auto: { mode: 'auto', kind: 'auto-thread', composer: 'auto', list: 'autoThreads', active: 'activeAuto', draft: 'draftAuto', center: '#center-auto', name: 'Auto Mode', idPrefix: 'au' },
};

function defaultEngine() {
  const eng = installedEngines();
  return (eng.find((e) => e.id === 'claude') || eng[0] || { id: 'claude' }).id;
}

async function gitInfo(cwd) {
  if (!cwd) return null;
  if (R.git[cwd] && Date.now() - R.git[cwd].at < 15000) return R.git[cwd];
  if (R.git[cwd] && R.git[cwd].pending) return R.git[cwd];
  R.git[cwd] = { ...(R.git[cwd] || {}), pending: true };
  const info = await window.fm.git.info(cwd);
  R.git[cwd] = { ...info, at: Date.now(), pending: false };
  invalidate('center');
  return R.git[cwd];
}

function permLabel(p) {
  return p === 'ask' ? 'Asks before editing' : p === 'full' ? 'Full access' : 'Edits files in the folder';
}

async function showChanges(t) {
  if (!t.cwd) { openModal({ title: 'Changes', body: '<p class="field-hint">This thread has no folder, so there is nothing to compare.</p>' }); return; }
  const m = openModal({ title: `Changes in ${basename(t.cwd)}`, wide: true, body: '<p class="field-hint">Reading git…</p>' });
  const res = await window.fm.git.changes(t.cwd);
  const body = m.el.querySelector('.modal-body');
  if (!res.ok) { body.innerHTML = `<p class="field-hint">${esc(res.text || 'Not a git repository.')}</p>`; return; }
  const colored = esc(res.diff || '').split('\n').map((l) => {
    if (/^(\+\+\+|---|diff |index )/.test(l)) return `<span class="meta">${l}</span>`;
    if (l.startsWith('+')) return `<span class="add">${l}</span>`;
    if (l.startsWith('-')) return `<span class="del">${l}</span>`;
    if (l.startsWith('@@')) return `<span class="hunk">${l}</span>`;
    return l;
  }).join('\n');
  body.innerHTML = `<div class="field"><span class="field-label">Status</span><pre class="diff selectable" style="max-height:140px">${esc(res.status || 'Clean — no changes.')}</pre></div>
    ${res.diff ? `<div class="field"><span class="field-label">${esc(res.stat.split('\n').pop() || 'Diff')}</span><pre class="diff selectable">${colored}</pre></div>` : ''}`;
}

async function pickFolderFor(t) {
  const dir = await window.fm.dialog.pickFolder();
  if (!dir) return;
  let ws = S.workspaces.find((w) => w.path.toLowerCase() === dir.toLowerCase());
  if (!ws) {
    ws = { id: uid('ws'), name: basename(dir), path: dir, open: true, panes: [], layout: 'grid', focus: null, zoomed: null };
    S.workspaces.push(ws);
  }
  t.wsId = ws.id;
  t.cwd = ws.path;
  t.sessionId = null;
  save();
  invalidate('all');
}

function createView(f) {
  const isAuto = f.mode === 'auto';
  const list = () => S[f.list];
  const active = () => list().find((t) => t.id === S[f.active]) || null;

  registerResolver(f.kind, (t) => ({
    engine: isAuto ? (t.routerEngine || t.engine) : t.engine, model: t.model || '', effort: t.effort || '', mode: t.mode || 'agent',
    permission: t.permission || 'smart', cwd: t.cwd || (R.info && R.info.home), systemPrompt: null,
    router: isAuto ? (t.router || 'auto') : null,
    label: t.title || f.name, target: { mode: f.mode, id: t.id },
  }));

  function makeThread(wsId) {
    const ws = S.workspaces.find((w) => w.id === wsId) || null;
    const prev = active();
    return {
      id: uid(f.idPrefix), kind: f.kind, wsId: ws ? ws.id : null, cwd: ws ? ws.path : null,
      title: '', autoTitle: true, engine: isAuto ? 'claude' : (prev ? prev.engine : defaultEngine()), model: isAuto ? '' : (prev ? prev.model : ''),
      effort: prev ? prev.effort : '', mode: 'agent', permission: prev ? prev.permission : 'smart',
      ...(isAuto ? { router: prev && prev.router ? prev.router : 'auto' } : {}),
      sessionId: null, turns: [], pinned: false, status: 'idle', createdAt: Date.now(), updatedAt: Date.now(),
    };
  }

  // Draft: a conversation that's only really born on the first message.
  function draft() {
    if (!R[f.draft]) R[f.draft] = makeThread(S.activeWs);
    return R[f.draft];
  }

  function current() {
    return active() || draft();
  }

  function newThread(wsId) {
    S.ui.mode = f.mode;
    R[f.draft] = makeThread(wsId === undefined ? S.activeWs : wsId);
    S[f.active] = null;
    save();
    invalidate('all');
    setTimeout(() => { const ta = document.querySelector(`${f.center} .editor-input`); if (ta) ta.focus(); }, 40);
  }

  async function deleteThread(id) {
    const t = list().find((x) => x.id === id);
    if (!t) return;
    if (convRunning(t)) return;
    const ok = await confirmBox({ title: `Delete this ${isAuto ? 'Auto Mode thread' : 'thread'}?`, text: `"${t.title || 'New thread'}" disappears from Stormo. Your files are not touched.`, ok: 'Delete', danger: true });
    if (!ok) return;
    stopVoice('chat:' + id);
    S[f.list] = list().filter((x) => x.id !== id);
    if (S[f.active] === id) S[f.active] = null;
    save();
    invalidate('all');
  }

  function barHtml(t) {
    const ws = S.workspaces.find((w) => w.id === t.wsId);
    const folderName = ws ? ws.name : (t.cwd ? basename(t.cwd) : 'No folder');
    const g = t.cwd ? R.git[t.cwd] : null;
    if (t.cwd && (!g || (!g.pending && Date.now() - (g.at || 0) > 15000))) gitInfo(t.cwd);
    const st = convRunning(t) ? 'working' : (t.status === 'needsYou' ? 'needsYou' : t.status === 'failed' ? 'failed' : 'idle');
    const usage = usageText(t);
    const regia = t.routerEngine ? `Director: ${t.routerEngine === 'codex' ? 'GPT-6.1 Sol' : 'Sonnet 5.5'} · medium` : 'Automatic Director · medium';
    const model = isAuto
      ? `<span class="thread-model" data-tip="${esc(regia)}: automatic router for coding; direct conversation">${icon('waypoints', 'thread-mark')}${esc(routerMode(t.router).label)} · ${esc(regia)}</span>`
      : `<span class="thread-model">${mark(t.engine, 'mark thread-mark')}${esc(modelLabel(t.engine, t.model))}</span>`;
    return `<div class="thread-bar">
    ${icon('folder', 'thread-folder')}<span class="thread-ws" data-tip="${esc(t.cwd || 'This thread has no folder: it works in your home folder')}">${esc(folderName)}</span>
    ${g && g.branch ? `<span class="thread-branch" data-tip="Git branch${g.changed ? ' · ' + g.changed + ' changed files' : ''}">${icon('git-branch')}${esc(g.branch)}</span>` : ''}
    <span class="thread-title">${esc(t.title || 'New thread')}</span>
    <span class="thread-spacer"></span>
    ${model}
    ${usage ? `<span class="thread-usage" data-tip="Context used (estimate)">${usage}</span>` : ''}
    <span class="thread-status"><span class="dot" data-state="${st}"></span></span>
    <button class="chrome-btn" data-act="new-thread" data-tip="New thread" aria-label="New thread">${icon('square-pen')}</button>
    <button class="chrome-btn" data-act="changes" data-tip="Changes" aria-label="Changes">${icon('file-diff')}</button>
  </div>`;
  }

  function barKey(t) {
    const g = t.cwd ? R.git[t.cwd] : null;
    return [t.title, t.engine, t.routerEngine, t.routerModel, t.model, t.router, t.status, convRunning(t) ? 1 : 0, g && g.branch, usageText(t), !!R.models[t.engine]].join('~');
  }

  function composerFor(t) {
    return composerHtml(t, { kind: f.composer, placeholder: 'Ask about your code — @ a file, or add files and folders' });
  }

  function syncComposer(center, t) {
    const host = center.querySelector('[data-composer]');
    if (!host) return;
    const running = convRunning(t);
    if (running === !!host.querySelector('[data-act="stop"]')) return;
    const ta = host.querySelector('.editor-input');
    const hadFocus = document.activeElement === ta;
    host.innerHTML = composerFor(t);
    if (hadFocus) { const n = host.querySelector('.editor-input'); if (n) n.focus(); }
  }

  function renderCenter(center) {
    const t = current();
    if (isAuto) ensureRegia(t);
    ensureModels(t.engine);
    const isDraft = !list().includes(t);
    const key = t.id + (isDraft ? ':draft' : '') + ':' + t.turns.length + ':' + (convRunning(t) ? 1 : 0);
    const tr = center.querySelector('.transcript');
    if (!isDraft && tr && center.dataset.conv === t.id && center.dataset.bar === barKey(t)) {
      renderScrolled(tr, transcriptHtml(t), false);
      syncComposer(center, t);
      return;
    }
    center.dataset.conv = t.id;
    center.dataset.bar = barKey(t);
    center.dataset.key = key;
    const composer = composerFor(t);
    if (isDraft || !t.turns.length) {
      const ws = S.workspaces.find((w) => w.id === t.wsId);
      const who = isAuto ? `${t.regiaError || (t.routerEngine ? 'Director: ' + (t.routerEngine === 'codex' ? 'GPT-6.1 Sol' : 'Sonnet 5.5') + ' · locked for this chat' : 'Choosing the Director on open…')} · medium effort · ${routerMode(t.router).label} · router already loaded · automatic coding, direct conversation` : (ENGINE_NAMES[t.engine] || t.engine);
      center.innerHTML = `<section class="pane" aria-label="New ${esc(f.name)}">${barHtml(t)}
      <div class="chat-draft"><div class="chat-hero">${ws ? `What should we build in ${esc(ws.name)}?` : 'What should we build?'}</div>
        <div class="chat-hero-sub">${esc(who)} · ${t.mode === 'plan' ? 'Plan mode: it reads and plans, it does not change files' : permLabel(t.permission)}
          · <a href="#" data-act="pick-folder" style="color:var(--accent);text-decoration:none">${ws || t.cwd ? 'change folder' : 'add a project folder'}</a></div>
        <div data-composer>${composer}</div></div></section>`;
      return;
    }
    center.innerHTML = `<section class="pane" aria-label="${esc(f.name)} — ${esc(t.title)}">${barHtml(t)}
    <div class="scroll transcript" aria-label="Conversation"><div class="column stack">${transcriptHtml(t)}</div></div>
    <div data-composer>${composer}</div></section>`;
    const scroller = center.querySelector('.transcript');
    scroller.scrollTop = scroller.scrollHeight;
  }

  function promoteDraft() {
    const t = current();
    if (list().includes(t)) return;
    const ta = document.querySelector(`${f.center} .editor-input`);
    if (!ta || !ta.value.trim()) return;
    list().push(t);
    S[f.active] = t.id;
    R[f.draft] = null;
    save();
  }

  function bindCenter(center) {
    bindChat(center, current, (conv, what, value) => {
      if (what === 'engine') { conv.engine = value; conv.model = ''; conv.effort = ''; conv.sessionId = null; ensureModels(value); }
      else if (what === 'model') conv.model = value;
      else if (what === 'effort') conv.effort = value;
      else if (what === 'permission') { conv.permission = value; delete conv.permissionOverride; }
      else if (what === 'mode') conv.mode = value;
      else if (what === 'router') conv.router = value;
      save();
      center.dataset.conv = '';
      invalidate('center');
    });
    // The first message turns the draft into a real conversation.
    center.addEventListener('keydown', (e) => {
      if (e.target.classList.contains('editor-input') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) promoteDraft();
    }, true);
    center.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="send"]')) promoteDraft();
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const t = current();
      if (b.dataset.act === 'new-thread') newThread(t.wsId);
      else if (b.dataset.act === 'changes') showChanges(t);
      else if (b.dataset.act === 'pick-folder') { e.preventDefault(); pickFolderFor(t); }
    }, true);
  }

  return { newThread, deleteThread, renderCenter, bindCenter };
}

const thread = createView(FLAVORS.thread);
const auto = createView(FLAVORS.auto);

export const { newThread, deleteThread, renderCenter: renderThreadCenter, bindCenter: bindThreadCenter } = thread;
export const { newThread: newAuto, deleteThread: deleteAuto, renderCenter: renderAutoCenter, bindCenter: bindAutoCenter } = auto;
