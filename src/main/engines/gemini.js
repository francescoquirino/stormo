'use strict';
// Gemini CLI headless: `gemini -p ... -o stream-json` → normalized events.
// Live behaviour not verified: fields taken from the installed CLI code and the docs.

const { clip, parseLine, errorText, withAgentBrief, tokenCount, lifecycle } = require('./common');

const APPROVAL = { ask: 'default', auto: 'auto_edit', smart: 'auto_edit', full: 'yolo' };

function buildArgs(opts) {
  const args = ['-p', withAgentBrief(opts), '-o', 'stream-json'];
  if (opts.model) args.push('-m', opts.model);
  args.push('--approval-mode', opts.mode === 'plan' ? 'plan' : (APPROVAL[opts.permission] || 'default'));
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  return args;
}

// Gemini CLI messages made understandable (seen live: it isn't connected to an account on this PC).
function friendlyGeminiError(tail, exitCode) {
  const text = String(tail || '');
  if (/Auth method|GEMINI_API_KEY|GOOGLE_GENAI_USE|sign in|log ?in/i.test(text)) {
    return 'Gemini CLI is not connected to an account on this PC. Open it once in a terminal (Code mode → Gemini CLI), log in with Google, then try again.';
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^Approval mode overridden/i.test(l));
  return lines.slice(-3).join(' ') || `Gemini CLI exited with code ${exitCode}`;
}

function firstStringValue(obj) {
  if (!obj || typeof obj !== 'object') return '';
  for (const v of Object.values(obj)) if (typeof v === 'string') return clip(v, 120);
  return '';
}

function createParser(emit) {
  const { st, publish, closed } = lifecycle(emit);
  let sessionId = null;
  let startSent = false;
  let failed = false;
  let errorSent = false;
  let resultSeen = false;
  let durationMs;
  let stderrTail = '';
  let trustNoticeSent = false;

  const reportError = (message) => {
    errorSent = true;
    publish({ type: 'error', message });
  };

  function handle(e) {
    switch (e.type) {
      case 'init':
        if (typeof e.session_id === 'string' && e.session_id) sessionId = e.session_id;
        if (!startSent && sessionId) {
          startSent = true;
          publish({ type: 'start', sessionId, ...(typeof e.model === 'string' ? { model: e.model } : {}) });
        }
        break;
      case 'message':
        if (e.role !== 'assistant' || typeof e.content !== 'string') break;
        publish({ type: e.delta === true ? 'text-delta' : 'text', key: 'final', text: e.content });
        break;
      case 'tool_use':
        if (typeof e.tool_id !== 'string' || typeof e.tool_name !== 'string') break;
        publish({ type: 'tool', id: e.tool_id, verb: e.tool_name, arg: firstStringValue(e.parameters), status: 'running' });
        break;
      case 'tool_result':
        if (typeof e.tool_id !== 'string' || typeof e.status !== 'string') break;
        publish({ type: 'tool', id: e.tool_id, status: e.status === 'success' ? 'done' : 'failed',
          output: typeof e.output === 'string' && e.output ? e.output : errorText(e.error) });
        break;
      case 'error':
        if (e.severity === 'warning') { publish({ type: 'notice', message: errorText(e.message) || errorText(e) || 'Warning' }); break; }
        failed = true;
        reportError(errorText(e.message) || errorText(e) || 'Gemini CLI error');
        break;
      case 'result': {
        if (resultSeen) break;
        resultSeen = true;
        const s = e.stats;
        if (s && typeof s === 'object') {
          publish({ type: 'usage', inputTokens: tokenCount(s.input_tokens), outputTokens: tokenCount(s.output_tokens) });
          if (typeof s.duration_ms === 'number' && Number.isFinite(s.duration_ms) && s.duration_ms >= 0) durationMs = s.duration_ms;
        }
        if (e.status !== 'success') {
          failed = true;
          if (!errorSent) reportError(errorText(e.error) || 'Gemini CLI failed: ' + e.status);
        }
        break;
      }
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
      if (!trustNoticeSent && /folder is not trusted/i.test(stderrTail)) {
        trustNoticeSent = true;
        publish({ type: 'notice', message: 'Gemini does not trust this folder and will ask for confirmation on every change: open it once with Gemini CLI in a terminal and choose "Trust".' });
      }
    },
    finish(exitCode) {
      if (st.finishing) return;
      st.finishing = true;
      if (exitCode !== 0 && !errorSent) reportError(friendlyGeminiError(stderrTail, exitCode));
      publish({ type: 'done', ok: exitCode === 0 && !failed,
        ...(sessionId ? { sessionId } : {}), ...(durationMs !== undefined ? { durationMs } : {}) });
    },
  };
}

module.exports = { id: 'gemini', buildArgs, createParser, friendlyGeminiError };
