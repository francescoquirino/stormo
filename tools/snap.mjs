// Automated QA check via the Chrome DevTools Protocol, on Stormo launched with --remote-debugging-port.
// Usage: node tools/snap.mjs <port> <file.png> [script.js] [wait-ms]
//   the script (optional) runs on the page BEFORE the screenshot; its result is printed.
import fs from 'node:fs';

const [port = '9223', out = 'snap.png', scriptFile, waitMs = '600'] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.url.startsWith('app://stormo'));
      if (page) return page;
    } catch { /* not ready yet */ }
    await sleep(250);
  }
  throw new Error('Stormo is not answering on port ' + port);
}

const page = await targets();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let seq = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
if (scriptFile) {
  // The page exists before the renderer finishes booting and detecting CLIs.
  await send('Runtime.evaluate', { expression: '(async()=>{for(let i=0;i<100&&!window.__fm;i++)await new Promise(r=>setTimeout(r,100));})()', awaitPromise: true });
  const code = fs.readFileSync(scriptFile, 'utf8');
  const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true });
  if (r.result && r.result.exceptionDetails) console.log('ERROR in the script:', JSON.stringify(r.result.exceptionDetails).slice(0, 800));
  else console.log('result:', JSON.stringify(r.result && r.result.result && r.result.result.value, null, 1)?.slice(0, 4000));
}
await sleep(+waitMs);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result && shot.result.data) {
  fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot saved:', out);
} else {
  console.log('screenshot failed:', JSON.stringify(shot).slice(0, 300));
}
ws.close();
process.exit(0);
