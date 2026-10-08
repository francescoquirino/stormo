'use strict';
// List of models for the composer's dropdown menus, read from the CLIs themselves when possible.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const EFFORTS = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max'],
  agy: ['low', 'medium', 'high'],
  gemini: [],
};

// Claude Code's official aliases ("--model fable|opus|sonnet|haiku" = latest version).
const CLAUDE = [
  { id: '', label: 'Default' },
  { id: 'sonnet', label: 'Sonnet 5.5' },
  { id: 'opus', label: 'Opus 5.5' },
  { id: 'fable', label: 'Fable 5.1' },
  { id: 'haiku', label: 'Haiku 4.5' },
];

function codexModels() {
  const file = path.join(os.homedir(), '.codex', 'models_cache.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : (data.models || data.data || []);
    const out = list
      .map((m) => ({ id: m.slug || m.id, label: prettyCodex(m.slug || m.id), hint: m.description || '' }))
      .filter((m) => m.id && !/auto-review/.test(m.id));
    if (out.length) return [{ id: '', label: 'Default' }, ...out];
  } catch { /* cache missing */ }
  return [{ id: '', label: 'Default' }, { id: 'gpt-6-sol', label: 'GPT-6 Sol' }, { id: 'gpt-6-luna', label: 'GPT-6 Luna' }];
}

function prettyCodex(slug) {
  return String(slug)
    .replace(/^gpt-/i, 'GPT-')
    .replace(/-(astra|sol|luna|terra|reserve)$/i, (m, w) => ' ' + w[0].toUpperCase() + w.slice(1))
    .replace(/-latest$/, '');
}

let agyCache = null;
function agyModels(agyExe) {
  if (agyCache) return Promise.resolve(agyCache);
  const fallback = [
    { id: '', label: 'Default' },
    { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  ];
  if (!agyExe) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    execFile(agyExe, ['models'], { timeout: 20000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(fallback);
      const rows = String(stdout).split(/\r?\n/)
        .map((l) => l.split('\t'))
        .filter((p) => p.length >= 2 && /^[a-z0-9.-]+$/i.test(p[0].trim()))
        .map(([id, label]) => ({ id: id.trim(), label: label.trim() }));
      agyCache = rows.length ? [{ id: '', label: 'Default' }, ...rows] : fallback;
      resolve(agyCache);
    });
  });
}

async function list(engine, execPath) {
  if (engine === 'claude') return { models: CLAUDE, efforts: EFFORTS.claude };
  if (engine === 'codex') return { models: codexModels(), efforts: EFFORTS.codex };
  if (engine === 'agy') return { models: await agyModels(execPath), efforts: EFFORTS.agy };
  if (engine === 'gemini') return { models: [{ id: '', label: 'Default' }], efforts: [] };
  return { models: [{ id: '', label: 'Default' }], efforts: [] };
}

module.exports = { list };
