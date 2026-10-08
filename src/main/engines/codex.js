'use strict';
// OpenAI Codex headless: `codex exec --json` → normalized events.

const { shortPath, parseLine, withAgentBrief, tokenCount, lifecycle } = require('./common');
const fs = require('node:fs');

const SANDBOX = { ask: 'read-only', auto: 'workspace-write', smart: 'workspace-write', full: 'danger-full-access' };
const PLAN_PREFIX = 'PLAN ONLY: do not modify any file and do not run commands that change anything. Reply with a step-by-step plan.\n\n';

function buildPrompt(opts) {
  let prompt = withAgentBrief(opts);
  if (opts.appendSystemPromptFile) prompt = fs.readFileSync(opts.appendSystemPromptFile, 'utf8') + '\n\n# User request\n' + prompt;
  if (opts.mode === 'plan') prompt = PLAN_PREFIX + prompt;
  return prompt;
}
function buildArgs(opts) {
  const sandbox = opts.mode === 'plan' ? 'read-only' : (SANDBOX[opts.permission] || 'read-only');
  const args = opts.sessionId
    ? ['exec', 'resume', opts.sessionId, '--json', '--skip-git-repo-check']
    : ['exec', '--json', '--skip-git-repo-check', '-C', opts.cwd];
  if (opts.model) args.push('-m', opts.model);
  if (opts.effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(opts.effort)}`);
  // The user's PowerShell profile doesn't load inside the Windows sandbox (constrained language mode)
  // and commands stay stuck: Codex must launch PowerShell with -NoProfile (verified live).
  args.push('-c', 'allow_login_shell=false');
  // "codex exec resume" accepts neither -s nor -C: the sandbox is set through the config instead.
  if (opts.sessionId) args.push('-c', `sandbox_mode=${JSON.stringify(sandbox)}`);
  else args.push('-s', sandbox);
  // "Safe auto": a reviewer model approves routine requests and stops risky ones.
  // The --approve-for-me flag CANNOT be combined with -s (and "exec resume" doesn't accept it): the same
  // thing is passed as settings, valid for both new chats and resumed ones (verified live).
  if (opts.mode !== 'plan' && opts.permission === 'smart') {
    args.push('-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"');
  }
  args.push(opts.appendSystemPromptFile || opts.promptStdin ? '-' : buildPrompt(opts));
  return args;
}

const WRAPPER_RE = /^\s*(?:"(?:[^"\r\n]*[\\/])?(?:powershell|pwsh|cmd)\.exe"|(?:[^\s"\r\n]*[\\/])?(?:powershell|pwsh|cmd)\.exe)\s+(?:-Command|-c|\/c)\s+([\s\S]*)$/i;

function cleanCommand(command) {
  if (typeof command !== 'string') return '';
  const m = command.match(WRAPPER_RE);
  if (!m) return command;
  const inner = m[1];
  // Codex uses both "..." and '...' (seen live) around the script.
  const quoted = inner.length >= 2 && ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'")));
  return quoted ? inner.slice(1, -1) : inner;
}

function toolStatus(item, completed) {
  const bad = item.status === 'failed' || item.status === 'error' || item.status === 'canceled'
    || (item.error !== undefined && item.error !== null);
  if (bad) return 'failed';
  return completed ? 'done' : 'running';
}

function createParser(emit, opts = {}) {
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : '';
  const { st, publish, closed } = lifecycle(emit);
  let sessionId = null;
  let startSent = false;
  let failed = false;
  let errorSent = false;
  let stderrTail = '';

  const reportError = (message) => {
    errorSent = true;
    publish({ type: 'error', message });
  };

  function onItem(item, completed) {
    if (!item || typeof item !== 'object' || typeof item.type !== 'string') return;
    const id = typeof item.id === 'string' ? item.id : undefined;
    switch (item.type) {
      case 'agent_message':
        if (completed && typeof item.text === 'string') publish({ type: 'text', key: id || 'message', text: item.text });
        break;
      case 'reasoning':
        if (completed) publish({ type: 'thought', ...(typeof item.text === 'string' ? { text: item.text } : {}) });
        break;
      case 'command_execution': {
        if (!id) break;
        const status = item.status === 'in_progress' ? 'running' : (completed && item.exit_code === 0 ? 'done' : 'failed');
        publish({ type: 'tool', id, verb: 'Run', arg: cleanCommand(item.command), status,
          ...(typeof item.aggregated_output === 'string' && item.aggregated_output ? { output: item.aggregated_output } : {}) });
        break;
      }
      case 'file_change': {
        if (!id) break;
        const paths = Array.isArray(item.changes) ? item.changes.filter((c) => c && typeof c.path === 'string').map((c) => shortPath(c.path, cwd)) : [];
        const status = item.status === 'failed' ? 'failed' : (completed ? 'done' : 'running');
        publish({ type: 'tool', id, verb: 'Edit', arg: paths.join(', '), status });
        break;
      }
      case 'mcp_tool_call':
        if (id) publish({ type: 'tool', id, verb: 'Tool', arg: `${item.server || ''}.${item.tool || ''}`, status: toolStatus(item, completed) });
        break;
      case 'web_search':
        if (id) publish({ type: 'tool', id, verb: 'Search', arg: typeof item.query === 'string' ? item.query : '', status: toolStatus(item, completed) });
        break;
      case 'todo_list':
        if (id) publish({ type: 'tool', id, verb: 'Plan', arg: `${Array.isArray(item.items) ? item.items.length : 0} steps`, status: 'done' });
        break;
      case 'error':
        if (typeof item.message === 'string') publish({ type: 'notice', message: item.message });
        break;
      default:
        break;
    }
  }

  function handle(e) {
    switch (e.type) {
      case 'thread.started':
        if (typeof e.thread_id === 'string' && e.thread_id) sessionId = e.thread_id;
        if (!startSent && sessionId) { startSent = true; publish({ type: 'start', sessionId }); }
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        onItem(e.item, e.type === 'item.completed');
        break;
      case 'turn.completed':
        if (e.usage && typeof e.usage === 'object') {
          publish({ type: 'usage', inputTokens: tokenCount(e.usage.input_tokens), outputTokens: tokenCount(e.usage.output_tokens),
            ...(typeof e.usage.cached_input_tokens === 'number' ? { cachedTokens: tokenCount(e.usage.cached_input_tokens) } : {}) });
        }
        break;
      case 'turn.failed':
        failed = true;
        reportError((e.error && typeof e.error.message === 'string' && e.error.message) || 'Codex turn failed');
        break;
      case 'error':
        failed = true;
        reportError((typeof e.message === 'string' && e.message) || 'Codex error');
        break;
      default:
        break;
    }
  }

  return {
    feedLine(line) {
      if (closed()) return;
      const e = parseLine(line);
      if (e) handle(e);
    },
    feedStderr(text) {
      if (closed()) return;
      stderrTail = (stderrTail + String(text ?? '')).slice(-600);
    },
    finish(exitCode) {
      if (st.finishing) return;
      st.finishing = true;
      if (exitCode !== 0 && !errorSent) reportError(stderrTail.trim() || `Codex exited with code ${exitCode}`);
      publish({ type: 'done', ok: exitCode === 0 && !failed, ...(sessionId ? { sessionId } : {}) });
    },
  };
}

module.exports = { id: 'codex', buildArgs, buildPrompt, createParser, cleanCommand };
