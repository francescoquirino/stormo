// Small CDP driver for Stormo's QA checks: evaluate JS, click and press REAL keys (Input.dispatch*).
// Needs Stormo launched with --remote-debugging-port=<port> (see README, Commands section).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function connect(port = 9223) {
  let page = null;
  for (let i = 0; i < 120 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((t) => t.type === 'page' && t.url.startsWith('app://stormo'));
    } catch { /* not ready yet */ }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error('Stormo is not answering on port ' + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((r) => (ws.onopen = r));
  const send = (method, params = {}) => new Promise((res) => { const i = ++seq; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable');
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 600));
    return r.result && r.result.result && r.result.result.value;
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const press = async (key, code, vk) => {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) });
    if (key === 'Enter') await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };
  const shot = async (file) => {
    const fs = await import('node:fs');
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(s.result.data, 'base64'));
  };
  return { send, evaluate, click, press, shot, sleep, close: () => ws.close() };
}
