// "Bridge": the command palette (orb button or Ctrl+K).
import { esc, icon } from './dom.js';
import { S, R, save, invalidate, cliInfo } from './state.js';
import { mark, ENGINE_NAMES } from './marks.js';
import { openModal } from './ui.js';

export function openPalette(actions) {
  const ws = S.workspaces.find((w) => w.id === S.activeWs);
  const cmds = [];
  if (ws) {
    for (const id of ['claude', 'codex', 'agy', 'gemini', 'terminal']) {
      if (cliInfo(id).installed) cmds.push({ label: `New ${ENGINE_NAMES[id]} pane in ${ws.name}`, markHtml: mark(id), run: () => actions.addPane(ws, id) });
    }
  }
  cmds.push(
    { label: 'Open folder…', icon: 'folder-plus', run: () => actions.openFolder() },
    { label: 'New thread', icon: 'square-pen', kbd: 'Ctrl+N', run: () => actions.newThread(S.activeWs) },
    { label: 'New Auto Mode thread', icon: 'waypoints', run: () => actions.newAuto(S.activeWs) },
    { label: 'Switch to Auto Mode', icon: 'waypoints', kbd: 'Ctrl+4', run: () => actions.setMode('auto') },
    { label: 'New agent', icon: 'bot', run: () => actions.newAgent() },
    { label: 'Switch to Agent mode', icon: 'bot', kbd: 'Ctrl+1', run: () => actions.setMode('agent') },
    { label: 'Switch to Code mode', icon: 'square-terminal', kbd: 'Ctrl+2', run: () => actions.setMode('code') },
    { label: 'Switch to Thread mode', icon: 'message-square', kbd: 'Ctrl+3', run: () => actions.setMode('thread') },
    { label: 'Open Dashboard', icon: 'layout-grid', run: () => actions.openDashboard() },
    { label: 'Preview localhost:3000', icon: 'globe', run: () => actions.openUrl('http://localhost:3000') },
    { label: 'Preview localhost:5173', icon: 'globe', run: () => actions.openUrl('http://localhost:5173') },
    { label: 'Toggle light / dark', icon: S.ui.theme === 'light' ? 'moon' : 'sun', run: () => actions.toggleTheme() },
    { label: 'Settings', icon: 'settings', run: () => actions.openSettings() },
  );
  for (const w of S.workspaces) cmds.push({ label: `Go to workspace ${w.name}`, icon: 'folder', run: () => { S.ui.mode = 'code'; S.activeWs = w.id; R.launching = null; save(); invalidate('all'); } });
  for (const a of S.agents) cmds.push({ label: `Open agent ${a.name}`, icon: 'bot', run: () => { S.ui.mode = 'agent'; S.activeAgent = a.id; save(); invalidate('all'); } });
  for (const t of S.threads.slice(-15).reverse()) cmds.push({ label: `Thread: ${t.title || 'New thread'}`, icon: 'message-square', run: () => { S.ui.mode = 'thread'; S.activeThread = t.id; save(); invalidate('all'); } });

  for (const t of S.autoThreads.slice(-15).reverse()) cmds.push({ label: `Auto Mode: ${t.title || 'New thread'}`, icon: 'waypoints', run: () => { S.ui.mode = 'auto'; S.activeAuto = t.id; save(); invalidate('all'); } });

  let active = 0;
  let shown = cmds;
  const m = openModal({
    title: null, cls: 'palette',
    body: `<div class="palette-input">${icon('search')}<input placeholder="Type a command, a workspace, an agent…" aria-label="Command"></div><div class="palette-list scroll"></div>`,
    onMount: ({ el, close }) => {
      const input = el.querySelector('input');
      const list = el.querySelector('.palette-list');
      el.querySelector('.modal-body').style.padding = '0';
      const draw = () => {
        list.innerHTML = shown.length ? shown.map((c, i) => `<button class="menu-item" data-i="${i}" data-active="${i === active}">${c.markHtml || icon(c.icon)}<span>${esc(c.label)}</span>${c.kbd ? `<kbd>${c.kbd}</kbd>` : ''}</button>`).join('')
          : '<div class="dash-empty">No match.</div>';
        const a = list.querySelector('[data-active="true"]');
        if (a) a.scrollIntoView({ block: 'nearest' });
      };
      const run = (i) => { const c = shown[i]; if (!c) return; close(); c.run(); };
      input.addEventListener('input', () => {
        const q = input.value.toLowerCase().trim();
        shown = q ? cmds.filter((c) => q.split(/\s+/).every((w) => c.label.toLowerCase().includes(w))) : cmds;
        active = 0;
        draw();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { active = Math.min(shown.length - 1, active + 1); draw(); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
        else if (e.key === 'Enter') { run(active); e.preventDefault(); }
      });
      list.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) run(+b.dataset.i); });
      draw();
      setTimeout(() => input.focus(), 20);
    },
  });
  return m;
}
