'use strict';
// Git info for the thread bar (branch) and for the "Changes" button.

const { execFile } = require('node:child_process');

function git(cwd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

async function info(cwd) {
  if (!cwd) return { branch: null, changed: 0 };
  const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === null) return { branch: null, changed: 0 };
  const status = await git(cwd, ['status', '--porcelain']);
  const changed = status ? status.split(/\r?\n/).filter(Boolean).length : 0;
  return { branch: branch.trim(), changed };
}

async function changes(cwd) {
  if (!cwd) return { ok: false, text: '' };
  const status = await git(cwd, ['status', '--short']);
  if (status === null) return { ok: false, text: 'This folder is not a git repository.' };
  const stat = await git(cwd, ['diff', '--stat']);
  const diff = await git(cwd, ['diff', '--no-color'], 8000);
  return { ok: true, status: status.trim(), stat: (stat || '').trim(), diff: (diff || '').slice(0, 200000) };
}

module.exports = { info, changes };
