'use strict';
// Stormo's Linux (and Windows) compatibility: env, paths, router labels, processes, PTY. No provider or network calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const engines = require('../src/main/engines');
const { shortPath, toolLabel } = require('../src/main/engines/common');
const router = require('../src/main/router');
const { PtyManager } = require('../src/main/pty');
const { pythonCandidates } = require('../src/main/voice');

const isWin = process.platform === 'win32';
const BSLASH = String.fromCharCode(92);
const DQUOTE = String.fromCharCode(34);
const BACKTICK = String.fromCharCode(96);
const CR = String.fromCharCode(13);
const w = (s) => s.split('/').join(BSLASH);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timeout waiting for ' + what);
    await sleep(25);
  }
}

// On Linux a killed process not yet reaped stays a "zombie": kill(pid, 0) still sees it, but it is dead.
function alive(pid) {
  try { process.kill(pid, 0); } catch (err) { return err.code === 'EPERM'; }
  try {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
    return stat[stat.lastIndexOf(')') + 2] !== 'Z';
  } catch { return true; } // no /proc (Windows, macOS): the earlier check is enough
}

// ——— Environment variables ———
test('env: PATH and Path are distinct on POSIX, a single variable on Windows', () => {
  const env = engines.buildEnv('codex', { PATH: '/a', Path: '/b' });
  const pathKeys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
  if (isWin) {
    assert.deepEqual(pathKeys, ['Path']);
    assert.equal(env.Path, '/b');
  } else {
    assert.deepEqual(pathKeys.sort(), ['PATH', 'Path']);
    assert.equal(env.PATH, '/a');
    assert.equal(env.Path, '/b');
  }
});

test('env: claude loses ANTHROPIC_API_KEY under the system\'s uppercase rule', () => {
  const env = engines.buildEnv('claude', { ANTHROPIC_API_KEY: 'k', anthropic_api_key: 'k2' });
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.anthropic_api_key, isWin ? undefined : 'k2');
  assert.equal(engines.buildEnv('codex', { ANTHROPIC_API_KEY: 'k' }).ANTHROPIC_API_KEY, 'k');
  assert.equal(env.NO_COLOR, '1');
});

// ——— Paths ———
test('shortPath: POSIX paths are case-sensitive', () => {
  assert.equal(shortPath('/home/u/Proj/src/a.js', '/home/u/Proj'), 'src/a.js');
  assert.equal(shortPath('/home/u/proj/src/a.js', '/home/u/Proj'), 'a.js');
  assert.equal(shortPath('/home/u/Project/x/a.js', '/home/u/Proj'), 'a.js');
  assert.equal(shortPath('/etc/hosts', '/home/u/Proj'), 'hosts');
  assert.equal(shortPath('src/a.js', '/home/u/Proj'), 'src/a.js');
  assert.equal(shortPath('/home/u/Proj', '/home/u/Proj'), '');
  assert.equal(shortPath('/home/u/Proj/a.js'), 'a.js');
  assert.equal(shortPath('', '/home/u'), '');
  assert.equal(shortPath('/home/u/a' + BSLASH + 'b.txt', '/home/u'), 'a' + BSLASH + 'b.txt');
});

test('shortPath: Windows paths stay case-insensitive on any system', () => {
  assert.equal(shortPath(w('C:/Proj/src/a.js'), w('C:/proj')), 'src/a.js');
  assert.equal(shortPath('c:/PROJ/src/a.js', w('C:/Proj')), 'src/a.js');
  assert.equal(shortPath(w('D:/other/a.js'), w('C:/Proj')), 'a.js');
  assert.equal(shortPath(w('//srv/share/p/a.js'), w('//srv/share/p')), 'a.js');
  assert.equal(shortPath(w('src/a.js'), w('C:/Proj')), 'src/a.js');
});

// ——— Router labels ———
test('toolLabel: the router is recognized with python3 and quoted POSIX paths', () => {
  const label = (command) => toolLabel('Bash', { command }, '/w');
  assert.deepEqual(label('python3 /home/u/.local/bin/route-ask -c hard fix it'), { verb: 'Router', arg: '-c hard fix it' });
  assert.deepEqual(label('"/usr/bin/python3" "/home/u/.local/bin/route-ask" --work C'), { verb: 'Router', arg: '--work C' });
  assert.deepEqual(label("'/usr/bin/python3' '/home/my user/.local/bin/route-ask' --status"), { verb: 'Router', arg: '--status' });
  assert.deepEqual(label('"C:/Python.exe" "C:/Users/dev/.local/bin/route-ask" -c hard'), { verb: 'Router', arg: '-c hard' });
  assert.deepEqual(label('python3 -m pytest'), { verb: 'Run', arg: 'python3 -m pytest' });
});

// ——— Router command ———
function withRouteAskEnv(value, fn) {
  const saved = process.env.STORMO_ROUTE_ASK;
  if (value === undefined) delete process.env.STORMO_ROUTE_ASK; else process.env.STORMO_ROUTE_ASK = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.STORMO_ROUTE_ASK; else process.env.STORMO_ROUTE_ASK = saved;
  }
}

test('router: double quotes unchanged for Windows Python and for simple POSIX paths, on every system', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-router-'));
  try {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'route-ask'), '');
    withRouteAskEnv(undefined, () => {
      const ra = router.routeAskFile(home).split(BSLASH).join('/');
      for (const python of ['C:/Python.exe', '/usr/bin/python3']) {
        const prep = router.prepare('low', { dataDir: path.join(home, 'data'), home, python, instructions: false });
        assert.equal(prep.ok, true, prep.error);
        assert.equal(prep.allowedTools[0], 'Bash("' + python + '" "' + ra + '" *)');
      }
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('router: POSIX paths with $, apostrophes, quotes and backslash are single-quoted and a real sh reads them back identically', { skip: isWin && 'POSIX shell quoting' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-router-'));
  const odd = "we'ird $dir " + BACKTICK + 'x' + DQUOTE + ' back' + BSLASH + 'slash';
  const ra = path.join(home, odd, 'route-ask');
  const py = "/opt/it's $HOME/python3";
  try {
    fs.mkdirSync(path.dirname(ra), { recursive: true });
    fs.writeFileSync(ra, '');
    const prep = withRouteAskEnv(ra, () => router.prepare('low', { dataDir: path.join(home, 'data'), home, python: py, instructions: false }));
    assert.equal(prep.ok, true, prep.error);
    assert.equal(prep.allowedTools.length, 1);
    const command = prep.allowedTools[0].slice('Bash('.length, -' *)'.length);
    const printed = execFileSync('/bin/sh', ['-c', 'printf "%s|%s" ' + command], { encoding: 'utf8' });
    assert.equal(printed, py + '|' + ra);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ——— Python ———
test('pythonCandidates: the first candidate is a runnable interpreter', (t) => {
  const list = pythonCandidates();
  assert.ok(Array.isArray(list));
  for (const c of list) assert.equal(typeof c, 'string');
  if (!list.length) { t.skip('no Python 3 on this machine'); return; }
  assert.equal(execFileSync(list[0], ['-c', 'print(40 + 2)'], { encoding: 'utf8' }).trim(), '42');
});

// ——— Engine processes ———
test('killProcessGroup: signals -pid with SIGKILL, ignores ESRCH, does not mask other errors and rejects unsafe pids', () => {
  const calls = [];
  engines.killProcessGroup(4242, (pid, sig) => calls.push([pid, sig]));
  assert.deepEqual(calls, [[-4242, 'SIGKILL']]);
  const gone = Object.assign(new Error('gone'), { code: 'ESRCH' });
  assert.doesNotThrow(() => engines.killProcessGroup(4242, () => { throw gone; }));
  const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
  assert.throws(() => engines.killProcessGroup(4242, () => { throw denied; }), /denied/);
  for (const bad of [0, 1, -5, 1.5, NaN, undefined]) {
    assert.throws(() => engines.killProcessGroup(bad, () => { throw new Error('should not have signaled'); }), RangeError);
  }
});

const STUB = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
setInterval(() => {}, 1000);
`;

test('startRun: Stop kills the engine\'s whole process tree and leaves the parent process alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-cancel-'));
  const stub = path.join(dir, 'stub.js');
  const pidFile = path.join(dir, 'grandchild.pid');
  fs.writeFileSync(stub, STUB);
  const events = [];
  const run = engines.startRun({ engine: 'claude', prompt: 'hi', cwd: dir, exec: { file: process.execPath, prefixArgs: [stub, pidFile] } }, (e) => events.push(e));
  let grandchild = null;
  try {
    grandchild = Number(await until(() => {
      try {
        const text = fs.readFileSync(pidFile, 'utf8');
        return text !== '' && Number.isInteger(Number(text)) ? text : false;
      } catch { return false; } // the file is not there yet: retry
    }, 'grandchild process pid'));
    assert.ok(alive(grandchild), 'the grandchild must be alive before Stop');
    run.cancel();
    await until(() => events.some((e) => e.type === 'done'), 'done event');
    await until(() => !alive(grandchild), 'grandchild exit');
    assert.equal(events.find((e) => e.type === 'done').ok, false);
    assert.ok(events.some((e) => e.type === 'notice' && e.message === 'Stopped'));
    assert.ok(!events.some((e) => e.type === 'error' && String(e.message).startsWith('Cannot stop')));
    assert.ok(alive(process.pid));
  } finally {
    if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
    run.cancel();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('startRun: a nonexistent executable ends with a start error and an unsuccessful done', async () => {
  const events = [];
  engines.startRun({ engine: 'claude', prompt: 'x', cwd: os.tmpdir(), exec: { file: path.join(os.tmpdir(), 'fm-no-such-binary') } }, (e) => events.push(e));
  await until(() => events.some((e) => e.type === 'done'), 'done event');
  assert.match(events.find((e) => e.type === 'error').message, /^Cannot start claude/);
  assert.equal(events.find((e) => e.type === 'done').ok, false);
});

// ——— PTY ———
async function runInPty(file, args, input) {
  const events = [];
  const mgr = new PtyManager((...a) => events.push(a));
  try {
    const res = mgr.spawn({ id: 'p1', file, args, cwd: os.tmpdir(), env: process.env });
    assert.equal(res.ok, true, res.error);
    if (input) mgr.write('p1', input);
    await until(() => events.some((e) => e[0] === 'pty:exit'), 'PTY exit', 15000);
  } finally {
    mgr.killAll();
  }
  return {
    data: events.filter((e) => e[0] === 'pty:data').map((e) => e[2]).join(''),
    exit: events.find((e) => e[0] === 'pty:exit')[2],
  };
}

test('native PTY: a process writes to the terminal and the exit code arrives', async () => {
  const code = "console.log('fm-pty-ok'); setTimeout(() => process.exit(3), 150);";
  const { data, exit } = await runInPty(process.execPath, ['-e', code]);
  assert.match(data, /fm-pty-ok/);
  assert.equal(exit, 3);
});

test('native PTY Linux: a shell runs the written command and exits with its code', { skip: isWin && 'needs /bin/sh' }, async () => {
  const { data, exit } = await runInPty('/bin/sh', [], 'echo fm-echo-$((20 + 22)); exit 5' + CR);
  assert.match(data, /fm-echo-42/);
  assert.equal(exit, 5);
});

test('PtyManager: ConPTY only on Windows, and kill() cancels the pending flush', async () => {
  const sent = [];
  let opts = null;
  let onData = null;
  const fake = {
    spawn(_file, _args, o) {
      opts = o;
      return { pid: 1, onData(cb) { onData = cb; }, onExit() {}, write() {}, resize() {}, kill() {} };
    },
  };
  const mgr = new PtyManager((...a) => sent.push(a), fake);
  try {
    assert.equal(mgr.spawn({ id: 'a', file: 'x', cwd: os.tmpdir(), env: {} }).ok, true);
    assert.equal(opts.useConpty === true, isWin);
    onData('hello');
    const entry = mgr.ptys.get('a');
    assert.notEqual(entry.flushTimer, null);
    mgr.kill('a');
    assert.equal(entry.flushTimer, null);
    await sleep(60);
    assert.deepEqual(sent.filter((a) => a[0] === 'pty:data'), []);
  } finally {
    mgr.killAll();
  }
});
