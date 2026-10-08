'use strict';
// Model router in the providers' instructions files: adds, doesn't break the rest, backs up, removes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const inj = require('../src/main/router-inject');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stormo-inj-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const env = {};
const skill = path.join(__dirname, '..', 'assets', 'router', 'SKILL.md');

test('adds the block without touching what was there, and makes a backup', (t) => {
  const h = home(t);
  const file = path.join(h, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# My rules\n\nDo not delete anything.\n');
  const backupDir = path.join(h, 'bk');
  const r = inj.apply({ home: h, ids: ['claude'], backupDir, bundledSkill: skill, env });
  assert.equal(r.results[0].ok, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.startsWith('# My rules\n\nDo not delete anything.\n\n' + inj.START));
  assert.equal(fs.readdirSync(backupDir).length, 1);
  assert.equal(fs.readFileSync(r.results[0].backup, 'utf8'), '# My rules\n\nDo not delete anything.\n');
});

test('twice in a row = a single block, no extra write', (t) => {
  const h = home(t);
  const backupDir = path.join(h, 'bk');
  inj.apply({ home: h, ids: ['codex', 'gemini'], backupDir, env });
  const r2 = inj.apply({ home: h, ids: ['codex', 'gemini'], backupDir, env });
  assert.deepEqual(r2.results.map((x) => x.changed), [false, false]);
  const text = fs.readFileSync(path.join(h, '.codex', 'AGENTS.md'), 'utf8');
  assert.equal(text.split(inj.START).length, 2);
});

test('removing it restores the file exactly as it was', (t) => {
  const h = home(t);
  const file = path.join(h, '.gemini', 'GEMINI.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = 'Rule 1\nRule 2\n';
  fs.writeFileSync(file, before);
  inj.apply({ home: h, ids: ['gemini'], backupDir: path.join(h, 'bk'), env });
  inj.remove({ home: h, env });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a skill already present (maybe customized) is not overwritten', (t) => {
  const h = home(t);
  const dest = inj.skillPath(h);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'my skill');
  const r = inj.apply({ home: h, ids: ['claude'], backupDir: path.join(h, 'bk'), bundledSkill: skill, env });
  assert.equal(r.skill.installed, false);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'my skill');
});

test('Cursor has no global file: it is skipped and says so', (t) => {
  const h = home(t);
  const r = inj.apply({ home: h, ids: ['cursor'], backupDir: path.join(h, 'bk'), env });
  assert.equal(r.results[0].skipped, true);
  assert.match(r.results[0].why, /Cursor/);
});

test('CODEX_HOME and COPILOT_HOME move the files', (t) => {
  const h = home(t);
  const st = inj.status({ home: h, env: { CODEX_HOME: path.join(h, 'cx'), COPILOT_HOME: path.join(h, 'cp') } });
  assert.equal(st.find((x) => x.id === 'codex').file, path.join(h, 'cx', 'AGENTS.md'));
  assert.equal(st.find((x) => x.id === 'copilot').file, path.join(h, 'cp', 'copilot-instructions.md'));
});

test('removing only some providers leaves the others untouched', (t) => {
  const h = home(t);
  inj.apply({ home: h, ids: ['claude', 'codex'], backupDir: path.join(h, 'bk'), env });
  inj.remove({ home: h, ids: ['codex'], env });
  assert.ok(fs.readFileSync(path.join(h, '.claude', 'CLAUDE.md'), 'utf8').includes(inj.START));
  assert.ok(!fs.readFileSync(path.join(h, '.codex', 'AGENTS.md'), 'utf8').includes(inj.START));
});
