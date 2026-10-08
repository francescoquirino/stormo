'use strict';
// Fake voice process for the tests: same protocol as src/main/voice_worker.py, without microphone or Whisper.
const readline = require('node:readline');

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'state', state: 'listening' });          // like --record-now: the microphone is already open
setTimeout(() => out({ type: 'ready', model: 'fake', device: 'cpu' }), 15);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let cmd;
  try { cmd = JSON.parse(line).cmd; } catch { return; }
  if (cmd === 'start') out({ type: 'state', state: 'listening' });
  else if (cmd === 'stop') {
    if (process.env.FAKE_CRASH_ON_STOP) process.exit(1);
    if (process.env.FAKE_SILENT_ON_STOP) return;       // stays silent: used to test the anti-hang watchdog
    setTimeout(() => { out({ type: 'text', text: `perché città è già pid=${process.pid}` }); out({ type: 'done' }); }, 30);
  } else if (cmd === 'quit') process.exit(0);
});
process.stdin.on('end', () => process.exit(0));
