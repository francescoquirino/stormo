'use strict';
// Lifecycle of terminals (PtyManager) with a fake node-pty: no real process.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PtyManager } = require('../src/main/pty');

function fakePty() {
  const procs = [];
  return {
    procs,
    spawn() {
      const p = {
        handlers: {}, killed: false, written: [], pid: 100 + procs.length,
        onData(cb) { this.handlers.data = cb; },
        onExit(cb) { this.handlers.exit = cb; },
        write(d) { this.written.push(d); }, resize() {}, kill() { this.killed = true; },
      };
      procs.push(p);
      return p;
    },
  };
}

function make(t) {
  const sent = [];
  const fp = fakePty();
  const m = new PtyManager((...a) => sent.push(a), fp);
  t.after(() => m.killAll());
  return { m, fp, sent, of: (ch) => sent.filter((a) => a[0] === ch) };
}

test('restart: the old process\'s late exit does not mark the new terminal "exited"', (t) => {
  const { m, fp, of } = make(t);
  m.spawn({ id: 'p1', file: 'x', cwd: '.', env: {} });
  m.spawn({ id: 'p1', file: 'x', cwd: '.', env: {} });      // restart: the first one gets killed
  assert.equal(fp.procs[0].killed, true);
  fp.procs[0].handlers.exit({ exitCode: 1 });               // its "exit" arrives after the new one has started
  assert.equal(of('pty:exit').length, 0, 'no pty:exit for a replaced process');
  assert.equal(of('pty:state').filter((a) => a[2] === 'exited').length, 0, 'no "exited" state for the new one');
  fp.procs[1].handlers.exit({ exitCode: 0 });
  assert.equal(of('pty:exit').length, 1, 'the current process\'s real exit arrives');
});

test('closing a panel: the killed process\'s late exit does not reach the UI', (t) => {
  const { m, fp, of } = make(t);
  m.spawn({ id: 'p1', file: 'x', cwd: '.', env: {} });
  m.kill('p1');
  fp.procs[0].handlers.exit({ exitCode: 1 });
  assert.equal(of('pty:exit').length, 0);
});

test('normal exit: the last output arrives first, then pty:exit', (t) => {
  const { m, fp, sent } = make(t);
  m.spawn({ id: 'p1', file: 'x', cwd: '.', env: {} });
  fp.procs[0].handlers.data('last words');
  fp.procs[0].handlers.exit({ exitCode: 0 });
  const order = sent.map((a) => a[0]).filter((c) => c === 'pty:data' || c === 'pty:exit');
  assert.deepEqual(order, ['pty:data', 'pty:exit']);
});

test('writing to an unknown or already-closed id throws no errors', (t) => {
  const { m } = make(t);
  assert.doesNotThrow(() => m.write('none', 'x'));
  assert.doesNotThrow(() => m.resize('none', 80, 24));
  assert.doesNotThrow(() => m.kill('none'));
});
