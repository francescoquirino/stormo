// Creates dist/Stormo/Stormo.exe without electron-builder.
// Copies Electron + app into resources/app + rcedit for icon and name.
// Usage: node tools/pack.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const OUT = path.join(ROOT, 'dist', 'Stormo');
const APP = path.join(OUT, 'resources', 'app');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist');
const RCEDIT = path.join(ROOT, 'tools', 'rcedit.exe');

// Only what the app needs while running (no electron, no dev tools).
const RUNTIME_MODULES = [
  '@lydell/node-pty', '@lydell/node-pty-win32-x64',
  '@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-unicode11', '@xterm/addon-web-links', '@xterm/addon-webgl',
  '@fontsource-variable/inter',
];
const APP_FILES = ['main.js', 'preload.js', 'src', 'renderer', 'assets'];

function copy(from, to) {
  fs.cpSync(from, to, { recursive: true, force: true, errorOnExist: false });
}

if (!fs.existsSync(path.join(ELECTRON, 'electron.exe'))) throw new Error('Electron not found: run npm install first');
if (!fs.existsSync(RCEDIT)) throw new Error('tools/rcedit.exe is missing');

// If the exe is open, Windows won't let it be overwritten: better to say so clearly right away.
const exe = path.join(OUT, 'Stormo.exe');
if (fs.existsSync(exe)) {
  try { fs.renameSync(exe, exe); } catch { throw new Error('Stormo.exe is open: close it and try again.'); }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copy(ELECTRON, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });
fs.renameSync(path.join(OUT, 'electron.exe'), exe);

fs.mkdirSync(APP, { recursive: true });
for (const f of APP_FILES) copy(path.join(ROOT, f), path.join(APP, f));
for (const m of RUNTIME_MODULES) copy(path.join(ROOT, 'node_modules', m), path.join(APP, 'node_modules', m));
// Strip modules' source maps and TypeScript sources: the app doesn't need them.
const prune = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (['src', 'typings', 'test', 'tests'].includes(e.name) && p.includes('node_modules')) fs.rmSync(p, { recursive: true, force: true }); else prune(p); }
    else if (/\.(map|md|pdb|d\.ts)$/i.test(e.name)) fs.rmSync(p, { force: true });
  }
};
prune(path.join(APP, 'node_modules'));
// Python cache or test leftovers: the app doesn't need them and they must not end up in the package.
const dropJunk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name === '__pycache__') fs.rmSync(p, { recursive: true, force: true }); else dropJunk(p); }
    else if (/\.pyc$/i.test(e.name)) fs.rmSync(p, { force: true });
  }
};
dropJunk(path.join(APP, 'src'));
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
  name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description,
  main: 'main.js', author: pkg.author, type: 'commonjs',
}, null, 2));

execFileSync(RCEDIT, [exe,
  '--set-icon', path.join(ROOT, 'assets', 'icon.ico'),
  '--set-version-string', 'ProductName', 'Stormo',
  '--set-version-string', 'FileDescription', 'Stormo',
  '--set-version-string', 'CompanyName', 'Stormo contributors',
  '--set-version-string', 'LegalCopyright', 'Stormo contributors',
  '--set-version-string', 'OriginalFilename', 'Stormo.exe',
  '--set-version-string', 'InternalName', 'Stormo',
  '--set-file-version', pkg.version,
  '--set-product-version', pkg.version,
], { stdio: 'inherit' });

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((s, e) => {
  const p = path.join(dir, e.name);
  return s + (e.isDirectory() ? size(p) : fs.statSync(p).size);
}, 0);
console.log(`Ready: ${exe}  (${Math.round(size(OUT) / 1048576)} MB)`);
