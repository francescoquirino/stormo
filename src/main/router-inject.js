'use strict';
// Model router given as global instructions to the providers (only after the user's consent).
// Each CLI has its own "user" instructions file: Stormo adds a marked block to it, makes a backup
// before touching it, and removes it when consent is revoked. The rest of the file is never changed.

const fs = require('node:fs');
const path = require('node:path');

const START = '<!-- stormo:model-router:start -->';
const END = '<!-- stormo:model-router:end -->';

// Where each CLI reads from (per each one's official docs, verified live).
function targets(home, env = process.env) {
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const copilotHome = env.COPILOT_HOME || path.join(home, '.copilot');
  const grokHome = env.GROK_HOME || path.join(home, '.grok');
  return [
    { id: 'claude', name: 'Claude Code', also: 'also GLM (z.ai), which runs through Claude Code', clis: ['claude', 'glm'],
      file: path.join(home, '.claude', 'CLAUDE.md') },
    { id: 'codex', name: 'Codex', clis: ['codex'], file: path.join(codexHome, 'AGENTS.md') },
    { id: 'gemini', name: 'Gemini CLI and Antigravity', also: 'they share this file', clis: ['gemini', 'agy'],
      file: path.join(home, '.gemini', 'GEMINI.md') },
    { id: 'copilot', name: 'GitHub Copilot CLI', clis: ['copilot'], file: path.join(copilotHome, 'copilot-instructions.md') },
    { id: 'grok', name: 'Grok', clis: ['grok'], file: path.join(grokHome, 'AGENTS.md') },
    { id: 'cursor', name: 'Cursor Agent', clis: ['cursor'], file: null,
      why: 'Cursor has no global instructions file: its "User Rules" live inside Cursor\'s settings and must be pasted by hand.' },
  ];
}

function skillPath(home) { return path.join(home, '.claude', 'skills', 'model-router', 'SKILL.md'); }

function blockText(home) {
  const skill = skillPath(home).replace(home, '~');
  return [
    START,
    '## Model router (added by Stormo)',
    '',
    'For coding work that can be delegated (code drafts, routine code, long reads, summaries, reviews)',
    'use the model router `route-ask` instead of doing everything yourself: it picks the right model among',
    'the available subscriptions and respects their quotas.',
    '',
    '- `route-ask --status` shows models and quotas before a big job;',
    '- `route-ask --work C -f brief.md` routine code; `--work B` complex code or review;',
    '  `--work A` design only; `--work BC` C writes and one B reviews;',
    '- put absolute file paths in the brief and ask for short answers; then read, verify and apply the result yourself.',
    '',
    `The full rules are in the skill \`${skill}\`: read it before the first use.`,
    'Greetings, short questions and explanations: answer directly, without the router.',
    'To remove these lines: Stormo → Settings → Model router → Remove from providers.',
    END,
  ].join('\n');
}

const RE = new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n*`, 'g');

function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
function hasBlock(text) { return !!text && text.includes(START) && text.includes(END); }
function strip(text) { return text.replace(RE, '\n').replace(/\n{3,}$/, '\n'); }

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.stormo-tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function backup(file, backupDir, id) {
  const text = read(file);
  if (text === null) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(backupDir, `${id}-${path.basename(file)}.${stamp}.bak`);
  fs.writeFileSync(out, text);
  return out;
}

// Each provider's state: installed? file present? block already inside?
function status({ home, installed = {}, env }) {
  return targets(home, env).map((t) => {
    const text = t.file ? read(t.file) : null;
    return { id: t.id, name: t.name, also: t.also || '', why: t.why || '', file: t.file,
      installed: t.clis.some((c) => installed[c]), exists: text !== null, injected: hasBlock(text) };
  });
}

// The full skill goes in ~/.claude/skills: if it already exists (even customized) it is NOT overwritten.
function ensureSkill({ home, bundledSkill }) {
  const dest = skillPath(home);
  if (fs.existsSync(dest)) return { ok: true, installed: false, file: dest };
  if (!bundledSkill || !fs.existsSync(bundledSkill)) return { ok: false, error: 'router skill not found in the app package' };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(bundledSkill, dest);
  return { ok: true, installed: true, file: dest };
}

// Adds (or updates) the block in the chosen files. Only writes when needed: calling it repeatedly changes nothing.
function apply({ home, ids, backupDir, bundledSkill, env }) {
  const results = [];
  const block = blockText(home);
  for (const t of targets(home, env)) {
    if (!ids.includes(t.id)) continue;
    if (!t.file) { results.push({ id: t.id, ok: false, skipped: true, why: t.why }); continue; }
    try {
      const text = read(t.file);
      if (text !== null && hasBlock(text) && text.includes(block)) { results.push({ id: t.id, ok: true, changed: false, file: t.file }); continue; }
      const saved = text !== null && !hasBlock(text) ? backup(t.file, backupDir, t.id) : null;
      const base = text === null ? '' : strip(text).replace(/\s*$/, '');
      writeAtomic(t.file, (base ? base + '\n\n' : '') + block + '\n');
      results.push({ id: t.id, ok: true, changed: true, file: t.file, backup: saved });
    } catch (err) {
      results.push({ id: t.id, ok: false, file: t.file, error: err.message });
    }
  }
  const skill = ids.includes('claude') ? ensureSkill({ home, bundledSkill }) : null;
  return { results, skill };
}

// Removes the block from all files (or only the given ones). The rest of the file stays as it was.
function remove({ home, ids, env }) {
  const results = [];
  for (const t of targets(home, env)) {
    if (!t.file || (ids && !ids.includes(t.id))) continue;
    const text = read(t.file);
    if (!hasBlock(text)) continue;
    try {
      writeAtomic(t.file, strip(text).replace(/^\n+/, ''));
      results.push({ id: t.id, ok: true, file: t.file });
    } catch (err) {
      results.push({ id: t.id, ok: false, file: t.file, error: err.message });
    }
  }
  return { results };
}

module.exports = { targets, status, apply, remove, ensureSkill, blockText, skillPath, START, END };
