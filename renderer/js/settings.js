// Settings: profile, appearance, agent CLIs found on this PC.
import { esc, icon, toast } from './dom.js';
import { S, R, save, invalidate } from './state.js';
import { mark, ENGINE_NAMES } from './marks.js';
import { openModal } from './ui.js';
import { applyTermTheme } from './code.js';
import { openSetup } from './setup.js';

const versions = {};

export function openSettings(refreshClis) {
  const cliRows = () => R.clis.map((c) => `<div class="cli-row">${mark(c.id)}
      <span class="cli-lines"><span class="cli-name">${esc(ENGINE_NAMES[c.id] || c.name)}${versions[c.id] ? ` <span style="font-weight:400;color:var(--ink-3)">v${esc(versions[c.id])}</span>` : ''}</span>
      <span class="cli-path" data-tip="${esc(c.path || '')}">${esc(c.path || (c.id === 'terminal' ? 'PowerShell' : 'Not found — install it, then press Refresh'))}</span></span>
      <span class="cli-state" data-ok="${c.installed}">${c.installed ? 'Ready' : 'Missing'}</span></div>`).join('');
  const m = openModal({
    title: 'Settings',
    wide: false,
    body: `
      <div class="settings-section"><h3>Profile</h3>
        <div class="field"><label for="st-name">Your name</label><input class="input" id="st-name" value="${esc(S.profile.name || '')}" maxlength="24"></div></div>
      <div class="settings-section"><h3>Appearance</h3>
        <div class="field-row">
          <div class="field"><label for="st-theme">Theme</label><select class="select" id="st-theme"><option value="dark" ${S.ui.theme !== 'light' ? 'selected' : ''}>Dark</option><option value="light" ${S.ui.theme === 'light' ? 'selected' : ''}>Light</option></select></div>
          <div class="field"><label for="st-font">Terminal text size</label><select class="select" id="st-font">${[11, 11.5, 12, 12.5, 13, 14, 15, 16].map((n) => `<option value="${n}" ${+S.ui.termFont === n ? 'selected' : ''}>${n}px</option>`).join('')}</select></div>
        </div></div>
      <div class="settings-section"><h3>Agents on this PC</h3>
        <div data-clis>${cliRows()}</div>
        <p class="field-hint" style="margin-top:8px">Stormo never uses paid API keys: every agent runs with the login of your own subscription (Claude, ChatGPT, Google). To log in, open the agent in a terminal pane and follow its instructions.</p>
        <div class="inline" style="margin-top:10px"><button class="ghost-btn" data-refresh>${icon('refresh-cw')}Refresh</button><button class="ghost-btn" data-versions>${icon('info')}Check versions</button><button class="ghost-btn" data-data>${icon('folder-open')}Open data folder</button></div></div>
      <div class="settings-section"><h3>Voice (dictation)</h3>
        <div class="cli-row"><span class="cli-lines"><span class="cli-name">Local dictation (Whisper)</span><span class="cli-path" data-voice-detail>Checking…</span></span><span class="cli-state" data-voice-state data-ok="false">…</span></div>
        <p class="field-hint" style="margin-top:8px">Click the microphone in a terminal, in Thread or in Agent, speak Italian or English and click it again. The text lands in the prompt: you always press Enter yourself. The audio never leaves this PC.</p>
        <div class="inline" style="margin-top:10px"><button class="ghost-btn" data-voice-recheck>${icon('refresh-cw')}Check again</button></div></div>
      <div class="settings-section"><h3>Model router</h3>
        <div data-router><p class="field-hint">Checking…</p></div>
        <div class="inline" style="margin-top:10px"><button class="ghost-btn" data-router-setup>${icon('route')}Configure</button><button class="ghost-btn" data-router-remove data-role="destructive">${icon('undo-2')}Remove from providers</button><button class="ghost-btn" data-replay>${icon('circle-play')}Replay the walkthrough</button></div></div>
      <div class="settings-section"><h3>About</h3><p class="field-hint">Stormo ${esc(R.info ? R.info.version : '')} · Electron + xterm.js</p></div>`,
    foot: '<span class="spacer"></span><button class="primary-btn" data-close>Done</button>',
    onMount: ({ el }) => {
      const q = (s) => el.querySelector(s);
      q('#st-name').addEventListener('input', (e) => { S.profile.name = e.target.value; save(); invalidate('rail'); });
      q('#st-theme').addEventListener('change', (e) => { S.ui.theme = e.target.value; document.querySelector('.stage').dataset.theme = S.ui.theme; applyTermTheme(); save(); invalidate('all'); });
      q('#st-font').addEventListener('change', (e) => { S.ui.termFont = +e.target.value; applyTermTheme(); save(); invalidate('center'); });
      const showVoice = (info) => {
        const st = q('[data-voice-state]');
        st.dataset.ok = String(!!info.ok);
        st.textContent = info.ok ? 'Ready' : 'Not ready';
        q('[data-voice-detail]').textContent = info.ok
          ? `${info.python} · models: ${info.models.join(', ')}`
          : info.problem;
      };
      const checkVoice = (force) => window.fm.voice.check(force).then(showVoice).catch((err) => showVoice({ ok: false, problem: String(err && err.message || err) }));
      checkVoice(false);
      const showRouter = async () => {
        const st = await window.fm.router.status();
        const on = st.targets.filter((t) => t.injected);
        q('[data-router]').innerHTML = `<div class="cli-row"><span class="cli-lines"><span class="cli-name">Router instructions in providers</span>
          <span class="cli-path">${on.length ? esc(on.map((t) => t.name).join(' · ')) : 'No provider: the router has not been given to any of them'}</span></span>
          <span class="cli-state" data-ok="${on.length > 0}">${on.length ? 'On' : 'Off'}</span></div>`;
      };
      showRouter();
      el.addEventListener('click', async (e) => {
        if (e.target.closest('[data-router-setup]')) { m.close(); openSetup('router'); return; }
        if (e.target.closest('[data-replay]')) { m.close(); openSetup('trailer'); return; }
        if (e.target.closest('[data-router-remove]')) { const r = await window.fm.router.remove(); await showRouter(); toast(r.results.length ? `Removed from ${r.results.length} file(s). Backup copies remain.` : 'There was nothing to remove.'); return; }
        if (e.target.closest('[data-voice-recheck]')) { q('[data-voice-detail]').textContent = 'Checking…'; await checkVoice(true); return; }
        if (e.target.closest('[data-refresh]')) { await refreshClis(); q('[data-clis]').innerHTML = cliRows(); }
        else if (e.target.closest('[data-versions]')) {
          const b = e.target.closest('[data-versions]');
          b.disabled = true;
          await Promise.all(R.clis.filter((c) => c.installed).map(async (c) => { versions[c.id] = await window.fm.cli.version(c.id); }));
          b.disabled = false;
          q('[data-clis]').innerHTML = cliRows();
        } else if (e.target.closest('[data-data]') && R.info) window.fm.shell.openPath(R.info.userData);
      });
    },
  });
  return m;
}
