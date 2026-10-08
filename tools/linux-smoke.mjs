import { connect } from './cdp.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const port = Number(process.argv[2] ?? 9337);
const shotPath = process.argv[3] ?? 'dist/linux-preview.png';
const MODES = ['agent', 'thread', 'auto', 'code']; // code last: it's the final screenshot

const fail = (msg) => { throw new Error(msg); };

const cdp = await connect(port).catch((e) => fail(`CDP not reachable on port ${port}: ${e.message}`));

// If evaluate returns the CDP wrapper instead of the value, discard it; if there are exceptions, fail.
async function ev(expression) {
  const r = await cdp.evaluate(expression);
  if (r?.exceptionDetails) fail(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r && typeof r === 'object' && r.result && 'value' in r.result ? r.result.value : r;
}

// Helper reused inside the expressions run on the page.
const WAIT = String.raw`const waitFor = async (fn, ms, what) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timeout: ' + what);
};`;

async function checkInfo() {
  const info = await ev('window.fm.app.info()');
  if (info?.platform !== 'linux') fail(`expected platform linux, found ${info?.platform}`);
  if (!String(info.userData).includes('qa-linux')) fail(`userData not isolated (qa-linux missing): ${info.userData}`);
  return info;
}

async function checkPty() {
  const out = await ev(String.raw`(async () => {
    ${WAIT}
    const id = 'qa-smoke-' + Date.now();
    let data = '', exit = null;
    const offData = window.fm.pty.onData((i, d) => { if (i === id) data += d; });
    const offExit = window.fm.pty.onExit((i, c) => { if (i === id) exit = c; });
    try {
      const r = await window.fm.pty.spawn({ id, agent: 'terminal', cwd: (await window.fm.app.info()).home, cols: 80, rows: 24 });
      if (!r?.ok) throw new Error('spawn failed: ' + r?.error);
      await window.fm.pty.write(id, "printf 'fm-smoke-%s\\n' 42\r");
      await waitFor(() => data.includes('fm-smoke-42'), 10000, 'marker fm-smoke-42');
      await window.fm.pty.resize(id, 100, 30);
      await window.fm.pty.write(id, 'exit\r');
      await waitFor(() => exit !== null, 10000, 'terminal exit');
      if (exit !== 0) throw new Error('exit code ' + exit);
      return { pid: r.pid, exit, data: data.slice(-200) };
    } finally {
      if (exit === null) { try { await window.fm.pty.kill(id); } catch {} }
      offData?.(); offExit?.();
    }
  })()`);
  return out;
}

async function checkPersistence() {
  return ev(String.raw`(async () => {
    const s = window.fm.state;
    const orig = (await s.load()) ?? {};
    const mark = 'qa-' + Date.now();
    try {
      await s.save({ ...orig, _linuxQaCheck: mark });
      const back = await s.load();
      if (back?._linuxQaCheck !== mark) throw new Error('save->load does not match: ' + back?._linuxQaCheck);
    } finally {
      await s.save(orig);
    }
    const after = await s.load();
    if (after?._linuxQaCheck !== orig._linuxQaCheck) throw new Error('state restore failed');
    return true;
  })()`);
}

async function checkSettings() {
  const opened = await ev(String.raw`(async () => {
    ${WAIT}
    const btn = document.querySelector('[data-act="settings"]');
    if (!btn) return { checked: false, reason: 'settings button missing' };
    btn.click();
    await waitFor(() => document.querySelector('#st-name'), 5000, '#st-name');
    return { checked: true };
  })()`);
  if (!opened.checked) return opened;
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  }
  await ev(String.raw`(async () => {
    ${WAIT}
    await waitFor(() => { const e = document.querySelector('#st-name'); return !e || e.offsetParent === null; }, 5000, 'closing the modal with Escape');
  })()`);
  return { checked: true, closedWithEscape: true };
}

async function checkModes() {
  const done = [];
  for (const m of MODES) {
    await ev(String.raw`(async () => {
      ${WAIT}
      const btn = document.querySelector('[data-mode="${m}"]');
      if (!btn) throw new Error('mode button missing: ${m}');
      btn.click();
      await waitFor(() => {
        const c = document.querySelector('#center-${m}');
        if (!c || c.hidden) return false;
        return ['agent', 'code', 'thread', 'auto'].filter((o) => o !== '${m}')
          .every((o) => document.querySelector('#center-' + o)?.hidden);
      }, 5000, 'center ${m} visible');
    })()`);
    done.push(m);
  }
  return done;
}

const summary = {};
try {
  summary.info = await checkInfo();
  summary.pty = await checkPty();
  summary.persistence = await checkPersistence();
  summary.settings = await checkSettings();
  summary.modes = await checkModes();
  mkdirSync(dirname(shotPath), { recursive: true });
  await cdp.shot(shotPath);
  summary.screenshot = shotPath;
  summary.theme = 'skipped';
  console.log(JSON.stringify(summary, null, 2));
} catch (e) {
  console.error(`SMOKE FAILED: ${e.message}`);
  console.error(JSON.stringify(summary));
  process.exitCode = 1;
} finally {
  await cdp.close(); // only closes the CDP connection, not the app
}
