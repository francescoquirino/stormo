'use strict';
// Claude Code headless: `claude -p ... --output-format stream-json` → normalized events.

const { toolLabel, toolOutputText, parseLine, tokenCount, lifecycle } = require('./common');

const PERMISSION = { ask: 'default', auto: 'acceptEdits', smart: 'auto', full: 'bypassPermissions' };

function buildArgs(opts) {
  const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (opts.sessionId) args.push('--resume', opts.sessionId);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  const mode = opts.mode === 'plan' ? 'plan' : (PERMISSION[opts.permission] || 'default');
  args.push('--permission-mode', mode, '--permission-prompts', 'none');
  if (opts.systemPrompt) args.push('--append-system-prompt', opts.systemPrompt);
  if (opts.appendSystemPromptFile) args.push('--append-system-prompt-file', opts.appendSystemPromptFile);
  if (opts.systemPromptSnapshot || opts.appendSystemPromptFile) args.push('--system-prompt-snapshot', opts.systemPromptSnapshot || 'on');
  // --allowedTools is variadic: it must stay last, otherwise it swallows the following arguments.
  const tools = Array.isArray(opts.allowedTools) ? opts.allowedTools.filter((t) => typeof t === 'string' && t) : [];
  if (tools.length) args.push('--allowedTools', ...tools);
  return args;
}

const validIndex = (i) => Number.isInteger(i) && i >= 0;
const finiteUnit = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function createParser(emit, opts = {}) {
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : '';
  const { st, publish, closed } = lifecycle(emit);
  let sessionId = null;
  let startSent = false;
  let resultSeen = false;
  let isError = false;
  let durationMs;
  let stderrTail = '';
  let currentMessageId = null;
  const messages = new Map();   // messageId -> Map(stream index -> { type, toolId, thinkStart, thoughtDone, bound })
  const seenUuids = new Set();

  const registry = (id) => {
    if (!messages.has(id)) messages.set(id, new Map());
    return messages.get(id);
  };

  // Claude Code sometimes sends an "assistant" event for each block: the position in content
  // is not the stream index (example: text at index 1, but content[0]).
  function resolveTextIndex(messageId, content, position) {
    const reg = messages.get(messageId);
    if (reg && content.length > 1) {
      const aligned = content.every((blk, i) => {
        const b = reg.get(i);
        if (!b || !blk || typeof blk !== 'object' || blk.type !== b.type) return false;
        return blk.type !== 'tool_use' || blk.id === b.toolId;
      });
      if (aligned) {
        reg.get(position).bound = true;
        return position;
      }
    }
    const streamTexts = reg ? [...reg.entries()].filter(([, b]) => b.type === 'text').map(([i]) => i).sort((a, b) => a - b) : [];
    if (!streamTexts.length) return position;
    const free = streamTexts.find((i) => !reg.get(i).bound);
    if (free === undefined) return null;
    reg.get(free).bound = true;
    return free;
  }

  function onStream(ev) {
    if (ev.type === 'message_start') {
      const id = ev.message && typeof ev.message.id === 'string' ? ev.message.id : null;
      if (id) { currentMessageId = id; registry(id); }
      return;
    }
    if (!currentMessageId || !validIndex(ev.index)) return;
    const reg = registry(currentMessageId);
    if (ev.type === 'content_block_start') {
      const cb = ev.content_block && typeof ev.content_block === 'object' ? ev.content_block : {};
      const b = reg.get(ev.index) || {};
      if (typeof cb.type === 'string') b.type = cb.type;
      if (cb.type === 'tool_use' && typeof cb.id === 'string') b.toolId = cb.id;
      if (cb.type === 'thinking' && b.thinkStart === undefined && !b.thoughtDone) b.thinkStart = Date.now();
      reg.set(ev.index, b);
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta;
      if (!d || d.type !== 'text_delta' || typeof d.text !== 'string') return;
      if (!reg.has(ev.index)) reg.set(ev.index, { type: 'text' });
      publish({ type: 'text-delta', key: `${currentMessageId}:${ev.index}`, text: d.text });
    } else if (ev.type === 'content_block_stop') {
      const b = reg.get(ev.index);
      if (b && typeof b.thinkStart === 'number') {
        const startedAt = b.thinkStart;
        delete b.thinkStart;
        b.thoughtDone = true;
        publish({ type: 'thought', seconds: Math.max(1, Math.round((Date.now() - startedAt) / 1000)) });
      }
    }
  }

  function handle(e) {
    if (e.type === 'system') {
      if (e.subtype !== 'init') return;
      if (typeof e.session_id === 'string' && e.session_id) sessionId = e.session_id;
      if (!startSent && sessionId) {
        startSent = true;
        publish({ type: 'start', sessionId, ...(typeof e.model === 'string' ? { model: e.model } : {}) });
      }
      return;
    }
    if (e.type === 'stream_event') {
      if (e.event && typeof e.event === 'object') onStream(e.event);
      return;
    }
    if (e.type === 'assistant') {
      const msg = e.message;
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) return;
      if (typeof e.uuid === 'string') {
        if (seenUuids.has(e.uuid)) return;
        seenUuids.add(e.uuid);
      }
      const mid = typeof msg.id === 'string' ? msg.id : null;
      msg.content.forEach((block, i) => {
        if (!block || typeof block !== 'object') return;
        if (block.type === 'text' && typeof block.text === 'string') {
          const idx = mid ? resolveTextIndex(mid, msg.content, i) : i;
          if (idx === null) return;
          publish({ type: 'text', key: `${mid || 'message'}:${idx}`, text: block.text });
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const { verb, arg } = toolLabel(block.name, block.input, cwd);
          publish({ type: 'tool', id: block.id, verb, arg, status: 'running', raw: block.input });
        }
      });
      return;
    }
    if (e.type === 'user') {
      const content = e.message && Array.isArray(e.message.content) ? e.message.content : [];
      for (const c of content) {
        if (!c || typeof c !== 'object' || c.type !== 'tool_result' || typeof c.tool_use_id !== 'string') continue;
        publish({ type: 'tool', id: c.tool_use_id, status: c.is_error === true ? 'failed' : 'done', output: toolOutputText(c.content) });
      }
      return;
    }
    if (e.type === 'rate_limit_event') {
      const w = e.rate_limit_info && e.rate_limit_info.unifiedWindows;
      const five = w && w.five_hour;
      const seven = w && w.seven_day;
      if (five && seven && finiteUnit(five.utilization) && finiteUnit(seven.utilization)) {
        publish({ type: 'limits', fiveHour: clamp01(five.utilization), sevenDay: clamp01(seven.utilization),
          ...(typeof five.resetsAt === 'number' ? { resetsAt: five.resetsAt } : {}) });
      }
      return;
    }
    if (e.type === 'result' && !resultSeen) {
      resultSeen = true;
      if (typeof e.session_id === 'string' && e.session_id) sessionId = e.session_id;
      if (typeof e.duration_ms === 'number' && Number.isFinite(e.duration_ms)) durationMs = e.duration_ms;
      if (Array.isArray(e.permission_denials)) {
        for (const d of e.permission_denials) {
          if (!d || typeof d !== 'object' || typeof d.tool_name !== 'string') continue;
          const { verb, arg } = toolLabel(d.tool_name, d.tool_input, cwd);
          publish({ type: 'denied', id: typeof d.tool_use_id === 'string' ? d.tool_use_id : undefined, tool: d.tool_name,
            input: d.tool_input && typeof d.tool_input === 'object' ? d.tool_input : {}, label: [verb, arg].filter(Boolean).join(' ') });
        }
      }
      if (e.usage && typeof e.usage === 'object') {
        const u = e.usage;
        publish({ type: 'usage',
          inputTokens: tokenCount(u.input_tokens) + tokenCount(u.cache_read_input_tokens) + tokenCount(u.cache_creation_input_tokens),
          outputTokens: tokenCount(u.output_tokens),
          ...(typeof u.cache_read_input_tokens === 'number' && Number.isFinite(u.cache_read_input_tokens) ? { cachedTokens: u.cache_read_input_tokens } : {}) });
      }
      isError = e.is_error === true || e.subtype !== 'success';
      if (isError) {
        publish({ type: 'error', message: (typeof e.result === 'string' && e.result) || (typeof e.subtype === 'string' && e.subtype) || 'Claude Code failed' });
      }
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
      if (!resultSeen) publish({ type: 'error', message: stderrTail.trim() || `Claude Code exited with code ${exitCode}` });
      publish({ type: 'done', ok: resultSeen && !isError && exitCode === 0,
        ...(sessionId ? { sessionId } : {}), ...(durationMs !== undefined ? { durationMs } : {}) });
    },
  };
}

module.exports = { id: 'claude', buildArgs, createParser };
