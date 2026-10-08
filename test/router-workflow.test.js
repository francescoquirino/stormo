'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pythonCandidates } = require('../src/main/voice');
test('BC workflow and dispatcher: isolated behavioral checks, no calls to providers', () => {
  const r = spawnSync(pythonCandidates()[0], [path.join(__dirname, 'router-workflow.test.py')], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || '') + (r.error || ''));
});
