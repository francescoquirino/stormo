'use strict';
// Launches a CLI in headless mode, reads its JSON stream line by line and translates it into events.

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const claude = require('./claude');
const codex = require('./codex');
const agy = require('./agy');
const gemini = require('./gemini');
const { AGY_QUOTA_MESSAGE } = require('./common');
const cli = require('../cli');

const adapters = { claude, codex, agy, gemini };

// On Windows, environment variable names are case-insensitive: we avoid duplicate PATH and Path.
function buildEnv(engine, overrides = {}) {
  const env = { ...cli.childEnv() };
  const sameKey = process.platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
  const setVar = (key, value) => {
    dropVar(key);
    env[key] = value;
  };
  const dropVar = (key) => {
    for (const k of Object.keys(env)) if (sameKey(k, key)) delete env[k];
  };
  const hasRunAsNode = Object.prototype.hasOwnProperty.call(overrides || {}, 'ELECTRON_RUN_AS_NODE');
  for (const [k, v] of Object.entries(overrides || {})) setVar(k, v);
  setVar('NO_COLOR', '1');
  setVar('FORCE_COLOR', '0');
  if (engine === 'claude') dropVar('ANTHROPIC_API_KEY');
  if (!hasRunAsNode) dropVar('ELECTRON_RUN_AS_NODE');
  return env;
}

// On POSIX the child is the leader of its own process group: -pid hits it and its descendants, not us.
function killProcessGroup(pid, kill = (p, sig) => process.kill(p, sig)) {
  if (!Number.isInteger(pid) || pid <= 1) throw new RangeError(`Invalid process group leader pid: ${pid}`);
  try { kill(-pid, 'SIGKILL'); } catch (err) { if (err.code !== 'ESRCH') throw err; }
}

const isStringMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');

// A call's environment variables override the executable's own (Auto Mode passes ROUTE_ONLY_TIER this way).
function runEnvOverrides(exec, opts) {
  return { ...((exec && exec.env) || {}), ...(opts.env || {}) };
}

function startRun(opts, emit) {
  let settled = false;
  let cancelled = false;
  let processExited = false;
  let fatal = false;
  let quotaReported = false;
  let stdoutBuffer = '';
  let quotaTimer = null;
  let readingLog = false;
  let child = null;
  let parser = null;

  const clearQuotaTimer = () => { if (quotaTimer) { clearInterval(quotaTimer); quotaTimer = null; } };

  function complete(doneEvent) {
    if (settled) return;
    settled = true;
    clearQuotaTimer();
    if (cancelled) emit({ type: 'notice', message: 'Stopped' });
    emit({ ...doneEvent, type: 'done', ok: doneEvent.ok === true && !cancelled && !fatal });
  }

  function forward(evt) {
    if (settled) return;
    if (evt.type === 'done') { complete(evt); return; }
    if (evt.type === 'error') {
      // After Stop the process is forced to exit "badly": that error must not be shown.
      if (cancelled && !String(evt.message).startsWith('Cannot stop')) return;
      fatal = true;
      if (quotaReported) return;
      if (evt.message === AGY_QUOTA_MESSAGE) quotaReported = true;
    }
    emit(evt);
  }

  function failStart(err) {
    if (settled) return;
    forward({ type: 'error', message: `Cannot start ${opts.engine}: ${err && err.message ? err.message : err}` });
    complete({ type: 'done', ok: false });
  }

  const adapter = Object.hasOwn(adapters, opts.engine) ? adapters[opts.engine] : null;
  const exec = opts.exec || {};
  const bad = !adapter ? `unknown engine "${opts.engine}"`
    : typeof opts.prompt !== 'string' ? 'missing prompt'
      : !opts.cwd ? 'missing working folder'
        : !exec.file ? 'missing executable'
          : exec.prefixArgs && (!Array.isArray(exec.prefixArgs) || exec.prefixArgs.some((a) => typeof a !== 'string')) ? 'bad prefix arguments'
            : opts.env !== undefined && !isStringMap(opts.env) ? 'bad environment'
              : null;
  if (bad) {
    setImmediate(() => failStart(new Error(bad)));
    return { cancel() {} };
  }

  parser = adapter.createParser(forward, opts);

  function onStdout(chunk) {
    stdoutBuffer += chunk;
    let nl;
    while ((nl = stdoutBuffer.indexOf('\n')) !== -1) {
      let line = stdoutBuffer.slice(0, nl);
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      parser.feedLine(line);
    }
  }

  function onClose(code) {
    clearQuotaTimer();
    processExited = true;
    if (settled) return;
    if (stdoutBuffer) {
      let line = stdoutBuffer;
      stdoutBuffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      parser.feedLine(line);
    }
    parser.finish(code ?? -1);
  }

  function cancel() {
    if (settled || cancelled || processExited) return;
    cancelled = true;
    clearQuotaTimer();
    if (!child || !Number.isInteger(child.pid)) return;
    if (process.platform !== 'win32') {
      try { killProcessGroup(child.pid); } catch (err) { if (!processExited) forward({ type: 'error', message: `Cannot stop ${opts.engine}: ${err.message}` }); }
      return;
    }
    let killer;
    try {
      killer = childProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch (err) {
      if (!processExited) forward({ type: 'error', message: `Cannot stop ${opts.engine}: ${err.message}` });
      return;
    }
    killer.on('error', (err) => { if (!processExited) forward({ type: 'error', message: `Cannot stop ${opts.engine}: ${err.message}` }); });
    killer.on('close', (code) => { if (code !== 0 && !processExited) forward({ type: 'error', message: `Cannot stop ${opts.engine}: taskkill exited with ${code}` }); });
  }

  async function pollQuota() {
    if (readingLog || settled || cancelled || processExited) return;
    readingLog = true;
    try {
      const logPath = path.isAbsolute(opts.logFile) ? opts.logFile : path.resolve(opts.cwd, opts.logFile);
      let text = '';
      try { text = await fs.promises.readFile(logPath, 'utf8'); } catch { return; }
      if (settled || cancelled || processExited) return;
      if (adapters.agy.countQuotaErrors(text) >= 3) {
        if (!quotaReported) forward({ type: 'error', message: AGY_QUOTA_MESSAGE });
        cancel();
      }
    } finally {
      readingLog = false;
    }
  }

  try {
    child = childProcess.spawn(exec.file, [...(exec.prefixArgs || []), ...adapter.buildArgs(opts)], {
      cwd: opts.cwd,
      env: buildEnv(opts.engine, runEnvOverrides(exec, opts)),
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: [opts.engine === 'codex' && (opts.appendSystemPromptFile || opts.promptStdin) ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    setImmediate(() => failStart(err));
    return { cancel() {} };
  }

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onStdout);
  child.stderr.on('data', (t) => { if (!settled) parser.feedStderr(t); });
  child.on('error', failStart);
  child.on('exit', () => { processExited = true; clearQuotaTimer(); });
  child.on('close', onClose);
  if (opts.engine === 'codex' && (opts.appendSystemPromptFile || opts.promptStdin)) {
    child.stdin.on('error', failStart);
    try { child.stdin.end(adapter.buildPrompt(opts), 'utf8'); } catch (err) { failStart(err); cancel(); }
  }

  if (opts.engine === 'agy' && opts.logFile) quotaTimer = setInterval(pollQuota, 2000);

  return { cancel };
}

module.exports = { adapters, startRun, buildEnv, runEnvOverrides, killProcessGroup };
