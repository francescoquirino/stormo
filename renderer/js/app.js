// Stormo startup: loads the state, finds the CLIs, wires everything up and renders.
import { $, installTooltips, toast } from './dom.js';
import { S, R, loadState, save, invalidate, registerRenderer } from './state.js';
import { renderTitlebar, bindTitlebar, setMode } from './titlebar.js';
import { renderRail, bindRail } from './rail.js';
import { renderCode, bindCode, onPtyData, onPtyExit, onPtyState, openFolder, addPane, applyTermTheme, parkAllTerminals } from './code.js';
import { renderSide, bindSide, openInBrowser } from './side.js';
import { applyEngineEvent } from './chat.js';
import { renderAgentCenter, bindAgentCenter, editAgent, deleteAgent, startScheduler } from './agent.js';
import { renderThreadCenter, bindThreadCenter, newThread, deleteThread, renderAutoCenter, bindAutoCenter, newAuto, deleteAuto } from './thread.js';
import { openSettings } from './settings.js';
import { openPalette } from './palette.js';
import { closeMenus } from './ui.js';
import { onVoiceEvent, refreshVoiceButtons } from './voice.js';
import { maybeRunSetup } from './setup.js';

const stage = $('#app');

async function refreshClis() {
  R.clis = await window.fm.cli.detect(S.cliOverrides || {});
  invalidate('all');
}

const actions = {
  toggleSidebar() { S.ui.sidebarHidden = !S.ui.sidebarHidden; save(); invalidate('titlebar', 'rail'); },
  toggleSide() { S.ui.sideHidden = !S.ui.sideHidden; save(); invalidate('titlebar', 'side'); },
  toggleTheme() {
    S.ui.theme = S.ui.theme === 'light' ? 'dark' : 'light';
    stage.dataset.theme = S.ui.theme;
    applyTermTheme();
    save();
    invalidate('all');
  },
  openSettings: () => openSettings(refreshClis),
  openPalette: () => openPalette(actions),
  newAgent: () => { S.ui.mode = 'agent'; save(); invalidate('all'); editAgent(null, {}); },
  deleteAgent: (id) => deleteAgent(id),
  newThread: (wsId) => newThread(wsId),
  deleteThread: (id) => deleteThread(id),
  newAuto: (wsId) => newAuto(wsId),
  deleteAuto: (id) => deleteAuto(id),
  openFolder: () => { S.ui.mode = 'code'; openFolder(); },
  addPane: (ws, id) => { S.ui.mode = 'code'; addPane(ws, id); },
  setMode: (m) => setMode(m),
  openDashboard: () => {
    const d = S.side.tabs.find((t) => t.kind === 'dashboard');
    if (d) S.side.active = d.id; else { S.side.tabs.push({ id: 'dash' + Date.now(), kind: 'dashboard', title: 'Dashboard' }); S.side.active = S.side.tabs[S.side.tabs.length - 1].id; }
    S.ui.sideHidden = false;
    save();
    invalidate('side', 'titlebar');
  },
  openUrl: (u) => openInBrowser(u),
};

function renderCenter() {
  const mode = S.ui.mode;
  const views = { code: $('#center-code'), agent: $('#center-agent'), thread: $('#center-thread'), auto: $('#center-auto') };
  for (const [k, el] of Object.entries(views)) el.hidden = k !== mode;
  if (mode === 'code') renderCode(views.code);
  else {
    parkAllTerminals();
    if (mode === 'agent') renderAgentCenter(views.agent);
    else if (mode === 'auto') renderAutoCenter(views.auto);
    else renderThreadCenter(views.thread);
  }
  refreshVoiceButtons();
}

function inTerminal(e) {
  return !!(e.target && e.target.closest && e.target.closest('.xterm'));
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    if (!ctrl) return;
    const k = e.key.toLowerCase();
    // Palette and the right bar work everywhere; the rest doesn't steal keys from the terminals (Ctrl+B, Ctrl+K… are needed by the CLIs).
    if (e.shiftKey && k === 'p') { e.preventDefault(); actions.openPalette(); return; }
    if (e.shiftKey && k === 'b') { e.preventDefault(); actions.toggleSide(); return; }
    if (inTerminal(e)) return;
    if (!e.shiftKey && k === 'k') { e.preventDefault(); actions.openPalette(); }
    else if (!e.shiftKey && k === 'b') { e.preventDefault(); actions.toggleSidebar(); }
    else if (!e.shiftKey && (k === '1' || k === '2' || k === '3' || k === '4')) { e.preventDefault(); setMode(['agent', 'code', 'thread', 'auto'][+k - 1]); }
    else if (!e.shiftKey && k === 'n') { e.preventDefault(); (S.ui.mode === 'auto' ? actions.newAuto : actions.newThread)(S.activeWs); }
    else if (!e.shiftKey && k === 't' && S.ui.mode === 'code' && S.activeWs) { e.preventDefault(); R.launching = S.activeWs; invalidate('center'); }
    else if (!e.shiftKey && k === ',') { e.preventDefault(); actions.openSettings(); }
  });
  window.addEventListener('resize', closeMenus);
}

async function main() {
  await loadState();
  stage.dataset.theme = S.ui.theme === 'light' ? 'light' : 'dark';
  R.info = await window.fm.app.info();
  R.clis = await window.fm.cli.detect(S.cliOverrides || {});

  registerRenderer('titlebar', renderTitlebar);
  registerRenderer('rail', renderRail);
  registerRenderer('center', renderCenter);
  registerRenderer('side', renderSide);

  bindTitlebar(actions);
  bindRail(actions);
  bindCode($('#center-code'));
  bindAgentCenter($('#center-agent'));
  bindThreadCenter($('#center-thread'));
  bindAutoCenter($('#center-auto'));
  bindSide();
  bindKeys();
  installTooltips(stage);

  window.fm.pty.onData(onPtyData);
  window.fm.pty.onExit(onPtyExit);
  window.fm.pty.onState(onPtyState);
  window.fm.engine.onEvent(applyEngineEvent);
  window.fm.voice.onEvent(onVoiceEvent);
  window.fm.win.onFocus((f) => { R.focused = f; stage.dataset.blurred = String(!f); });

  startScheduler();
  invalidate('all');
  window.addEventListener('beforeunload', () => save(true));
  window.__fm = { S, R, actions, toast };   // for automated tests (CDP)
  maybeRunSetup();
}

main().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:auto 12px 12px 12px;z-index:99;color:#ff6568;background:#141414;padding:12px;border-radius:10px;font:12px Consolas;white-space:pre-wrap">Stormo failed to start:\n${String(err && err.stack || err)}</pre>`);
});
