import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import {
  resolveSession, resolveSessionViewer, getRoom,
  pauseRoom, resumeRoom, seekRoom, getLiveTimeMs, currentItem,
} from '../rooms/manager';
import type { VoiceMember } from '../rooms/manager';

interface SyncMessage {
  type: string;
  [key: string]: unknown;
}

// roomId -> (socket -> the Discord user that socket is identified as)
const webViewers = new Map<string, Map<WebSocket, VoiceMember>>();

export function getConnectedCount(roomId: string): number {
  return webViewers.get(roomId)?.size ?? 0;
}

export function broadcast(roomId: string, msg: SyncMessage): void {
  const sockets = webViewers.get(roomId);
  if (!sockets) return;
  const payload = JSON.stringify(msg);
  for (const ws of sockets.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Participant list = voice-channel members ∪ identified web viewers, deduped
 *  by Discord id. Web-only viewers are marked "(web)". */
export function broadcastParticipants(roomId: string): void {
  const room = getRoom(roomId);
  if (!room) return;
  const byId = new Map<string, { name: string; voice: boolean }>();
  for (const m of room.voiceMembers) byId.set(m.id, { name: m.name, voice: true });
  for (const v of webViewers.get(roomId)?.values() ?? []) {
    if (!byId.has(v.id)) byId.set(v.id, { name: v.name, voice: false });
  }
  const names = [...byId.values()].map(e => (e.voice ? e.name : `${e.name} (web)`));
  broadcast(roomId, { type: 'participants', names });
}

export function attachSyncServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/sync' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token');
    const room = token ? resolveSession(token) : null;
    if (!room) {
      ws.close(4001, 'Invalid or expired session token');
      return;
    }

    const roomId = room.id;
    const viewer: VoiceMember = (token && resolveSessionViewer(token)) || { id: `anon:${token}`, name: 'Guest' };
    if (!webViewers.has(roomId)) webViewers.set(roomId, new Map());
    webViewers.get(roomId)!.set(ws, viewer);

    sendState(ws, roomId);
    broadcastParticipants(roomId);

    ws.on('message', (data: Buffer) => {
      let msg: SyncMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      handleClientMessage(roomId, ws, msg);
    });

    ws.on('close', () => {
      webViewers.get(roomId)?.delete(ws);
      broadcastParticipants(roomId);
    });
  });

  // Periodic sync heartbeat — keeps all clients aligned
  setInterval(() => {
    for (const [roomId, sockets] of webViewers) {
      if (sockets.size === 0) continue;
      const room = getRoom(roomId);
      if (!room || room.state === 'stopped') continue;
      const payload = JSON.stringify({
        type: 'sync',
        state: room.state,
        currentTimeMs: getLiveTimeMs(room),
        ratingKey: currentItem(room)?.id,
      });
      for (const ws of sockets.keys()) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  }, 5_000);
}

function sendState(ws: WebSocket, roomId: string): void {
  const room = getRoom(roomId);
  if (!room) return;
  const item = currentItem(room);
  ws.send(JSON.stringify({
    type: 'state',
    state: room.state,
    currentTimeMs: getLiveTimeMs(room),
    ratingKey: item?.id ?? null,
    title: item ? formatTitle(item) : null,
    durationMs: item?.duration ?? 0,
  }));
}

function handleClientMessage(roomId: string, ws: WebSocket, msg: SyncMessage): void {
  const who = webViewers.get(roomId)?.get(ws)?.name ?? 'A viewer';
  switch (msg.type) {
    case 'pause': {
      const room = pauseRoom(roomId);
      if (room) {
        broadcast(roomId, { type: 'pause', currentTimeMs: room.currentTimeMs });
        broadcast(roomId, { type: 'notification', text: `${who} paused` });
      }
      break;
    }
    case 'play': {
      const room = resumeRoom(roomId);
      if (room) {
        broadcast(roomId, { type: 'play', currentTimeMs: room.currentTimeMs });
        broadcast(roomId, { type: 'notification', text: `${who} resumed` });
      }
      break;
    }
    case 'seek': {
      const ms = typeof msg.currentTimeMs === 'number' ? msg.currentTimeMs : 0;
      const room = seekRoom(roomId, ms);
      if (room) {
        broadcast(roomId, { type: 'seek', currentTimeMs: ms });
        const label = typeof msg.label === 'string' ? msg.label : 'changed the position';
        broadcast(roomId, { type: 'notification', text: `${who} ${label}` });
      }
      break;
    }
  }
}

function formatTitle(item: { grandparentTitle?: string; parentIndex?: number; index?: number; title: string; year?: number }): string {
  if (item.grandparentTitle) {
    return `${item.grandparentTitle} S${item.parentIndex}E${item.index} – ${item.title}`;
  }
  return item.year ? `${item.title} (${item.year})` : item.title;
}
