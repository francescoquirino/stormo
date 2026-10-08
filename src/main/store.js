'use strict';
// Saves the app state (workspaces, threads, agents…) in a JSON file under %APPDATA%\Stormo.
// Atomic write: temp file + rename, so a crash never leaves a half-written file.

const fs = require('node:fs');
const path = require('node:path');

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'state.json');
    fs.mkdirSync(dir, { recursive: true });
  }

  load() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return {}; }
    try {
      const data = JSON.parse(text);
      return data && typeof data === 'object' ? data : {};
    } catch {
      // Corrupted file: set it aside (don't delete it) and start fresh.
      const aside = this.file.replace(/\.json$/, `.corrupt-${Date.now()}.json`);
      try { fs.renameSync(this.file, aside); } catch { /* ignore */ }
      return {};
    }
  }

  save(data) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
