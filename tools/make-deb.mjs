import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DEB_ARCH = { x64: 'amd64', arm64: 'arm64' };

const DEPENDS = [
  'libgtk-3-0 | libgtk-3-0t64',
  'libnss3',
  'libatk1.0-0 | libatk1.0-0t64',
  'libatk-bridge2.0-0 | libatk-bridge2.0-0t64',
  'libgbm1',
  'libasound2 | libasound2t64',
  'libx11-6',
  'libxcomposite1',
  'libxdamage1',
  'libxext6',
  'libxfixes3',
  'libxrandr2',
  'libxcb1',
  'libxkbcommon0',
  'libcups2 | libcups2t64',
  'libatspi2.0-0 | libatspi2.0-0t64',
];

function fail(message) {
  throw new Error(message);
}

// Recursive copy: keeps symlinks and permissions, skips __pycache__ and .pyc.
function copyTree(src, dest) {
  const st = lstatSync(src);
  if (st.isSymbolicLink()) {
    symlinkSync(readlinkSync(src), dest);
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src).sort()) {
      if (name === '__pycache__' || name.endsWith('.pyc')) continue;
      copyTree(path.join(src, name), path.join(dest, name));
    }
    chmodSync(dest, st.mode & 0o7777);
    return;
  }
  if (st.isFile()) {
    copyFileSync(src, dest);
    chmodSync(dest, st.mode & 0o7777);
    return;
  }
  fail(`Unsupported file type: ${src}`);
}

function sizeOf(target) {
  const st = lstatSync(target);
  if (st.isDirectory()) {
    return readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0);
  }
  return st.size;
}

// Only deletes dist/<expectedName> inside this workspace, never anything else.
function removeOwnDistEntry(target, expectedName) {
  const expected = path.join(DIST, expectedName);
  if (path.resolve(target) !== expected) fail(`Unexpected path to delete: ${target}`);
  if (path.dirname(expected) !== DIST || path.dirname(DIST) !== ROOT) {
    fail(`Path outside the workspace: ${expected}`);
  }
  if (existsSync(DIST) && lstatSync(DIST).isSymbolicLink()) fail(`${DIST} is a symlink, stopping`);
  rmSync(expected, { recursive: true, force: true });
}

function main() {
  if (process.platform !== 'linux') fail(`Linux required; this machine is ${process.platform}`);
  const arch = process.arch;
  const debArch = DEB_ARCH[arch];
  if (!debArch) fail(`Unsupported architecture: ${arch} (only x64 and arm64)`);

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!pkg.version) fail('package.json: field "version" missing');

  const packDir = path.join(DIST, `Stormo-linux-${arch}`);
  for (const rel of ['stormo', 'Stormo', path.join('resources', 'app', 'main.js')]) {
    if (!existsSync(path.join(packDir, rel))) {
      fail(`Packaged folder incomplete (missing ${rel}). Run first: node tools/pack-linux.mjs`);
    }
  }
  const iconSrc = path.join(ROOT, 'assets', 'icon.png');
  if (!existsSync(iconSrc)) fail(`Icon missing: ${iconSrc}`);
  const iconHeader = readFileSync(iconSrc).subarray(0, 24);
  if (iconHeader.toString('latin1', 1, 4) !== 'PNG') fail(`${iconSrc} is not a PNG`);
  const iconW = iconHeader.readUInt32BE(16);
  const iconH = iconHeader.readUInt32BE(20);
  if (iconW !== 256 || iconH !== 256) {
    console.warn(`WARNING: icon.png is ${iconW}x${iconH}, the hicolor folder is 256x256`);
  }

  const stageName = `linux-deb-${arch}`;
  const stage = path.join(DIST, stageName);
  removeOwnDistEntry(stage, stageName);

  const dirs = [
    'DEBIAN',
    'opt',
    'usr',
    'usr/bin',
    'usr/share',
    'usr/share/applications',
    'usr/share/icons',
    'usr/share/icons/hicolor',
    'usr/share/icons/hicolor/256x256',
    'usr/share/icons/hicolor/256x256/apps',
  ];
  mkdirSync(stage, { recursive: true });
  chmodSync(stage, 0o755);
  for (const rel of dirs) {
    const dir = path.join(stage, rel);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);
  }

  const installDir = path.join(stage, 'opt', 'stormo');
  copyTree(packDir, installDir);
  chmodSync(installDir, 0o755);
  const sandbox = path.join(installDir, 'chrome-sandbox');
  if (existsSync(sandbox)) {
    chmodSync(sandbox, 0o4755);
  } else {
    console.warn('WARNING: chrome-sandbox missing, no setuid applied');
  }

  symlinkSync('/opt/stormo/Stormo', path.join(stage, 'usr', 'bin', 'stormo'));

  const desktop = `[Desktop Entry]
Type=Application
Name=Stormo
Comment=All your coding agents. One flock.
Exec=/opt/stormo/Stormo
Icon=stormo
Terminal=false
Categories=Development;
`;
  const desktopPath = path.join(stage, 'usr', 'share', 'applications', 'stormo.desktop');
  writeFileSync(desktopPath, desktop);
  chmodSync(desktopPath, 0o644);

  const iconDest = path.join(stage, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'stormo.png');
  copyFileSync(iconSrc, iconDest);
  chmodSync(iconDest, 0o644);

  const installedSizeKiB = Math.ceil(sizeOf(stage) / 1024);
  const control = [
    'Package: stormo',
    `Version: ${pkg.version}`,
    `Architecture: ${debArch}`,
    'Section: devel',
    'Priority: optional',
    'Maintainer: Stormo contributors <noreply@example.com>',
    `Installed-Size: ${installedSizeKiB}`,
    `Depends: ${DEPENDS.join(', ')}`,
    'Description: All your coding agents. One flock.',
    '',
  ].join('\n');
  const controlPath = path.join(stage, 'DEBIAN', 'control');
  writeFileSync(controlPath, control);
  chmodSync(controlPath, 0o644);

  const debPath = path.join(DIST, `stormo_${pkg.version}_${debArch}.deb`);
  rmSync(debPath, { force: true });
  execFileSync('dpkg-deb', ['--root-owner-group', '--build', stage, debPath], { stdio: 'inherit' });
  if (!existsSync(debPath)) fail(`Package not created: ${debPath}`);

  console.log('Done (package NOT installed).');
  console.log(`Stage: ${stage}`);
  console.log(`Deb:   ${debPath}`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
