// QA check: after dictating in a terminal, Enter must reach the terminal and NOT restart the microphone.
// (With focus left on the microphone button, Enter would restart it instead of sending the text.)
// Needs Stormo launched with a test profile and an audio file in place of the microphone:
//   STORMO_PROFILE=test STORMO_VOICE_WAV=sentence.wav npx electron . --remote-debugging-port=9223
// Usage: node tools/check-voice-focus.mjs [port]
import os from 'node:os';
import path from 'node:path';
import { connect } from './cdp.mjs';

const port = Number(process.argv[2]) || 9223;
const c = await connect(port);
const folder = os.tmpdir().split(path.sep).join('/');
let failed = 0;
const check = (ok, what) => { console.log((ok ? 'OK   ' : 'FAILED ') + what); if (!ok) failed++; };
const active = () => c.evaluate(`(() => { const a = document.activeElement; return a ? a.tagName + '.' + String(a.className).split(' ')[0] : ''; })()`);
const micState = () => c.evaluate(`document.querySelector('.voice-btn[data-voice-key="code:chk"]').dataset.state || 'off'`);

await c.evaluate(`(async () => {
  const { S } = window.__fm; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  S.workspaces = [{ id: 'wsChk', name: 'check', path: ${JSON.stringify(folder)}, open: true, layout: 'grid', focus: 'chk', zoomed: null, panes: [{ id: 'chk', agent: 'terminal', smart: false }] }];
  S.activeWs = 'wsChk'; S.ui.mode = 'thread';
  document.querySelector('.mode[data-mode="thread"]').click(); await wait(200);
  document.querySelector('.mode[data-mode="code"]').click(); await wait(3500);
  window.__voiceEvents = [];
  window.fm.voice.onEvent((key, ev) => window.__voiceEvents.push(ev.type));
})()`);

const r = await c.evaluate(`(() => { const r = document.querySelector('.voice-btn[data-voice-key="code:chk"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await c.click(r.x, r.y);
await c.sleep(500);
check((await active()).includes('xterm-helper-textarea'), 'after clicking the microphone the keyboard focus is in the terminal (not on the button)');
for (let i = 0; i < 200; i++) {                                   // la dettatura di prova finisce da sola
  await c.sleep(250);
  if ((await micState()) === 'off' && i > 4) break;
}
const texts = await c.evaluate(`window.__voiceEvents.filter((t) => t === 'text').length`);
check(texts > 0, 'dictation produced some text (' + texts + ' sentences)');
const before = await c.evaluate(`window.__voiceEvents.length`);
await c.press('Enter', 'Enter', 13);
await c.sleep(4000);
const after = await c.evaluate(`window.__voiceEvents.length`);
check(after === before, 'pressing Enter does not restart the microphone (new voice events: ' + (after - before) + ')');
check((await micState()) === 'off', 'the microphone is off after Enter');

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed.');
c.close();
process.exit(failed ? 1 : 0);
