'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Regia } = require('../src/main/regia');
const sonnet = { ok: true, engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' };
const sol = { ok: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
function archive(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-regia-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'regia.json');
}
test('director: concurrent open, changed quotas and a new chat', async t => {
  let calls = 0; let chosen = sonnet;
  const r = new Regia(archive(t), async () => { calls++; await Promise.resolve(); return chosen; });
  const [a, b] = await Promise.all([r.open({routerChatId:'au-one'}), r.open({routerChatId:'au-one'})]);
  assert.equal(calls, 1); assert.equal(a.model, sonnet.model); assert.deepEqual(a, b);
  chosen = sol;
  assert.equal((await r.open({routerChatId:'au-one', routerEngine:'codex', routerModel:sol.model})).model, sonnet.model);
  assert.equal(calls, 1, 'no quota check mid-conversation');
  assert.equal((await r.open({routerChatId:'au-two'})).model, sol.model);
  assert.equal(calls, 2);
});
test('director and session survive a restart, without re-reading quotas', async t => {
  const file = archive(t);
  const r = new Regia(file, async () => sol);
  await r.open({routerChatId:'au-resume'});
  r.started('au-resume', 'session-persisted', 'bc');
  const restarted = new Regia(file, async () => { throw new Error('Must not select'); });
  const result = await restarted.open({routerChatId:'au-resume'});
  assert.equal(result.model, sol.model); assert.equal(result.sessionId, 'session-persisted');
  assert.equal(result.initialized, true); assert.equal(result.mode, 'bc');
});
test('migrating existing chats keeps the provider and blocks switching on a quota error', async t => {
  const r = new Regia(archive(t), async () => ({ok:false,error:'Quota esaurita'}));
  const old = await r.open({routerChatId:'au-old', engine:'claude', sessionId:'old-session'});
  assert.equal(old.model, sonnet.model); assert.equal(old.sessionId, 'old-session');
  assert.equal((await r.open({routerChatId:'au-new'})).ok, false);
  assert.equal((await r.open({routerChatId:'au-old'})).model, sonnet.model);
});
test('a corrupted archive does not cause a silent change of director', t => {
  const file = archive(t); fs.writeFileSync(file, '{ broken');
  assert.throws(() => new Regia(file), /Director archive/);
});
