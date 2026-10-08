'use strict';
// Dictation manager with a fake voice process: no microphone, no Python.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { VoiceManager } = require('../src/main/voice');

const FAKE = path.join(__dirname, 'fixtures', 'fake-voice-worker.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function make(t, opts = {}) {
  const events = [];
  const vm = new VoiceManager((ch, id, ev) => events.push({ ch, id, ...ev }), {
    spawnSpec: { file: process.execPath, args: [FAKE] }, ...opts,
  });
  t.after(() => vm.stopAll());
  const of = (id) => events.filter((e) => e.id === id);
  const waitFor = async (pred, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(10); }
    return false;
  };
  return { vm, events, of, waitFor };
}

const pidOf = (events) => +(events.find((e) => e.type === 'text').text.match(/pid=(\d+)/) || [])[1];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a complete dictation: listens, transcribes with the right accents, finishes', async (t) => {
  const { vm, of, waitFor } = make(t);
  assert.deepEqual(await vm.start('A'), { ok: true });
  assert.ok(await waitFor(() => of('A').some((e) => e.type === 'state' && e.state === 'listening')));
  vm.stop('A');
  assert.ok(await waitFor(() => of('A').some((e) => e.type === 'done')));
  assert.equal(of('A').find((e) => e.type === 'text').text.startsWith('perché città è già'), true);
  assert.equal(of('A')[0].state, 'loading', 'the first time, the UI knows it\'s loading');
});

test('the process stays warm: the second dictation doesn\'t launch another one', async (t) => {
  const { vm, of, waitFor } = make(t);
  await vm.start('A');
  await waitFor(() => of('A').some((e) => e.state === 'listening'));
  vm.stop('A');
  await waitFor(() => of('A').some((e) => e.type === 'done'));
  const pidA = pidOf(of('A'));
  await vm.start('B');
  assert.ok(await waitFor(() => of('B').some((e) => e.state === 'listening')));
  assert.ok(!of('B').some((e) => e.state === 'loading'), 'no new loading');
  vm.stop('B');
  await waitFor(() => of('B').some((e) => e.type === 'done'));
  assert.equal(pidOf(of('B')), pidA, 'same process');
});

test('another dictation while one is active is rejected with a clear message', async (t) => {
  const { vm } = make(t);
  await vm.start('A');
  const r = await vm.start('B');
  assert.equal(r.ok, false);
  assert.match(r.error, /Stop the active dictation/);
  assert.deepEqual(await vm.start('A'), { ok: true }, 'double-click on the same one: no error');
});

test('while one is finishing transcribing, the new one queues up and starts right after', async (t) => {
  const { vm, events, waitFor } = make(t);
  await vm.start('A');
  await waitFor(() => events.some((e) => e.id === 'A' && e.state === 'listening'));
  vm.stop('A');
  const r = await vm.start('B');                       // A is still transcribing
  assert.deepEqual(r, { ok: true, queued: true });
  assert.ok(await waitFor(() => events.some((e) => e.id === 'B' && e.state === 'listening')));
  const iDoneA = events.findIndex((e) => e.id === 'A' && e.type === 'done');
  const iListenB = events.findIndex((e) => e.id === 'B' && e.state === 'listening');
  assert.ok(iDoneA !== -1 && iDoneA < iListenB, 'A finishes before B starts');
});

test('if the voice process hangs after Stop, the anti-hang watchdog kicks in and the app doesn\'t freeze', async (t) => {
  const { vm, of, waitFor } = make(t, { stopWatchdogMs: 150, env: { FAKE_SILENT_ON_STOP: '1' } });
  await vm.start('A');
  await waitFor(() => of('A').some((e) => e.state === 'listening'));
  vm.stop('A');
  assert.ok(await waitFor(() => of('A').some((e) => e.type === 'error')), 'error to the UI');
  assert.match(of('A').find((e) => e.type === 'error').message, /stopped/);
});

test('process crash during dictation: clear error, and the next click starts fresh', async (t) => {
  const { vm, of, waitFor } = make(t, { env: { FAKE_CRASH_ON_STOP: '1' } });
  await vm.start('A');
  await waitFor(() => of('A').some((e) => e.state === 'listening'));
  vm.stop('A');
  assert.ok(await waitFor(() => of('A').some((e) => e.type === 'error')));
  const r = await vm.start('B');
  assert.deepEqual(r, { ok: true });
  assert.ok(await waitFor(() => of('B').some((e) => e.state === 'loading')), 'new process = loading');
});

test('Stop pressed right away, before the process starts: nothing stays running', async (t) => {
  const { vm, of, waitFor } = make(t);
  const starting = vm.start('A');
  vm.stop('A');
  await starting;
  assert.ok(await waitFor(() => of('A').some((e) => e.type === 'done')));
  assert.equal(vm.worker, null, 'no process launched');
  assert.equal(vm.active, null);
});

test('after a while idle, the process shuts itself down (frees RAM and GPU)', async (t) => {
  const { vm, of, waitFor } = make(t, { idleMs: 150 });
  await vm.start('A');
  await waitFor(() => of('A').some((e) => e.state === 'listening'));
  vm.stop('A');
  await waitFor(() => of('A').some((e) => e.type === 'done'));
  const pid = pidOf(of('A'));
  assert.ok(alive(pid));
  assert.ok(await waitFor(() => !alive(pid), 4000), 'the process ended after being idle');
  assert.equal(vm.worker, null);
});

test('stopAll (app shutdown) kills the process and leaves no timers', async (t) => {
  const { vm, of, waitFor } = make(t);
  await vm.start('A');
  await waitFor(() => of('A').some((e) => e.state === 'listening'));
  const pid = vm.worker.child.pid;
  vm.stopAll();
  assert.ok(await waitFor(() => !alive(pid), 3000));
});
