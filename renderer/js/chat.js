// Chat shared by Agent and Thread: transcript, composer, headless CLI execution.
import { esc, icon, uid, tokensLabel, toast } from './dom.js';
import { S, R, save, invalidate, notify, cliInfo, installedEngines } from './state.js';
import { mark, ENGINE_NAMES, ENGINE_SHORT } from './marks.js';
import { markdown } from './markdown.js';
import { toggleVoice, voiceActive } from './voice.js';
import { confirmBox } from './ui.js';
import { ROUTER_MODES, routerMode } from './router-modes.js';

// Each conversation type (thread, agent chat) registers how its parameters are derived.
const resolvers = {};
export function registerResolver(kind, fn) { resolvers[kind] = fn; }
function ctxOf(conv) { return resolvers[conv.kind](conv); }

const regiaOpening = new WeakMap();
export function ensureRegia(conv) {
  if (regiaOpening.has(conv)) return regiaOpening.get(conv);
  const job = window.fm.engine.regia({ routerChatId: conv.id, routerEngine: conv.routerEngine,
    routerModel: conv.routerModel, engine: conv.engine, sessionId: conv.sessionId,
    routerSessions: conv.routerSessions, routerPolicyLoaded: conv.routerPolicyLoaded,
    routerPolicyMode: conv.routerPolicyMode }).then(binding => {
    if (!binding.ok) { conv.regiaError = binding.error; return binding; }
    conv.routerEngine = binding.engine; conv.routerModel = binding.model;
    conv.routerPolicyLoaded = !!binding.initialized; conv.routerPolicyMode = binding.mode;
    if (binding.sessionId) conv.sessionId = binding.sessionId;
    delete conv.regiaError;
    save(); invalidate('center', 'side');
    return binding;
  }).catch(error => { conv.regiaError = error.message; invalidate('center'); return { ok: false, error: error.message }; });
  regiaOpening.set(conv, job);
  return job;
}

const CONTEXT_SIZE = { claude: 200000, codex: 272000, agy: 1000000, gemini: 1000000 };
const htmlCache = new WeakMap();

export function convRunning(conv) {
  for (const r of R.runs.values()) if (r.conv === conv) return true;
  return false;
}
function runOf(conv) {
  for (const [id, r] of R.runs) if (r.conv === conv) return id;
  return null;
}

// ——— Models for the menus ———
export async function ensureModels(engine) {
  if (R.models[engine]) return R.models[engine];
  try { R.models[engine] = await window.fm.models.list(engine); } catch { R.models[engine] = { models: [{ id: '', label: 'Default' }], efforts: [] }; }
  invalidate('center');
  return R.models[engine];
}
export function modelLabel(engine, id) {
  const m = R.models[engine];
  const found = m && m.models.find((x) => x.id === (id || ''));
  if (found) return found.label;
  return id || 'Default';
}

// ——— Transcript ———
const VERB_ICON = { Read: 'file-text', View: 'file-text', Write: 'file-pen', Edit: 'file-pen', Run: 'square-terminal',
  Grep: 'search', Glob: 'file-search', Search: 'search', Fetch: 'globe', Browse: 'globe', List: 'folder', Agent: 'bot', Plan: 'list-todo', Tool: 'wrench', Router: 'waypoints' };

function toolHtml(it) {
  const ic = VERB_ICON[it.verb] || VERB_ICON[String(it.verb).split(' ')[0]] || 'wrench';
  const state = it.status === 'running' ? 'loader' : it.status === 'failed' ? 'x' : 'check';
  const mono = it.verb === 'Run' || it.verb === 'Grep' || it.verb === 'Glob' || it.verb === 'Router';
  return `<details class="tool-details" data-tool="${esc(it.id)}" ${it.open ? 'open' : ''}>
    <summary class="work"><span class="work-icon">${icon(ic)}</span><span class="work-verb">${esc(it.verb)}</span>
      <span class="work-arg" ${mono ? 'data-mono' : ''}>${esc(it.arg || '')}</span>${icon('chevron-down', 'tool-caret')}
      <span class="work-state" data-state="${it.status}">${icon(state)}</span></summary>
    <pre class="tool-output selectable">${esc(it.output ? it.output : (it.status === 'running' ? 'Running…' : 'No output.'))}</pre>
  </details>`;
}

function workGroupHtml(tools, turnKey) {
  const first = tools[0];
  const hidden = tools.length > 2 && !first.foldOpen ? tools.length - 2 : 0;
  const shown = hidden ? tools.slice(-2) : tools;
  const fold = tools.length > 2
    ? `<button class="work-fold" data-fold="${esc(first.id)}" data-turn="${turnKey}" aria-expanded="${!!first.foldOpen}"><span class="work-icon">${icon('chevron-down')}</span>${first.foldOpen ? 'Hide tool calls' : `+${hidden} previous tool call${hidden > 1 ? 's' : ''}`}</button>`
    : '';
  return `<div class="work-group">${fold}${shown.map(toolHtml).join('')}</div>`;
}

function deniedHtml(it, conv, turn) {
  const who = ENGINE_NAMES[(turn && turn.engine) || ctxOf(conv).engine] || 'The agent';
  if (it.resolved) {
    return `<div class="approval" data-resolved><div class="approval-head">${icon(it.resolved === 'allowed' ? 'shield-check' : 'shield')}<span class="approval-done">${it.resolved === 'allowed' ? 'You allowed' : 'You denied'} <code>${esc(it.label)}</code></span></div></div>`;
  }
  return `<div class="approval" data-denied="${esc(it.id)}">
    <div class="approval-head">${icon('shield-alert')}<strong>${esc(who)} wants your OK</strong></div>
    <code>${esc(it.label)}</code>
    <div class="approval-actions"><button class="primary-btn" data-act="allow" data-id="${esc(it.id)}">${icon('check')}Allow and continue</button>
    <button class="ghost-btn" data-act="deny" data-id="${esc(it.id)}">Deny</button></div>
  </div>`;
}

function sandboxHtml(it) {
  if (it.resolved) {
    return `<div class="approval" data-resolved><div class="approval-head">${icon('shield')}<span class="approval-done">Retried without protection</span></div></div>`;
  }
  return `<div class="approval" data-sandbox>
    <div class="approval-head">${icon('shield-alert')}<strong>Codex failed to run ${it.count > 1 ? 'some commands' : 'a command'}</strong></div>
    <p class="approval-text">Codex's Windows protection (its "sandbox") on this PC does not let commands finish: what Codex wrote above may <b>not actually have happened</b>. You can retry without protection, but then Codex will be able to touch any file on this PC.</p>
    <div class="approval-actions"><button class="ghost-btn" data-act="retry-nosandbox" data-id="${esc(it.id)}">${icon('shield-alert')}Retry without protection…</button></div>
  </div>`;
}

function assistantHtml(turn, conv, isLast) {
  const parts = [];
  let group = [];
  const flush = () => { if (group.length) { parts.push(workGroupHtml(group, turn.at)); group = []; } };
  for (const it of turn.items) {
    if (it.kind === 'tool') { group.push(it); continue; }
    flush();
    if (it.kind === 'text') {
      if (it.text.trim()) parts.push(`<div class="turn-assistant selectable">${markdown(it.text)}</div>`);
    } else if (it.kind === 'thought') {
      const label = it.seconds ? `Thought for ${it.seconds}s` : 'Thought';
      parts.push(`<div><button class="thought" data-thought="${esc(it.id || '')}" aria-expanded="${!!it.open}">${icon('chevron-right')}${label}</button>${it.open && it.text ? `<div class="thought-body selectable">${esc(it.text)}</div>` : ''}</div>`);
    } else if (it.kind === 'denied') {
      parts.push(deniedHtml(it, conv, turn));
    } else if (it.kind === 'error') {
      parts.push(`<div class="turn-error selectable">${icon('circle-alert')}<span>${esc(it.message)}</span></div>`);
    } else if (it.kind === 'notice') {
      parts.push(`<p class="note">${esc(it.message)}</p>`);
    } else if (it.kind === 'sandbox') {
      parts.push(sandboxHtml(it));
    }
  }
  flush();
  if (!turn.done && isLast) {
    const started = turn.at || Date.now();
    parts.push(`<div class="activity"><span class="dot"></span><span>Working… <span class="activity-time" data-since="${started}">${Math.round((Date.now() - started) / 1000)}s</span></span><button data-act="stop">Stop</button></div>`);
  }
  return parts.join('');
}

function turnHtml(turn, conv, isLast) {
  if (turn.role === 'user') {
    if (turn.system) return `<p class="note">${esc(turn.text)}</p>`;
    return `<div class="turn-user selectable">${esc(turn.text)}</div>`;
  }
  const running = !turn.done;
  const cached = htmlCache.get(turn);
  if (!running && cached && cached.v === turn._v) return cached.html;
  const html = assistantHtml(turn, conv, isLast);
  if (!running) htmlCache.set(turn, { v: turn._v, html });
  return html;
}

export function transcriptHtml(conv) {
  const n = conv.turns.length;
  return conv.turns.map((t, i) => turnHtml(t, conv, i === n - 1)).join('');
}

// ——— Composer ———
function select(name, options, value) {
  return `<select data-pick="${name}">${options.map((o) => `<option value="${esc(o.id)}" ${o.id === (value || '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
}

const PERMS = [
  { id: 'ask', label: 'Ask first', icon: 'shield', tip: 'asks before editing files or running commands' },
  { id: 'auto', label: 'Auto-edit', icon: 'shield-check', tip: 'edits files on its own, asks before running commands' },
  { id: 'smart', label: 'Safe auto', icon: 'shield-check', tip: 'does normal things on its own (files, commands, downloads) and stops for risky ones' },
  { id: 'full', label: 'Full access', icon: 'shield-alert', tip: 'no checks: can do anything' },
];

// cfg: { kind:'thread'|'agent', placeholder, segment:bool, compact:bool }
export function composerHtml(conv, cfg) {
  const ctx = ctxOf(conv);
  const engine = ctx.engine;
  const m = R.models[engine];
  if (!m) ensureModels(engine);
  const models = m ? m.models : [{ id: ctx.model || '', label: ctx.model || 'Default' }];
  const efforts = m ? m.efforts : [];
  const engines = installedEngines().map((c) => ({ id: c.id, label: ENGINE_SHORT[c.id] || c.name }));
  if (!engines.find((e) => e.id === engine)) engines.unshift({ id: engine, label: (ENGINE_SHORT[engine] || engine) + ' (missing)' });
  const running = convRunning(conv);
  const usage = conv.usage && conv.usage.input ? `${tokensLabel(conv.usage.input)} tokens` : '';
  const effPerm = conv.permissionOverride || ctx.permission;
  const perm = PERMS.find((p) => p.id === effPerm) || PERMS[2];
  const draft = conv.draft || '';
  const modelChips = cfg.kind === 'auto'
    ? `<label class="cchip" data-tip="${esc(routerMode(ctx.router).tip)}">${icon('waypoints')}<span class="cchip-label">${esc(routerMode(ctx.router).label)}</span>${icon('chevron-down', 'cchip-caret')}${select('router', ROUTER_MODES, ctx.router || 'auto')}</label>`
    : `<label class="cchip" data-tip="Provider">${mark(engine)}${icon('chevron-down', 'cchip-caret')}${select('engine', engines, engine)}</label>
        <label class="cchip" data-tip="Model"><span class="cchip-label">${esc(modelLabel(engine, ctx.model))}</span>${icon('chevron-down', 'cchip-caret')}${select('model', models, ctx.model)}</label>
        ${efforts.length ? `<label class="cchip" data-tip="Effort: ${esc(ctx.effort || 'default')}">${icon('brain')}${icon('chevron-down', 'cchip-caret')}${select('effort', [{ id: '', label: 'Default effort' }, ...efforts.map((e) => ({ id: e, label: e[0].toUpperCase() + e.slice(1) }))], ctx.effort)}</label>` : ''}`;
  const cluster = cfg.kind === 'thread' || cfg.kind === 'auto'
    ? `<div class="segment" role="group" aria-label="Plan or Agent"><button data-seg="plan" data-on="${ctx.mode === 'plan'}">Plan</button><button data-seg="agent" data-on="${ctx.mode !== 'plan'}">Agent</button></div>
      <div class="ccluster">
        <button class="cchip" data-act="attach" data-tip="Add files and folders" aria-label="Attach">${icon('plus')}</button>
        <span class="cdivider"></span>
        ${modelChips}
        <span class="cdivider"></span>
        <label class="cchip" data-tip="${esc(perm.label)}: ${esc(perm.tip)}">${icon(perm.icon)}${icon('chevron-down', 'cchip-caret')}${select('permission', PERMS, effPerm)}</label>
      </div>`
    : `<div class="ccluster">
        <label class="cchip" data-tip="Engine">${mark(engine, 'mark cchip-mark')}<span class="cchip-label">${esc(ENGINE_SHORT[engine] || engine)}</span>${icon('chevron-down', 'cchip-caret')}${select('engine', engines, engine)}</label>
        <label class="cchip" data-tip="Model"><span class="cchip-label">${esc(modelLabel(engine, ctx.model))}</span>${icon('chevron-down', 'cchip-caret')}${select('model', models, ctx.model)}</label>
      </div>`;
  return `<div class="composer-host"><div class="column"><div class="composer">
    <div class="editor"><textarea class="editor-input" rows="1" placeholder="${esc(cfg.placeholder)}" aria-label="${esc(cfg.placeholder)}">${esc(draft)}</textarea></div>
    <div class="composer-footer">${cluster}
      <span class="ctrail">${usage ? `<span class="tokens">${usage}</span>` : ''}
        <button class="disc" data-tone="mic" data-act="mic" data-voice-key="chat:${conv.id}" data-on="${voiceActive('chat:' + conv.id)}" data-tip="Dictate in Italian or English (does not send)" aria-label="Dictate into the prompt" aria-pressed="${voiceActive('chat:' + conv.id)}">${icon('audio-lines')}</button>
        ${running
          ? `<button class="disc" data-tone="stop" data-act="stop" data-tip="Stop" aria-label="Stop">${icon('square')}</button>`
          : `<button class="disc" data-tone="send" data-act="send" data-ready="${!!draft.trim()}" data-tip="Send (Enter)" aria-label="Send">${icon('arrow-up')}</button>`}
      </span></div>
  </div></div></div>`;
}

export function usageText(conv) {
  const ctx = ctxOf(conv);
  const input = conv.usage && conv.usage.input;
  if (!input) return '';
  const pct = Math.min(100, Math.round((input / (CONTEXT_SIZE[ctx.engine] || 200000)) * 100));
  return `${tokensLabel(input)} · ${pct}%`;
}

// ——— Sending and events ———
export async function send(conv, text, extra = {}) {
  const ctx = ctxOf(conv);
  if (convRunning(conv)) { toast('Wait for the current reply, or press Stop.'); return; }
  const info = cliInfo(ctx.engine);
  if (!info.installed && !(ctx.router && (cliInfo('claude').installed || cliInfo('codex').installed))) { toast(`${ENGINE_NAMES[ctx.engine] || ctx.engine} is not installed on this PC.`); return; }
  const now = Date.now();
  if (!extra.system) conv.turns.push({ role: 'user', text, at: now });
  else conv.turns.push({ role: 'user', system: true, text: extra.systemLabel || text, at: now });
  const turn = { role: 'assistant', at: now, items: [], done: false, engine: ctx.engine, _v: 1 };
  conv.turns.push(turn);
  if (!extra.system && (!conv.title || conv.autoTitle)) { conv.title = text.replace(/\s+/g, ' ').trim().slice(0, 64); conv.autoTitle = false; }
  conv.status = 'working';
  conv.updatedAt = now;
  conv.draft = '';
  const runId = uid('run');
  const permission = conv.permissionOverride || ctx.permission || 'smart';
  R.runs.set(runId, { conv, turn, ctx, permission });
  invalidate('center', 'rail', 'side');
  save();
  if (ctx.router) ensureRegia(conv); // main awaits the same opening and handles Stop even during the selection.
  const res = await window.fm.engine.run({
    runId, engine: ctx.engine, prompt: text, cwd: ctx.cwd, sessionId: conv.sessionId || null,
    model: ctx.model || null, effort: ctx.effort || null, mode: ctx.mode || 'agent', router: ctx.router || null,
    permission, systemPrompt: ctx.systemPrompt || null,
    allowedTools: extra.allowedTools || [],
    ...(ctx.router ? {
      routerChatId: conv.id, routerModel: conv.routerModel, routerEngine: conv.routerEngine,
      routerSessions: conv.routerSessions || {}, routerPolicyLoaded: conv.routerPolicyLoaded,
      routerPolicyMode: conv.routerPolicyMode,
      recentRequests: conv.turns.slice(0, -2).filter(t => t.role === 'user' && !t.system).slice(-6).map(t => t.text),
    } : {}),
  });
  if (!res || !res.ok) {
    turn.items.push({ kind: 'error', message: (res && res.error) || 'Could not start the engine.' });
    finish(runId, { ok: false });
  }
}

export function stop(conv) {
  const id = runOf(conv);
  if (id) window.fm.engine.cancel(id);
}

function finish(runId, evt) {
  const run = R.runs.get(runId);
  if (!run) return;
  const { conv, turn, ctx, permission } = run;
  // Some CLIs (Codex) start a command and never say how it ended: no spinner forever.
  let unfinished = 0;
  for (const it of turn.items) {
    if (it.kind === 'tool' && it.status === 'running') {
      it.status = 'failed';
      unfinished++;
      if (!it.output) it.output = 'No result was reported for this step.';
    }
  }
  // Codex inside the Windows sandbox: on this PC commands don't finish and have no effect, but the model
  // still writes "done". We say so clearly and offer to retry without protection (only after confirmation).
  if (unfinished && ctx.engine === 'codex' && permission !== 'full' && evt.ok !== false && (!R.info || R.info.platform === 'win32')) {
    turn.items.push({ kind: 'sandbox', id: uid('sb'), count: unfinished, resolved: false });
  }
  turn.done = true;
  turn.ok = !!evt.ok;
  turn.durationMs = evt.durationMs;
  turn._v = (turn._v || 0) + 1;
  R.runs.delete(runId);
  const pending = turn.items.some((i) => i.kind === 'denied' && !i.resolved);
  conv.status = pending ? 'needsYou' : (evt.ok ? 'idle' : 'failed');
  conv.updatedAt = Date.now();
  if (conv.kind === 'agent-chat') conv.unread = !isVisible(conv);
  const title = ctx.label || conv.title || 'Done';
  if (pending) notify(`${title} needs you`, turn.items.find((i) => i.kind === 'denied' && !i.resolved).label, ctx.target);
  else if (!isVisible(conv) || !R.focused) {
    const last = [...turn.items].reverse().find((i) => i.kind === 'text' || i.kind === 'error');
    notify(evt.ok ? `${title} finished` : `${title} stopped`, last ? (last.text || last.message || '').slice(0, 140) : '', ctx.target);
  }
  invalidate('center', 'rail', 'side');
  save();
}

function isVisible(conv) {
  if (conv.kind === 'thread') return S.ui.mode === 'thread' && S.activeThread === conv.id;
  if (conv.kind === 'auto-thread') return S.ui.mode === 'auto' && S.activeAuto === conv.id;
  const a = S.agents.find((x) => x.chats.includes(conv));
  return S.ui.mode === 'agent' && a && S.activeAgent === a.id && a.activeChat === conv.id;
}

let renderQueued = false;
function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => { renderQueued = false; invalidate('center'); }, 50);
}

export function applyEngineEvent(runId, evt) {
  const run = R.runs.get(runId);
  if (!run) return;
  const { conv, turn } = run;
  const items = turn.items;
  switch (evt.type) {
    case 'start':
      if (evt.sessionId) conv.sessionId = evt.sessionId;
      if (run.ctx.router && evt.engine) {
        conv.routerEngine = evt.engine;
        conv.routerModel = evt.model || conv.routerModel;
        conv.routerPolicyLoaded = true; conv.routerPolicyMode = run.ctx.router;
        conv.routerSessions ||= {};
        if (evt.sessionId) conv.routerSessions[evt.engine] = evt.sessionId;
        turn.engine = evt.engine; run.ctx.engine = evt.engine;
      }
      if (evt.model) turn.model = evt.model;
      break;
    case 'text-delta': {
      let it = items.find((i) => i.kind === 'text' && i.key === evt.key);
      if (!it) { it = { kind: 'text', key: evt.key, text: '' }; items.push(it); }
      it.text += evt.text || '';
      break;
    }
    case 'text': {
      const it = items.find((i) => i.kind === 'text' && i.key === evt.key);
      if (it) it.text = evt.text || '';
      else items.push({ kind: 'text', key: evt.key, text: evt.text || '' });
      break;
    }
    case 'thought':
      items.push({ kind: 'thought', id: uid('th'), seconds: evt.seconds || 0, text: evt.text || '' });
      break;
    case 'tool': {
      const it = items.find((i) => i.kind === 'tool' && i.id === evt.id);
      if (!it) items.push({ kind: 'tool', id: evt.id, verb: evt.verb || 'Tool', arg: evt.arg || '', status: evt.status || 'running', output: evt.output || '' });
      else {
        if (evt.verb) it.verb = evt.verb;
        if (evt.arg) it.arg = evt.arg;
        if (evt.status) it.status = evt.status;
        if (evt.output !== undefined && evt.output !== null && evt.output !== '') it.output = evt.output;
      }
      break;
    }
    case 'denied':
      if (!items.find((i) => i.kind === 'denied' && i.id === evt.id)) {
        items.push({ kind: 'denied', id: evt.id || uid('d'), tool: evt.tool, label: evt.label || evt.tool, input: evt.input || {}, resolved: null });
      }
      break;
    case 'usage':
      conv.usage = { input: evt.inputTokens || 0, output: evt.outputTokens || 0 };
      break;
    case 'limits':
      R.limits = { fiveHour: evt.fiveHour, sevenDay: evt.sevenDay, at: Date.now() };
      invalidate('rail');
      break;
    case 'notice':
      if (evt.message === 'Stopped') items.push({ kind: 'notice', message: 'Stopped.' });
      // notes to show the user (e.g. the coordinator worked without the model router)
      else if (evt.show && evt.message) items.push({ kind: 'notice', message: String(evt.message) });
      break;
    case 'error':
      if (!items.some((i) => i.kind === 'error' && i.message === evt.message)) items.push({ kind: 'error', message: evt.message || 'Error' });
      break;
    case 'done':
      finish(runId, evt);
      return;
    default:
      return;
  }
  turn._v = (turn._v || 0) + 1;
  queueRender();
}

function toolSpec(it) {
  const input = it.input || {};
  if ((it.tool === 'Bash' || it.tool === 'PowerShell') && input.command) return `${it.tool}(${input.command})`;
  return it.tool;
}

export function resolveDenied(conv, id, allow) {
  for (const turn of conv.turns) {
    if (turn.role !== 'assistant') continue;
    const it = turn.items.find((i) => i.kind === 'denied' && i.id === id);
    if (!it || it.resolved) continue;
    it.resolved = allow ? 'allowed' : 'denied';
    turn._v = (turn._v || 0) + 1;
    const stillPending = conv.turns.some((t) => t.role === 'assistant' && t.items.some((i) => i.kind === 'denied' && !i.resolved));
    if (!stillPending && conv.status === 'needsYou') conv.status = 'idle';
    if (allow) {
      send(conv, `The user approved this action: ${it.label}. You may perform it now — continue where you stopped.`,
        { system: true, systemLabel: `✓ Allowed: ${it.label} — continuing`, allowedTools: [toolSpec(it)] });
    } else {
      invalidate('center', 'rail', 'side');
      save();
    }
    return;
  }
}

// ——— Chat UI events (delegated) ———
export function bindChat(root, getConv, onPick) {
  root.addEventListener('click', (e) => {
    const conv = getConv();
    if (!conv) return;
    const a = e.target.closest('a[data-href]');
    if (a) { e.preventDefault(); window.fm.shell.openExternal(a.dataset.href); return; }
    const summary = e.target.closest('.tool-details > summary');
    if (summary) {
      e.preventDefault();
      const id = summary.parentElement.dataset.tool;
      for (const t of conv.turns) {
        const it = t.role === 'assistant' && t.items.find((i) => i.kind === 'tool' && i.id === id);
        if (it) { it.open = !it.open; t._v = (t._v || 0) + 1; summary.parentElement.open = it.open; break; }
      }
      save();
      return;
    }
    const fold = e.target.closest('[data-fold]');
    if (fold) {
      for (const t of conv.turns) {
        const it = t.role === 'assistant' && t.items.find((i) => i.kind === 'tool' && i.id === fold.dataset.fold);
        if (it) { it.foldOpen = !it.foldOpen; t._v = (t._v || 0) + 1; break; }
      }
      invalidate('center');
      return;
    }
    const th = e.target.closest('[data-thought]');
    if (th) {
      for (const t of conv.turns) {
        const it = t.role === 'assistant' && t.items.find((i) => i.kind === 'thought' && i.id === th.dataset.thought);
        if (it) { it.open = !it.open; t._v = (t._v || 0) + 1; break; }
      }
      invalidate('center');
      return;
    }
    const seg = e.target.closest('[data-seg]');
    if (seg) { onPick(conv, 'mode', seg.dataset.seg); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'send') submit(root, conv);
    else if (act === 'stop') stop(conv);
    else if (act === 'allow' || act === 'deny') resolveDenied(conv, b.dataset.id, act === 'allow');
    else if (act === 'retry-nosandbox') retryWithoutSandbox(conv, b.dataset.id);
    else if (act === 'mic') {
      toggleVoice('chat:' + conv.id, (spoken) => {
        const text = spoken.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
        if (!text) return;
        // The text always goes into THIS chat's draft (never lost, never sent); if it's still the one in view
        // the input box is updated too.
        conv.draft = (conv.draft ? conv.draft.trimEnd() + ' ' : '') + text + ' ';
        const ta = getConv() === conv ? root.querySelector('.editor-input') : null;
        if (ta) {
          ta.value = conv.draft;
          ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
        save();
      });
      // Keyboard focus goes back to the input box: Enter sends the text (focus on the button would re-trigger the mic).
      const box = root.querySelector('.editor-input');
      if (box) box.focus();
    } else if (act === 'attach') attachFiles(root, conv);
  });
  root.addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-pick]');
    if (!sel) return;
    const conv = getConv();
    if (conv) onPick(conv, sel.dataset.pick, sel.value);
  });
  root.addEventListener('input', (e) => {
    if (!e.target.classList.contains('editor-input')) return;
    const conv = getConv();
    if (conv) conv.draft = e.target.value;
    autoGrow(e.target);
    const sendBtn = root.querySelector('[data-act="send"]');
    if (sendBtn) sendBtn.dataset.ready = String(!!e.target.value.trim());
    save();
  });
  root.addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('editor-input')) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const conv = getConv();
      if (conv) submit(root, conv);
    }
  });
}

async function retryWithoutSandbox(conv, id) {
  if (convRunning(conv)) return;
  const ok = await confirmBox({
    title: 'Retry without protection?',
    text: 'Codex will be able to modify or delete any file on this PC and run any command, with no checks. Only use this if you trust the request. It only applies to this chat.',
    ok: 'Retry without protection', danger: true,
  });
  if (!ok) return;
  for (const t of conv.turns) {
    const it = t.role === 'assistant' && t.items.find((i) => i.kind === 'sandbox' && i.id === id);
    if (it) { it.resolved = true; t._v = (t._v || 0) + 1; }
  }
  const lastUser = [...conv.turns].reverse().find((t) => t.role === 'user' && !t.system);
  conv.permissionOverride = 'full';
  send(conv, 'The commands of the previous turn did not actually run (the Windows sandbox blocked them). Do the requested work again now, for real, and check that it happened: '
    + (lastUser ? lastUser.text : ''), { system: true, systemLabel: '↻ Retrying without Windows protection' });
}

function submit(root, conv) {
  const ta = root.querySelector('.editor-input');
  const text = (ta ? ta.value : conv.draft || '').trim();
  if (!text) return;
  // With a reply in progress the message doesn't send: it stays in the box instead of disappearing.
  if (convRunning(conv)) { toast('Wait for the current reply, or press Stop.'); return; }
  if (ta) ta.value = '';
  send(conv, text);
}

async function attachFiles(root, conv) {
  const files = await window.fm.dialog.pickFiles();
  if (!files || !files.length) return;
  const ctx = ctxOf(conv);
  const rel = files.map((f) => {
    const base = (ctx.cwd || '').replace(/[\\/]+$/, '');
    const win = /^(?:[a-zA-Z]:|\\\\)/.test(f);
    const inside = base && (win ? f.toLowerCase().startsWith(base.toLowerCase() + '\\') : f.startsWith(base + '/'));
    return '@' + (inside ? (win ? f.slice(base.length + 1).replace(/\\/g, '/') : f.slice(base.length + 1)) : f);
  });
  const ta = root.querySelector('.editor-input');
  const add = rel.join(' ') + ' ';
  conv.draft = (conv.draft ? conv.draft.replace(/\s*$/, ' ') : '') + add;
  if (ta) { ta.value = conv.draft; autoGrow(ta); ta.focus(); }
  save();
}

export function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(192, Math.max(28, ta.scrollHeight)) + 'px';
}

// Updates the "Working…" seconds without redrawing everything.
setInterval(() => {
  document.querySelectorAll('.activity-time').forEach((el) => {
    const since = +el.dataset.since;
    const s = Math.round((Date.now() - since) / 1000);
    el.textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  });
}, 1000);

// Keeps the scroll at the bottom while replies arrive, if the user was already at the bottom.
export function renderScrolled(scroller, html, keyChanged) {
  const nearBottom = keyChanged || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  const prev = scroller.scrollTop;
  scroller.querySelector('.stack').innerHTML = html;
  if (nearBottom) scroller.scrollTop = scroller.scrollHeight;
  else scroller.scrollTop = prev;
}
