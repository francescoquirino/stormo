'use strict';
// Real CLI parsing and role locks, all dry runs in an isolated HOME: no subscription calls.
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
function home(t, percent = 10) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-roles-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.route'));
  fs.writeFileSync(path.join(dir, '.route', 'claude-usage.json'), JSON.stringify({ ts: Date.now()/1000,
    windows: [{ label: 'session', percent, resets: '' }, { label: 'week (all models)', percent, resets: '' }] }));
  return dir;
}
function route(dir, args, env = {}) {
  const clean = { ...process.env };
  for (const key of ['ROUTE_ONLY_TIER', 'ROUTE_TIER_LOCK', 'ROUTE_WORK_CLASS']) delete clean[key];
  const r = spawnSync(python, [ROUTE, ...args], { encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...clean, HOME: dir, USERPROFILE: dir, ...env } });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const picked = (s) => [...s.matchAll(/would pick (\S+) \(tier ([ABC]), class (\w+)\)/g)].map((m) => ({ model:m[1], tier:m[2] }));

test('exact catalog: Opus A; Sonnet, Sol and Haiku (reserve) B; Luna and GLM Flash C; Opus and Sonnet (Antigravity) before the native ones', {skip}, t => {
  const r = route(home(t), ['--tiers']);
  assert.equal(r.code, 0, r.err);
  const models = [...r.out.matchAll(/^   (\S+)\s+(claude|openai|zai|antigravity) /gm)].map(m => m[1]);
  assert.deepEqual(models, ['claude-opus-5-5-antigravity','claude-opus-5-5','claude-sonnet-5-5-antigravity','claude-sonnet-5-5','gpt-6.1-sol','claude-haiku-5-5','glm-5.3-flash','gpt-6-luna']);
  assert.match(r.out, /Opus 5\.5 \(Antigravity\)/);
  assert.match(r.out, /Sonnet 5\.5 \(Antigravity\)/);
  assert.ok(!/gemini|glm-5\.3(?!-flash)|astra|opus-4-8|gpt-6-sol/.test(r.out));
});
for (const cls of ['A','B','C','BC']) {
  test(`work ${cls}: candidates for each role, no promotions`, {skip}, t => {
    const r = route(home(t), ['--work',cls,'--dry-run','x']);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(picked(r.err).map(m => m.tier), cls === 'BC' ? ['C','B'] : [cls]);
  });
}
for (const tier of ['A','B','C']) {
  test(`${tier} lock: legacy class and --code keep the role`, {skip}, t => {
    const h = home(t);
    for (const cls of ['easy','med','hard']) {
      const r = route(h, ['-c',cls,'--dry-run','x'], {ROUTE_ONLY_TIER:tier});
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(picked(r.err).map(m => m.tier), [tier]);
    }
    const r = route(h, ['--code','--dry-run','x'], {ROUTE_ONLY_TIER:tier});
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(picked(r.err).map(m => m.tier), [tier]);
  });
}
test('legacy easy/med/hard are C/B/A; automatic --code is BC', {skip}, t => {
  const h = home(t);
  for (const [cls,tier] of [['easy','C'],['med','B'],['hard','A']])
    assert.deepEqual(picked(route(h,['-c',cls,'--dry-run','x']).err).map(m => m.tier),[tier]);
  assert.deepEqual(picked(route(h,['--code','--dry-run','x']).err).map(m => m.tier),['C','B']);
});
test('removed models or models in the wrong role are refused', {skip}, t => {
  const h = home(t);
  for (const m of ['gemini-3.8-flash','gemini-3.1-pro','glm-5.3','gpt-6-astra','gpt-6-sol','claude-opus-4-8'])
    assert.equal(route(h,['-m',m,'--dry-run','x']).code, 2, m);
  for (const args of [ ['--work','A','-m','gpt-6.1-sol'], ['--work','BC','--writer','claude-sonnet-5-5'],
    ['--work','BC','--reviewer','gpt-6-luna'], ['--work','B','--planner','claude-opus-5-5'], ['--work','C','--review'] ])
    assert.equal(route(h,[...args,'--dry-run','x']).code, 2, args.join(' '));
});
test('BC preferences: Flash develops, Sol is the sole reviewer', {skip}, t => {
  const r = route(home(t), ['--work','BC','--writer','glm-5.3-flash','--reviewer','gpt-6.1-sol','--dry-run','x']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(picked(r.err).map(m => m.model),['glm-5.3-flash','gpt-6.1-sol']);
});
test('work imposed by the app cannot be changed with --work, -m or --only-tier', {skip}, t => {
  const h = home(t);
  for (const work of ['A','B','C','BC']) {
    const env = {ROUTE_WORK_CLASS:work,ROUTE_ONLY_TIER:work==='BC'?'auto':work,ROUTE_TIER_LOCK:'1'};
    const allowed = route(h,['--dry-run','x'],env);
    assert.equal(allowed.code,0,allowed.err);
    for (const other of ['A','B','C','BC'].filter(m => m!==work)) {
      const r = route(h,['--work',other,'--dry-run','x'],env);
      assert.equal(r.code,2); assert.match(r.err,/menu/);
    }
    if(work!=='BC') assert.equal(route(h,['--only-tier','AUTO','--dry-run','x'],env).code,2);
    else assert.equal(route(h,['--only-tier','A','--dry-run','x'],env).code,2);
  }
});
test('a lock without the app can be changed explicitly, never with invalid values', {skip}, t => {
  const h=home(t);
  assert.equal(picked(route(h,['--only-tier','B','--dry-run','x'],{ROUTE_ONLY_TIER:'A'}).err)[0].tier,'B');
  assert.equal(route(h,['--dry-run','x'],{ROUTE_ONLY_TIER:'HIGH'}).code,2);
  assert.equal(route(h,['--dry-run','x'],{ROUTE_WORK_CLASS:'bad'}).code,2);
});
test('native Opus exhausted: A falls back to Opus (Antigravity), separate quota', {skip}, t => {
  const r=route(home(t,97),['--work','A','--dry-run','x']);
  assert.equal(r.code,0,r.err); assert.deepEqual(picked(r.err).map(m => m.model), ['claude-opus-5-5-antigravity']);
});
test('quota of every Opus exhausted: A stops, no fallback to B', {skip}, t => {
  const h=home(t,97);
  const rows=Array.from({length:100},()=>JSON.stringify({ts:Date.now()/1000,event:'dispatch',account:'antigravity',model:'claude-opus-5-5-antigravity',class:'hard',status:0,role:'ask'}));
  fs.writeFileSync(path.join(h,'.route','ledger.jsonl'),rows.join('\n')+'\n');
  const r=route(h,['--work','A','--dry-run','x']);
  assert.equal(r.code,1); assert.equal(picked(r.err).length,0); assert.match(r.err,/tier A/);
  assert.match(r.err,/antigravity 5h: 100\/100 exhausted/);
});
test('an Antigravity model cannot be the coordinator (only Claude or Codex lead a session)', {skip}, t => {
  const r=route(home(t,100),['--leader-json']);
  assert.equal(r.code,0,r.err);
  const leader=JSON.parse(r.out);
  assert.ok(['claude','codex'].includes(leader.engine)); assert.ok(!/antigravity/.test(leader.model));
});
test('BC cannot start with a lock on a single tier', {skip}, t => {
  const h=home(t);
  for(const tier of ['A','B','C']) assert.equal(route(h,['--work','BC','--only-tier',tier,'--dry-run','x']).code,2);
});

test('coordinator picks Codex when Claude is exhausted', {skip}, t => {
  const r=route(home(t,100),['--leader-json']);
  assert.equal(r.code,0,r.err);
  const leader=JSON.parse(r.out);
  assert.equal(leader.engine,'codex'); assert.equal(leader.model,'gpt-6.1-sol');
  assert.equal(leader.effort,'medium');
});
