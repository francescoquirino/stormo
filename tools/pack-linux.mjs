import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const ELF_MACHINE = { x64: 62, arm64: 183 };

function fail(message) {
  throw new Error(message);
}

function assertElf(file, arch) {
  const header = Buffer.alloc(20);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  const isElf = header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
  if (!isElf) fail(`${file} is not an ELF file (is it the Linux Electron binary?)`);
  if (header[4] !== 2 || header[5] !== 1) fail(`${file} is not a 64-bit little-endian ELF`);
  const machine = header.readUInt16LE(18);
  if (machine !== ELF_MACHINE[arch]) {
    fail(`${file} e_machine=${machine}, expected ${ELF_MACHINE[arch]} for ${arch}`);
  }
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

function findFile(dir, fileName) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, fileName);
      if (found) return found;
    } else if (entry.name === fileName) {
      return full;
    }
  }
  return null;
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
  if (!Object.hasOwn(ELF_MACHINE, arch)) fail(`Unsupported architecture: ${arch} (only x64 and arm64)`);

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const key of ['name', 'productName', 'version', 'main']) {
    if (!pkg[key]) fail(`package.json: field "${key}" missing`);
  }

  const electronDist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  const electronBin = path.join(electronDist, 'electron');
  if (!existsSync(electronBin)) fail(`Electron not found: ${electronBin} (run npm install)`);
  assertElf(electronBin, arch);

  const outName = `Stormo-linux-${arch}`;
  const outDir = path.join(DIST, outName);
  removeOwnDistEntry(outDir, outName);
  mkdirSync(DIST, { recursive: true });

  console.log(`Copying Electron from ${electronDist}`);
  copyTree(realpathSync(electronDist), outDir);
  renameSync(path.join(outDir, 'electron'), path.join(outDir, 'stormo'));
  rmSync(path.join(outDir, 'resources', 'default_app.asar'), { force: true });

  const appDir = path.join(outDir, 'resources', 'app');
  mkdirSync(appDir, { recursive: true });
  for (const item of ['main.js', 'preload.js', 'src', 'renderer', 'assets']) {
    const src = path.join(ROOT, item);
    if (!existsSync(src)) fail(`App file missing: ${src}`);
    copyTree(realpathSync(src), path.join(appDir, item));
  }
  if (!existsSync(path.join(appDir, pkg.main))) fail(`The main "${pkg.main}" is not in the copied app`);

  const minimalPkg = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    main: pkg.main,
    private: true,
  };
  writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(minimalPkg, null, 2) + '\n');

  const modules = [
    '@lydell/node-pty',
    `@lydell/node-pty-linux-${arch}`,
    '@xterm/xterm',
    '@xterm/addon-fit',
    '@xterm/addon-unicode11',
    '@xterm/addon-web-links',
    '@xterm/addon-webgl',
    '@fontsource-variable/inter',
  ];
  for (const name of modules) {
    const src = path.join(ROOT, 'node_modules', ...name.split('/'));
    if (!existsSync(src)) fail(`Module not installed: ${name}`);
    const dest = path.join(appDir, 'node_modules', ...name.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyTree(realpathSync(src), dest);
  }
  const ptyDir = path.join(appDir, 'node_modules', '@lydell', `node-pty-linux-${arch}`);
  if (!findFile(ptyDir, 'pty.node')) fail(`pty.node not found in ${ptyDir}`);

  chmodSync(path.join(outDir, 'stormo'), 0o755);
  const sandbox = path.join(outDir, 'chrome-sandbox');
  if (existsSync(sandbox)) {
    chmodSync(sandbox, 0o755); // portable: no setuid; the .deb sets it to 4755
  } else {
    console.warn('WARNING: chrome-sandbox missing from the Electron folder');
  }
  if (!existsSync(path.join(outDir, 'LICENSE')) && !existsSync(path.join(outDir, 'LICENSES.chromium.html'))) {
    console.warn('WARNING: Electron license files not found');
  }

  const launcher = `#!/bin/sh
# Stormo launcher: starts the Electron binary next to this script.
if [ "$(id -u)" = "0" ]; then
  echo "Do not run Stormo as root." >&2
  exit 1
fi
SELF=$(readlink -f -- "$0" 2>/dev/null) || SELF=$0
DIR=$(cd -- "$(dirname -- "$SELF")" && pwd)
exec "$DIR/stormo" "$@"
`;
  const launcherPath = path.join(outDir, 'Stormo');
  writeFileSync(launcherPath, launcher);
  chmodSync(launcherPath, 0o755);

  const desktop = `[Desktop Entry]
# Manual install: replace Exec with the absolute path of the Stormo launcher.
Type=Application
Name=Stormo
Comment=All your coding agents. One flock.
Exec=Stormo
Icon=stormo
Terminal=false
Categories=Development;
`;
  writeFileSync(path.join(outDir, 'stormo.desktop'), desktop);

  const iconSrc = path.join(ROOT, 'assets', 'icon.png');
  if (!existsSync(iconSrc)) fail(`Icon missing: ${iconSrc}`);
  copyFileSync(iconSrc, path.join(outDir, 'icon.png'));
  chmodSync(path.join(outDir, 'icon.png'), 0o644);

  const archive = path.join(DIST, `Stormo-${pkg.version}-linux-${arch}.tar.gz`);
  rmSync(archive, { force: true });
  // Neutral ownership: tar would otherwise record the build machine's user name in every entry.
  execFileSync('tar', ['--owner=0', '--group=0', '--numeric-owner', '-czf', archive, '-C', DIST, path.basename(outDir)], { stdio: 'inherit' });
  if (!statSync(archive).isFile()) fail(`Archive not created: ${archive}`);

  console.log('Done.');
  console.log(`Folder: ${outDir}`);
  console.log(`Archive: ${archive}`);
}

try {
  main();
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
