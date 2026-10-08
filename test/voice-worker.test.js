'use strict';
// Real end-to-end test of the whole voice chain: Windows synthetic voice -> local Whisper -> text.
// Skips itself if Python, the packages, the model, or Windows voices are missing (on another PC).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VoiceManager } = require('../src/main/voice');

const SCRIPT = path.join(__dirname, '..', 'src', 'main', 'voice_worker.py');

function makeWav(voice, text, file) {
  const ps = [
    'Add-Type -AssemblyName System.Speech',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.SelectVoice('${voice}')`,
    `$s.SetOutputToWaveFile('${file}', $fmt)`,
    `$s.Speak('${text}')`,
    '$s.Dispose()',
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 60000 });
}

function voices() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }'],
    { encoding: 'utf8', timeout: 30000 });
    return out.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  } catch { return []; }
}

// Runs the real Python program reading the WAV in place of the microphone, and collects the events.
function runWorker(python, wav) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-u', SCRIPT, '--record-now'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      // no PYTHONIOENCODING/PYTHONUTF8: the program has to handle accents on its own
      env: { ...process.env, STORMO_VOICE_WAV: wav, PYTHONUNBUFFERED: '1' },
    });
    const events = [];
    let buf = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('timeout: ' + JSON.stringify(events))); }, 150000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      for (;;) {
        const i = buf.indexOf('\n');
        if (i < 0) break;
        const ev = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        events.push(ev);
        if (ev.type === 'done') child.stdin.write('{"cmd":"quit"}\n');
        if (ev.type === 'error') child.kill();
      }
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ events, code, err }); });
  });
}

test('real voice: Italian sentence with accents and English sentence both arrive correct, and dictation ends on its own', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const info = await new VoiceManager(() => {}).check();
  if (!info.ok) return t.skip('voice not available on this PC: ' + info.problem);
  const have = voices();
  const it = have.find((v) => /Elsa|Italian|it-IT/i.test(v));
  const en = have.find((v) => /Zira|David|English|en-US/i.test(v));
  if (!it || !en) return t.skip('missing Windows voices to generate the test audio');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-voice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wavIt = path.join(dir, 'it.wav');
  const wavEn = path.join(dir, 'en.wav');
  makeWav(it, 'Crea una cartella chiamata progetto e poi apri il file principale, perché è già pronto.', wavIt);
  makeWav(en, 'Open the settings page and run all the tests before the commit.', wavEn);

  const a = await runWorker(info.python, wavIt);
  assert.equal(a.code, 0, 'clean exit. stderr: ' + a.err.slice(-300));
  assert.ok(a.events.some((e) => e.type === 'ready'), 'the model loaded');
  assert.equal(a.events[a.events.length - 1].type, 'done');
  const textIt = a.events.filter((e) => e.type === 'text').map((e) => e.text).join(' ');
  assert.match(textIt, /cartella/i);
  assert.match(textIt, /progetto/i);
  assert.match(textIt, /perché/, 'accents arrive in UTF-8 (they used to become "perch?")');

  const b = await runWorker(info.python, wavEn);
  assert.equal(b.code, 0, 'clean exit. stderr: ' + b.err.slice(-300));
  const textEn = b.events.filter((e) => e.type === 'text').map((e) => e.text).join(' ');
  assert.match(textEn, /settings/i);
  assert.match(textEn, /tests?/i);
  assert.ok(!/[àèéìòù]/i.test(textEn), 'English doesn\'t get "translated" into Italian');
});
