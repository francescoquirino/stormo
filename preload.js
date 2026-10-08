'use strict';
// Secure bridge between the UI (renderer) and the main process.

const { contextBridge, ipcRenderer } = require('electron');

function listen(channel, cb) {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
}

contextBridge.exposeInMainWorld('fm', {
  state: {
    load: () => ipcRenderer.invoke('state:load'),
    save: (data) => ipcRenderer.invoke('state:save', data),
  },
  cli: {
    detect: (overrides) => ipcRenderer.invoke('cli:detect', overrides),
    version: (id) => ipcRenderer.invoke('cli:version', id),
  },
  dialog: {
    pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  },
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.send('pty:kill', id),
    onData: (cb) => listen('pty:data', cb),
    onExit: (cb) => listen('pty:exit', cb),
    onState: (cb) => listen('pty:state', cb),
  },
  voice: {
    start: (id) => ipcRenderer.invoke('voice:start', id),
    check: (force) => ipcRenderer.invoke('voice:check', !!force),
    stop: (id) => ipcRenderer.send('voice:stop', id),
    onEvent: (cb) => listen('voice:event', cb),
  },
  engine: {
    run: (opts) => ipcRenderer.invoke('engine:run', opts),
    regia: (opts) => ipcRenderer.invoke('engine:regia', opts),
    cancel: (runId) => ipcRenderer.send('engine:cancel', runId),
    onEvent: (cb) => listen('engine:event', cb),
  },
  models: { list: (engine) => ipcRenderer.invoke('models:list', engine) },
  git: {
    info: (cwd) => ipcRenderer.invoke('git:info', cwd),
    changes: (cwd) => ipcRenderer.invoke('git:changes', cwd),
  },
  fs: {
    exists: (p) => ipcRenderer.invoke('fs:exists', p),
    agentDir: (id) => ipcRenderer.invoke('fs:agentDir', id),
  },
  app: { info: () => ipcRenderer.invoke('app:info') },
  setup: {
    get: () => ipcRenderer.invoke('setup:get'),
    set: (patch) => ipcRenderer.invoke('setup:set', patch),
  },
  router: {
    status: () => ipcRenderer.invoke('router:status'),
    apply: (ids) => ipcRenderer.invoke('router:apply', ids),
    remove: () => ipcRenderer.invoke('router:remove'),
  },
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    toggleMaximize: () => ipcRenderer.send('win:toggleMaximize'),
    close: () => ipcRenderer.send('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onMaximized: (cb) => listen('win:maximized', cb),
    onFocus: (cb) => listen('win:focus', cb),
  },
  shell: {
    openExternal: (url) => ipcRenderer.send('shell:openExternal', url),
    openPath: (p) => ipcRenderer.send('shell:openPath', p),
  },
  clip: {
    read: () => ipcRenderer.invoke('clip:read'),
    write: (text) => ipcRenderer.send('clip:write', text),
  },
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
});
