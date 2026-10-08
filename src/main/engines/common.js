'use strict';
// Helpers shared by the CLI adapters (see docs/tasks/engines.md).

const path = require('node:path');

const AGY_QUOTA_MESSAGE = 'Google quota exhausted (429 RESOURCE_EXHAUSTED). Antigravity will work again when the quota resets.';

function clip(s, n) {
  const text = s === null || s === undefined ? '' : String(s);
  if (n <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= n) return text;
  return chars.slice(0, n - 1).join('') + '…';
}

// Lexical comparison (no disk access), the same on any system: Windows paths (drive or UNC) case-insensitively,
// POSIX ones case-sensitively.
const isWindowsShaped = (s) => typeof s === 'string' && /^(?:[a-zA-Z]:(?:[\\/]|$)|\\\\)/.test(s);
function shortPath(p, cwd) {
  if (typeof p !== 'string' || !p) return '';
  if (isWindowsShaped(p) || isWindowsShaped(cwd) || (p.includes('\\') && !p.startsWith('/'))) return shortPathWin32(p, cwd);
  const posix = path.posix;
  if (typeof cwd !== 'string' || !cwd) return posix.basename(p);
  const base = posix.normalize(cwd);
  const target = posix.isAbsolute(p) ? posix.normalize(p) : posix.resolve(base, p);
  const relative = posix.relative(base, target);
  const inside = relative === '' || (relative !== '..' && !relative.startsWith('../'));
  return inside ? relative : posix.basename(target);
}

function shortPathWin32(p, cwd) {
  if (typeof p !== 'string' || !p) return '';
  const win = path.win32;
  const target0 = p.replace(/\//g, '\\');
  if (typeof cwd !== 'string' || !cwd) return win.basename(target0);
  const base = win.normalize(cwd.replace(/\//g, '\\'));
  const target = win.isAbsolute(target0) ? win.normalize(target0) : win.resolve(base, target0);
  const relative = win.relative(base, target);
  const inside = relative === ''
    || (!win.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'));
  if (!inside) return win.basename(target);
  return relative.replace(/\\/g, '/');
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// A call to the model router ("python .../route-ask -c hard ...") is a "Router": only the options are shown.
const ROUTER_CALL = /python[^\s"']*["']?\s+(?:"[^"]*route-ask"|'[^']*route-ask'|["']?[^\s"']*route-ask["']?)(?:\s+(.*))?$/i;
function routerArg(command) {
  const m = ROUTER_CALL.exec(command.split(/\r\n|\n|\r/, 1)[0] || '');
  return m ? clip(m[1] || '', 160) : null;
}

function toolLabel(name, input, cwd) {
  const inp = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  switch (name) {
    case 'Read': return { verb: 'Read', arg: shortPath(str(inp.file_path), cwd) };
    case 'Write': return { verb: 'Write', arg: shortPath(str(inp.file_path), cwd) };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: 'Edit', arg: shortPath(str(inp.file_path) || str(inp.notebook_path), cwd) };
    case 'Bash':
    case 'PowerShell': {
      const command = str(inp.command);
      const router = routerArg(command);
      if (router !== null) return { verb: 'Router', arg: router };
      return { verb: 'Run', arg: clip(command.split(/\r\n|\n|\r/, 1)[0] || '', 160) };
    }
    case 'Grep': {
      const where = shortPath(str(inp.path), cwd);
      return { verb: 'Grep', arg: `"${str(inp.pattern)}"` + (where ? ' · ' + where : '') };
    }
    case 'Glob': return { verb: 'Glob', arg: str(inp.pattern) };
    case 'WebFetch': return { verb: 'Fetch', arg: str(inp.url) };
    case 'WebSearch': return { verb: 'Search', arg: str(inp.query) };
    case 'Task':
    case 'Agent':
      return { verb: 'Agent', arg: str(inp.description) };
    case 'TodoWrite':
      return { verb: 'Plan', arg: `${Array.isArray(inp.todos) ? inp.todos.length : 0} todos` };
    default: {
      let json;
      try { json = JSON.stringify(input); } catch { json = '[unserializable]'; }
      return { verb: String(name || 'Tool'), arg: json === undefined ? '' : clip(json, 120) };
    }
  }
}

function toolOutputText(content) {
  if (typeof content === 'string') return clip(content, 4000);
  if (Array.isArray(content)) {
    const parts = content
      .filter((c) => c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text);
    return clip(parts.join('\n'), 4000);
  }
  return '';
}

function parseLine(line) {
  if (typeof line !== 'string' || !line.trim()) return null;
  let v;
  try { v = JSON.parse(line); } catch { return null; }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function firstString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) if (typeof obj[k] === 'string') return obj[k];
  return '';
}

function errorText(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.message === 'string') return value.message;
  return '';
}

function withAgentBrief(opts) {
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  if (opts.systemPrompt && !opts.sessionId) {
    return '<agent-brief>\n' + opts.systemPrompt + '\n</agent-brief>\n\n' + prompt;
  }
  return prompt;
}

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

// Common lifecycle: no events after "done", "done" only once.
function lifecycle(emit) {
  const st = { finishing: false, doneSent: false };
  const publish = (evt) => {
    if (st.doneSent) return;
    if (evt.type === 'done') st.doneSent = true;
    emit(evt);
  };
  return { st, publish, closed: () => st.finishing || st.doneSent };
}

module.exports = {
  AGY_QUOTA_MESSAGE, clip, shortPath, isWindowsShaped, toolLabel, toolOutputText, parseLine,
  firstString, errorText, withAgentBrief, tokenCount, lifecycle,
};
