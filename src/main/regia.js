'use strict';
// One choice per chat, saved to disk. Quotas only matter for new chats.
const fs = require('node:fs');
const path = require('node:path');
const { validLeader, selectLeader } = require('./router');

class Regia {
  constructor(file, select = selectLeader) {
    this.file = file;
    this.select = select;
    this.pending = new Map();
    this.chats = {};
    try { this.chats = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      if (e.code !== 'ENOENT') throw new Error('Director archive not readable: choice kept, no automatic change.');
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.chats), 'utf8');
    fs.renameSync(this.file + '.tmp', this.file);
  }
  async open(opts) {
    const id = opts.routerChatId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id))
      return { ok: false, error: 'Missing a valid Auto chat identifier.' };
    if (Object.hasOwn(this.chats, id)) return this.chats[id];
    if (this.pending.has(id)) return this.pending.get(id);
    const job = (async () => {
      let engine = opts.routerEngine;
      // Migration: a chat already started keeps its own session's provider.
      if (!engine && opts.sessionId) engine = opts.engine;
      const stored = { ok: true, engine, effort: 'medium',
        model: opts.routerModel || (engine === 'claude' ? 'claude-sonnet-5-5' : engine === 'codex' ? 'gpt-6.1-sol' : '') };
      const leader = validLeader(stored) ? stored : await this.select();
      if (!validLeader(leader)) return leader;
      const binding = { ...leader, sessionId: opts.sessionId || opts.routerSessions?.[leader.engine] || null,
        initialized: !!opts.routerPolicyLoaded, mode: opts.routerPolicyMode || null };
      this.chats[id] = binding;
      this.save();
      return binding;
    })();
    this.pending.set(id, job);
    try { return await job; } finally { this.pending.delete(id); }
  }
  started(id, sessionId, mode, policyVersion) {
    const b = this.chats[id];
    if (!b || !sessionId) return;
    Object.assign(b, { sessionId, initialized: true, mode });
    if (policyVersion) b.policyVersion = policyVersion;
    this.save();
  }
}

module.exports = { Regia };
