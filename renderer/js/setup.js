// Stormo's first launch: trailer → connect the providers → model router consent → ready.
// It can be revisited from Settings. Router consent can be withdrawn anytime.
import { $, esc, icon, uid, toast } from './dom.js';
import { S, R, save, invalidate } from './state.js';
import { mark, ENGINE_NAMES, brandMark } from './marks.js';
import { addPane } from './code.js';

// How to install each CLI (official commands) and how to sign in the first time.
const PROVIDERS = {
  claude: { install: 'curl -fsSL https://claude.ai/install.sh | bash', login: 'On first launch it asks you to sign in with your Claude account.' },
  codex: { install: 'npm i -g @openai/codex', login: 'On first launch pick "Sign in with ChatGPT".' },
  agy: { site: 'https://antigravity.google', login: 'Sign in with your Google account when asked.' },
  gemini: { install: 'npm i -g @google/gemini-cli', login: 'On first launch pick "Login with Google".' },
  copilot: { install: 'npm i -g @github/copilot', login: 'Type /login and follow the GitHub code.' },
  cursor: { install: 'curl https://cursor.com/install -fsS | bash', login: 'Run cursor-agent login in the terminal.' },
  grok: { site: 'https://docs.x.ai', login: 'Follow xAI\'s instructions to sign in.' },
  glm: { site: 'https://docs.z.ai', login: 'GLM runs through Claude Code with a z.ai key (see the z.ai guide).' },
};

let host = null;
let step = 'trailer';
let pill = null;
let routerState = null;
let routerResult = null;

export async function maybeRunSetup() {
  const st = await window.fm.setup.get();
  if (!st.onboarded) openSetup();
}

export function openSetup(from = 'trailer') {
  step = from;
  routerResult = null;
  if (pill) { pill.remove(); pill = null; }
  if (!host) {
    host = document.createElement('div');
    host.className = 'setup';
    $('#app').appendChild(host);
    host.addEventListener('click', onClick);
  }
  host.hidden = false;
  draw();
}

function close(done) {
  if (host) { host.remove(); host = null; }
  if (done) window.fm.setup.set({ onboarded: true, at: new Date().toISOString() });
}

// Signing in to a provider needs its terminal: the setup shrinks down to a pill at the bottom.
function minimize() {
  if (host) host.hidden = true;
  if (pill) return;
  pill = document.createElement('button');
  pill.className = 'setup-pill';
  pill.innerHTML = `${brandMark('setup-pill-mark')}<span>Back to setup</span>${icon('chevron-right')}`;
  pill.addEventListener('click', async () => { R.clis = await window.fm.cli.detect(S.cliOverrides || {}); openSetup('providers'); });
  $('#app').appendChild(pill);
}

function homeWorkspace() {
  const home = R.info && R.info.home;
  let ws = S.workspaces.find((w) => w.path === home);
  if (!ws) {
    ws = { id: uid('ws'), name: 'Home', path: home, open: true, panes: [], layout: 'grid', focus: null, zoomed: null };
    S.workspaces.push(ws);
  }
  return ws;
}

function dots() {
  const order = ['trailer', 'providers', 'router', 'done'];
  return `<div class="setup-dots">${order.map((s) => `<span data-on="${s === step}"></span>`).join('')}</div>`;
}

function draw() {
  if (!host) return;
  if (step === 'trailer') {
    host.innerHTML = `<div class="setup-video">
      <video src="app://stormo/assets/trailer.mp4" autoplay playsinline></video>
      <button class="setup-skip" data-go="providers">Skip ${icon('skip-forward')}</button></div>`;
    const v = host.querySelector('video');
    let retried = false;
    v.addEventListener('ended', () => { if (step === 'trailer') { step = 'providers'; draw(); } });
    // At a cold start the media pipeline can fail once: try again before skipping the trailer.
    v.addEventListener('error', () => {
      if (step !== 'trailer') return;
      if (retried) { step = 'providers'; draw(); return; }
      retried = true;
      setTimeout(() => { v.load(); v.play().catch(() => {}); }, 500);
    });
    return;
  }
  let body = '';
  if (step === 'providers') {
    const list = (R.clis || []).filter((c) => c.id !== 'terminal');
    body = `<h1>Connect your providers</h1>
      <p class="setup-lead">Stormo runs the CLIs you already have, with <b>your own</b> sign-in: no paid API keys.
        Press <b>Sign in</b> and you log in yourself, inside the CLI's terminal.</p>
      <div class="setup-grid">${list.map((c) => {
        const p = PROVIDERS[c.id] || {};
        return `<div class="setup-card" data-ok="${c.installed}">
          <div class="setup-card-head">${mark(c.id)}<b>${esc(ENGINE_NAMES[c.id] || c.name)}</b>
            <span class="setup-badge" data-ok="${c.installed}">${c.installed ? 'Installed' : 'Not installed'}</span></div>
          ${c.installed
            ? `<p>${esc(p.login || 'Sign in by following the steps in the terminal.')}</p>
               <button class="ghost-btn" data-login="${c.id}">${icon('plug')}Sign in</button>`
            : p.install
              ? `<p>To install it, run in a terminal:</p><code class="setup-cmd">${esc(p.install)}</code>
                 <button class="ghost-btn" data-copy="${esc(p.install)}">${icon('copy')}Copy command</button>`
              : `<p>Install it from the official site.</p><button class="ghost-btn" data-site="${esc(p.site || '')}">${icon('external-link')}Open site</button>`}
        </div>`;
      }).join('')}</div>`;
    body += `<div class="setup-foot"><button class="ghost-btn" data-refresh>${icon('refresh-cw')}Check again</button>
      <span class="spacer"></span><button class="primary-btn" data-go="router">Next ${icon('chevron-right')}</button></div>`;
  } else if (step === 'router') {
    body = routerResult ? routerDone() : routerAsk();
  } else if (step === 'done') {
    body = `<div class="setup-final">${brandMark('setup-final-mark')}<h1>Stormo is ready</h1>
      <p class="setup-lead">All your agents, one flock. You can come back to this setup anytime from Settings.</p>
      <button class="primary-btn setup-big" data-finish>Get started ${icon('arrow-right')}</button></div>`;
  }
  host.innerHTML = `<div class="setup-card-wrap">${dots()}<div class="setup-body">${body}</div></div>`;
  if (step === 'router' && !routerState) loadRouter();
}

async function loadRouter() {
  routerState = await window.fm.router.status();
  draw();
}

function routerAsk() {
  if (!routerState) return '<h1>Model router</h1><p class="setup-lead">Checking your providers…</p>';
  const rows = routerState.targets.map((t) => {
    const can = !!t.file;
    const checked = can && (t.installed || t.injected);
    return `<label class="setup-target" data-can="${can}">
      <input type="checkbox" data-target="${t.id}" ${checked ? 'checked' : ''} ${can ? '' : 'disabled'}>
      <span class="setup-target-lines"><b>${esc(t.name)}</b>${t.also ? ` <i>(${esc(t.also)})</i>` : ''}
        <span class="setup-path">${can ? esc(t.file.replace(R.info.home, '~')) : esc(t.why)}</span></span>
      <span class="setup-badge" data-ok="${t.installed}">${t.injected ? 'Already added' : t.installed ? 'Installed' : 'Not installed'}</span></label>`;
  }).join('');
  return `<h1>Give the model router to all your providers?</h1>
    <p class="setup-lead">With your permission Stormo adds a <b>small block of instructions</b> to each CLI's rules file,
      so Claude, Codex, Gemini and the others use the model router <b>even outside Stormo</b>: work gets routed to the right model and your quotas last longer.</p>
    <ul class="setup-promise">
      <li>${icon('shield-check')}Every file is backed up before it is touched.</li>
      <li>${icon('undo-2')}The rest of the file stays the same. Remove it all with one click in Settings → Model router.</li>
      <li>${icon('lock')}Nothing is sent anywhere: only files on your computer change.</li>
    </ul>
    <div class="setup-targets">${rows}</div>
    ${routerState.routeAsk ? '' : '<p class="setup-warn">The <code>route-ask</code> command is not installed on this computer yet: the instructions will be there, but routing starts once you install it (<code>python3 assets/router/setup.py</code>).</p>'}
    <div class="setup-foot"><button class="ghost-btn" data-go="providers">${icon('chevron-left')}Back</button><span class="spacer"></span>
      <button class="ghost-btn" data-no-router>No, thanks</button>
      <button class="primary-btn" data-yes-router>${icon('route')}Yes, add the router</button></div>`;
}

function routerDone() {
  const names = Object.fromEntries(routerState.targets.map((t) => [t.id, t.name]));
  const rows = routerResult.results.map((r) => `<li data-ok="${r.ok}">${icon(r.ok ? 'circle-check' : 'circle-alert')}<b>${esc(names[r.id] || r.id)}</b>
    <span>${r.ok ? (r.changed ? 'instructions added' + (r.backup ? ' · backup saved' : '') : 'already up to date') : esc(r.why || r.error || 'failed')}</span></li>`).join('');
  const sk = routerResult.skill;
  return `<h1>Done</h1>
    <ul class="setup-results">${rows}</ul>
    ${sk ? `<p class="setup-lead">${sk.ok ? (sk.installed ? 'The full router skill for Claude Code was installed too.' : 'Claude Code already had a router skill: it was left untouched.') : esc(sk.error)}</p>` : ''}
    <div class="setup-foot"><span class="spacer"></span><button class="primary-btn" data-go="done">Next ${icon('chevron-right')}</button></div>`;
}

async function onClick(e) {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.go) { step = t.dataset.go; if (step === 'router') routerState = null; draw(); return; }
  if (t.dataset.login) {
    const ws = homeWorkspace();
    S.ui.mode = 'code';
    S.activeWs = ws.id;
    save();
    addPane(ws, t.dataset.login);
    invalidate('all');
    minimize();
    return;
  }
  if (t.dataset.copy) { window.fm.clip.write(t.dataset.copy); toast('Command copied'); return; }
  if (t.dataset.site) { window.fm.shell.openExternal(t.dataset.site); return; }
  if ('refresh' in t.dataset) { R.clis = await window.fm.cli.detect(S.cliOverrides || {}); draw(); return; }
  if ('noRouter' in t.dataset) { step = 'done'; draw(); return; }
  if ('yesRouter' in t.dataset) {
    const ids = [...host.querySelectorAll('[data-target]:checked')].map((x) => x.dataset.target);
    if (!ids.length) { toast('Pick at least one provider, or press "No, thanks".'); return; }
    t.disabled = true;
    routerResult = await window.fm.router.apply(ids);
    draw();
    return;
  }
  if ('finish' in t.dataset) close(true);
}
