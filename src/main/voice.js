'use strict';
// Local dictation. A Python process with Whisper stays alive between one dictation and the next
// (the model isn't reloaded on every click) and shuts itself down after a few minutes idle.
// Only one recording at a time. The transcribed text reaches the UI: Enter is never sent from here.

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IDLE_MS = 8 * 60 * 1000;      // after this idle time the process shuts down and frees RAM and GPU
const STOP_WATCHDOG_MS = 60 * 1000; // after Stop, total process silence for this long = it's stuck
const IS_WIN = process.platform === 'win32';

const PROBE = [
  'import importlib.util as u, json, pathlib',
  'miss = [m for m in ("numpy", "sounddevice", "whisper", "torch") if u.find_spec(m) is None]',
  'cache = pathlib.Path.home() / ".cache" / "whisper"',
  'print(json.dumps({"missing": miss, "models": [n for n in ("small", "base", "tiny") if (cache / (n + ".pt")).is_file()]}))',
].join('\n');

// On POSIX a Python is usable only with the execute bit set (statSync follows venv symlinks).
function isRunnableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!IS_WIN) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function pythonCandidates() {
  const out = [];
  if (process.env.STORMO_PYTHON) out.push(process.env.STORMO_PYTHON);
  if (IS_WIN) {
    const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Python');
    try {
      const dirs = fs.readdirSync(base).filter((d) => /^Python\d+$/.test(d)).sort((a, b) => +b.slice(6) - +a.slice(6));
      for (const d of dirs) out.push(path.join(base, d, 'python.exe'));
    } catch { /* folder missing */ }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (dir) out.push(path.join(dir, 'python.exe'));
    }
  } else {
    // Stormo's dedicated venv before the system Python
    out.push(path.join(os.homedir(), '.local', 'share', 'stormo', 'voice-venv', 'bin', 'python'));
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (dir) out.push(path.join(dir, 'python3'));
    }
    out.push('/usr/local/bin/python3', '/usr/bin/python3');
  }
  return [...new Set(out)].filter(isRunnableFile)
    // the fake "python.exe" from the Store lives in WindowsApps and runs nothing
    .filter((p) => !/WindowsApps/i.test(p));
}

function probe(python) {
  return new Promise((resolve) => {
    execFile(python, ['-c', PROBE], { timeout: 20000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } },
      (err, stdout) => {
        if (err) return resolve({ python, missing: ['python'], models: [] });
        try { resolve({ python, ...JSON.parse(String(stdout).trim().split(/\r?\n/).pop()) }); } catch { resolve({ python, missing: ['python'], models: [] }); }
      });
  });
}

function problemText(info) {
  if (!info) return 'Python not found: dictation needs Python 3.12 with openai-whisper.';
  if (info.missing.includes('python')) return 'Python won\'t start: check the installation.';
  if (info.missing.length) return `Missing Python package "${info.missing[0]}" (install with: pip install ${info.missing[0] === 'whisper' ? 'openai-whisper' : info.missing[0]}).`;
  if (!info.models.length) return 'Missing voice model: put small.pt or base.pt in ' + path.join(os.homedir(), '.cache', 'whisper') + '.';
  return '';
}

class VoiceManager {
  // opts.spawnSpec = { file, args }: for tests only (a fake process that speaks the same protocol).
  constructor(send, opts = {}) {
    this.send = send;
    this.script = opts.script || path.join(__dirname, 'voice_worker.py');
    this.spawnSpec = opts.spawnSpec || null;
    this.idleMs = opts.idleMs || IDLE_MS;
    this.stopWatchdogMs = opts.stopWatchdogMs || STOP_WATCHDOG_MS;
    this.env = opts.env || {};
    this.worker = null;    // { child, buffer, ready, quitting, errTail }
    this.active = null;    // { id, stopping }
    this.pending = null;   // { id } dictation waiting for the previous one to finish
    this.idleTimer = null;
    this.watchdog = null;
    this.info = null;
  }

  // Says whether voice can work on this PC (and why not). A positive result is remembered.
  async check(force = false) {
    if (this.spawnSpec) return { ok: true, python: this.spawnSpec.file, missing: [], models: ['test'], problem: '' };
    if (this.info && this.info.ok && !force) return this.info;
    let best = null;
    for (const py of pythonCandidates()) {
      const r = await probe(py);
      if (!r.missing.length && r.models.length) { best = r; break; }
      if (!best || r.missing.length < best.missing.length) best = r;
    }
    const ok = !!best && !best.missing.length && best.models.length > 0;
    this.info = { ok, python: best && best.python, missing: best ? best.missing : ['python'], models: best ? best.models : [], problem: ok ? '' : problemText(best) };
    return this.info;
  }

  _forward(id, event) { this.send('voice:event', id, event); }

  _write(obj) {
    const w = this.worker;
    if (!w || w.quitting) return;
    try { w.child.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* process just closed: 'close' handles it */ }
  }

  async start(id) {
    if (this.active) {
      if (this.active.id === id) return { ok: true };
      if (!this.active.stopping) return { ok: false, error: 'Stop the active dictation first.' };
      this.pending = { id };                        // the other one is finishing transcribing: I'll start right after
      return { ok: true, queued: true };
    }
    this.active = { id, stopping: false };          // reserved right away: no race while looking for Python
    const info = await this.check();
    if (!this.active || this.active.id !== id) return { ok: true };
    if (!info.ok) { this.active = null; return { ok: false, error: info.problem }; }
    if (this.active.stopping) {                     // Stop pressed while I was looking for Python: nothing to start
      this.active = null;
      this._forward(id, { type: 'done' });
      return { ok: true };
    }
    this._launch(id, info.python);
    return { ok: true };
  }

  _launch(id, python) {
    clearTimeout(this.idleTimer);
    if (this.worker && !this.worker.quitting) {
      this._write({ cmd: 'start' });                // process already warm: the microphone opens right away
      return;
    }
    const spec = this.spawnSpec || { file: python, args: ['-u', this.script, '--record-now'] };
    const child = spawn(spec.file, spec.args, {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not essential */ }
    const w = { child, buffer: '', ready: false, quitting: false, errTail: '' };
    this.worker = w;
    child.stdin.on('error', () => { /* pipe closed: 'close' reports it */ });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { w.errTail = (w.errTail + d).slice(-1500); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => {
      w.buffer += data;
      for (;;) {
        const at = w.buffer.indexOf('\n');
        if (at < 0) break;
        const line = w.buffer.slice(0, at).trim();
        w.buffer = w.buffer.slice(at + 1);
        if (line) this._onLine(w, line);
      }
    });
    child.on('error', (err) => this._onExit(w, err.message));
    child.on('close', () => this._onExit(w));
    this._forward(id, { type: 'state', state: 'loading' });
    this._forward(id, { type: 'notice', message: 'Loading speech recognition (a few seconds, first time only): you can start speaking already.' });
  }

  _onLine(w, line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }   // diagnostic lines that aren't JSON
    if (this.active && this.active.stopping) this._armWatchdog();
    const a = this.active;
    if (ev.type === 'ready') { w.ready = true; return; }
    if (ev.type === 'state' || ev.type === 'text') { if (a) this._forward(a.id, ev); return; }
    if (ev.type === 'done') {
      if (a) { this._forward(a.id, { type: 'done' }); this.active = null; }
      clearTimeout(this.watchdog);
      this._afterFinished();
      return;
    }
    if (ev.type === 'error') {
      if (a) { this._forward(a.id, { type: 'error', message: ev.message || 'error' }); this.active = null; }
      this._killWorker(w);                                // after an error, start fresh on the next click
      this._afterFinished();
    }
  }

  _afterFinished() {
    if (this.pending) {
      const { id } = this.pending;
      this.pending = null;
      this.start(id).then((r) => { if (!r.ok) this._forward(id, { type: 'error', message: r.error }); });
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this._quitWorker(), this.idleMs);
    if (this.idleTimer.unref) this.idleTimer.unref();
  }

  _onExit(w, reason) {
    clearTimeout(this.watchdog);
    if (this.worker === w) this.worker = null;
    if (w.quitting) return;
    w.quitting = true;
    if (this.active) {
      const tail = w.errTail.trim().split(/\r?\n/).pop();
      this._forward(this.active.id, { type: 'error', message: 'Dictation stopped' + (reason || tail ? ': ' + (reason || tail) : '.') });
      this.active = null;
    }
    this._afterFinished();
  }

  _armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      const w = this.worker;
      if (this.active && this.active.stopping && w) this._killWorker(w);   // 'close' notifies the UI
    }, this.stopWatchdogMs);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  _killWorker(w) {
    w.quitting = w.quitting || false;
    try { w.child.kill(); } catch { /* already closed */ }
  }

  _quitWorker() {
    const w = this.worker;
    if (!w || this.active) return;
    w.quitting = true;
    this.worker = null;
    try { w.child.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch { /* ok */ }
    setTimeout(() => { try { w.child.kill(); } catch { /* already closed */ } }, 3000).unref();
  }

  stop(id) {
    const a = this.active;
    if (!a || a.id !== id || a.stopping) return;
    a.stopping = true;
    if (!this.worker) return;       // still starting up: start() will see it
    this._write({ cmd: 'stop' });
    this._armWatchdog();
  }

  stopAll() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.watchdog);
    this.pending = null;
    const w = this.worker;
    this.worker = null;
    this.active = null;
    if (w) { w.quitting = true; try { w.child.kill(); } catch { /* already closed */ } }
  }
}

module.exports = { VoiceManager, pythonCandidates, probe, problemText };
