'use strict';
// Stormo — Electron main process.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, Notification, Menu, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const { Store } = require('./src/main/store');
const cli = require('./src/main/cli');
const { PtyManager } = require('./src/main/pty');
const { VoiceManager } = require('./src/main/voice');
const git = require('./src/main/git');
const models = require('./src/main/models');
const autoRouter = require('./src/main/router');
const { Regia } = require('./src/main/regia');
const { createRouterGuard } = require('./src/main/router-guard');
const { requestKind } = require('./src/main/request-kind');
const routerInject = require('./src/main/router-inject');

let engines = null;
try { engines = require('./src/main/engines'); } catch (err) { console.error('engines not available:', err.message); }

const APP_ID = 'app.stormo.desktop';
const ROOT = __dirname;

// If Stormo starts from inside a Claude Code session (e.g. launched from one of its terminals),
// that session's variables must be stripped right away, for every child process.
require('./src/main/env').stripInheritedClaudeSession();

app.setAppUserModelId(APP_ID);
// A window covered by others would be treated as "hidden" and would stop rendering:
// the terminals need to stay alive and updated even behind other windows.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
if (process.env.STORMO_PROFILE) {
  // Separate profile for automated tests (does not touch the user's real data).
  app.setPath('userData', path.join(app.getPath('appData'), 'Stormo-' + process.env.STORMO_PROFILE));
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let win = null;
let store = null;
let regia = null;
let ptys = null;
let voice = null;
const runs = new Map();
let cliOverrides = {};

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function serveAppProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT + path.sep)) return new Response('forbidden', { status: 403 });
    const res = await net.fetch(pathToFileURL(file).toString());
    // No caching: after a file update the UI must reload the new ones.
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(res.body, { status: res.status, headers });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 840, minWidth: 980, minHeight: 620,
    frame: false,
    backgroundColor: '#060918',
    show: false,
    title: 'Stormo',
    icon: path.join(ROOT, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      backgroundThrottling: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  win.on('focus', () => send('win:focus', true));
  win.on('blur', () => send('win:focus', false));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) e.preventDefault();
  });
  win.loadURL('app://stormo/renderer/index.html');
}

app.on('web-contents-created', (_e, contents) => {
  // The side browser (webview) must never have special powers.
  contents.on('will-attach-webview', (ev, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!/^(https?:|about:blank)/i.test(params.src || 'about:blank')) ev.preventDefault();
  });
  if (contents.getType() === 'webview') {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) contents.loadURL(url);
      return { action: 'deny' };
    });
  }
});

function consentFile() { return path.join(app.getPath('userData'), 'stormo-setup.json'); }
function readConsent() {
  try { return JSON.parse(fs.readFileSync(consentFile(), 'utf8')); } catch { return {}; }
}
function writeConsent(data) {
  fs.mkdirSync(path.dirname(consentFile()), { recursive: true });
  fs.writeFileSync(consentFile(), JSON.stringify(data, null, 2));
  return data;
}
// Once consent is given, the block is reapplied wherever it's missing on every startup (some tools rewrite those files).
function reapplyRouter() {
  const c = readConsent().router;
  if (!c || !c.accepted || !Array.isArray(c.ids) || !c.ids.length) return;
  try {
    routerInject.apply({ home: os.homedir(), ids: c.ids, backupDir: path.join(app.getPath('userData'), 'router-backups'),
      bundledSkill: path.join(ROOT, 'assets', 'router', 'SKILL.md') });
  } catch (err) { console.error('router: could not reapply the instructions:', err.message); }
}

function registerIpc() {
  ipcMain.handle('state:load', () => store.load());
  ipcMain.handle('state:save', (_e, data) => { store.save(data); return true; });

  ipcMain.handle('cli:detect', (_e, overrides) => {
    cliOverrides = overrides || {};
    return cli.detectAll(cliOverrides);
  });
  ipcMain.handle('cli:version', (_e, id) => cli.versionOf(id, cliOverrides));

  ipcMain.handle('dialog:pickFolder', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('pty:spawn', (_e, { id, agent, cwd, cols, rows, smart }) => {
    const def = cli.getAgent(agent);
    if (!def) return { ok: false, error: 'Unknown agent: ' + agent };
    const exec = cli.resolveAgent(def, cliOverrides);
    if (!exec) return { ok: false, error: def.name + ' is not installed on this PC.' };
    const folder = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
    return ptys.spawn({ id, file: exec.file, args: [...exec.prefixArgs, ...cli.baseArgs(agent), ...(smart ? cli.smartArgs(agent) : [])], cwd: folder,
      env: cli.childEnv(exec.env), cols, rows });
  });
  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:kill', (_e, id) => ptys.kill(id));

  ipcMain.handle('voice:start', (_e, id) => voice.start(String(id)));
  ipcMain.handle('voice:check', (_e, force) => voice.check(!!force));
  ipcMain.on('voice:stop', (_e, id) => voice.stop(String(id)));

  ipcMain.handle('engine:regia', (_e, opts) => regia.open(opts));
  ipcMain.handle('engine:run', async (_e, opts) => {
    if (!engines) return { ok: false, error: 'Engine module missing' };
    const runId = opts.runId;
    const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
    const logFile = opts.engine === 'agy' ? path.join(app.getPath('temp'), `stormo-agy-${runId}.log`) : undefined;
    // Only the Auto Mode mode NAME comes from the renderer: router.js builds the prompt, permissions and environment.
    const { router: routerMode, routerSessions: _sessions, routerEngine: _leader, routerHistory: _history,
      routerModel: _model, routerChatId: _chat, routerPolicyLoaded: _loaded, routerPolicyMode: _mode,
      recentRequests: _recent, requestKind: _requestKind,
      env: _env, appendSystemPromptFile: _file, systemPromptSnapshot: _snapshot, promptStdin: _stdin, ...fromRenderer } = opts;
    let auto = {};
    if (routerMode) {
      if (!['claude', 'codex'].includes(opts.engine)) return { ok: false, error: 'Auto Mode uses Claude Code or Codex.' };
      let cancelled = false;
      runs.set(runId, { cancel() { cancelled = true; } });
      const leader = await regia.open(opts);
      runs.delete(runId);
      if (cancelled || !win || win.isDestroyed()) return { ok: false, error: 'Request cancelled.' };
      if (!leader.ok) return leader;
      const prep = autoRouter.prepare(String(routerMode), { dataDir: path.join(app.getPath('userData'), 'auto'),
        instructions: !leader.sessionId || !leader.initialized });
      if (!prep.ok) return { ok: false, error: prep.error };
      const kind = requestKind(opts.prompt, opts.recentRequests);
      auto = { ...autoRouter.leaderRunOptions({ ...opts, requestKind: kind }, prep, leader),
        requestKind: kind, env: { ...prep.env, STORMO_REQUEST_KIND: kind } };
    }
    const selectedEngine = auto.engine || opts.engine;
    const def = cli.getAgent(selectedEngine);
    const exec = def && cli.resolveAgent(def, cliOverrides);
    if (!exec) return { ok: false, error: (def ? def.name : selectedEngine) + ' is not installed on this PC.' };
    const base = { ...fromRenderer, ...auto, cwd, logFile, exec: { file: exec.file, prefixArgs: exec.prefixArgs, env: exec.env } };
    const guard = routerMode ? createRouterGuard({ required: auto.requestKind === 'coding' }) : null;
    let sessionId = base.sessionId;
    let cancelled = false;
    let current = null;
    const start = (retry = false) => {
      if (cancelled) { runs.delete(runId); send('engine:event',runId,{type:'done',ok:false}); return; }
      current = engines.startRun({ ...base, sessionId, ...(retry ? { appendSystemPromptFile: sessionId ? null : base.appendSystemPromptFile,
        prompt: 'REQUIREMENT NOT MET: run route-ask NOW to generate the answer to the request below, then report the result. No direct answer.\n\n' + base.prompt } : {}) }, evt => {
        if (evt.type === 'start' && evt.sessionId) {
          sessionId = evt.sessionId;
          if (routerMode) regia.started(opts.routerChatId, sessionId, routerMode, autoRouter.POLICY_VERSION);
        }
        const action = guard ? guard.event(evt) : { events: [evt] };
        if (action.retry) { setImmediate(() => start(true)); return; }
        for (const event of action.events) {
          send('engine:event', runId, event.type === 'start' ? { ...event, engine: selectedEngine,
            ...(routerMode ? { model: auto.model, effort: auto.effort } : {}) } : event);
          if (event.type === 'done') runs.delete(runId);
        }
      });
    };
    runs.set(runId, { cancel() { cancelled = true; if (current) current.cancel(); } });
    start();
    return { ok: true, engine: selectedEngine };
  });
  ipcMain.on('engine:cancel', (_e, runId) => {
    const r = runs.get(runId);
    if (r) r.cancel();
  });

  ipcMain.handle('models:list', (_e, engine) => {
    const def = cli.getAgent(engine);
    const exec = def && cli.resolveAgent(def, cliOverrides);
    return models.list(engine, exec && exec.file);
  });

  ipcMain.handle('git:info', (_e, cwd) => git.info(cwd));
  ipcMain.handle('git:changes', (_e, cwd) => git.changes(cwd));

  ipcMain.handle('fs:exists', (_e, p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  ipcMain.handle('fs:agentDir', (_e, agentId) => {
    const safe = String(agentId).replace(/[^a-z0-9_-]/gi, '');
    const dir = path.join(app.getPath('userData'), 'agents', safe);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  // First run and model router consent (separate file: the main process also reads it on startup).
  ipcMain.handle('setup:get', () => readConsent());
  ipcMain.handle('setup:set', (_e, patch) => writeConsent({ ...readConsent(), ...patch }));
  ipcMain.handle('router:status', async () => {
    const found = cli.detectAll(cliOverrides);
    const installed = {};
    for (const a of found || []) installed[a.id] = !!a.installed;
    return { targets: routerInject.status({ home: os.homedir(), installed }), skill: fs.existsSync(routerInject.skillPath(os.homedir())),
      routeAsk: !!cli.which('route-ask'), consent: readConsent().router || null };
  });
  ipcMain.handle('router:apply', (_e, ids) => {
    const r = routerInject.apply({ home: os.homedir(), ids, backupDir: path.join(app.getPath('userData'), 'router-backups'),
      bundledSkill: path.join(ROOT, 'assets', 'router', 'SKILL.md') });
    // Providers left unticked lose the block if they had it: the consent covers exactly the ticked ones.
    const others = routerInject.targets(os.homedir()).map((t) => t.id).filter((id) => !ids.includes(id));
    r.removed = routerInject.remove({ home: os.homedir(), ids: others }).results;
    writeConsent({ ...readConsent(), router: { accepted: true, ids, at: new Date().toISOString() } });
    return r;
  });
  ipcMain.handle('router:remove', () => {
    const r = routerInject.remove({ home: os.homedir() });
    writeConsent({ ...readConsent(), router: { accepted: false, ids: [], at: new Date().toISOString() } });
    return r;
  });

  ipcMain.handle('app:info', () => ({ version: app.getVersion(), home: os.homedir(),
    userData: app.getPath('userData'), platform: process.platform }));

  ipcMain.on('win:minimize', () => win && win.minimize());
  ipcMain.on('win:toggleMaximize', () => { if (!win) return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
  ipcMain.on('win:close', () => win && win.close());
  ipcMain.handle('win:isMaximized', () => !!(win && win.isMaximized()));

  ipcMain.handle('clip:read', () => clipboard.readText());
  ipcMain.on('clip:write', (_e, text) => clipboard.writeText(String(text ?? '')));

  ipcMain.on('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(url);
  });
  ipcMain.on('shell:openPath', (_e, p) => {
    try { if (fs.statSync(p).isDirectory()) shell.openPath(p); } catch { /* ignore */ }
  });

  ipcMain.on('notify', (_e, { title, body }) => {
    if (win && win.isFocused()) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: String(title || 'Stormo'), body: String(body || ''),
      icon: path.join(ROOT, 'assets', 'icon.png') });
    n.on('click', () => { if (win) { win.show(); win.focus(); } });
    n.show();
  });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  store = new Store(app.getPath('userData'));
  regia = new Regia(path.join(app.getPath('userData'), 'regia.json'));
  ptys = new PtyManager(send);
  voice = new VoiceManager(send);
  serveAppProtocol();
  registerIpc();
  reapplyRouter();
  createWindow();
});

app.on('before-quit', () => {
  if (ptys) ptys.killAll();
  if (voice) voice.stopAll();
  for (const r of runs.values()) { try { r.cancel(); } catch { /* ignore */ } }
});

app.on('window-all-closed', () => app.quit());
