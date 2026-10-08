'use strict';
// Finds the agent CLIs installed on the PC and explains how to launch them
// without going through cmd.exe (no shell: arguments arrive intact).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';
const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');

// Order = order of the "Start vibe coding" cards (agents first, Terminal last).
const AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', engine: true,
    candidates: [path.join(HOME, '.local', 'bin', 'claude' + EXE)] },
  { id: 'codex', name: 'Codex', command: 'codex', engine: true, candidates: [] },
  { id: 'agy', name: 'Antigravity', command: 'agy', engine: true,
    candidates: IS_WIN ? [path.join(LOCAL, 'agy', 'bin', 'agy.exe')] : [] },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini', engine: true, candidates: [] },
  { id: 'grok', name: 'Grok Build', command: 'grok', engine: false,
    candidates: [path.join(HOME, '.grok', 'bin', 'grok' + EXE)] },
  { id: 'glm', name: 'GLM (z.ai)', command: 'glm', engine: false, bashScript: true,
    candidates: [path.join(HOME, '.local', 'bin', 'glm')] },
  { id: 'copilot', name: 'GitHub Copilot', command: 'copilot', engine: false, candidates: [] },
  { id: 'cursor', name: 'Cursor Agent', command: 'cursor-agent', engine: false, candidates: [] },
  { id: 'terminal', name: 'Terminal', command: IS_WIN ? 'powershell' : 'bash', engine: false, candidates: [] },
];

const GIT_BASH = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(LOCAL, 'Programs', 'Git', 'bin', 'bash.exe'),
];

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// On Linux/macOS a file is runnable only with the execute bit set (statSync follows symlinks).
function isExecutable(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

const canRun = IS_WIN ? isFile : isExecutable;

function pathDirs() {
  return (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
}

function versionParts(dirName) {
  return dirName.slice(1).split('.').map((n) => parseInt(n, 10) || 0);
}

function compareVersionsDesc(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const dx = x[i] || 0;
    const dy = y[i] || 0;
    if (dx !== dy) return dy - dx;
  }
  return 0;
}

// nvm bin folders: the active one (NVM_BIN) and then all installed versions, newest first.
function nvmBinDirs() {
  const dirs = [];
  if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN);
  const root = path.join(process.env.NVM_DIR || path.join(HOME, '.nvm'), 'versions', 'node');
  try {
    const versions = fs.readdirSync(root).filter((d) => /^v\d+/.test(d)).sort(compareVersionsDesc);
    for (const v of versions) dirs.push(path.join(root, v, 'bin'));
  } catch { /* nvm missing */ }
  return dirs;
}

// Folders where user-installed CLIs usually end up. POSIX only: nothing is touched on Windows.
// An app launched from the desktop menu often doesn't inherit the shell's PATH.
function toolDirs() {
  if (IS_WIN) return [];
  const all = [
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, '.npm-global', 'bin'),
    ...nvmBinDirs(),
    '/usr/local/bin', '/usr/bin', '/bin',
  ];
  return [...new Set(all)].filter(isDir);
}

function withToolDirs(pathValue) {
  const dirs = String(pathValue || '').split(path.delimiter).filter(Boolean);
  for (const d of toolDirs()) if (!dirs.includes(d)) dirs.push(d);
  return dirs.join(path.delimiter);
}

// Like Windows' `where`: tries the PATHEXT extensions, preferring .exe.
// An npm shim with no extension makes CreateProcess fail (WinError 193), so we skip it.
// On POSIX: looks for the exact name with the execute bit set, in PATH and then in user folders.
function which(name) {
  if (!IS_WIN) {
    const dirs = [...new Set([...pathDirs(), ...toolDirs()])];
    for (const dir of dirs) {
      const full = path.join(dir, name);
      if (isExecutable(full)) return full;
    }
    return null;
  }
  const exts = ['.exe', '.cmd', '.bat', '.com'];
  for (const dir of pathDirs()) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      if (isFile(full)) return full;
    }
  }
  return null;
}

// npm's .cmd shims end with: "%_prog%" "%dp0%\node_modules\...\bin\x.js" %*
// We launch node + that .js file directly: same thing, without cmd.exe in between.
function npmShimEntry(cmdPath) {
  let text;
  try { text = fs.readFileSync(cmdPath, 'utf8'); } catch { return null; }
  const m = text.match(/"%~?dp0%?\\([^"]+?\.(?:c|m)?js)"/i);
  if (!m) return null;
  const js = path.join(path.dirname(cmdPath), m[1]);
  return isFile(js) ? js : null;
}

let nodeExeCache;
function nodeExe() {
  if (nodeExeCache === undefined) nodeExeCache = which('node');
  return nodeExeCache;
}

// hintDir (POSIX only): the folder of the launched script; with nvm its `node` is the right one.
function nodeRunner(jsFile, hintDir) {
  let node = null;
  if (!IS_WIN && hintDir) {
    const sibling = path.join(hintDir, 'node');
    if (isExecutable(sibling)) node = sibling;
  }
  node = node || nodeExe();
  if (node) return { file: node, prefixArgs: [jsFile], env: {} };
  // No node in PATH: Electron can act as Node.
  return { file: process.execPath, prefixArgs: [jsFile], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// Reads a file's "#!" line and returns the interpreter's { bin, args }
// ("#!/usr/bin/env node" -> bin 'node'), or null if it isn't a shebang script.
function shebangOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.toString('utf8', 0, n).split(/\r?\n/)[0];
    if (!first.startsWith('#!')) return null;
    const tokens = first.slice(2).trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    let bin = path.posix.basename(tokens[0]);
    let args = tokens.slice(1);
    if (bin === 'env') {
      const at = args.findIndex((t) => !t.startsWith('-') && !t.includes('='));
      if (at < 0) return null;
      bin = path.posix.basename(args[at]);
      args = args.slice(at + 1);
    }
    return { bin, args };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
}

// POSIX: a native binary starts as-is; an npm script (symlink -> file with a node shebang)
// starts with the right node, without depending on the launching process's PATH.
function posixRunner(found) {
  let real = found;
  try { real = fs.realpathSync(found); } catch { /* keep the path we found */ }
  const she = shebangOf(real);
  if (she && (she.bin === 'node' || she.bin === 'nodejs')) {
    const run = nodeRunner(real, path.dirname(found));
    return { ...run, prefixArgs: [...she.args, ...run.prefixArgs], path: found };
  }
  return { file: found, prefixArgs: [], env: {}, path: found };
}

function bashExe() {
  if (IS_WIN) return GIT_BASH.find(isFile) || which('bash');
  return which('bash') || ['/bin/bash', '/usr/bin/bash'].find(isExecutable) || null;
}

// Native terminal on POSIX: the user's SHELL, otherwise bash, otherwise sh.
function posixShell() {
  const list = [];
  const sh = process.env.SHELL;
  if (sh && path.isAbsolute(sh) && !['nologin', 'false'].includes(path.basename(sh))) list.push(sh);
  list.push(which('bash'), '/bin/bash', '/usr/bin/bash', which('sh'), '/bin/sh', '/usr/bin/sh');
  return list.filter(Boolean).find(isExecutable) || null;
}

// Returns { file, prefixArgs, env, path } or null if the agent isn't there.
function resolveAgent(def, overrides = {}) {
  if (def.id === 'terminal') {
    if (!IS_WIN) {
      const shell = posixShell();
      return shell ? { file: shell, prefixArgs: ['-i'], env: {}, path: shell } : null;
    }
    const pwsh = which('pwsh');
    const file = pwsh || path.join(process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return { file, prefixArgs: ['-NoLogo'], env: {}, path: file };
  }
  const custom = overrides[def.id];
  // A bash script is launched by bash: the execute bit isn't needed.
  const usable = def.bashScript ? isFile : canRun;
  const found = [custom, ...def.candidates].filter(Boolean).find((p) => usable(p))
    || (def.bashScript ? null : which(def.command));
  if (!found) return null;

  if (def.bashScript) {
    const bash = bashExe();
    if (!bash) return null;
    return { file: bash, prefixArgs: [IS_WIN ? found.replace(/\\/g, '/') : found], env: {}, path: found };
  }
  if (!IS_WIN) return posixRunner(found);
  const ext = path.extname(found).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    const js = npmShimEntry(found);
    if (js) return { ...nodeRunner(js), path: found };
    const comspec = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    return { file: comspec, prefixArgs: ['/d', '/c', found], env: {}, path: found };
  }
  return { file: found, prefixArgs: [], env: {}, path: found };
}

function detectAll(overrides = {}) {
  return AGENTS.map((def) => {
    const exec = resolveAgent(def, overrides);
    return { id: def.id, name: def.name, command: def.command, engine: def.engine,
      installed: !!exec, path: exec ? exec.path : null };
  });
}

function getAgent(id) {
  return AGENTS.find((a) => a.id === id) || null;
}

function versionOf(id, overrides = {}) {
  const def = getAgent(id);
  if (!def || id === 'terminal' || id === 'glm') return Promise.resolve(null);
  const exec = resolveAgent(def, overrides);
  if (!exec) return Promise.resolve(null);
  const toolPath = IS_WIN ? {} : { PATH: withToolDirs(process.env.PATH) };
  return new Promise((resolve) => {
    execFile(exec.file, [...exec.prefixArgs, '--version'],
      { timeout: 15000, windowsHide: true, env: { ...process.env, ...toolPath, ...exec.env, NO_COLOR: '1' } },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = String(stdout).trim().split(/\r?\n/)[0] || '';
        const m = line.match(/\d+\.\d+(?:\.\d+)?/);
        resolve(m ? m[0] : line.slice(0, 40) || null);
      });
  });
}

// Paid API keys: always stripped, so the CLIs use the subscription login instead.
const PAID_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of PAID_KEYS) delete env[k];
  if (!extra.ELECTRON_RUN_AS_NODE) delete env.ELECTRON_RUN_AS_NODE;
  if (!IS_WIN) env.PATH = withToolDirs(env.PATH);
  return env;
}

// Fixed arguments for each CLI in the terminals. Codex: no PowerShell profile, since inside its
// Windows sandbox it doesn't load and leaves commands stuck.
function baseArgs(id) {
  return id === 'codex' ? ['-c', 'allow_login_shell=false'] : [];
}

// CLIs without automatic command review keep their own auto-edit mode.
function smartArgs(id) {
  switch (id) {
    case 'claude': return ['--permission-mode', 'auto'];
    case 'codex': return ['--approve-for-me'];
    case 'agy': return ['--mode', 'accept-edits'];
    case 'gemini': return ['--approval-mode', 'auto_edit'];
    case 'glm': return ['--raw', '--permission-mode', 'auto'];
    default: return [];
  }
}

module.exports = { AGENTS, detectAll, resolveAgent, getAgent, versionOf, which, childEnv, npmShimEntry, smartArgs, baseArgs };
