'use strict';
// Auto Mode on the program side: the prompt with the skill, permissions, environment variables and the handoff to Claude.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const router = require('../src/main/router');
const claude = require('../src/main/engines/claude');
const codex = require('../src/main/engines/codex');
const { toolLabel } = require('../src/main/engines/common');
const { runEnvOverrides } = require('../src/main/engines');

const SKILL = '---\nname: model-router\ndescription: prova\n---\n\n# Model Router\n\nregola numero uno\n';

function setup(t, skill = SKILL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-auto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'model-router'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'skills', 'model-router', 'SKILL.md'), skill);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'route-ask'), '#!/usr/bin/env python3\n');
  return { dir, home, dataDir: path.join(dir, 'data'), python: 'C:/Python312/python.exe' };
}
const prep = (mode, s) => router.prepare(mode, { home: s.home, dataDir: s.dataDir, python: s.python });

test('AUTO MODE: the skill loads without front matter, the command is exact and nothing is blocked', (t) => {
  delete process.env.STORMO_ROUTE_ASK;
  const s = setup(t);
  const r = prep('auto', s);
  assert.equal(r.ok, true, r.error);
  const text = fs.readFileSync(r.promptFile, 'utf8');
  assert.ok(text.includes('# Model Router') && text.includes('regola numero uno'));
  assert.ok(!text.includes('description: prova'), 'the front matter does not go into the prompt');
  const ra = path.join(s.home, '.local', 'bin', 'route-ask').split(path.sep).join('/');
  assert.ok(text.includes(`"C:/Python312/python.exe" "${ra}"`), 'exact prefix with absolute paths');
  assert.match(text, /AUTO MODE/);
  assert.match(text, /No lock/);
  assert.match(text, /do not invoke it with the Skill tool/);
  assert.match(text, /Every coding request, even a short one, goes through the router/);
  assert.match(text, /Answer directly, WITHOUT running route-ask, to greetings/);
  assert.match(text, /Do not delegate greetings or conversation to C/);
  assert.ok(!text.includes('SEMPRE: ogni messaggio'));
  assert.match(text, /empty output is not finished work/);
  assert.equal(r.env.ROUTE_ONLY_TIER, 'auto');
  assert.equal(r.env.ROUTE_WORK_CLASS, 'auto');
  assert.equal(r.env.ROUTE_TIER_LOCK, '1');
  assert.equal(r.env.BASH_DEFAULT_TIMEOUT_MS, '600000');
  assert.equal(r.env.BASH_MAX_TIMEOUT_MS, '600000');
  assert.equal(r.allowedTools[0], `Bash("C:/Python312/python.exe" "${ra}" *)`);
  assert.equal(r.allowedTools[1], `Bash(C:/Python312/python.exe ${ra} *)`, 'even unquoted (paths with no spaces)');
});

for (const [mode, tier] of [['high', 'A'], ['medium', 'B'], ['low', 'C']]) {
  test(`${mode.toUpperCase()} MODE: the router is locked to tier ${tier} (environment and rules)`, (t) => {
    delete process.env.STORMO_ROUTE_ASK;
    const s = setup(t);
    const r = prep(mode, s);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.env.ROUTE_ONLY_TIER, tier);
    assert.equal(r.env.ROUTE_WORK_CLASS, tier);
    const text = fs.readFileSync(r.promptFile, 'utf8');
    assert.match(text, new RegExp(`${mode.toUpperCase()} MODE`));
    assert.match(text, new RegExp(`LOCKED to tier ${tier}`));
    assert.match(text, new RegExp(`ROUTE_ONLY_TIER=${tier}`));
    assert.match(text, /Never quietly do the work/);
  });
}

test('the skill is reread on every request: a change gives a new file, otherwise it stays the same', (t) => {
  delete process.env.STORMO_ROUTE_ASK;
  const s = setup(t);
  const a = prep('auto', s);
  const again = prep('auto', s);
  assert.equal(again.promptFile, a.promptFile);
  fs.writeFileSync(path.join(s.home, '.claude', 'skills', 'model-router', 'SKILL.md'), SKILL + '\nregola numero due\n');
  const b = prep('auto', s);
  assert.notEqual(b.promptFile, a.promptFile);
  assert.ok(fs.readFileSync(b.promptFile, 'utf8').includes('regola numero due'));
  assert.ok(fs.existsSync(a.promptFile), 'the old file is not touched while someone is reading it');
});

test('old prompt files get cleaned up (at most 12 remain)', (t) => {
  delete process.env.STORMO_ROUTE_ASK;
  const s = setup(t);
  for (let i = 0; i < 16; i++) {
    fs.writeFileSync(path.join(s.home, '.claude', 'skills', 'model-router', 'SKILL.md'), SKILL + `\nversione ${i}\n`);
    assert.equal(prep('auto', s).ok, true);
  }
  const left = fs.readdirSync(s.dataDir).filter((n) => /^auto-.*\.md$/.test(n));
  assert.ok(left.length <= 12, `${left.length} remaining`);
});

test('clear errors: unknown mode, missing skill, missing router', (t) => {
  delete process.env.STORMO_ROUTE_ASK;
  const s = setup(t);
  assert.match(prep('turbo', s).error, /unknown mode/);
  assert.equal(router.prepare('auto', { home: s.home, python: s.python }).ok, false, 'missing data folder');
  fs.rmSync(path.join(s.home, '.local', 'bin', 'route-ask'));
  assert.match(prep('auto', s).error, /missing router/);
  fs.rmSync(path.join(s.home, '.claude', 'skills', 'model-router', 'SKILL.md'));
  const r = prep('auto', s);
  assert.equal(r.ok, false);
  assert.match(r.error, /missing model-router skill/);
});

test('the menu\'s labels and tiers in the UI match the ones in main', async () => {
  const { ROUTER_MODES, routerMode } = await import(pathToFileURL(path.join(__dirname, '..', 'renderer', 'js', 'router-modes.js')).href);
  assert.deepEqual(ROUTER_MODES.map((m) => m.id), Object.keys(router.MODES));
  for (const m of ROUTER_MODES) {
    assert.equal(m.label, router.MODES[m.id].label);
    assert.equal(m.tier, router.MODES[m.id].tier);
    assert.equal(m.work, router.MODES[m.id].work);
  }
  assert.deepEqual(ROUTER_MODES.map((m) => m.label), ['AUTO MODE', 'HIGH MODE', 'MEDIUM MODE', 'LOW MODE', 'BC MODE']);
  assert.equal(routerMode('inesistente').id, 'auto', 'an unknown value falls back to AUTO');
});

test('BC MODE: C develops, a single B reviewer, two returns and real tests required', (t) => {
  const r = prep('bc', setup(t));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.env.ROUTE_ONLY_TIER, 'auto');
  assert.equal(r.env.ROUTE_WORK_CLASS, 'BC');
  const text = fs.readFileSync(r.promptFile, 'utf8');
  assert.match(text, /ONE SINGLE B reviewer/);
  assert.match(text, /At most two returns to C/);
  assert.match(text, /real tests/);
});

test('Claude: the system prompt from a file goes before --allowedTools, which stays last; no model forced', () => {
  const args = claude.buildArgs({ prompt: 'hi', permission: 'smart', mode: 'agent', appendSystemPromptFile: 'C:/x/auto-1.md', allowedTools: ['Bash(a *)', 'Bash(b *)'] });
  const f = args.indexOf('--append-system-prompt-file');
  const a = args.indexOf('--allowedTools');
  assert.ok(f !== -1 && a !== -1 && f < a);
  assert.equal(args[f + 1], 'C:/x/auto-1.md');
  assert.equal(args[args.indexOf('--system-prompt-snapshot') + 1], 'on');
  assert.deepEqual(args.slice(a), ['--allowedTools', 'Bash(a *)', 'Bash(b *)']);
  assert.ok(!args.includes('--model'), 'Auto Mode uses Claude\'s default model');
});

test('fixed director: policy only on the first turn, same session and no duplicate', t => {
  const s = setup(t);
  const prep = router.prepare('bc', s);
  const opts = { engine: 'codex', routerEngine: 'codex', prompt: 'continua' };
  const lead = { ok: true, engine: 'codex', model: 'gpt-6.1-sol', effort: 'medium' };
  const r = router.leaderRunOptions(opts, prep, lead);
  assert.equal(r.engine, 'codex'); assert.equal(r.sessionId, null);
  assert.equal(r.prompt, 'continua');
  assert.equal(r.env.ROUTE_WORK_CLASS, 'BC');
  const args = codex.buildArgs({ ...r, cwd: s.dir, permission: 'smart' });
  assert.equal(args.at(-1), '-', 'long prompt via stdin');
  const prompt = codex.buildPrompt(r);
  assert.match(prompt, /ONE SINGLE B reviewer/); assert.match(prompt, /continua/);
  const resumed = router.leaderRunOptions(opts, prep, { ...lead, initialized:true, sessionId:'same-session', mode:'bc', policyVersion:router.POLICY_VERSION });
  assert.equal(resumed.sessionId, 'same-session'); assert.equal(resumed.appendSystemPromptFile, null);
  assert.equal(codex.buildPrompt(resumed), 'continua'); assert.equal(codex.buildArgs({...resumed,cwd:s.dir}).at(-1), '-');
  const changed = router.leaderRunOptions(opts, router.prepare('low', {...s,instructions:false}),
    {...lead, initialized:true, sessionId:'same-session', mode:'bc', policyVersion:router.POLICY_VERSION});
  assert.equal(changed.sessionId, 'same-session'); assert.equal(changed.appendSystemPromptFile, null);
  assert.match(changed.prompt, /Mode updated: LOW MODE/);
  assert.throws(() => router.leaderRunOptions(opts, prep,
    { ok:true, engine:'claude', model:'claude-sonnet-5-5', effort:'medium' }), /Director.*locked in/);
  assert.equal(router.validLeader({ok:true,engine:'codex',model:'gpt-6-astra',effort:'medium'}),false);
});

test('existing chat: new rules in a short update, without duplicating the skill or changing session', t => {
  const s=setup(t); const p=router.prepare('auto', {...s,instructions:false});
  const old={ok:true,engine:'claude',model:'claude-sonnet-5-5',effort:'medium',sessionId:'keep-id',initialized:true,mode:'auto'};
  const r=router.leaderRunOptions({engine:'claude',prompt:'hi',requestKind:'conversation'},p,old);
  assert.equal(r.sessionId,'keep-id');assert.equal(r.appendSystemPromptFile,null);
  assert.match(r.prompt,/Updated rules/);assert.match(r.prompt,/without running the router/);
  const next=router.leaderRunOptions({engine:'claude',prompt:'grazie',requestKind:'conversation'},p,{...old,policyVersion:router.POLICY_VERSION});
  assert.ok(!next.prompt.includes('Updated rules'));
});

test('Router: a call to route-ask shows up as "Router" with just the options; reading the file does not', () => {
  const call = (command) => toolLabel('Bash', { command }, 'C:/w');
  assert.deepEqual(call('"C:/Users/dev/AppData/Local/Programs/Python/Python312/python.exe" "C:/Users/dev/.local/bin/route-ask" -c hard --code -f task.md'),
    { verb: 'Router', arg: '-c hard --code -f task.md' });
  assert.deepEqual(call('python C:/Users/dev/.local/bin/route-ask --tiers'), { verb: 'Router', arg: '--tiers' });
  assert.equal(call('cat ~/.local/bin/route-ask').verb, 'Run');
  assert.equal(call('grep -n MODELS route-ask').verb, 'Run');
  assert.equal(call('npm test').verb, 'Run');
  assert.equal(toolLabel('PowerShell', { command: 'python "C:/r/route-ask" -c easy x' }, 'C:/w').verb, 'Router');
});

test('a single call\'s variables override the executable\'s own', () => {
  assert.deepEqual(runEnvOverrides({ env: { A: '1', B: '2' } }, { env: { B: '3', ROUTE_ONLY_TIER: 'A' } }), { A: '1', B: '3', ROUTE_ONLY_TIER: 'A' });
  assert.deepEqual(runEnvOverrides({}, {}), {});
  assert.deepEqual(runEnvOverrides(undefined, { env: { X: 'y' } }), { X: 'y' });
});
