// Creates dist/Stormo-Setup.exe: a regular installer (Start Menu, Desktop icon, uninstall).
// Needs Inno Setup 6 and the package already built in dist/Stormo (node tools/pack.mjs).
// Usage: node tools/make-installer.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (!fs.existsSync(path.join(ROOT, 'dist', 'Stormo', 'Stormo.exe'))) {
  throw new Error('dist/Stormo is missing: run node tools/pack.mjs first');
}

const candidates = [
  process.env.ISCC,
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Inno Setup 6', 'ISCC.exe'),
  'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
  'C:/Program Files/Inno Setup 6/ISCC.exe',
].filter(Boolean);
const iscc = candidates.find((p) => fs.existsSync(p));
if (!iscc) throw new Error('Inno Setup 6 not found (looking for ISCC.exe): install it or set the ISCC variable');

execFileSync(iscc, [`/DAppVersion=${pkg.version}`, path.join(ROOT, 'tools', 'Stormo.iss')], { stdio: 'inherit' });
const setup = path.join(ROOT, 'dist', 'Stormo-Setup.exe');
console.log(`Ready: ${setup}  (${Math.round(fs.statSync(setup).size / 1048576)} MB)`);
