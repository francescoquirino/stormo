'use strict';
// Antigravity: REAL samples recorded live (agy 1.2.8) — a successful command and an unapproved one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const agy = require('../src/main/engines/agy');

const sample = (n) => fs.readFileSync(path.join(__dirname, '..', 'docs', 'samples', n), 'utf8');
const CWD = 'C:\\Users\\dev\\Stormo\\.qa\\agyp-ok';

function run(lines, exitCode = 0, stderr = '', opts = { cwd: CWD }) {
  const events = [];
  const p = agy.createParser((e) => events.push(e), opts);
  for (const l of lines) p.feedLine(typeof l === 'string' ? l : JSON.stringify(l));
  if (stderr) p.feedStderr(stderr);
  p.finish(exitCode);
  return events;
}

test('successful command (real sample): "Run node -v" line with output, text only once, no fake tool', () => {
  const ev = run(sample('agy-stream-ok.jsonl').split(/\r?\n/));
  assert.equal(ev[0].type, 'start');
  assert.equal(ev[0].model, 'gemini-3.8-flash-low');
  const tools = ev.filter((e) => e.type === 'tool');
  assert.ok(tools.every((t) => t.verb === 'Run'), 'no "Agent response" disguised as a tool');
  assert.deepEqual([tools[0].arg, tools[0].status], ['node -v', 'running']);
  const done = tools.find((t) => t.status === 'done');
  assert.equal(done.output, 'v24.13.0\r\n');
  const texts = ev.filter((e) => e.type === 'text');
  assert.equal(texts.length, 1, 'the final text is not duplicated by the result');
  assert.match(texts[0].text, /v24\.13\.0/);
  const u = ev.find((e) => e.type === 'usage');
  assert.deepEqual([u.inputTokens, u.outputTokens], [29043, 179]);
  const last = ev[ev.length - 1];
  assert.deepEqual([last.type, last.ok], ['done', true]);
  assert.ok(!ev.some((e) => e.type === 'denied' || e.type === 'error'));
});

test('unapproved command (real sample): Allow card with the exact command, failed line with a clear message', () => {
  const ev = run(sample('agy-stream-denied.jsonl').split(/\r?\n/), 0, sample('agy-stderr-denied.txt'));
  const denied = ev.filter((e) => e.type === 'denied');
  assert.equal(denied.length, 1, 'a single card, even if several updates arrive');
  assert.equal(denied[0].tool, 'command');
  assert.match(denied[0].label, /^Run Set-Content -Path "a\.txt"/);
  assert.match(denied[0].input.CommandLine, /Remove-Item/);
  const failed = ev.find((e) => e.type === 'tool' && e.status === 'failed');
  assert.match(failed.output, /cannot ask for permission/);
  assert.ok(!ev.some((e) => e.type === 'error'), 'not an error: it\'s a permission request');
  assert.equal(ev[ev.length - 1].ok, true);
});

test('user deny rule: failed line but NO Allow card (allowing wouldn\'t help)', () => {
  const ev = run([
    { event: 'init', conversation_id: 'c1', init: { model: 'm' } },
    { event: 'step_update', step_update: { step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'write_to_file',
      tool_info: { name: 'write_to_file', parameters: { TargetFile: CWD + '\\x.txt' },
        error: { message: 'permission check failed for write_file "x": Permission denied for write_file(x). Matches user-configured deny rule.' } } } },
    { event: 'result', result: { status: 'SUCCESS', response: '' } },
  ]);
  const t = ev.find((e) => e.type === 'tool');
  assert.deepEqual([t.verb, t.arg, t.status], ['Write', 'x.txt', 'failed']);
  assert.match(t.output, /deny rule/);
  assert.ok(!ev.some((e) => e.type === 'denied'));
});

test('file and search tools: readable verb and argument', () => {
  const step = (i, name, params) => ({ event: 'step_update', step_update: { step_index: i, state: 'DONE', step_type: 'tool', tool_name: name, tool_info: { name, parameters: params, output: 'ok' } } });
  const ev = run([
    step(1, 'view_file', { AbsolutePath: CWD + '\\src\\a.js' }),
    step(2, 'grep_search', { Query: 'TODO', SearchPath: CWD }),
    step(3, 'list_dir', { DirectoryPath: CWD }),
    step(4, 'qualcosa_di_nuovo', { Foo: 'bar' }),
  ]);
  const t = ev.filter((e) => e.type === 'tool').map((e) => [e.verb, e.arg]);
  assert.deepEqual(t, [['Read', 'src/a.js'], ['Grep', 'TODO'], ['List', ''], ['Qualcosa di nuovo', 'bar']]);
});

test('buildArgs: after an "Allow" it starts with the approval; Plan stays read-only; with nothing it stays accept-edits', () => {
  const a = agy.buildArgs({ prompt: 'p', permission: 'smart', allowedTools: ['command'] });
  assert.ok(a.includes('--dangerously-skip-permissions') && !a.includes('--mode'));
  const p = agy.buildArgs({ prompt: 'p', permission: 'smart', allowedTools: ['command'], mode: 'plan' });
  assert.ok(!p.includes('--dangerously-skip-permissions'));
  assert.deepEqual(p.slice(p.indexOf('--mode'), p.indexOf('--mode') + 2), ['--mode', 'plan']);
  const n = agy.buildArgs({ prompt: 'p', permission: 'smart' });
  assert.deepEqual(n.slice(n.indexOf('--mode'), n.indexOf('--mode') + 2), ['--mode', 'accept-edits']);
  assert.ok(!agy.buildArgs({ prompt: 'p', permission: 'smart', allowedTools: [] }).includes('--dangerously-skip-permissions'));
});
