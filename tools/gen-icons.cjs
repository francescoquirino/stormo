// Renders assets/logo.svg with Electron (offscreen, transparent background) and creates
// assets/icon.png (256) and assets/icon.ico (16…256, PNG inside the ICO container).
// Usage: npx electron tools/gen-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, png } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(ROOT, 'assets', 'logo.svg'), 'utf8');
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true,
    webPreferences: { offscreen: true } });
  win.webContents.setFrameRate(5);
  let done = false;
  win.webContents.on('paint', (_e, _dirty, image) => {
    if (done) return;
    const size = image.getSize();
    if (size.width < 1024) return;
    done = true;
    const pngs = SIZES.map((s) => ({ size: s, png: image.resize({ width: s, height: s, quality: 'best' }).toPNG() }));
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.png'), pngs.find((p) => p.size === 256).png);
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon-32.png'), pngs.find((p) => p.size === 32).png);
    fs.writeFileSync(path.join(ROOT, 'assets', 'icon.ico'), ico(pngs));
    console.log('icons created:', SIZES.join(', '));
    app.quit();
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  setTimeout(() => { if (!done) { console.error('no frame rendered'); app.exit(1); } }, 15000);
});
