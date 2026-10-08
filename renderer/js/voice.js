// One dictation at a time: transcribes locally and only inserts text, never Enter.
import { toast, icon, refreshTip } from './dom.js';

let active = null;     // { key, onText, state, stopping }
let queued = null;     // { key, onText } waiting for the previous dictation to finish
let noticeShown = false;

const TIPS = {
  off: 'Dictate into the prompt (does not send)',
  loading: 'Loading voice… you can speak already',
  listening: 'Listening: click to stop',
  transcribing: 'Transcribing… text coming shortly',
};

function paintButton(b, state, on) {
  b.dataset.on = String(on);
  b.dataset.state = state;
  b.setAttribute('aria-pressed', String(on));
  b.dataset.tip = TIPS[state] || TIPS.off;
  refreshTip(b);
  b.setAttribute('aria-label', on ? 'Stop dictation' : 'Dictate into the prompt');
  const want = state === 'loading' ? 'loader' : 'audio-lines';
  if (b.dataset.glyph !== want) {
    b.dataset.glyph = want;
    b.innerHTML = icon(want);
  }
}

function paintLivePill() {
  const pill = document.getElementById('voice-live');
  if (!pill) return;
  pill.hidden = !active;
  if (!active) return;
  pill.dataset.state = active.state;
  pill.querySelector('.voice-live-text').textContent =
    active.state === 'loading' ? 'Loading voice…' : active.state === 'transcribing' ? 'Transcribing…' : 'Listening';
}

function paint() {
  document.querySelectorAll('[data-voice-key]').forEach((b) => {
    const on = !!active && b.dataset.voiceKey === active.key;
    paintButton(b, on ? active.state : 'off', on);
  });
  paintLivePill();
}

export function refreshVoiceButtons() {
  paint();
  // The target has left the scene (other panel, other chat, other mode): microphone off.
  if (active && !active.stopping && !document.querySelector(`[data-voice-key="${CSS.escape(active.key)}"]`)) requestStop();
}

export function voiceActive(key) { return !!active && active.key === key; }
export function voiceSnapshot() { return active ? { state: active.state } : null; }

function requestStop() {
  if (!active || active.stopping) return;
  active.stopping = true;
  active.state = 'transcribing';
  window.fm.voice.stop(active.key);
  paint();
}

export function stopVoice(key) {
  if (queued && queued.key === key) queued = null;
  if (active && active.key === key) requestStop();
}

export function stopAllVoice() {
  queued = null;
  requestStop();
}

async function begin(key, onText) {
  active = { key, onText, state: 'loading', stopping: false };
  paint();
  try {
    const result = await window.fm.voice.start(key);
    if (!result.ok && active && active.key === key) {
      active = null;
      paint();
      toast(result.error || 'Microphone not available.', 6000);
    }
  } catch (error) {
    if (active && active.key === key) active = null;
    paint();
    toast('Could not start the microphone: ' + error.message, 6000);
  }
}

export async function toggleVoice(key, onText) {
  if (active) {
    if (active.key === key) { requestStop(); return; }
    queued = { key, onText };                 // I'll move on to this as soon as the other one finishes transcribing
    requestStop();
    return;
  }
  await begin(key, onText);
}

function finishActive() {
  active = null;
  if (queued) {
    const q = queued;
    queued = null;
    begin(q.key, q.onText);
  }
}

export function onVoiceEvent(key, event) {
  if (!active || active.key !== key) return;
  if (event.type === 'text') {
    if (event.text) active.onText(event.text);   // even after Stop: it's the last sentence being transcribed
  } else if (event.type === 'state') {
    if (!active.stopping) active.state = event.state;
  } else if (event.type === 'notice') {
    if (!noticeShown) { noticeShown = true; toast(event.message, 7000); }
  } else if (event.type === 'done') {
    finishActive();
  } else if (event.type === 'error') {
    toast('Dictation: ' + (event.message || 'error'), 7000);
    finishActive();
  }
  paint();
}
