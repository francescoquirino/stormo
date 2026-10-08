'use strict';
// Adapter tests with REAL samples recorded live (docs/samples). No process started.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const claude = require('../src/main/engines/claude');
const codex = require('../src/main/engines/codex');
const agy = require('../src/main/engines/agy');
const gemini = require('../src/main/engines/gemini');
const common = require('../src/main/engines/common');
const cli = require('../src/main/cli');

const CWD = 'C:\\Users\\dev\\AppData\\Local\\Temp\\claude\\C--\\005704a0-0000-0040-0080-000000000002\\scratchpad\\clitest';

function readSample(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'docs', 'samples', name), 'utf8');
}

function parseSample(adapter, name, opts, exitCode, stderr = '') {
  const events = [];
  const p = adapter.createParser((e) => events.push(e), opts);
  for (const line of readSample(name).split(/\r?\n/)) p.feedLine(line);
  if (stderr) p.feedStderr(stderr);
  p.finish(exitCode);
  return events;
}

function feed(adapter, lines, opts = {}, exitCode = 0, stderr = '') {
  const events = [];
  const p = adapter.createParser((e) => events.push(e), opts);
  for (const l of lines) p.feedLine(typeof l === 'string' ? l : JSON.stringify(l));
  if (stderr) p.feedStderr(stderr);
  p.finish(exitCode);
  return { events, p };
}

function hasPair(args, flag, value) {
  return args.some((x, i) => x === flag && args[i + 1] === value);   // any occurrence, not just the first
}

function assertTerminal(p, events) {
  const before = events.length;
  p.finish(0);
  p.feedLine('{"type":"system","subtype":"init","session_id":"late"}');
  p.feedStderr('late\n');
  assert.equal(events.length, before, 'no event after done');
  assert.equal(events.filter((e) => e.type === 'done').length, 1, 'only one done');
  assert.equal(events[events.length - 1].type, 'done');
}

// ——— Claude ———
test('Claude real sample: start, Read nota.txt, text and done', () => {
  const ev = parseSample(claude, 'claude-stream.jsonl', { cwd: CWD }, 0);
  assert.equal(ev[0].type, 'start');
  assert.equal(ev[0].sessionId, '005704a0-0000-0040-0080-000000000005');
  const tools = ev.filter((e) => e.type === 'tool');
  const run = tools.find((t) => t.status === 'running');
  assert.equal(run.verb, 'Read');
  assert.equal(run.arg, 'nota.txt');
  const done = tools.find((t) => t.id === run.id && t.status === 'done');
  assert.ok(done && done.output.includes('hello world'));
  const text = ev.find((e) => e.type === 'text');
  assert.ok(text.text.includes('hello world'));
  const last = ev[ev.length - 1];
  assert.deepEqual([last.type, last.ok, last.sessionId, last.durationMs], ['done', true, '005704a0-0000-0040-0080-000000000005', 6144]);
});

test('Claude real sample: the text key uses the stream index and the deltas reassemble it', () => {
  const ev = parseSample(claude, 'claude-stream.jsonl', { cwd: CWD }, 0);
  const text = ev.find((e) => e.type === 'text');
  assert.match(text.key, /^msg_[A-Za-z0-9]+:1$/);
  const deltas = ev.filter((e) => e.type === 'text-delta' && e.key === text.key);
  assert.ok(deltas.length >= 2);
  assert.equal(deltas.map((d) => d.text).join(''), text.text);
});

test('Claude real sample: thought, usage, limits', () => {
  const ev = parseSample(claude, 'claude-stream.jsonl', { cwd: CWD }, 0);
  assert.ok(ev.some((e) => e.type === 'thought' && e.seconds >= 1));
  const u = ev.find((e) => e.type === 'usage');
  assert.deepEqual([u.inputTokens, u.outputTokens, u.cachedTokens], [90129, 291, 69819]);
  const lim = ev.find((e) => e.type === 'limits');
  assert.equal(lim.fiveHour, 0.25);
  assert.equal(lim.sevenDay, 0.4);
});

test('Claude: permission denied → denied event with a label', () => {
  const result = { type: 'result', subtype: 'success', is_error: false, session_id: 's1', duration_ms: 10,
    permission_denials: [{ tool_name: 'Write', tool_use_id: 'toolu_sample02', tool_input: { file_path: path.win32.join(CWD, 'prova.txt'), content: 'ok' } }] };
  const { events } = feed(claude, [result], { cwd: CWD });
  const d = events.filter((e) => e.type === 'denied');
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].tool, d[0].label, d[0].id], ['Write', 'Write prova.txt', 'toolu_sample02']);
});

test('Claude: finish with no result → error and done false', () => {
  const { events } = feed(claude, [], {}, 0);
  assert.equal(events[0].type, 'error');
  assert.equal(events[1].ok, false);
});

test('Claude: thought + two texts delivered as fragments → keys 1 and 2', () => {
  const lines = [
    { type: 'stream_event', event: { type: 'message_start', message: { id: 'M' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 2, content_block: { type: 'text' } } },
    { type: 'assistant', uuid: 'u1', message: { id: 'M', content: [{ type: 'thinking', thinking: '' }] } },
    { type: 'assistant', uuid: 'u2', message: { id: 'M', content: [{ type: 'text', text: 'A' }] } },
    { type: 'assistant', uuid: 'u3', message: { id: 'M', content: [{ type: 'text', text: 'B' }] } },
    { type: 'assistant', uuid: 'u3', message: { id: 'M', content: [{ type: 'text', text: 'B' }] } },
  ];
  const { events } = feed(claude, lines);
  const texts = events.filter((e) => e.type === 'text');
  assert.deepEqual(texts.map((t) => [t.key, t.text]), [['M:1', 'A'], ['M:2', 'B']]);
});

test('Claude without partial messages: array indices', () => {
  const { events } = feed(claude, [{ type: 'assistant', message: { id: 'X', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }]);
  assert.deepEqual(events.filter((e) => e.type === 'text').map((t) => t.key), ['X:0', 'X:1']);
});

test('Claude: rounded thinking time, repeated stop = a single thought', (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const mk = (ms) => {
    now = 1000;
    const ev = [];
    const p = claude.createParser((e) => ev.push(e));
    p.feedLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { id: 'T' } } }));
    p.feedLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } }));
    now = 1000 + ms;
    p.feedLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
    p.feedLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }));
    return ev.filter((e) => e.type === 'thought');
  };
  assert.deepEqual(mk(0).map((e) => e.seconds), [1]);
  assert.deepEqual(mk(1499).map((e) => e.seconds), [1]);
  assert.deepEqual(mk(1500).map((e) => e.seconds), [2]);
});

// ——— Codex ———
test('Codex real sample: session, notice, clean command, text, usage', () => {
  const ev = parseSample(codex, 'codex-exec.jsonl', { cwd: CWD }, 0);
  assert.deepEqual(ev[0], { type: 'start', sessionId: '005704a0-0000-0040-0080-00000000003f' });
  assert.ok(ev.some((e) => e.type === 'notice' && /Skill descriptions/.test(e.message)));
  const tools = ev.filter((e) => e.type === 'tool');
  assert.equal(tools[0].status, 'running');
  assert.equal(tools[0].arg, "Get-Content -LiteralPath 'nota.txt'; Get-ChildItem");
  const rawCompleted = readSample('codex-exec.jsonl').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    .find((e) => e.type === 'item.completed' && e.item.type === 'command_execution');
  const expected = rawCompleted.item.exit_code === 0 ? 'done' : 'failed';
  assert.equal(tools[tools.length - 1].status, expected);
  assert.ok(tools[tools.length - 1].output.length > 0);
  const texts = ev.filter((e) => e.type === 'text');
  assert.equal(texts[texts.length - 1].text, '`nota.txt` contains "hello world".');
  const u = ev.find((e) => e.type === 'usage');
  assert.deepEqual([u.inputTokens, u.outputTokens, u.cachedTokens], [48712, 101, 23296]);
  assert.equal(ev[ev.length - 1].ok, true);
});

test('Codex: turn error with exit 0 → done false; tool with exit null → failed', () => {
  const { events } = feed(codex, [
    { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'x', exit_code: null, status: 'completed' } },
    { type: 'turn.failed', error: { message: 'boom' } },
  ]);
  assert.equal(events.find((e) => e.type === 'tool').status, 'failed');
  assert.ok(events.some((e) => e.type === 'error' && e.message === 'boom'));
  assert.equal(events[events.length - 1].ok, false);
});

test('Codex: command in single quotes (seen live) → clean script', () => {
  const raw = "\"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe\" -Command 'Get-ChildItem -LiteralPath . -File | Select-Object -ExpandProperty Name'";
  assert.equal(codex.cleanCommand(raw), 'Get-ChildItem -LiteralPath . -File | Select-Object -ExpandProperty Name');
  assert.equal(codex.cleanCommand('mypowershell.exe -Command x'), 'mypowershell.exe -Command x');
  assert.equal(codex.cleanCommand('"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c "dir"'), 'dir');
});

test('Codex: a failed tool with no turn error doesn\'t make done false', () => {
  const { events } = feed(codex, [{ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'x', exit_code: 2 } }]);
  assert.equal(events[events.length - 1].ok, true);
});

// ——— Antigravity ———
test('AGY real sample (429): a single quota error, done false', () => {
  const ev = parseSample(agy, 'agy-stream-429.jsonl', {}, 3, readSample('agy-stderr-429.txt'));
  assert.equal(ev[0].sessionId, '005704a0-0000-0040-0080-000000000001');
  const errs = ev.filter((e) => e.type === 'error');
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /quota/i);
  assert.equal(ev[ev.length - 1].ok, false);
});

test('AGY: stderr before stdout → still only a single error', () => {
  const ev = [];
  const p = agy.createParser((e) => ev.push(e));
  p.feedStderr(readSample('agy-stderr-429.txt'));
  for (const l of readSample('agy-stream-429.jsonl').split(/\r?\n/)) p.feedLine(l);
  p.finish(3);
  assert.equal(ev.filter((e) => e.type === 'error').length, 1);
});

test('AGY: AGY_ERROR line split at any point and with no trailing newline', () => {
  const line = 'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429)","error_code":429}';
  for (let cut = 0; cut <= line.length; cut++) {
    const ev = [];
    const p = agy.createParser((e) => ev.push(e));
    p.feedStderr(line.slice(0, cut));
    p.feedStderr(line.slice(cut));
    p.finish(0);
    assert.equal(ev.filter((e) => e.type === 'error').length, 1, 'cut ' + cut);
  }
});

test('AGY: quota count per line', () => {
  assert.equal(agy.countQuotaErrors('a RESOURCE_EXHAUSTED\nb\nc RESOURCE_EXHAUSTED'), 2);
  assert.equal(agy.countQuotaErrors('RESOURCE_EXHAUSTED RESOURCE_EXHAUSTED'), 1);
  for (const n of [2, 3, 4]) assert.equal(agy.countQuotaErrors(Array(n).fill('x RESOURCE_EXHAUSTED').join('\r\n')), n);
  assert.equal(agy.countQuotaErrors(null), 0);
});

test('AGY: effort xhigh/max → high', () => {
  assert.ok(hasPair(agy.buildArgs({ prompt: 'p', effort: 'xhigh' }), '--effort', 'high'));
  assert.ok(hasPair(agy.buildArgs({ prompt: 'p', effort: 'max' }), '--effort', 'high'));
  assert.ok(hasPair(agy.buildArgs({ prompt: 'p', effort: 'low' }), '--effort', 'low'));
});

// ——— Gemini (synthetic) ———
test('Gemini: warning then success → notice and done true; object tool error → message', () => {
  const { events } = feed(gemini, [
    { type: 'init', session_id: 'g1', model: 'm' },
    { type: 'error', severity: 'warning', message: 'attenzione' },
    { type: 'tool_use', tool_id: 't1', tool_name: 'read_file', parameters: { path: 'a.txt' } },
    { type: 'tool_result', tool_id: 't1', status: 'error', error: { message: 'no file' } },
    { type: 'message', role: 'assistant', content: 'ci', delta: true },
    { type: 'result', status: 'success', stats: { input_tokens: 0, output_tokens: 0, duration_ms: 0 } },
  ]);
  assert.ok(events.some((e) => e.type === 'notice' && e.message === 'attenzione'));
  const tr = events.filter((e) => e.type === 'tool');
  assert.deepEqual([tr[0].arg, tr[1].status, tr[1].output], ['a.txt', 'failed', 'no file']);
  const last = events[events.length - 1];
  assert.deepEqual([last.ok, last.durationMs], [true, 0]);
});

// ——— Arguments ———
test('Claude buildArgs: prompt after -p, permissions, allowedTools at the end', () => {
  const a = claude.buildArgs({ prompt: 'hi', permission: 'auto', allowedTools: ['Write'] });
  assert.deepEqual(a.slice(0, 2), ['-p', 'hi']);
  assert.ok(hasPair(a, '--permission-mode', 'acceptEdits'));
  assert.ok(hasPair(a, '--permission-prompts', 'none'));
  assert.deepEqual(a.slice(-2), ['--allowedTools', 'Write']);
  assert.ok(!claude.buildArgs({ prompt: 'x', allowedTools: [] }).includes('--allowedTools'));
  assert.ok(!claude.buildArgs({ prompt: 'x' }).includes('--allowedTools'));
});

test('Codex buildArgs resume: no -s or -C, sandbox via -c, prompt at the end', () => {
  const a = codex.buildArgs({ prompt: 'hi', sessionId: 'abc', permission: 'auto' });
  assert.deepEqual(a.slice(0, 3), ['exec', 'resume', 'abc']);
  assert.ok(hasPair(a, '-c', 'sandbox_mode="workspace-write"'));
  assert.ok(!a.includes('-s') && !a.includes('-C'));
  assert.equal(a[a.length - 1], 'hi');
});

test('Safe auto uses native review, not the no-checks bypass', () => {
  assert.ok(hasPair(claude.buildArgs({ prompt: 'p', permission: 'smart' }), '--permission-mode', 'auto'));
  const cx = codex.buildArgs({ prompt: 'p', cwd: 'C:\\x', permission: 'smart' });
  // --approve-for-me CANNOT be combined with -s (a Codex error, seen live): same thing via settings instead.
  assert.ok(!cx.includes('--approve-for-me'));
  assert.ok(hasPair(cx, '-s', 'workspace-write'));
  assert.ok(hasPair(cx, '-c', 'approval_policy="on-request"'));
  assert.ok(hasPair(cx, '-c', 'approvals_reviewer="auto_review"'));
  const cr = codex.buildArgs({ prompt: 'p', sessionId: 's1', permission: 'smart' });
  assert.ok(hasPair(cr, '-c', 'approvals_reviewer="auto_review"') && hasPair(cr, '-c', 'sandbox_mode="workspace-write"'));
  assert.ok(!cr.includes('-s') && !cr.includes('--approve-for-me'));
  assert.ok(!cx.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(hasPair(agy.buildArgs({ prompt: 'p', permission: 'smart' }), '--mode', 'accept-edits'));
  assert.ok(!agy.buildArgs({ prompt: 'p', permission: 'smart' }).includes('--dangerously-skip-permissions'));
  assert.ok(hasPair(gemini.buildArgs({ prompt: 'p', permission: 'smart' }), '--approval-mode', 'auto_edit'));
  assert.deepEqual(cli.smartArgs('claude'), ['--permission-mode', 'auto']);
  assert.deepEqual(cli.smartArgs('codex'), ['--approve-for-me']);        // interactive terminal: the flag works on its own
  assert.deepEqual(cli.baseArgs('codex'), ['-c', 'allow_login_shell=false']);
  assert.deepEqual(cli.baseArgs('claude'), []);
  assert.deepEqual(cli.smartArgs('agy'), ['--mode', 'accept-edits']);
  assert.deepEqual(cli.smartArgs('gemini'), ['--approval-mode', 'auto_edit']);
  assert.deepEqual(cli.smartArgs('terminal'), []);
});

test('Plan stays read-only even when the preference is Safe auto', () => {
  const cx = codex.buildArgs({ prompt: 'p', cwd: 'C:\\x', permission: 'smart', mode: 'plan' });
  assert.ok(hasPair(cx, '-s', 'read-only'));
  assert.ok(!cx.includes('--approve-for-me'));
  assert.ok(!cx.some((x) => String(x).includes('approvals_reviewer')));
  assert.ok(hasPair(claude.buildArgs({ prompt: 'p', permission: 'smart', mode: 'plan' }), '--permission-mode', 'plan'));
});

test('Plan beats full for every adapter', () => {
  assert.ok(hasPair(claude.buildArgs({ prompt: 'p', mode: 'plan', permission: 'full' }), '--permission-mode', 'plan'));
  assert.ok(hasPair(codex.buildArgs({ prompt: 'p', cwd: 'C:\\x', mode: 'plan', permission: 'full' }), '-s', 'read-only'));
  const ag = agy.buildArgs({ prompt: 'p', mode: 'plan', permission: 'full' });
  assert.ok(hasPair(ag, '--mode', 'plan') && !ag.includes('--dangerously-skip-permissions'));
  assert.ok(hasPair(gemini.buildArgs({ prompt: 'p', mode: 'plan', permission: 'full' }), '--approval-mode', 'plan'));
});

test('Agent brief only in the first session', () => {
  assert.equal(common.withAgentBrief({ prompt: 'p', systemPrompt: 'S' }), '<agent-brief>\nS\n</agent-brief>\n\np');
  assert.equal(common.withAgentBrief({ prompt: 'p', systemPrompt: 'S', sessionId: 'x' }), 'p');
});

// ——— Helpers ———
test('shortPath: uppercase, mixed slashes, sibling folder, other drive', () => {
  assert.equal(common.shortPath('c:/users/DEV/app/src/a.js', 'C:\\Users\\dev\\app'), 'src/a.js');
  assert.equal(common.shortPath('C:\\Users\\dev\\apple\\b.js', 'C:\\Users\\dev\\app'), 'b.js');
  assert.equal(common.shortPath('D:\\x\\y.txt', 'C:\\Users'), 'y.txt');
  assert.equal(common.shortPath('C:\\Users\\dev\\app', 'C:\\Users\\dev\\app'), '');
  assert.equal(common.shortPath('', 'C:\\x'), '');
});

test('clip: exact limits', () => {
  assert.equal(common.clip('abcd', 4), 'abcd');
  assert.equal(common.clip('abcde', 4), 'abc…');
  assert.equal(common.clip('abc', 4), 'abc');
  assert.equal(common.clip('abc', 0), '');
  assert.equal(common.clip('abc', 1), '…');
  assert.equal(common.clip(null, 3), '');
});

test('toolOutputText: string, mixed array, empty, too long', () => {
  assert.equal(common.toolOutputText('x'), 'x');
  assert.equal(common.toolOutputText([{ type: 'text', text: 'a' }, null, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb');
  assert.equal(common.toolOutputText(undefined), '');
  assert.equal(Array.from(common.toolOutputText('z'.repeat(5000))).length, 4000);
});

test('All parsers: junk lines ignored and idempotent finish', () => {
  for (const ad of [claude, codex, agy, gemini]) {
    const ev = [];
    const p = ad.createParser((e) => ev.push(e), { cwd: CWD });
    for (const g of ['not json', '', '{"type":"weird"}', 'null', '[]', '0', '"test"', '{"type":"assistant","message":null}', '{"type":"user","message":{"content":[null]}}', '{"event":"step_update","step_update":null}']) p.feedLine(g);
    assert.equal(ev.length, 0, ad.id + ' must not emit anything before finish');
    p.finish(0);
    assertTerminal(p, ev);
  }
});

test('Two parsers together stay independent', () => {
  const a = [];
  const b = [];
  const pa = codex.createParser((e) => a.push(e));
  const pb = codex.createParser((e) => b.push(e));
  pa.feedLine('{"type":"thread.started","thread_id":"A"}');
  pb.feedLine('{"type":"thread.started","thread_id":"B"}');
  pa.feedLine('{"type":"turn.failed","error":{"message":"x"}}');
  pa.finish(0);
  pb.finish(0);
  assert.deepEqual([a[a.length - 1].sessionId, a[a.length - 1].ok], ['A', false]);
  assert.deepEqual([b[b.length - 1].sessionId, b[b.length - 1].ok], ['B', true]);
});

test('Codex: always without a PowerShell profile (it doesn\'t load inside the Windows sandbox and blocks commands)', () => {
  for (const permission of ['ask', 'auto', 'smart', 'full']) {
    for (const sessionId of [undefined, 'abc']) {
      const a = codex.buildArgs({ prompt: 'p', cwd: 'C:\\x', permission, sessionId });
      assert.ok(hasPair(a, '-c', 'allow_login_shell=false'), `${permission}/${sessionId}`);
      assert.equal(a[a.length - 1], 'p', 'the prompt stays last');
    }
  }
});
