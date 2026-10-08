'use strict';
// Real terminals (ConPTY) for the Code mode panels.
// Each panel = one process (claude, codex, agy, powershell…) connected to xterm.js in the renderer.

const pty = require('@lydell/node-pty');

// State shown by the panel's dot and by the Dashboard.
const WORKING_WINDOW_MS = 1500;   // output in the last 1.5s = working
const ECHO_GRACE_MS = 250;        // the echo of what you type doesn't count as "work"
const TAIL_CHARS = 1600;

// OSC sequences (window title etc.) end with BEL: they aren't a real "bell".
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g;

// Phrases CLIs use to ask for a permission or confirmation.
const NEEDS_YOU_RE = new RegExp([
  'Do you want to (?:proceed|make this edit|create|run|allow)',
  'Would you like to (?:run|make|apply|allow)',
  'Allow (?:command|execution|this|once|always)',
  'Apply this change\\?',
  'approve this',
  'Press enter to confirm',
  'Enter to confirm',
  // Folder-trust prompts (Claude Code, Codex, Antigravity on first launch).
  'Do you trust',
  'trust this folder',
  'Trust and continue',
  '\\(y/n\\)', '\\[y/N\\]', '\\[Y/n\\]',
].join('|'), 'i');

function stripAnsi(s) {
  return s.replace(OSC_RE, '').replace(ANSI_RE, '');
}

class PtyManager {
  constructor(send, ptyImpl = pty) {
    this.send = send;          // (channel, ...args) => void
    this.pty = ptyImpl;
    this.ptys = new Map();
    this.timer = setInterval(() => this.tick(), 400);
    if (this.timer.unref) this.timer.unref();   // the timer alone must not keep the program alive
  }

  spawn({ id, file, args = [], cwd, env, cols = 100, rows = 30 }) {
    this.kill(id);
    let proc;
    try {
      proc = this.pty.spawn(file, args, {
        name: 'xterm-256color', cols: Math.max(2, cols | 0), rows: Math.max(2, rows | 0),
        cwd, env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        ...(process.platform === 'win32' ? { useConpty: true } : {}),
      });
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
    const entry = { proc, buf: '', flushTimer: null, lastDataAt: Date.now(), lastInputAt: 0,
      tail: '', needsYou: false, state: 'working', exited: false };
    this.ptys.set(id, entry);

    proc.onData((data) => {
      entry.buf += data;
      if (!entry.flushTimer) entry.flushTimer = setTimeout(() => this.flush(id), 12);
      const now = Date.now();
      if (now - entry.lastInputAt > ECHO_GRACE_MS) entry.lastDataAt = now;
      const bell = data.replace(OSC_RE, '').includes('\x07');
      entry.tail = (entry.tail + stripAnsi(data)).slice(-TAIL_CHARS);
      if (bell || NEEDS_YOU_RE.test(entry.tail.slice(-700))) entry.needsYou = true;
    });
    proc.onExit(({ exitCode }) => {
      entry.exited = true;
      clearTimeout(entry.flushTimer);
      // A replaced (restarted) or closed (panel closed) process must not talk to the UI:
      // its "exit" arrives after the new one has started and would make it look dead.
      if (this.ptys.get(id) !== entry) return;
      this.flush(id);
      this.ptys.delete(id);
      this.send('pty:exit', id, exitCode);
      this.setState(id, entry, 'exited');
      // node-pty on Windows only closes outSocket on natural exit: inSocket and the
      // ConoutConnection worker stay open and keep the process alive. kill() frees them.
      if (process.platform === 'win32') {
        setImmediate(() => {
          try { proc.kill(); } catch { /* already closed: the exitCode was already sent */ }
        });
      }
    });
    return { ok: true, pid: proc.pid };
  }

  flush(id) {
    const e = this.ptys.get(id);
    if (!e) return;
    clearTimeout(e.flushTimer);
    e.flushTimer = null;
    if (e.buf) {
      const chunk = e.buf;
      e.buf = '';
      this.send('pty:data', id, chunk);
    }
  }

  write(id, data) {
    const e = this.ptys.get(id);
    if (!e) return;
    e.lastInputAt = Date.now();
    // You've answered: the prompt was seen. The old text must not re-trigger the alert.
    if (e.needsYou) { e.needsYou = false; e.tail = ''; }
    e.proc.write(data);
  }

  resize(id, cols, rows) {
    const e = this.ptys.get(id);
    if (!e || e.exited) return;
    try { e.proc.resize(Math.max(2, cols | 0), Math.max(2, rows | 0)); } catch { /* process just exited */ }
  }

  kill(id) {
    const e = this.ptys.get(id);
    if (!e) return;
    this.ptys.delete(id);
    clearTimeout(e.flushTimer);
    e.flushTimer = null;
    try { e.proc.kill(); } catch { /* already closed */ }
  }

  killAll() {
    for (const id of [...this.ptys.keys()]) this.kill(id);
    clearInterval(this.timer);
  }

  setState(id, e, state) {
    if (e.state === state) return;
    e.state = state;
    this.send('pty:state', id, state);
  }

  tick() {
    const now = Date.now();
    for (const [id, e] of this.ptys) {
      const state = e.needsYou ? 'needsYou'
        : (now - e.lastDataAt < WORKING_WINDOW_MS ? 'working' : 'idle');
      this.setState(id, e, state);
    }
  }
}

module.exports = { PtyManager, stripAnsi, NEEDS_YOU_RE };
