// Jumps from one point of the app to another (Dashboard, notifications, palette).
import { S, save, invalidate } from './state.js';

export function goTo(target) {
  if (!target) return;
  if (target.mode === 'code') {
    S.ui.mode = 'code';
    if (target.wsId) {
      S.activeWs = target.wsId;
      const ws = S.workspaces.find((w) => w.id === target.wsId);
      if (ws) { ws.open = true; if (target.paneId) { ws.focus = target.paneId; if (ws.zoomed && ws.zoomed !== target.paneId) ws.zoomed = null; } }
    }
  } else if (target.mode === 'thread') {
    S.ui.mode = 'thread';
    if (target.id) S.activeThread = target.id;
  } else if (target.mode === 'auto') {
    S.ui.mode = 'auto';
    if (target.id) S.activeAuto = target.id;
  } else if (target.mode === 'agent') {
    S.ui.mode = 'agent';
    if (target.agentId) {
      S.activeAgent = target.agentId;
      const a = S.agents.find((x) => x.id === target.agentId);
      if (a && target.chatId) a.activeChat = target.chatId;
    }
  }
  save();
  invalidate('all');
}
