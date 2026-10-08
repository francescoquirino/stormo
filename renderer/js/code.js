// Code mode: workspaces (folders) with panels of real terminals.
import { $, esc, icon, uid, basename, toast } from './dom.js';
import { S, R, save, invalidate, activeWs, cliInfo } from './state.js';
import { mark, ENGINE_NAMES } from './marks.js';
import { openMenu, confirmBox } from './ui.js';
import { toggleVoice, voiceActive, stopVoice } from './voice.js';

const LAUNCH_ORDER = ['claude', 'codex', 'agy', 'gemini', 'grok', 'glm', 'copilot', 'cursor', 'terminal'];
const SMART_ENGINES = new Set(['claude', 'codex', 'agy', 'gemini', 'glm']);

function termTheme() {
  const light = S.ui.theme === 'light';
  return light ? {
    background: '#fbfbff', foreground: '#12142b', cursor: '#6d4fe8', cursorAccent: '#fbfbff',
    selectionBackground: '#6d4fe833', black: '#0a0a0a', red: '#c71930', green: '#15753b', yellow: '#8a5800',
    blue: '#245dc0', magenta: '#6f42e0', cyan: '#0e7490', white: '#525252', brightBlack: '#686868',
    brightRed: '#dc2626', brightGreen: '#16a34a', brightYellow: '#a16207', brightBlue: '#1d4ed8',
    brightMagenta: '#7c3aed', brightCyan: '#0891b2', brightWhite: '#171717',
  } : {
    background: '#0c1029', foreground: '#eef0ff', cursor: '#a78bfa', cursorAccent: '#0c1029',
    selectionBackground: '#8b7cf84d', black: '#161b3d', red: '#ff6b81', green: '#7fe0a8', yellow: '#f0cf86',
    blue: '#9ab8ff', magenta: '#c4a8ff', cyan: '#5fdcea', white: '#d6daf5', brightBlack: '#7880aa',
    brightRed: '#ff8fa0', brightGreen: '#a8f0c4', brightYellow: '#f8e0a8', brightBlue: '#bcd0ff',
    brightMagenta: '#dccbff', brightCyan: '#9cecf5', brightWhite: '#ffffff',
  };
}

export function applyTermTheme() {
  for (const t of R.terms.values()) {
    t.term.options.theme = termTheme();
    t.term.options.fontSize = S.ui.termFont;
  }
}

// ——— Workspace ———
export async function openFolder() {
  const dir = await window.fm.dialog.pickFolder();
  if (!dir) return null;
  let ws = S.workspaces.find((w) => w.path.toLowerCase() === dir.toLowerCase());
  if (!ws) {
    ws = { id: uid('ws'), name: basename(dir), path: dir, open: true, panes: [], layout: 'grid', focus: null, zoomed: null };
    S.workspaces.push(ws);
  }
  S.activeWs = ws.id;
  ws.open = true;
  if (!ws.panes.length) R.launching = ws.id;
  save();
  invalidate('all');
  return ws;
}

export async function closeWorkspace(ws) {
  if (ws.panes.length) {
    const ok = await confirmBox({ title: `Close ${ws.name}?`, text: `This stops ${ws.panes.length} running terminal${ws.panes.length > 1 ? 's' : ''} in this workspace. Your files are not touched.`, ok: 'Close workspace', danger: true });
    if (!ok) return;
  }
  for (const p of ws.panes) disposePane(p.id);
  S.workspaces = S.workspaces.filter((w) => w.id !== ws.id);
  if (S.activeWs === ws.id) S.activeWs = S.workspaces[0] ? S.workspaces[0].id : null;
  save();
  invalidate('all');
}

export function addPane(ws, agent) {
  const info = cliInfo(agent);
  if (!info.installed) { toast(`${ENGINE_NAMES[agent] || agent} is not installed on this PC.`); return; }
  const pane = { id: uid('p'), agent, smart: SMART_ENGINES.has(agent), createdAt: Date.now() };
  ws.panes.push(pane);
  ws.focus = pane.id;
  ws.zoomed = null;
  R.launching = null;
  S.activeWs = ws.id;
  ws.open = true;
  save();
  invalidate('all');
}

export function closePane(ws, paneId) {
  disposePane(paneId);
  ws.panes = ws.panes.filter((p) => p.id !== paneId);
  if (ws.focus === paneId) ws.focus = ws.panes.length ? ws.panes[ws.panes.length - 1].id : null;
  if (ws.zoomed === paneId) ws.zoomed = null;
  save();
  invalidate('all');
}

function disposePane(paneId) {
  stopVoice('code:' + paneId);
  window.fm.pty.kill(paneId);
  const t = R.terms.get(paneId);
  if (t) {
    try { t.ro && t.ro.disconnect(); } catch { /* ignore */ }
    t.term.dispose();
    t.el.remove();
    R.terms.delete(paneId);
  }
  delete R.ptyState[paneId];
}

function restartPane(ws, pane) {
  const t = R.terms.get(pane.id);
  if (!t) return;
  window.fm.pty.kill(pane.id);
  t.term.reset();
  t.exited = false;
  spawnInto(ws, pane, t);
}

// ——— Terminals ———
function parking() {
  let p = $('#term-park');
  if (!p) {
    p = document.createElement('div');
    p.id = 'term-park';
    p.style.cssText = 'position:absolute;left:-20000px;top:0;width:900px;height:600px;visibility:hidden;overflow:hidden';
    document.body.appendChild(p);
  }
  return p;
}

export function parkAllTerminals() {
  const park = parking();
  for (const t of R.terms.values()) if (t.el.parentElement !== park) park.appendChild(t.el);
}

function createTerm(ws, pane) {
  const el = document.createElement('div');
  el.className = 'xterm-mount';
  el.style.cssText = 'width:100%;height:100%';
  const term = new window.Terminal({
    fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, monospace",
    fontSize: S.ui.termFont, lineHeight: 1.22, letterSpacing: 0,
    cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2,
    scrollback: 8000, allowProposedApi: true, theme: termTheme(),
    rescaleOverlappingGlyphs: true, customGlyphs: true, drawBoldTextInBrightColors: false,
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  try {
    const u = new window.Unicode11Addon.Unicode11Addon();
    term.loadAddon(u);
    term.unicode.activeVersion = '11';
  } catch { /* optional */ }
  try {
    term.loadAddon(new window.WebLinksAddon.WebLinksAddon((_e, url) => window.fm.shell.openExternal(url)));
  } catch { /* optional */ }
  parking().appendChild(el);
  term.open(el);
  // Rendered with the GPU (like VS Code and "real" terminals): crisp, fast text.
  // If the WebGL context is lost, xterm falls back to normal rendering on its own.
  try {
    const gl = new window.WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* no WebGL: DOM rendering stays */ }
  const t = { term, fit, el, spawned: false, exited: false, title: '', ro: null, wsId: ws.id };

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && key === 'c' && term.hasSelection()) {
      window.fm.clip.write(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (e.ctrlKey && !e.altKey && key === 'v') {
      e.preventDefault();
      window.fm.clip.read().then((text) => { if (text) term.paste(text); });
      return false;
    }
    if (e.ctrlKey && e.shiftKey && key === 'c') {
      if (term.hasSelection()) window.fm.clip.write(term.getSelection());
      return false;
    }
    return true;
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      window.fm.clip.write(term.getSelection());
      term.clearSelection();
      toast('Copied');
    } else {
      window.fm.clip.read().then((text) => { if (text) term.paste(text); });
    }
  });
  term.onData((data) => {
    if (t.exited) {
      if (data === '\r') restartPane(S.workspaces.find((w) => w.id === t.wsId) || ws, pane);
      return;
    }
    window.fm.pty.write(pane.id, data);
  });
  term.onResize(({ cols, rows }) => { if (t.spawned && !t.exited) window.fm.pty.resize(pane.id, cols, rows); });
  term.onTitleChange((title) => {
    t.title = cleanTitle(title, S.workspaces.find((w) => w.id === t.wsId));
    invalidate('side');
    const meta = document.querySelector(`.cell[data-pane="${pane.id}"] .phead-title`);
    if (meta) meta.textContent = t.title;
  });
  el.addEventListener('mousedown', () => focusPane(t.wsId, pane.id));
  R.terms.set(pane.id, t);
  return t;
}

function cleanTitle(title, ws) {
  // Claude Code puts a spinner in front of the title ("✳ Fix login"); PowerShell the exe's path;
  // Codex the folder name. We only keep titles that say what the agent is doing.
  const s = String(title || '').replace(/^[\s✳✻✶✽✢·⠀-⣿*•◐◓◑◒]+/, '').trim();
  if (/(?:\\|^[^\s]*\/)(powershell|pwsh|cmd|node|claude|codex|agy|bash|zsh|fish|dash|sh)(\.exe)?$/i.test(s)) return '';
  if (/^(claude( code)?|(openai )?codex|agy|antigravity|gemini( cli)?|grok|(windows )?powershell|bash|zsh|fish|dash|sh|mingw64.*)$/i.test(s)) return '';
  // Codex and PowerShell use the folder as the title ("C:\", "~\Projects"): that's not a task.
  if (/^([a-z]:[\\/]|~[\\/]?|\\\\|\/)/i.test(s)) return '';
  // Bash and zsh on Linux use "user@host: ~/folder" as the title.
  if (/^[\w.-]+@[\w.-]+:/.test(s)) return '';
  if (ws && (s.toLowerCase() === ws.name.toLowerCase() || s.toLowerCase() === basename(ws.path).toLowerCase())) return '';
  return s.slice(0, 80);
}

async function spawnInto(ws, pane, t) {
  const { cols, rows } = t.term;
  t.spawned = true;
  R.ptyState[pane.id] = 'working';
  const res = await window.fm.pty.spawn({ id: pane.id, agent: pane.agent, cwd: ws.path, cols, rows,
    smart: pane.smart === true });
  if (!res.ok) {
    t.exited = true;
    R.ptyState[pane.id] = 'failed';
    t.term.write(`\x1b[31m${res.error}\x1b[0m\r\n\x1b[2mPress Enter to try again.\x1b[0m\r\n`);
    invalidate('rail', 'side');
  }
}

function fitSoon(t) {
  clearTimeout(t.fitTimer);
  t.fitTimer = setTimeout(() => {
    const host = t.el.parentElement;
    if (!host || host.id === 'term-park' || !host.clientWidth || !host.clientHeight) return;
    try { t.fit.fit(); } catch { /* ignore */ }
  }, 30);
}

export function focusPane(wsId, paneId) {
  const ws = S.workspaces.find((w) => w.id === wsId);
  if (!ws || ws.focus === paneId) return;
  ws.focus = paneId;
  document.querySelectorAll('.cell[data-pane]').forEach((c) => { c.dataset.focus = String(c.dataset.pane === paneId); });
  invalidate('rail');
  save();
}

export function focusTerminal(paneId) {
  const t = R.terms.get(paneId);
  if (t) setTimeout(() => t.term.focus(), 0);
}

// Called from the IPC bridge in app.js
export function onPtyData(id, data) {
  const t = R.terms.get(id);
  if (t) t.term.write(data);
}
export function onPtyExit(id, code) {
  const t = R.terms.get(id);
  R.ptyState[id] = 'exited';
  if (t) {
    t.exited = true;
    t.term.write(`\r\n\x1b[2m[process exited${code ? ' with code ' + code : ''} — press Enter to restart]\x1b[0m\r\n`);
  }
  updatePaneDot(id);
  invalidate('rail', 'side');
}
export function onPtyState(id, state) {
  R.ptyState[id] = state;
  updatePaneDot(id);
  invalidate('rail', 'side');
}
function updatePaneDot(id) {
  const d = document.querySelector(`.cell[data-pane="${id}"] .phead > .dot`);
  if (d) d.dataset.state = R.ptyState[id] || 'idle';
}

// ——— Center panel rendering ———
function arrange(ws, panes) {
  const n = panes.length;
  const layout = ws.layout || 'grid';
  if (layout === 'rows') return [panes];
  if (layout === 'columns') return panes.map((p) => [p]);
  const cols = n <= 1 ? 1 : n === 2 ? 2 : n <= 4 ? 2 : 3;
  const out = Array.from({ length: cols }, () => []);
  const perCol = Math.ceil(n / cols);
  panes.forEach((p, i) => out[Math.floor(i / perCol)].push(p));
  return out.filter((c) => c.length);
}

function launchView(ws) {
  const cards = LAUNCH_ORDER.map((id) => {
    const info = cliInfo(id);
    const missing = !info.installed;
    return `<button class="launch-card" data-launch="${id}" ${missing ? 'data-missing' : ''} data-tip="${esc(missing ? 'Not found on this PC' : (info.path || ''))}">
      ${mark(id, 'mark launch-mark')}<span class="launch-lines"><span class="launch-name">${esc(ENGINE_NAMES[id])}</span>${missing ? '<span class="launch-hint">not installed</span>' : ''}</span></button>`;
  }).join('');
  return `<div class="empty">
    ${ws.panes.length ? `<button class="launch-cancel" data-act="cancel-launch">${icon('x')}Back to workspace</button>` : ''}
    ${icon('layout-template', 'empty-glyph')}
    <div class="empty-copy"><h3 class="empty-title">Who should we send to work in ${esc(ws.name)}?</h3><p class="empty-lead">Choose an agent: it opens in a real terminal.</p></div>
    <div class="launch-grid">${cards}</div>
    <p class="form-foot">These run in real terminals over your own folder, with your own logins — no API keys, no extra cost.</p>
  </div>`;
}

function welcomeView() {
  return `<div class="empty">
    ${icon('folder-open', 'empty-glyph')}
    <div class="empty-copy"><h3 class="empty-title">Open a folder to start</h3><p class="empty-lead">Each workspace is a folder on your PC. Agents work right inside it.</p></div>
    <button class="primary-btn" data-act="open-folder">${icon('folder-plus')}Open folder</button>
    <p class="form-foot">Claude Code, Codex, Antigravity and the rest launch into real terminals — whatever is installed on this PC.</p>
  </div>`;
}

function cellHtml(ws, pane) {
  const t = R.terms.get(pane.id);
  const state = R.ptyState[pane.id] || (t && t.exited ? 'exited' : 'idle');
  const zoomed = ws.zoomed === pane.id;
  return `<div class="cell" data-pane="${pane.id}" data-focus="${ws.focus === pane.id}">
    <div class="phead">
      <span class="dot" data-state="${state}"></span>
      ${mark(pane.agent)}
      <span class="phead-center"><span class="phead-meta">${esc(ws.name)}</span><span class="phead-meta phead-title">${esc(t && t.title ? t.title : '')}</span></span>
      <span class="phead-actions">
        <button class="pbtn voice-btn" data-act="pane-voice" data-voice-key="code:${pane.id}" data-on="${voiceActive('code:' + pane.id)}" data-tip="Dictate in Italian or English (does not send)" aria-label="Dictate into the prompt" aria-pressed="${voiceActive('code:' + pane.id)}">${icon('audio-lines')}</button>
        ${SMART_ENGINES.has(pane.agent) ? `<button class="pbtn" data-act="pane-smart" data-on="${pane.smart === true}" data-tip="Safe auto: approves normal actions, stops risky ones (restarts the terminal)" aria-label="Safe auto" aria-pressed="${pane.smart === true}">${icon('shield-check')}</button>` : ''}
        <button class="pbtn" data-act="pane-more" data-tip="More" aria-label="More">${icon('ellipsis')}</button>
        <button class="pbtn" data-act="pane-zoom" data-on="${zoomed}" data-tip="${zoomed ? 'Exit full screen' : 'Full screen'}" aria-label="Full screen">${icon(zoomed ? 'minimize-2' : 'maximize-2')}</button>
        <button class="pbtn" data-act="pane-new" data-tip="New pane" aria-label="New pane">${icon('plus')}</button>
        <button class="pbtn" data-act="pane-close" data-role="destructive" data-tip="Close pane" aria-label="Close pane">${icon('x')}</button>
      </span>
    </div>
    <div class="term-host"></div>
  </div>`;
}

export function renderCode(center) {
  const ws = activeWs();
  parkAllTerminals();
  if (!ws) { center.innerHTML = welcomeView(); return; }
  if (R.launching === ws.id || !ws.panes.length) { center.innerHTML = launchView(ws); return; }
  const visible = ws.zoomed ? ws.panes.filter((p) => p.id === ws.zoomed) : ws.panes;
  const cols = arrange(ws, visible.length ? visible : ws.panes);
  center.innerHTML = `<section class="canvas" data-layout="${ws.layout || 'grid'}">${cols.map((c) => `<div class="col">${c.map((p) => cellHtml(ws, p)).join('')}</div>`).join('')}</section>`;
  for (const pane of visible.length ? visible : ws.panes) {
    const host = center.querySelector(`.cell[data-pane="${pane.id}"] .term-host`);
    let t = R.terms.get(pane.id);
    if (!t) t = createTerm(ws, pane);
    t.wsId = ws.id;
    host.appendChild(t.el);
    if (t.ro) t.ro.disconnect();
    t.ro = new ResizeObserver(() => fitSoon(t));
    t.ro.observe(host);
    try { t.fit.fit(); } catch { /* ignore */ }
    if (!t.spawned) spawnInto(ws, pane, t);
  }
  if (ws.focus) focusTerminal(ws.focus);
}

export function bindCode(center) {
  center.addEventListener('click', (e) => {
    const ws = activeWs();
    const launch = e.target.closest('[data-launch]');
    if (launch && ws) {
      if (launch.hasAttribute('data-missing')) { toast(`${ENGINE_NAMES[launch.dataset.launch]} is not installed on this PC.`); return; }
      addPane(ws, launch.dataset.launch);
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'open-folder') { openFolder(); return; }
    if (!ws) return;
    if (act === 'cancel-launch') { R.launching = null; invalidate('center'); return; }
    const cell = b.closest('.cell');
    const pane = cell && ws.panes.find((p) => p.id === cell.dataset.pane);
    if (!pane) return;
    if (act === 'pane-close') closePane(ws, pane.id);
    else if (act === 'pane-voice') {
      toggleVoice('code:' + pane.id, (spoken) => {
        const t = R.terms.get(pane.id);
        if (!t || t.exited) { toast('This terminal is closed.'); return; }
        // Paste uses the terminal's own protocol; no newline reaches the CLI.
        t.term.paste(spoken.replace(/[\x00-\x1f\x7f]/g, ' ').trim() + ' ');
      });
      // Keyboard focus goes back to the terminal: Enter sends the text to the CLI (focus on the button would re-trigger the mic).
      focusTerminal(pane.id);
    }
    else if (act === 'pane-smart') {
      const t = R.terms.get(pane.id);
      const inUse = t && !t.exited && R.ptyState[pane.id] !== 'exited';
      (async () => {
        const next = !pane.smart;
        const ok = !inUse || await confirmBox({
          title: next ? 'Turn on "Safe auto"?' : 'Turn off "Safe auto"?',
          text: 'Changing this mode restarts the terminal: the current session closes (files are not touched).',
          ok: 'Restart the terminal',
        });
        if (!ok) return;
        pane.smart = next;
        save();
        toast(next ? 'Safe auto on: restarting the terminal.' : 'Safe auto off: restarting the terminal.');
        restartPane(ws, pane);
        invalidate('center');
      })();
    }
    else if (act === 'pane-new') { R.launching = ws.id; invalidate('center'); }
    else if (act === 'pane-zoom') { ws.zoomed = ws.zoomed === pane.id ? null : pane.id; ws.focus = pane.id; save(); invalidate('center'); }
    else if (act === 'pane-more') {
      openMenu(b, [
        { label: 'Restart', icon: 'rotate-cw', action: () => restartPane(ws, pane) },
        { label: 'Clear', icon: 'wand-sparkles', action: () => { const t = R.terms.get(pane.id); if (t) t.term.clear(); } },
        { label: 'Copy folder path', icon: 'copy', action: () => { window.fm.clip.write(ws.path); toast('Copied ' + ws.path); } },
        { label: 'Open folder in Explorer', icon: 'folder-open', action: () => window.fm.shell.openPath(ws.path) },
        { sep: true },
        { label: 'Close pane', icon: 'x', role: 'destructive', action: () => closePane(ws, pane.id) },
      ], { align: 'right' });
    }
  });
  center.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.cell[data-pane]');
    const ws = activeWs();
    if (cell && ws) focusPane(ws.id, cell.dataset.pane);
  });
}

// Agent name in the left column ("Claude Code", "Codex").
export function paneName(pane) {
  return ENGINE_NAMES[pane.agent] || pane.agent;
}

// Task title, if the agent declares one (Claude Code puts it in the terminal's title).
export function paneTask(pane) {
  const t = R.terms.get(pane.id);
  return (t && t.title) || '';
}
