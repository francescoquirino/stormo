'use strict';
// For coding, the Director must use the model router; conversation and questions can finish directly.
// The check never throws away work already done, though: the Director is only called back if it answered
// without having touched anything yet. Once it has written files or run commands, the reply is delivered with a note:
// re-running the request would redo the same actions a second time (seen live: banners, video, uploads).
function isInvocation(evt) {
  if (evt.type !== 'tool') return false;
  const arg = String(evt.arg || '');
  if (/--(?:status|tiers|guard|usage-json|leader-json|dry-run)\b/.test(arg)) return false;
  if (evt.verb === 'Router') return true;
  return /python[\d.]*(?:\.exe)?["']?\s+["']?[^\r\n]*[\\/]route-ask["']?\s/i.test(arg);
}
const isGeneration = evt => evt.status === 'done' && isInvocation(evt);

// Tools that only look: after these, a callback repeats no action.
const PASSIVE = new Set(['Read', 'View', 'Grep', 'Glob', 'List', 'Search', 'Fetch', 'Browse', 'Plan', 'Skill', 'Router']);
// Claude only sends the verb when the tool starts: the result arrives with just the ID.
const isAction = evt => evt.type === 'tool' && !!evt.verb && !PASSIVE.has(evt.verb) && !isInvocation(evt);

const NOTE_DIRECT = 'Note: the Director did this work on its own, without going through the model router.';
const NOTE_FAILED = 'Note: the model router did not complete the request; the Director finished the work on its own.';

function createRouterGuard({ required = true } = {}) {
  let routed = false;
  let attempted = false;
  let acted = false;
  let retryUsed = false;
  const invocations = new Set();
  const held = [];
  return {
    event(evt) {
      if (isInvocation(evt)) {
        attempted = true;
        if (evt.id) invocations.add(evt.id);
      }
      if (isGeneration(evt) || (evt.type === 'tool' && evt.status === 'done' && invocations.has(evt.id))) {
        routed = true;
        return { events: [evt, ...held.splice(0)] };
      }
      if (isAction(evt)) {
        // Real work has started: no more waiting for text and no more callback.
        acted = true;
        return { events: [...held.splice(0), evt] };
      }
      if (!required && !attempted) return { events: [evt] };
      if (evt.type === 'done' && !routed && evt.ok !== false) {
        if (acted) return { events: [...held.splice(0), { type: 'notice', show: true, message: attempted ? NOTE_FAILED : NOTE_DIRECT }, evt] };
        if (attempted) return { events: [...held.splice(0), { type: 'error', message: 'The model router did not complete the request.' }, { ...evt, ok: false }] };
        held.length = 0;
        if (!retryUsed) { retryUsed = true; return { events: [], retry: true }; }
        return { events: [{ type: 'error', message: 'The Director did not use the model router: response incomplete.' }, { ...evt, ok: false }] };
      }
      if (evt.type === 'done' && evt.ok === false) return { events: [...held.splice(0), evt] };
      if (!routed && !acted && ['text', 'text-delta', 'thought'].includes(evt.type)) {
        held.push(evt); return { events: [] };
      }
      return { events: [evt] };
    },
    get routed() { return routed; },
  };
}
module.exports = { isGeneration, isInvocation, isAction, createRouterGuard, NOTE_DIRECT, NOTE_FAILED };
