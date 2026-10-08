'use strict';
// Gemini CLI: real error messages seen live (no account connected).

const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../src/main/engines/gemini');

const STDERR = 'Approval mode overridden to "default" because the current folder is not trusted.\n'
  + 'Please set an Auth method in your C:\\Users\\dev\\.gemini\\settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA\n';

function run(stderr, exitCode) {
  const events = [];
  const p = gemini.createParser((e) => events.push(e), { cwd: 'C:\\x' });
  p.feedStderr(stderr);
  p.finish(exitCode);
  return events;
}

test('no account: clear message about what to do, not Gemini\'s raw text', () => {
  const ev = run(STDERR, 41);
  const err = ev.find((e) => e.type === 'error');
  assert.match(err.message, /not connected to an account/);
  assert.match(err.message, /log in/);
  assert.ok(!/GEMINI_API_KEY/.test(err.message));
  assert.equal(ev[ev.length - 1].ok, false);
});

test('untrusted folder: a single notice, even if the line arrives in several chunks', () => {
  const events = [];
  const p = gemini.createParser((e) => events.push(e), {});
  const line = 'Approval mode overridden to "default" because the current folder is not trusted.\n';
  p.feedStderr(line.slice(0, 30));
  p.feedStderr(line.slice(30));
  p.feedStderr(line);
  p.finish(0);
  assert.equal(events.filter((e) => e.type === 'notice').length, 1);
  assert.match(events.find((e) => e.type === 'notice').message, /Trust/);
  assert.equal(events[events.length - 1].ok, true);
});

test('any other error: last useful lines, without the untrusted-folder line', () => {
  const m = gemini.friendlyGeminiError('Approval mode overridden to "default" because the current folder is not trusted.\nquota finita per oggi\n', 1);
  assert.equal(m, 'quota finita per oggi');
  assert.equal(gemini.friendlyGeminiError('', 7), 'Gemini CLI exited with code 7');
});
