'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isGeneration, isAction, createRouterGuard, NOTE_DIRECT, NOTE_FAILED } = require('../src/main/router-guard');
const tool = { type: 'tool', verb: 'Router', arg: '--work C "hi"', status: 'done' };
const types = (r) => r.events.map((e) => e.type);

test('conversation: direct answer, no wait or automatic request to the router', () => {
  const g = createRouterGuard({ required: false });
  assert.deepEqual(g.event({ type: 'text', text: 'Hi!' }).events, [{ type: 'text', text: 'Hi!' }]);
  const end = g.event({ type: 'done', ok: true }); assert.equal(end.retry, undefined); assert.equal(end.events[0].ok, true);
});

// Regression: the coordinator had already done the work (files written, commands run) and the response was
// discarded with "response not completed", after RELAUNCHING the whole request.
test('work already done by the coordinator (files written, commands run): no relaunch, no error, one notice', () => {
  const g = createRouterGuard({ required: true });
  assert.deepEqual(g.event({ type: 'text', text: 'I will do it myself with Python.' }).events, [], 'before acting the text waits');
  const first = g.event({ type: 'tool', id: 'w1', verb: 'Write', arg: 'banner.py', status: 'running' });
  assert.deepEqual(types(first), ['text', 'tool'], 'as soon as it acts the held-back text comes out');
  assert.deepEqual(types(g.event({ type: 'tool', id: 'w1', status: 'done' })), ['tool']);
  assert.deepEqual(types(g.event({ type: 'tool', id: 'r1', verb: 'Run', arg: 'python banner.py', status: 'running' })), ['tool']);
  assert.deepEqual(types(g.event({ type: 'text', text: 'Banner created.' })), ['text'], 'after acting the text no longer waits');
  const end = g.event({ type: 'done', ok: true });
  assert.equal(end.retry, undefined, 'never relaunch a request that has already taken actions');
  assert.deepEqual(types(end), ['notice', 'done']);
  assert.equal(end.events[0].message, NOTE_DIRECT);
  assert.equal(end.events[0].show, true);
  assert.equal(end.events[1].ok, true, 'the response stays valid');
});

test('message not classified as coding: a coordinator edit passes through cleanly, with no notice', () => {
  const g = createRouterGuard({ required: false });
  g.event({ type: 'tool', id: 'e1', verb: 'Edit', arg: 'a.txt', status: 'running' });
  const end = g.event({ type: 'done', ok: true });
  assert.equal(end.retry, undefined);
  assert.deepEqual(types(end), ['done']);
  assert.equal(end.events[0].ok, true);
});

test('router failed but work finished by the coordinator: delivered with the right notice', () => {
  const g = createRouterGuard();
  g.event({ ...tool, id: 'x1', status: 'failed' });
  g.event({ type: 'tool', id: 'e1', verb: 'Edit', arg: 'a.py', status: 'running' });
  const end = g.event({ type: 'done', ok: true });
  assert.equal(end.retry, undefined);
  assert.equal(end.events.at(-1).ok, true);
  assert.equal(end.events.find((e) => e.type === 'notice').message, NOTE_FAILED);
});

test('only reads and then a direct answer to a coding request: the recall stays (repeats no action)', () => {
  const g = createRouterGuard();
  for (const verb of ['Read', 'Grep', 'Glob', 'Skill']) g.event({ type: 'tool', id: verb, verb, status: 'running' });
  g.event({ type: 'text', text: 'here is the code' });
  assert.equal(g.event({ type: 'done', ok: true }).retry, true);
});

test('what counts as an action: writing and running yes, reading and querying the router no', () => {
  for (const verb of ['Write', 'Edit', 'Run', 'Patch', 'Monitor']) assert.equal(isAction({ type: 'tool', verb, status: 'running' }), true, verb);
  for (const verb of ['Read', 'Grep', 'Glob', 'List', 'Search', 'Fetch', 'Skill']) assert.equal(isAction({ type: 'tool', verb, status: 'running' }), false, verb);
  assert.equal(isAction({ ...tool, arg: '--status' }), false);
  assert.equal(isAction({ type: 'tool', id: 'x', status: 'done' }), false, 'a result with no verb is not a new action');
  assert.equal(isAction({ type: 'tool', verb: 'Run', arg: 'python C:/Users/dev/.local/bin/route-ask --work C "x"', status: 'running' }), false, 'calling the router is not direct work');
});

test('even on a question, a router that actually failed is not approved', () => {
  const g = createRouterGuard({ required: false }); g.event({ ...tool, status: 'failed' });
  assert.equal(g.event({ type: 'done', ok: true }).events.at(-1).ok, false);
});

test('real Claude stream: the result with only an ID completes the router call', () => {
  const { createParser } = require('../src/main/engines/claude');
  const g = createRouterGuard(); const events = [];
  const parser = createParser((e) => events.push(...(g.event(e).events || [])));
  parser.feedLine(JSON.stringify({ type: 'assistant', message: { id: 'msg', content: [{ type: 'tool_use', id: 'route-1', name: 'Bash', input: { command: 'python C:/Users/dev/.local/bin/route-ask --work C "hi"' } }] } }));
  parser.feedLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'route-1', content: 'response', is_error: false }] } }));
  parser.feedLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  parser.finish(0);
  assert.equal(g.routed, true); assert.equal(events.at(-1).ok, true);
  assert.ok(!events.some((e) => e.type === 'notice'), 'with the router used there is no notice');
});

test('real Claude stream: the coordinator writes a file by itself → response delivered with the notice', () => {
  const { createParser } = require('../src/main/engines/claude');
  const g = createRouterGuard(); const events = []; let retry = false;
  const parser = createParser((e) => { const a = g.event(e); if (a.retry) retry = true; events.push(...(a.events || [])); });
  parser.feedLine(JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'w-1', name: 'Write', input: { file_path: 'C:/w/banner.py', content: 'x' } }] } }));
  parser.feedLine(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w-1', content: 'File created', is_error: false }] } }));
  parser.feedLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }));
  parser.finish(0);
  assert.equal(retry, false);
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).ok, true);
  assert.equal(events.filter((e) => e.type === 'notice').length, 1);
});

test('response held back until the router: no direct response is considered finished', () => {
  const g = createRouterGuard(); const text = { type: 'text', text: 'hi' };
  assert.deepEqual(g.event(text).events, []);
  assert.deepEqual(g.event(tool).events, [tool, text]);
  assert.equal(g.event({ type: 'done', ok: true }).events[0].ok, true);
});

test('if the coordinator answers without having done anything: a single recall, then error', () => {
  const g = createRouterGuard(); g.event({ type: 'text', text: 'direct response' });
  assert.equal(g.event({ type: 'done', ok: true }).retry, true);
  g.event({ type: 'text', text: 'still direct' });
  const result = g.event({ type: 'done', ok: true });
  assert.equal(result.retry, undefined); assert.equal(result.events.at(-1).ok, false);
  assert.equal(result.events[0].type, 'error');
});

test('status, dry-run or reading the source do not substitute for a delegation', () => {
  for (const flag of ['--status', '--tiers', '--dry-run', '--usage-json', '--leader-json', '--guard'])
    assert.equal(isGeneration({ ...tool, arg: flag }), false);
  assert.equal(isGeneration({ ...tool, verb: 'Run', arg: 'Get-Content C:/Users/dev/.local/bin/route-ask' }), false);
});

test('a real call from Codex\'s PowerShell is recognized', () => {
  assert.equal(isGeneration({ ...tool, verb: 'Run', arg: '"pwsh.exe" -NoProfile -Command \'& "C:/Python/python.exe" "C:/Users/dev/.local/bin/route-ask" --work C "hi"\'' }), true);
  assert.equal(isGeneration({ ...tool, verb: 'Run', arg: 'python C:\\Users\\dev\\.local\\bin\\route-ask --work BC "x"' }), true);
});

test('router failed and no work done: not approved and does not relaunch spending other models', () => {
  const g = createRouterGuard(); g.event({ ...tool, status: 'failed' });
  const r = g.event({ type: 'done', ok: true }); assert.equal(r.retry, undefined); assert.equal(r.events.at(-1).ok, false);
});
