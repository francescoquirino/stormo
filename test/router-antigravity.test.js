'use strict';
// Opus 5.5 and Sonnet 5.5 served by Antigravity: same tier as the native models, SEPARATE quota,
// low/medium/high version chosen by effort, "no shell commands" rule. No real model is launched:
// the router is loaded as a Python module and agy's launch is replaced by a function that records the arguments.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pythonCandidates } = require('../src/main/voice');

const ROUTE = process.env.STORMO_ROUTE_ASK || path.join(__dirname, '..', 'assets', 'router', 'route-ask');
const python = pythonCandidates()[0];
const skip = python && fs.existsSync(ROUTE) ? false : 'router or Python not available';

const SCRIPT = [
  'import importlib.machinery, importlib.util, json, os, sys, tempfile',
  'sys.path.insert(0, os.path.dirname(sys.argv[1]))',
  'loader = importlib.machinery.SourceFileLoader("ra", sys.argv[1])',
  'spec = importlib.util.spec_from_loader("ra", loader)',
  'ra = importlib.util.module_from_spec(spec)',
  'loader.exec_module(ra)',
  'from route_budget import effort_for',
  'captured = []',
  'def fake(cmd, log, out, err):',
  '    captured.append(cmd)',
  '    return 0',
  'ra.run_agy_watched = fake',
  'cfg = ra.load_config()',
  'cfg["agy_path"] = sys.executable',
  'model, effort, size = sys.argv[2], sys.argv[3], int(sys.argv[4])',
  'brief = tempfile.NamedTemporaryFile("w", suffix=".md", delete=False, encoding="utf-8")',
  'brief.write("TEST-TASK-MARKER " + "x" * size)',
  'brief.close()',
  'rc, err = ra.dispatch(cfg, model, brief.name, effort)',
  'os.unlink(brief.name)',
  'print(json.dumps({"rc": rc, "cmd": captured[0] if captured else None, "diet": {m: ra.gets_token_diet(m) for m in ra.MODELS},',
  '                  "effort_easy": effort_for(model, "easy"), "effort_medium": effort_for(model, "medium"), "effort_hard": effort_for(model, "hard"),',
  '                  "tier": ra.MODELS[model]["tier"], "account": ra.ACCOUNT[model], "label": ra.MODELS[model].get("label")}))',
].join('\n');

function homeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-agy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.route'));
  fs.writeFileSync(path.join(dir, '.route', 'claude-usage.json'), JSON.stringify({
    ts: Date.now() / 1000, windows: [{ label: 'session', percent: 10, resets: '' }, { label: 'week (all models)', percent: 10, resets: '' }] }));
  return dir;
}

function dispatchInfo(t, model, effort = 'medium', size = 10, { diet = false, env = {} } = {}) {
  const dir = homeDir(t);
  if (diet) {
    fs.writeFileSync(path.join(dir, '.route', 'token-diet.md'), '---\nname: token-diet\ndescription: x\n---\n\n# TEST TOKEN DIET\n\nshort rule\n');
  }
  const script = path.join(dir, 'probe.py');
  fs.writeFileSync(script, SCRIPT);
  const r = spawnSync(python, [script, ROUTE, model, effort, String(size)], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, HOME: dir, USERPROFILE: dir, PYTHONIOENCODING: 'utf-8', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

const modelOf = (cmd) => cmd[cmd.indexOf('--model') + 1];

for (const [model, base, tier, label] of [
  ['claude-opus-5-5-antigravity', 'claude-opus-5-5', 'A', 'Opus 5.5 (Antigravity)'],
  ['claude-sonnet-5-5-antigravity', 'claude-sonnet-5-5', 'B', 'Sonnet 5.5 (Antigravity)'],
]) {
  test(`${label}: tier ${tier}, separate "antigravity" account, name with the parenthesis`, { skip }, (t) => {
    const info = dispatchInfo(t, model);
    assert.equal(info.tier, tier);
    assert.equal(info.account, 'antigravity');
    assert.equal(info.label, label);
  });

  test(`${label}: Antigravity's low/medium/high version follows the effort`, { skip }, (t) => {
    for (const [effort, suffix] of [['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'high']]) {
      const info = dispatchInfo(t, model, effort);
      assert.equal(modelOf(info.cmd), `${base}-${suffix}`, `effort ${effort}`);
    }
  });

  test(`${label}: no shell commands (without it, Opus stayed silent), sandbox active, task intact`, { skip }, (t) => {
    const info = dispatchInfo(t, model);
    const prompt = info.cmd[info.cmd.indexOf('-p') + 1];
    assert.ok(prompt.startsWith('RULE: respond directly in text'), prompt.slice(0, 80));
    assert.ok(prompt.includes('TEST-TASK-MARKER'));
    assert.ok(info.cmd.includes('--sandbox'));
  });
}

test('long brief: on Windows agy gets the file path, on POSIX the text travels through argv, and the "no commands" rule still applies', { skip }, (t) => {
  const info = dispatchInfo(t, 'claude-sonnet-5-5-antigravity', 'medium', 40000);
  const prompt = info.cmd[info.cmd.indexOf('-p') + 1];
  assert.ok(prompt.startsWith('RULE: respond directly in text'));
  if (process.platform === 'win32') {
    assert.match(prompt, /Open the file located exactly at/);
    assert.ok(!prompt.includes('TEST-TASK-MARKER'), 'long text does not travel on the command line');
  } else {
    assert.ok(prompt.includes('TEST-TASK-MARKER'), 'long text travels on the command line on POSIX');
    assert.ok(prompt.length >= 40000, `prompt of ${prompt.length} characters, expected at least 40000`);
    assert.ok(!prompt.includes('Open the file located exactly at'), 'on POSIX there is no fallback to the file path');
  }
});

test("the effort chosen by the router: Opus (Antigravity) always medium like native Opus, Sonnet by difficulty", { skip }, (t) => {
  const opus = dispatchInfo(t, 'claude-opus-5-5-antigravity');
  assert.deepEqual([opus.effort_easy, opus.effort_medium, opus.effort_hard], ['medium', 'medium', 'medium']);
  const sonnet = dispatchInfo(t, 'claude-sonnet-5-5-antigravity');
  assert.deepEqual([sonnet.effort_easy, sonnet.effort_medium, sonnet.effort_hard], ['low', 'medium', 'high']);
});

test('token diet: Opus and Sonnet (Antigravity) get it ahead of the task, without front matter', { skip }, (t) => {
  for (const model of ['claude-opus-5-5-antigravity', 'claude-sonnet-5-5-antigravity']) {
    const info = dispatchInfo(t, model, 'medium', 10, { diet: true });
    const prompt = info.cmd[info.cmd.indexOf('-p') + 1];
    assert.ok(prompt.includes('# TEST TOKEN DIET') && prompt.includes('short rule'), model);
    assert.ok(!prompt.includes('description: x'), 'the front matter does not go into the brief');
    assert.ok(prompt.indexOf('TEST TOKEN DIET') < prompt.indexOf('TEST-TASK-MARKER'), 'the diet comes before the task');
    assert.ok(prompt.includes('TEST-TASK-MARKER'));
  }
});

test('token diet: without the file or with ROUTE_NO_TOKEN_DIET nothing is added', { skip }, (t) => {
  const none = dispatchInfo(t, 'claude-sonnet-5-5-antigravity');
  assert.ok(!none.cmd[none.cmd.indexOf('-p') + 1].includes('TEST TOKEN DIET'));
  const off = dispatchInfo(t, 'claude-sonnet-5-5-antigravity', 'medium', 10, { diet: true, env: { ROUTE_NO_TOKEN_DIET: '1' } });
  assert.ok(!off.cmd[off.cmd.indexOf('-p') + 1].includes('TEST TOKEN DIET'));
});

test('token diet: only Antigravity Opus and Sonnet, not the native Claude models or the other models', { skip }, (t) => {
  const info = dispatchInfo(t, 'claude-opus-5-5-antigravity');
  const yes = Object.entries(info.diet).filter(([, v]) => v).map(([m]) => m).sort();
  assert.deepEqual(yes, ['claude-opus-5-5-antigravity', 'claude-sonnet-5-5-antigravity']);
  assert.equal(info.diet['claude-opus-5-5'], false);
  assert.equal(info.diet['claude-sonnet-5-5'], false);
});
