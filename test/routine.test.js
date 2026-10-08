'use strict';
// Agent routines: when they're due, with no surprise runs for times already past.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// The UI module is a dependency-free ES module (renderer/package.json says "type": "module").
let dueAt;
test.before(async () => {
  ({ dueAt } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'routine.js')).href));
});

const at = (h, m = 0, day = 30) => new Date(2026, 8, day, h, m).getTime();   // September 2026, local time
const MIN = 60000;
const agent = (routine, createdAt) => ({ createdAt, routine: { prompt: 'Fai il riassunto.', ...routine } });

test('no routine, routine off, or no instructions: nothing to run', () => {
  assert.equal(dueAt({ createdAt: at(9) }, at(10)), null);
  assert.equal(dueAt(agent({ kind: 'off' }, at(9)), at(10)), null);
  assert.equal(dueAt(agent({ kind: 'every', minutes: 60, prompt: '' }, at(9)), at(10)), null);
});

test('every N minutes: a just-created agent fires after the interval, not right away', () => {
  const a = agent({ kind: 'every', minutes: 60 }, at(14));
  assert.equal(dueAt(a, at(14, 1)), at(15));
});

test('every N minutes: counts from the last run', () => {
  const a = agent({ kind: 'every', minutes: 30, lastRun: at(14, 10) }, at(9));
  assert.equal(dueAt(a, at(14, 20)), at(14, 40));
});

test('every N minutes: the minimum interval is 5 minutes', () => {
  const a = agent({ kind: 'every', minutes: 1 }, at(14));
  assert.equal(dueAt(a, at(14, 1)), at(14, 5));
});

test('every N minutes: a routine turned on days after creation doesn\'t fire right away', () => {
  const a = agent({ kind: 'every', minutes: 60, since: at(14) }, at(14, 0, 23));
  assert.equal(dueAt(a, at(14, 5)), at(15));
});

test('every day: set at 14:00 for 09:00 fires tomorrow, not right away', () => {
  const a = agent({ kind: 'daily', at: '09:00' }, at(14));
  assert.equal(dueAt(a, at(14, 1)), new Date(2026, 9, 1, 9, 0).getTime());
});

test('every day: set at 08:00 for 09:00 fires today at 09:00', () => {
  const a = agent({ kind: 'daily', at: '09:00' }, at(8));
  assert.equal(dueAt(a, at(8, 1)), at(9));
});

test('every day: if the app was closed at 09:00, it fires as soon as it reopens (catch-up)', () => {
  const a = agent({ kind: 'daily', at: '09:00', lastRun: at(9, 0, 29) }, at(9, 0, 20));
  assert.equal(dueAt(a, at(10)), at(9));
});

test('every day: already run today, the next one is tomorrow', () => {
  const a = agent({ kind: 'daily', at: '09:00', lastRun: at(9, 5) }, at(9, 0, 20));
  assert.equal(dueAt(a, at(10)), new Date(2026, 9, 1, 9, 0).getTime());
});

test('every day: a routine set today after its time doesn\'t fire right away, even on an old agent', () => {
  const a = agent({ kind: 'daily', at: '09:00', since: at(15) }, at(9, 0, 20));
  assert.equal(dueAt(a, at(15, 1)), new Date(2026, 9, 1, 9, 0).getTime());
});
