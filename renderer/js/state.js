// App state: S = saved to disk, R = memory only (terminals, running executions…).
import { uid } from './dom.js';

export const S = {};
export const R = {
  clis: [],            // [{id,name,installed,path,engine}]
  ptyState: {},        // paneId -> 'working'|'idle'|'needsYou'|'exited'
  terms: new Map(),    // paneId -> { term, fit, el, spawned, exited }
  runs: new Map(),     // runId -> { conv, turn, kind, ownerId }
  git: {},             // cwd -> { branch, changed }
  models: {},          // engine -> { models, efforts }
  launching: null,     // wsId while picking the agent for a new panel
  dashFilter: null,
  limits: null,        // Claude usage (5h/7d) from the last rate_limit event
  focused: true,
  info: null,
};

function defaults() {
  const dashId = uid('side');
  return {
    v: 1,
    ui: { mode: 'code', sidebarHidden: false, sideHidden: false, theme: 'dark', termFont: 12.5 },
    profile: { name: '' },
    cliOverrides: {},
    workspaces: [],
    activeWs: null,
    side: { tabs: [{ id: uid('side'), kind: 'browser', url: '', title: 'Browser' }, { id: dashId, kind: 'dashboard', title: 'Dashboard' }], active: dashId },
    threads: [],
    activeThread: null,
    autoThreads: [],
    activeAuto: null,
    agents: [],
    activeAgent: null,
    notifications: [],
  };
}

export async function loadState() {
  const saved = await window.fm.state.load();
  const d = defaults();
  Object.assign(S, d, saved || {});
  S.ui = { ...d.ui, ...(saved && saved.ui) };
  S.profile = { ...d.profile, ...(saved && saved.profile) };
  if (!S.side || !Array.isArray(S.side.tabs)) S.side = d.side;
  // Runs don't survive a restart: nothing stays "working" forever.
  if (!Array.isArray(S.autoThreads)) S.autoThreads = [];
  for (const t of [...S.threads, ...S.autoThreads]) if (t.status === 'working') t.status = 'idle';
  for (const a of S.agents) for (const c of a.chats || []) if (c.status === 'working') c.status = 'idle';
  for (const conv of allConvs()) {
    for (const turn of conv.turns || []) {
      if (turn.role === 'assistant' && !turn.done) {
        turn.done = true;
        turn.items.push({ kind: 'error', message: 'Interrupted: Stormo was closed while this was running.' });
      }
      if (turn.role === 'assistant') {
        for (const it of turn.items) {
          if (it.kind === 'tool' && it.status === 'running') { it.status = 'failed'; it.output = it.output || 'No result was reported for this step.'; }
        }
      }
    }
  }
}

export function allConvs() {
  const out = [...S.threads, ...S.autoThreads];
  for (const a of S.agents) out.push(...(a.chats || []));
  return out;
}

let saveTimer = null;
export function save(now = false) {
  clearTimeout(saveTimer);
  const doSave = () => window.fm.state.save(JSON.parse(JSON.stringify(S))).catch(() => {});
  if (now) return doSave();
  saveTimer = setTimeout(doSave, 400);
}

// Region-based redraw: invalidate('rail') etc.; all in a single frame.
const dirty = new Set();
let frame = 0;
let fallback = 0;
const renderers = {};
export function registerRenderer(region, fn) { renderers[region] = fn; }
export function invalidate(...regions) {
  for (const r of regions.length ? regions : ['all']) dirty.add(r);
  if (frame) return;
  frame = requestAnimationFrame(flush);
  // With the window minimized, requestAnimationFrame doesn't fire: the timer guarantees
  // the terminals still start and the state still updates.
  fallback = setTimeout(flush, 120);
}
function flush() {
  cancelAnimationFrame(frame);
  clearTimeout(fallback);
  frame = 0;
  const all = dirty.has('all');
  const order = ['titlebar', 'rail', 'center', 'side'];
  const list = all ? order : order.filter((r) => dirty.has(r));
  dirty.clear();
  for (const r of list) if (renderers[r]) renderers[r]();
}

export function activeWs() {
  return S.workspaces.find((w) => w.id === S.activeWs) || null;
}
export function activeThread() {
  return S.threads.find((t) => t.id === S.activeThread) || null;
}
export function activeAgent() {
  return S.agents.find((a) => a.id === S.activeAgent) || null;
}
export function cliInfo(id) {
  return R.clis.find((c) => c.id === id) || { id, name: id, installed: false };
}
export function installedEngines() {
  return R.clis.filter((c) => c.engine && c.installed);
}

export function notify(title, body, target) {
  S.notifications.unshift({ id: uid('n'), title, body, at: Date.now(), read: false, target });
  S.notifications = S.notifications.slice(0, 60);
  window.fm.notify(title, body);
  invalidate('titlebar');
  save();
}
