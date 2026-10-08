'use strict';
// Google Antigravity CLI headless: `agy -p ... --output-format stream-json` → normalized events.
// Schema verified live on agy 1.2.8 (docs/samples/agy-stream-*.jsonl).

const { AGY_QUOTA_MESSAGE, clip, shortPath, parseLine, firstString, errorText, withAgentBrief, tokenCount, lifecycle } = require('./common');

// Antigravity tool name → [shown verb, possible names of the main parameter]
const TOOLS = {
  run_command: ['Run', ['CommandLine']],
  view_file: ['Read', ['AbsolutePath', 'FilePath', 'Path']],
  write_to_file: ['Write', ['TargetFile']],
  replace_file_content: ['Edit', ['TargetFile']],
  multi_replace_file_content: ['Edit', ['TargetFile']],
  sed_file: ['Edit', ['TargetFile', 'AbsolutePath']],
  notebook_edit: ['Edit', ['TargetFile', 'AbsolutePath']],
  list_dir: ['List', ['DirectoryPath', 'Path']],
  find_by_name: ['Glob', ['Pattern', 'SearchDirectory']],
  grep_search: ['Grep', ['Query', 'SearchPath']],
  read_url_content: ['Fetch', ['Url']],
  search_web: ['Search', ['query', 'Query']],
  open_browser_url: ['Browse', ['Url']],
};
const PATH_VERBS = new Set(['Read', 'Write', 'Edit', 'List']);

function hasApproval(opts) {
  return Array.isArray(opts.allowedTools) && opts.allowedTools.some((t) => typeof t === 'string' && t);
}

function buildArgs(opts) {
  const args = ['-p', withAgentBrief(opts), '--output-format', 'stream-json'];
  if (opts.sessionId) args.push('--conversation', opts.sessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort === 'max' || opts.effort === 'xhigh' ? 'high' : opts.effort);
  if (opts.mode === 'plan') args.push('--mode', 'plan');
  // Antigravity has no command-line "allow only this command": after the user's "Allow"
  // (card with the exact command) the resume starts with that turn's approval. The denials written
  // in its settings still remain valid even so (verified live).
  else if (opts.permission === 'full' || hasApproval(opts)) args.push('--dangerously-skip-permissions');
  else args.push('--mode', 'accept-edits');
  if (opts.logFile) args.push('--log-file', opts.logFile);
  return args;
}

// when its quota runs out agy silently retries for minutes: the runner reads its log and stops it.
function countQuotaErrors(logText) {
  if (typeof logText !== 'string') return 0;
  return logText.split(/\r\n|\n|\r/).filter((l) => l.includes('RESOURCE_EXHAUSTED')).length;
}

function friendlyAgyError(msg, code) {
  const text = errorText(msg);
  if (code === 429 || text.includes('RESOURCE_EXHAUSTED')) return AGY_QUOTA_MESSAGE;
  return text || 'Antigravity failed';
}

function humanize(stepType) {
  const s = String(stepType).replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const HARD_DENY_TEXT = 'Blocked by one of your deny rules in Antigravity\'s settings (~/.gemini/antigravity-cli/settings.json).';
const AUTO_DENY_TEXT = 'Not approved: in non-interactive mode Antigravity cannot ask for permission.';

function createParser(emit, opts = {}) {
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : '';
  const { st, publish, closed } = lifecycle(emit);
  let sessionId = null;
  let startSent = false;
  let status = null;
  let durationMs;
  let errored = false;
  let resultSeen = false;
  let lastStepText = '';
  let stderrTail = '';
  let stderrBuf = '';
  const deniedSent = new Set();

  const reportError = (message) => {
    if (errored) return;
    errored = true;
    publish({ type: 'error', message });
  };

  function onTool(s) {
    const info = s.tool_info && typeof s.tool_info === 'object' ? s.tool_info : {};
    const name = typeof s.tool_name === 'string' && s.tool_name ? s.tool_name : (typeof info.name === 'string' ? info.name : 'tool');
    const params = info.parameters && typeof info.parameters === 'object' ? info.parameters : {};
    const spec = TOOLS[name];
    const verb = spec ? spec[0] : humanize(name);
    let arg = '';
    if (spec) for (const k of spec[1]) if (typeof params[k] === 'string') { arg = params[k]; break; }
    if (!arg) arg = firstString(params, Object.keys(params));
    arg = verb === 'Run' ? clip(arg.split(/\r\n|\n|\r/, 1)[0], 160) : (PATH_VERBS.has(verb) ? shortPath(arg, cwd) : clip(arg, 160));
    const state = s.state === 'DONE' ? 'done' : (s.state === 'ERROR' || s.state === 'FAILED' || s.state === 'CANCELED' ? 'failed' : 'running');
    const id = 'step' + s.step_index;
    const message = info.error && typeof info.error.message === 'string' ? info.error.message : '';
    let output = typeof info.output === 'string' ? clip(info.output, 4000) : '';
    if (state === 'failed' && message) {
      if (message.includes('Matches user-configured deny rule')) output = HARD_DENY_TEXT;
      else if (message.includes('user denied permission')) output = AUTO_DENY_TEXT;
      else output = clip(message, 400);
    }
    publish({ type: 'tool', id, verb, arg, status: state, ...(output ? { output } : {}) });
    // An unapproved command (non-interactive mode denies on its own) becomes an Allow/Deny card.
    if (state === 'failed' && message.includes('user denied permission') && !deniedSent.has(id)) {
      deniedSent.add(id);
      publish({ type: 'denied', id, tool: name === 'run_command' ? 'command' : name, input: params, label: [verb, arg].filter(Boolean).join(' ') });
    }
  }

  function onStep(s) {
    if (!s || typeof s !== 'object' || !Number.isInteger(s.step_index) || s.step_index < 0 || typeof s.step_type !== 'string') return;
    const type = s.step_type;
    if (type === 'user_input' || type === 'error_message') return;
    if (type === 'agent_response') {
      if (typeof s.text_delta === 'string' && s.text_delta.trim() && s.state === 'DONE') {
        lastStepText = s.text_delta;
        publish({ type: 'text', key: 'step' + s.step_index, text: s.text_delta });
      }
      return;
    }
    if (type === 'tool') onTool(s);
    // all other steps (system messages, summaries…) are internal: not agent actions
  }

  function handle(e) {
    const kind = e.event;
    if (kind === 'init') {
      if (typeof e.conversation_id === 'string' && e.conversation_id) sessionId = e.conversation_id;
      if (!startSent && sessionId) {
        startSent = true;
        const model = e.init && typeof e.init.model === 'string' ? e.init.model : undefined;
        publish({ type: 'start', sessionId, ...(model ? { model } : {}) });
      }
    } else if (kind === 'step_update') {
      onStep(e.step_update);
    } else if (kind === 'result' && !resultSeen) {
      resultSeen = true;
      const r = e.result && typeof e.result === 'object' ? e.result : {};
      status = typeof r.status === 'string' ? r.status : null;
      if (typeof r.conversation_id === 'string' && r.conversation_id) sessionId = r.conversation_id;
      if (typeof r.duration_seconds === 'number' && Number.isFinite(r.duration_seconds) && r.duration_seconds >= 0) durationMs = r.duration_seconds * 1000;
      // The last step's text has already been shown: no duplicate.
      if (typeof r.response === 'string' && r.response.trim() && r.response.trim() !== lastStepText.trim()) {
        publish({ type: 'text', key: 'final', text: r.response });
      }
      if (r.usage && typeof r.usage === 'object') publish({ type: 'usage', inputTokens: tokenCount(r.usage.input_tokens), outputTokens: tokenCount(r.usage.output_tokens) });
      if (status === 'ERROR') reportError(friendlyAgyError(r.error));
    }
  }

  function stderrLine(line) {
    const m = line.match(/^\s*AGY_ERROR:\s*(.*)$/);
    if (!m) return;
    const info = parseLine(m[1]);
    if (info) reportError(friendlyAgyError(info.short_error, info.error_code));
  }

  function drainStderr(final) {
    const parts = stderrBuf.split(/\r\n|\n|\r/);
    // Mid-stream, the last line may be incomplete: it stays in the buffer until the next chunk.
    stderrBuf = final ? '' : parts.pop();
    for (const l of parts) stderrLine(l);
  }

  return {
    feedLine(line) {
      if (closed()) return;
      const e = parseLine(line);
      if (e) handle(e);
    },
    feedStderr(text) {
      if (closed()) return;
      const t = String(text ?? '');
      stderrTail = (stderrTail + t).slice(-600);
      stderrBuf += t;
      drainStderr(false);
    },
    finish(exitCode) {
      if (st.finishing) return;
      st.finishing = true;
      if (stderrBuf) drainStderr(true);
      if (exitCode !== 0 && !errored) reportError(stderrTail.trim() || `Antigravity exited with code ${exitCode}`);
      publish({ type: 'done', ok: exitCode === 0 && status !== 'ERROR' && !errored,
        ...(sessionId ? { sessionId } : {}), ...(durationMs !== undefined ? { durationMs } : {}) });
    },
  };
}

module.exports = { id: 'agy', buildArgs, createParser, countQuotaErrors, friendlyAgyError, humanize };
