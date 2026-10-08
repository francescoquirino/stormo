'use strict';
// Recognizing "the agent is waiting for you" on real phrases seen in the panels.

const test = require('node:test');
const assert = require('node:assert/strict');
const { NEEDS_YOU_RE, stripAnsi } = require('../src/main/pty');

test('phrases asking for a response → needsYou', () => {
  for (const t of [
    'Do you trust the contents of this project?',          // Antigravity
    '> Yes, I trust this folder',                           // Claude Code
    '› 1. Trust and continue',                              // Codex
    'Enter to confirm · Esc to cancel',
    'Do you want to proceed?',
    'Would you like to run the following command?',
    'Allow execution of: npm test',
  ]) assert.ok(NEEDS_YOU_RE.test(t), t);
});

test('normal screens → no alert', () => {
  for (const t of ['Ask Codex to do anything', 'Try "fix lint errors"', 'PS C:\\Users\\dev> ', '⏵⏵ auto mode on (shift+tab to cycle)']) {
    assert.ok(!NEEDS_YOU_RE.test(t), t);
  }
});

test('stripAnsi removes colors and titles (OSC with BEL)', () => {
  assert.equal(stripAnsi('\x1b]0;C:\\WINDOWS\\cmd.exe\x07\x1b[31mhi\x1b[0m'), 'hi');
});
