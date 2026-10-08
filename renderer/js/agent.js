// Agent mode: teammates with a name, instructions (brief), memory (folder) and a routine.
import { $, esc, icon, uid, toast } from './dom.js';
import { S, R, save, invalidate, activeAgent, installedEngines, cliInfo } from './state.js';
import { ENGINE_NAMES, mark } from './marks.js';
import { face, randomLook, FACE_COLORS, FACE_SHAPES, FACE_EYES } from './faces.js';
import { registerResolver, transcriptHtml, composerHtml, bindChat, send, convRunning, ensureModels, renderScrolled } from './chat.js';
import { openModal, confirmBox } from './ui.js';
import { routineText } from './rail.js';
import { dueAt } from './routine.js';
import { stopVoice } from './voice.js';

const TEMPLATES = [
  { name: 'Code reviewer', brief: 'Review the latest changes in my project folder. Point out bugs, risky code and missing tests, most important first. Do not edit files unless I ask.', routine: { kind: 'off' } },
  { name: 'Daily digest', brief: 'Every morning, summarize what changed in my project yesterday (git log and diff) in 5 short bullet points a beginner can understand.', routine: { kind: 'daily', at: '09:00', prompt: 'Write today\'s digest.' } },
  { name: 'Bug hunter', brief: 'Look for bugs in my project: run the tests if there are any, read the error output, and explain each bug in simple words with the exact file and line.', routine: { kind: 'off' } },
  { name: 'Docs writer', brief: 'Keep the README of my project clear and up to date. Explain how to install and run it, in simple English.', routine: { kind: 'off' } },
];

function agentOfChat(conv) {
  return S.agents.find((a) => (a.chats || []).includes(conv));
}

function systemPrompt(a) {
  return `You are "${a.name}", a teammate agent inside Stormo (a desktop workspace for coding agents).\n`
    + `Your brief from the user:\n${a.brief || '(no brief yet)'}\n\n`
    + `Your working folder is: ${a.cwd}. You can keep notes and memory files there.\n`
    + 'Be concise and concrete. When you finish, end with a short summary of what you did and anything that needs the user.';
}

registerResolver('agent-chat', (conv) => {
  const a = agentOfChat(conv) || {};
  return { engine: a.engine || 'claude', model: a.model || '', effort: a.effort || '', mode: 'agent',
    permission: a.permission || 'smart', cwd: a.cwd, systemPrompt: systemPrompt(a), label: a.name,
    target: { mode: 'agent', agentId: a.id, chatId: conv.id } };
});

function defaultEngine() {
  const eng = installedEngines();
  return (eng.find((e) => e.id === 'claude') || eng[0] || { id: 'claude' }).id;
}

function newChat(a, title = 'New chat') {
  const c = { id: uid('c'), kind: 'agent-chat', title, autoTitle: title === 'New chat', turns: [], status: 'idle', createdAt: Date.now(), updatedAt: Date.now() };
  a.chats.push(c);
  a.activeChat = c.id;
  return c;
}

export async function createAgent(tpl = {}) {
  const id = uid('a');
  const cwd = await window.fm.fs.agentDir(id);
  const a = {
    id, name: tpl.name || 'New agent', brief: tpl.brief || '', engine: defaultEngine(), model: '', effort: '',
    permission: 'smart', cwd, look: randomLook(id), pinned: S.agents.length === 0,
    routine: { kind: 'off', minutes: 60, at: '09:00', prompt: '', lastRun: 0, ...(tpl.routine || {}) },
    chats: [], activeChat: null, createdAt: Date.now(),
  };
  newChat(a);
  return a;
}

export function currentChat(a) {
  if (!a) return null;
  let c = a.chats.find((x) => x.id === a.activeChat);
  if (!c) c = a.chats[a.chats.length - 1] || newChat(a);
  return c;
}

export async function deleteAgent(id) {
  const a = S.agents.find((x) => x.id === id);
  if (!a) return;
  if (a.chats.some((c) => convRunning(c))) { toast(`${a.name} is working: stop it before deleting it.`); return; }
  const ok = await confirmBox({ title: `Delete ${a.name}?`, text: 'Its chats disappear from Stormo. Files in its folder stay on disk.', ok: 'Delete agent', danger: true });
  if (!ok) return;
  for (const c of a.chats) stopVoice('chat:' + c.id);
  S.agents = S.agents.filter((x) => x.id !== id);
  if (S.activeAgent === id) S.activeAgent = S.agents[0] ? S.agents[0].id : null;
  save();
  invalidate('all');
}

// ——— Agent editor ———
export function editAgent(existing, tpl) {
  (async () => {
    const isNew = !existing;
    const a = existing ? JSON.parse(JSON.stringify(existing)) : await createAgent(tpl);
    const engines = installedEngines();
    const models = await ensureModels(a.engine);
    const m = openModal({
      title: isNew ? 'New agent' : `Edit ${a.name}`,
      body: `
        <div class="field"><div class="look-row"><span data-look-preview>${face(a.look, 48)}</span>
          <div style="display:flex;flex-direction:column;gap:8px;flex:auto">
            <div class="swatches">${FACE_COLORS.map((c) => `<button class="swatch" data-color="${c}" style="background:${c}" data-on="${a.look.color === c}" aria-label="Color ${c}"></button>`).join('')}</div>
            <div class="inline"><button class="ghost-btn" data-shuffle>${icon('sparkles')}Shuffle face</button></div>
          </div></div></div>
        <div class="field"><label for="ag-name">Name</label><input class="input" id="ag-name" value="${esc(a.name)}" maxlength="60" placeholder="e.g. Bug hunter"></div>
        <div class="field"><label for="ag-brief">Brief</label><textarea class="textarea" id="ag-brief" placeholder="What does this teammate do? Write it like you would explain it to a person.">${esc(a.brief)}</textarea></div>
        <div class="field-row">
          <div class="field"><label for="ag-engine">Engine</label><select class="select" id="ag-engine">${(engines.length ? engines : [{ id: 'claude', name: 'Claude Code' }]).map((e) => `<option value="${e.id}" ${e.id === a.engine ? 'selected' : ''}>${esc(ENGINE_NAMES[e.id] || e.name)}</option>`).join('')}</select></div>
          <div class="field"><label for="ag-model">Model</label><select class="select" id="ag-model">${models.models.map((x) => `<option value="${esc(x.id)}" ${x.id === (a.model || '') ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></div>
          <div class="field"><label for="ag-perm">Permissions</label><select class="select" id="ag-perm">
            <option value="ask" ${a.permission === 'ask' ? 'selected' : ''}>Ask first</option>
            <option value="auto" ${a.permission === 'auto' ? 'selected' : ''}>Auto-edit</option>
            <option value="smart" ${a.permission === 'smart' ? 'selected' : ''}>Safe auto</option>
            <option value="full" ${a.permission === 'full' ? 'selected' : ''}>Full access</option></select></div>
        </div>
        <div class="field"><label for="ag-cwd">Working folder</label><div class="inline"><input class="input" id="ag-cwd" value="${esc(a.cwd)}" spellcheck="false"><button class="ghost-btn" data-pick-cwd>${icon('folder-open')}Choose</button></div>
          <span class="field-hint">Its own folder by default (its memory). Pick a project folder if it should work on your code.</span></div>
        <div class="field"><label for="ag-routine">Routine</label>
          <div class="field-row">
            <select class="select" id="ag-routine">
              <option value="off" ${a.routine.kind === 'off' ? 'selected' : ''}>Off</option>
              <option value="every" ${a.routine.kind === 'every' ? 'selected' : ''}>Every…</option>
              <option value="daily" ${a.routine.kind === 'daily' ? 'selected' : ''}>Every day at…</option></select>
            <select class="select" id="ag-every" data-show="every">${[15, 30, 60, 120, 240, 480].map((n) => `<option value="${n}" ${+a.routine.minutes === n ? 'selected' : ''}>${n < 60 ? n + ' minutes' : n / 60 + (n === 60 ? ' hour' : ' hours')}</option>`).join('')}</select>
            <input class="input" type="time" id="ag-at" data-show="daily" value="${esc(a.routine.at || '09:00')}">
          </div>
          <textarea class="textarea" id="ag-rprompt" data-show-any style="min-height:60px;margin-top:8px" placeholder="What should it do each time? e.g. Check the repo and summarize what changed.">${esc(a.routine.prompt || '')}</textarea>
          <span class="field-hint">Routines run while Stormo is open. Each run opens a new chat you can review.</span></div>`,
      foot: `${isNew ? '' : `<button class="ghost-btn" data-role="destructive" data-delete>${icon('trash-2')}Delete</button>`}<span class="spacer"></span>
        <button class="ghost-btn" data-close>Cancel</button><button class="primary-btn" data-save>${isNew ? 'Create agent' : 'Save'}</button>`,
      onMount: ({ el, close }) => {
        const q = (s) => el.querySelector(s);
        const syncRoutine = () => {
          const k = q('#ag-routine').value;
          q('#ag-every').style.display = k === 'every' ? '' : 'none';
          q('#ag-at').style.display = k === 'daily' ? '' : 'none';
          q('#ag-rprompt').style.display = k === 'off' ? 'none' : '';
        };
        syncRoutine();
        q('#ag-routine').addEventListener('change', syncRoutine);
        q('#ag-engine').addEventListener('change', async () => {
          const list = await ensureModels(q('#ag-engine').value);
          q('#ag-model').innerHTML = list.models.map((x) => `<option value="${esc(x.id)}">${esc(x.label)}</option>`).join('');
        });
        const repaint = () => {
          q('[data-look-preview]').innerHTML = face(a.look, 48);
          el.querySelectorAll('.swatch').forEach((s) => { s.dataset.on = String(s.dataset.color === a.look.color); });
        };
        el.addEventListener('click', async (e) => {
          const sw = e.target.closest('[data-color]');
          if (sw) { a.look.color = sw.dataset.color; repaint(); return; }
          if (e.target.closest('[data-shuffle]')) {
            const r = randomLook(Math.random().toString(36));
            a.look.shape = r.shape === a.look.shape ? FACE_SHAPES[(FACE_SHAPES.indexOf(r.shape) + 1) % FACE_SHAPES.length] : r.shape;
            a.look.eyes = r.eyes === a.look.eyes ? FACE_EYES[(FACE_EYES.indexOf(r.eyes) + 1) % FACE_EYES.length] : r.eyes;
            repaint();
            return;
          }
          if (e.target.closest('[data-pick-cwd]')) { const d = await window.fm.dialog.pickFolder(); if (d) q('#ag-cwd').value = d; return; }
          if (e.target.closest('[data-delete]')) { close(); deleteAgent(a.id); return; }
          if (e.target.closest('[data-save]')) {
            const name = q('#ag-name').value.trim() || 'New agent';
            const cwd = q('#ag-cwd').value.trim();
            if (cwd && !(await window.fm.fs.exists(cwd))) { q('#ag-cwd').focus(); q('#ag-cwd').style.boxShadow = 'inset 0 0 0 1px var(--fail)'; return; }
            const target = existing || a;
            const routine = { ...target.routine, kind: q('#ag-routine').value, minutes: +q('#ag-every').value, at: q('#ag-at').value || '09:00', prompt: q('#ag-rprompt').value.trim() };
            // Changing when the routine runs restarts the cycle from now (see dueAt in routine.js).
            const before = target.routine || {};
            if (routine.kind !== before.kind || routine.minutes !== before.minutes || routine.at !== before.at) routine.since = Date.now();
            Object.assign(target, {
              name, brief: q('#ag-brief').value.trim(), engine: q('#ag-engine').value, model: q('#ag-model').value,
              permission: q('#ag-perm').value, cwd: cwd || a.cwd, look: a.look, routine,
            });
            if (isNew) S.agents.push(target);
            S.activeAgent = target.id;
            save();
            close();
            invalidate('all');
          }
        });
        setTimeout(() => q('#ag-name').select(), 30);
      },
    });
    return m;
  })();
}

// ——— Center panel rendering ———
export function renderAgentCenter(center) {
  const a = activeAgent() || S.agents[0];
  if (a && S.activeAgent !== a.id) S.activeAgent = a.id;
  if (!a) {
    center.innerHTML = `<section class="pane"><div class="chat-welcome">
      <span class="welcome-symbol">${face(randomLook('welcome'), 44)}</span>
      <h3>Teammates on routines</h3>
      <p>Name an agent, give it a brief, put it on a routine. The work runs on a schedule — you review the result.</p>
      <div class="suggestions">${TEMPLATES.map((t, i) => `<button data-tpl="${i}">${esc(t.name)}</button>`).join('')}<button data-tpl="-1">${icon('plus').replace('<svg ', '<svg style="display:inline;vertical-align:-2px;margin-right:4px" ')}Blank agent</button></div>
    </div></section>`;
    return;
  }
  const chat = currentChat(a);
  chat.unread = false;
  const running = a.chats.some((c) => convRunning(c));
  const needs = a.chats.some((c) => c.status === 'needsYou');
  const status = running ? ['working', 'Working'] : needs ? ['needsYou', 'Waiting on you'] : ['idle', 'Ready'];
  const info = cliInfo(a.engine);
  const keyChanged = center.dataset.conv !== chat.id;
  const existing = center.querySelector('.transcript');
  if (!keyChanged && existing && center.dataset.agentVersion === versionKey(a)) {
    renderScrolled(existing, transcriptHtml(chat), false);
    refreshComposer(center, chat);
    return;
  }
  center.dataset.conv = chat.id;
  center.dataset.agentVersion = versionKey(a);
  center.innerHTML = `<section class="pane" aria-label="Agent ${esc(a.name)}">
    <header class="agent-header">${face(a.look, 28)}
      <span class="agent-id"><span class="agent-name">${esc(a.name)}</span><span class="agent-engine">Powered by ${esc(ENGINE_NAMES[a.engine] || a.engine)}${info.installed ? '' : ' (not installed)'}${a.routine && a.routine.kind !== 'off' ? ' · ' + esc(routineText(a.routine)) : ''}</span></span>
      <span style="flex:auto"></span>
      <span class="working"><span class="dot" data-state="${status[0]}"></span>${status[1]}</span>
      <span class="gear-seat"><button class="chrome-btn" data-act="edit-agent" data-tip="Settings, brief and routine" aria-label="Agent settings">${icon('settings')}</button>${a.routine && a.routine.kind !== 'off' ? '<span class="gear-dot"></span>' : ''}</span>
    </header>
    <div class="hairline"></div>
    <div class="tabs">${a.chats.slice(-6).map((c) => `<button class="tab" data-chat="${c.id}" data-on="${c.id === chat.id}">${convRunning(c) ? '<span class="dot" data-state="working"></span>' : c.status === 'needsYou' ? '<span class="dot" data-state="needsYou"></span>' : ''}<span class="tab-title">${esc(c.title || 'New chat')}</span>${a.chats.length > 1 ? `<span class="tab-close" data-close-chat="${c.id}" aria-label="Close chat">${icon('x')}</span>` : ''}</button>`).join('')}
      <button class="tab-add" data-act="new-chat" data-tip="New chat" aria-label="New chat">${icon('plus')}</button></div>
    <div class="agent-main">
      ${chat.turns.length ? `<div class="scroll transcript" aria-label="Conversation"><div class="column stack">${transcriptHtml(chat)}</div></div>`
        : `<div class="chat-welcome" style="flex:auto"><span class="welcome-symbol">${face(a.look, 44)}</span><h3 style="font-size:22px">${esc(a.name)}</h3><p>${esc(a.brief || 'Give this agent a brief with the gear button, or just say what you need.')}</p></div>`}
      <div data-composer>${composerHtml(chat, { kind: 'agent', placeholder: `Message ${a.name}…` })}</div>
    </div></section>`;
  const tr = center.querySelector('.transcript');
  if (tr) tr.scrollTop = tr.scrollHeight;
}

function versionKey(a) {
  const chat = currentChat(a);
  return [a.name, a.engine, a.model, a.chats.length, a.chats.map((c) => c.title + c.status + (convRunning(c) ? 1 : 0)).join('|'), chat.turns.length ? 1 : 0, a.routine && a.routine.kind].join('~');
}

function refreshComposer(center, chat) {
  const host = center.querySelector('[data-composer]');
  if (!host) return;
  const ta = host.querySelector('.editor-input');
  const hadFocus = document.activeElement === ta;
  const sel = ta ? [ta.selectionStart, ta.selectionEnd] : null;
  const running = convRunning(chat);
  const wasRunning = !!host.querySelector('[data-act="stop"]');
  if (running === wasRunning && host.dataset.models === String(!!R.models[agentOfChat(chat).engine])) return;
  host.dataset.models = String(!!R.models[agentOfChat(chat).engine]);
  host.innerHTML = composerHtml(chat, { kind: 'agent', placeholder: `Message ${agentOfChat(chat).name}…` });
  const nta = host.querySelector('.editor-input');
  if (hadFocus && nta) { nta.focus(); nta.setSelectionRange(sel[0], sel[1]); }
}

export function bindAgentCenter(center) {
  bindChat(center, () => { const a = activeAgent(); return a ? currentChat(a) : null; }, (conv, what, value) => {
    const a = agentOfChat(conv);
    if (!a) return;
    if (what === 'engine') { a.engine = value; a.model = ''; ensureModels(value); conv.sessionId = null; }
    else if (what === 'model') a.model = value;
    else if (what === 'effort') a.effort = value;
    else if (what === 'permission') a.permission = value;
    save();
    center.dataset.agentVersion = '';
    invalidate('center');
  });
  center.addEventListener('click', (e) => {
    const a = activeAgent();
    const tpl = e.target.closest('[data-tpl]');
    if (tpl) { const i = +tpl.dataset.tpl; editAgent(null, i >= 0 ? TEMPLATES[i] : {}); return; }
    if (!a) return;
    const closeChat = e.target.closest('[data-close-chat]');
    if (closeChat) {
      e.stopPropagation();
      const c = a.chats.find((x) => x.id === closeChat.dataset.closeChat);
      if (c && convRunning(c)) return;
      if (c) stopVoice('chat:' + c.id);
      a.chats = a.chats.filter((x) => x.id !== closeChat.dataset.closeChat);
      if (a.activeChat === closeChat.dataset.closeChat) a.activeChat = a.chats.length ? a.chats[a.chats.length - 1].id : null;
      save();
      invalidate('center', 'rail', 'side');
      return;
    }
    const tab = e.target.closest('[data-chat]');
    if (tab) { a.activeChat = tab.dataset.chat; save(); invalidate('center', 'rail'); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'new-chat') { newChat(a); save(); invalidate('center', 'rail'); setTimeout(() => { const ta = center.querySelector('.editor-input'); if (ta) ta.focus(); }, 30); }
    else if (b.dataset.act === 'edit-agent') editAgent(a);
  });
}

// ——— Routine: checked every 20 seconds ———
export function startScheduler() {
  setInterval(() => {
    const now = Date.now();
    for (const a of S.agents) {
      const due = dueAt(a, now);
      if (!due || now < due) continue;
      if (a.chats.some((c) => convRunning(c))) continue;
      if (!cliInfo(a.engine).installed) continue;
      a.routine.lastRun = now;
      const when = new Date(now).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
      const chat = newChat(a, `Routine · ${when}`);
      chat.routine = true;
      if (!(S.ui.mode === 'agent' && S.activeAgent === a.id)) a.activeChat = chat.id;
      save();
      send(chat, a.routine.prompt);
      invalidate('rail', 'center', 'side');
    }
  }, 20000);
}
