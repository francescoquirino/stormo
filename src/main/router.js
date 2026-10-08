'use strict';
// Auto Mode: prepares a (headless) Claude Code call with the model-router skill already loaded and the router
// locked to the chosen work (HIGH=A, MEDIUM=B, LOW=C, BC=C+one B, AUTO=picks). Only the mode NAME comes from the
// renderer: this module builds the prompt, permissions and environment variables, never the UI.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pythonCandidates } = require('./voice');
const { isWindowsShaped } = require('./engines/common');
const POLICY_VERSION = 'coding-conversation-v2';
const CONVERSATION_RULES = 'Updated rules: the model-router skill is already loaded and must be remembered. Answer directly, WITHOUT running route-ask, to greetings, small talk, general non-coding questions, translations, short explanations, status requests and questions about the rules or the models. For software design, writing/changing/fixing code, real debugging and review, use the router automatically in the chosen class. A greeting followed by a coding request, or a continuation of coding work, requires the router. If the message is ambiguous, ask for clarification directly. The director stays the same for this chat.';

// id, label and tier must stay the same as renderer/js/router-modes.js (checked by test/router.test.js).
const MODES = {
  auto: { label: 'AUTO MODE', tier: null, work: 'auto' },
  high: { label: 'HIGH MODE', tier: 'A', work: 'A' },
  medium: { label: 'MEDIUM MODE', tier: 'B', work: 'B' },
  low: { label: 'LOW MODE', tier: 'C', work: 'C' },
  bc: { label: 'BC MODE', tier: null, work: 'BC' },
};

const TIER_TEXT = {
  A: 'tier A (Opus 5.5: design only)',
  B: 'tier B (Sonnet 5.5 and GPT-6.1 Sol: complex code and review)',
  C: 'tier C (GPT-6 Luna and GLM-5.3 Flash: routine code)',
};
const BASH_TIMEOUT_MS = '600000'; // a router call can take many minutes
const KEEP_PROMPTS = 12;          // prompt files kept in the folder (they change when the skill changes)

// On Windows (or with a Python from a Windows-style path) backslashes become "/" and the command uses double quotes;
// on POSIX paths stay as-is and, if they contain characters the shell interprets, single quotes are used.
const slash = (p, windowsStyle = process.platform === 'win32') => (windowsStyle ? String(p).replace(/\\/g, '/') : String(p));
const SAFE_UNQUOTED = /^[\w./+:@%=,-]+$/;
const needsPosixQuotes = (s) => /[$`"'\\!]/.test(s);
function quoteArg(value, windowsStyle) {
  if (windowsStyle || !needsPosixQuotes(value)) return `"${value}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function skillFile(home) { return path.join(home, '.claude', 'skills', 'model-router', 'SKILL.md'); }
function routeAskFile(home) { return process.env.STORMO_ROUTE_ASK || path.join(home, '.local', 'bin', 'route-ask'); }

function stripFrontMatter(text) {
  return String(text).replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim();
}

function buildPrompt({ mode, command, skill }) {
  const m = MODES[mode];
  const lock = m.tier
    ? [
      `Current mode: **${m.label}**. The router is LOCKED to ${TIER_TEXT[m.tier]}: ROUTE_ONLY_TIER=${m.tier} is already set and any call to a model of another tier fails.`,
      `- Use --work ${m.work}. Always delegate only to models of that tier. A produces the design and splits the work into B/C/BC tasks; B builds the complex parts; C builds the routine ones. In HIGH, deliver the design; switching mode is needed to build it.`,
      `- If the whole tier ${m.tier} is exhausted or paused, explain it to the user and suggest another mode from the menu next to the prompt. Never quietly do the work with a model of another tier.`,
    ]
    : mode === 'bc' ? [
      `Current mode: **BC MODE**. ROUTE_WORK_CLASS=BC is already set. Use --work BC: C writes, ONE SINGLE B reviewer checks the same task. At most two returns to C with precise defects and fixes.`,
      '- The router enforces the limit. After two returns, minor defects are accepted with notes; with blocking defects the same B fixes it directly once. No second reviewer. Always verify the final code with real tests.',
    ] : [
      `Current mode: **${m.label}**. No lock: pick --work A to design, B for complex code, C for routine code or BC for C code with one B reviewer. Opus never writes the full code.`,
      '- Most tasks belong in C; use BC when a review is needed. Use A only when design is needed: the design must split the work into B/C/BC tasks, then run those tasks through the router.',
    ];
  return [
    '# Stormo — AUTO MODE (read before answering)',
    '',
    'You are the Claude Code or Codex director of Stormo "Auto Mode": a coding chat over the working folder where the user talks to you. '
      + 'In this mode you use the **model router** automatically for coding tasks: the user does NOT have to ask. '
      + 'The "model-router" skill is already loaded below (the same one Claude uses by hand): do not invoke it with the Skill tool. '
      + 'You answer the conversation and direct the coding: decide, delegate, verify and apply.',
    '',
    '## How to run the router',
    'Use EXACTLY this prefix (absolute paths, already verified), followed by the skill options: ' + command,
    'Permission for this command is already granted.',
    '- It can take many minutes: run it with the Bash tool and timeout 600000 (10 minutes).',
    '- Do not add shell variables ($VAR) or other chained commands on the same line: the permission covers only the router.',
    '',
    ...lock,
    '',
    '## How you work here',
    '- Every coding request, even a short one, goes through the router: do not call it "small" to write it yourself. Delegate first, then read the result, apply it and verify the real files.',
    '- ' + CONVERSATION_RULES,
    '- This applies in AUTO/HIGH/MEDIUM/LOW/BC. The menu changes the class of coding work; greetings and non-coding questions stay direct. --status, --tiers and --dry-run do not replace a generation when coding requires the router.',
    '- The router saves result.json and the final code: a model review is not a test run. After applying the code, run the necessary checks and report any remaining errors.',
    '- Fixed effort: Luna and GLM Flash max, Opus medium. Sonnet and Sol low/medium/high by difficulty, never above high. Use --difficulty easy|medium|hard for every B/BC task.',
    '- The router compares the real 5-hour and weekly quotas and prefers the least used provider in the same tier. It keeps the same B reviewer for the whole BC task.',
    '- In AUTO pick the right class for the coding work and use the router without the user asking. Do not delegate greetings or conversation to C. Mixed requests: answer the greeting and delegate the coding.',
    '- If the router exits without text, treat it as a failure: explain the problem or pick another candidate of the allowed tier. An empty output is not finished work.',
    '- Tell the user, simply and in their own language, what you did and which model did what (name and tier: the router prints them).',
    '- End with a short summary: verified / inferred / still to check.',
    '',
    '---',
    '',
    '# model-router skill (loaded by Stormo, same as ~/.claude/skills/model-router/SKILL.md)',
    '',
    skill,
    '',
  ].join('\n');
}

// The file name is a fingerprint of the content: a changed skill gives a new file, and anyone still
// reading the old one never sees it get rewritten halfway through.
function writePrompt(dir, text) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `auto-${crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)}.md`);
  if (!fs.existsSync(file)) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  }
  try {
    const old = fs.readdirSync(dir).filter((n) => /^auto-[0-9a-f]{12}\.md$/.test(n)).map((n) => path.join(dir, n))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).slice(KEEP_PROMPTS);
    for (const { f } of old) if (f !== file) fs.rmSync(f, { force: true });
  } catch { /* cleanup is optional */ }
  return file;
}

// opts: { dataDir (required), home, python } — home and python are for tests only.
function prepare(modeId, opts = {}) {
  if (!Object.hasOwn(MODES, modeId)) return { ok: false, error: `Auto Mode: unknown mode "${modeId}".` };
  const home = opts.home || os.homedir();
  if (!opts.dataDir) return { ok: false, error: 'Auto Mode: missing data folder.' };
  let skill;
  if (opts.instructions !== false) {
  try { skill = stripFrontMatter(fs.readFileSync(skillFile(home), 'utf8')); } catch {
    return { ok: false, error: `Auto Mode: missing model-router skill (${skillFile(home)}): the router can't start without it.` };
  }
  if (!skill) return { ok: false, error: 'Auto Mode: the model-router skill is empty.' };
  }
  const routeAsk = routeAskFile(home);
  if (!fs.existsSync(routeAsk)) return { ok: false, error: `Auto Mode: missing router (${routeAsk}).` };
  const python = opts.python || pythonCandidates()[0];
  if (!python) return { ok: false, error: 'Auto Mode: Python not found, but the router needs it (Python 3).' };

  const windowsStyle = process.platform === 'win32' || isWindowsShaped(python);
  const py = slash(python, windowsStyle);
  const ra = slash(routeAsk, windowsStyle);
  const command = `${quoteArg(py, windowsStyle)} ${quoteArg(ra, windowsStyle)}`;
  const unquotedOk = windowsStyle ? !/\s/.test(py + ra) : SAFE_UNQUOTED.test(py) && SAFE_UNQUOTED.test(ra);
  const promptFile = opts.instructions === false ? null : writePrompt(opts.dataDir, buildPrompt({ mode: modeId, command, skill }));
  // Only the router, with the exact prefix (even unquoted if the paths have no spaces): chained commands
  // that change anything stay denied (verified on Claude Code 2.1.285).
  const allowedTools = [`Bash(${command} *)`];
  if (unquotedOk) allowedTools.push(`Bash(${py} ${ra} *)`);
  return {
    ok: true, mode: modeId, label: MODES[modeId].label, promptFile, allowedTools,
    env: { ROUTE_ONLY_TIER: MODES[modeId].tier || 'auto', ROUTE_WORK_CLASS: MODES[modeId].work, ROUTE_TIER_LOCK: '1', BASH_DEFAULT_TIMEOUT_MS: BASH_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS: BASH_TIMEOUT_MS },
  };
}

function validLeader(value) {
  return value && value.ok === true && value.effort === 'medium'
    && ((value.engine === 'claude' && value.model === 'claude-sonnet-5-5')
      || (value.engine === 'codex' && value.model === 'gpt-6.1-sol'));
}

async function selectLeader(opts = {}) {
  const home = opts.home || os.homedir();
  const python = opts.python || pythonCandidates()[0];
  if (!python) return { ok: false, error: 'Python not available to read quotas.' };
  // Real probe only outside the test profile; the simulator doesn't use up subscriptions.
  if (String(process.env.STORMO_PROFILE || '').startsWith('qa-') && process.env.STORMO_QA_LEADER === 'claude')
    return { ok: true, engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' };
  return new Promise(resolve => {
    execFile(python, [routeAskFile(home), '--leader-json'], { windowsHide: true, timeout: 25000, encoding: 'utf8', maxBuffer: 65536 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: 'Could not read the router\'s quotas. Try again shortly.' });
      try {
        const leader = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        resolve(validLeader(leader) ? leader : { ok: false, error: leader.error || 'Invalid response from the router.' });
      } catch { resolve({ ok: false, error: 'The router did not return valid quotas.' }); }
    });
  });
}

function leaderRunOptions(opts, prep, leader) {
  if (!validLeader(leader)) throw new Error('Invalid coordinator');
  const sessionId = leader.sessionId || opts.routerSessions?.[leader.engine]
    || (opts.engine === leader.engine ? opts.sessionId : null) || null;
  if (opts.routerEngine && opts.routerEngine !== leader.engine) throw new Error('This chat\'s Director is already locked in. Open a new chat to change it.');
  const first = !sessionId || !leader.initialized;
  const changedMode = !first && leader.mode !== prep.mode;
  const update = !first && leader.policyVersion !== POLICY_VERSION ? CONVERSATION_RULES + '\n\n' : '';
  const direct = opts.requestKind === 'conversation' ? 'This message is conversation or a question: answer directly as the director, without running the router.\n\n' : '';
  return { engine: leader.engine, model: leader.model, effort: leader.effort, sessionId,
    appendSystemPromptFile: first ? prep.promptFile : null, systemPromptSnapshot: 'on', promptStdin: true, env: prep.env,
    prompt: update + (changedMode ? `Mode updated: ${prep.label}. For coding use --work ${prep.env.ROUTE_WORK_CLASS === 'auto' ? 'A/B/C/BC depending on the task' : prep.env.ROUTE_WORK_CLASS}. A design only; B complex code; C routine code; BC C with one B reviewer and at most two returns. Greetings and non-coding questions stay direct.\n\n` : '') + direct + opts.prompt,
    allowedTools: [...(Array.isArray(opts.allowedTools) ? opts.allowedTools : []), ...prep.allowedTools] };
}

module.exports = { MODES, prepare, buildPrompt, stripFrontMatter, skillFile, routeAskFile, selectLeader, validLeader, leaderRunOptions, POLICY_VERSION };
