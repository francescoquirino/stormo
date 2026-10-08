'use strict';
// Manual QA check of an engine in headless mode: prints the normalized events and a summary.
// Usage: node tools/qa-engine.js --engine=claude --permission=smart --cwd=C:\folder --prompt="..." [--model=sonnet] [--effort=low] [--mode=agent]
//      [--router=auto|high|medium|low]  (Auto Mode: Claude with the model-router skill and the router locked to the tier)
require('../src/main/env').stripInheritedClaudeSession();
const fs = require('node:fs');
const cli = require('../src/main/cli');
const { startRun } = require('../src/main/engines');

const a = Object.fromEntries(process.argv.slice(2).map((x) => {
  const m = x.match(/^--([^=]+)=([\s\S]*)$/);
  return m ? [m[1], m[2]] : [x.replace(/^--/, ''), true];
}));
if (!a.engine || !a.cwd || !a.prompt) { console.error('servono --engine --cwd --prompt'); process.exit(2); }
const def = cli.getAgent(a.engine);
const exec = def && cli.resolveAgent(def);
if (!exec) { console.error('engine not found: ' + a.engine); process.exit(2); }
fs.mkdirSync(a.cwd, { recursive: true });

let auto = {};
if (a.router) {
  const prep = require('../src/main/router').prepare(String(a.router), { dataDir: require('node:path').join(require('node:os').tmpdir(), 'stormo-auto') });
  if (!prep.ok) { console.error(prep.error); process.exit(2); }
  auto = { appendSystemPromptFile: prep.promptFile, env: prep.env, allowedTools: prep.allowedTools };
}

const t0 = Date.now();
const denied = [];
const tools = new Map();
const texts = [];
const errors = [];
const run = startRun({
  engine: a.engine, prompt: a.prompt, cwd: a.cwd, permission: a.permission || 'smart', mode: a.mode || 'agent',
  model: a.model || null, effort: a.effort || null, sessionId: a.session || null,
  allowedTools: [...(a.allow ? String(a.allow).split(';;') : []), ...(auto.allowedTools || [])],
  appendSystemPromptFile: auto.appendSystemPromptFile, env: auto.env,
  exec: { file: exec.file, prefixArgs: exec.prefixArgs, env: exec.env },
}, (e) => {
  const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's ';
  if (e.type === 'tool') {
    const t = tools.get(e.id) || { verb: '', arg: '', status: '', output: '' };
    Object.assign(t, Object.fromEntries(Object.entries(e).filter(([k, v]) => v !== undefined && v !== '' && k !== 'type' && k !== 'raw')));
    tools.set(e.id, t);
    if (e.status !== 'running') console.log(s + `tool   ${t.verb} ${String(t.arg).slice(0, 90)} -> ${e.status}`);
  } else if (e.type === 'denied') { denied.push(e); console.log(s + `DENIED ${e.label}`); }
  else if (e.type === 'text') { texts.push(e.text); console.log(s + 'text   ' + e.text.replace(/\s+/g, ' ').slice(0, 160)); }
  else if (e.type === 'error') { errors.push(e.message); console.log(s + 'ERROR  ' + e.message); }
  else if (e.type === 'notice') console.log(s + 'notice ' + e.message.slice(0, 100));
  else if (e.type === 'start') console.log(s + 'start  ' + (e.sessionId || '') + ' ' + (e.model || ''));
  else if (e.type === 'done') {
    console.log(s + `DONE ok=${e.ok}`);
    console.log('\n--- riassunto ---');
    console.log('tools:   ', [...tools.values()].map((t) => `${t.verb}:${t.status}`).join(' | ') || '(none)');
    console.log('denied:  ', denied.map((d) => d.label).join(' | ') || '(none)');
    console.log('errors:  ', errors.join(' | ') || '(none)');
    process.exit(e.ok ? 0 : 1);
  }
});
setTimeout(() => { console.log('TIMEOUT: stopping the test'); run.cancel(); setTimeout(() => process.exit(3), 5000); }, (+a.timeout || 240) * 1000);
