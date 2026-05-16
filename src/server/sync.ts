import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { resolveSessionGuildId, getRoom, pauseRoom, resumeRoom, seekRoom, getLiveTimeMs, currentItem } from '../rooms/manager';

interface SyncMessage {
  type: string;
  [key: string]: unknown;
}

// guildId → set of connected sockets
const roomSockets = new Map<string, Set<WebSocket>>();

export function getConnectedCount(guildId: string): number {
  return roomSockets.get(guildId)?.size ?? 0;
}

export function broadcast(guildId: string, msg: SyncMessage): void {
  const sockets = roomSockets.get(guildId);
  if (!sockets) return;
  const payload = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export function attachSyncServer(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: '/sync' });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token');
    const guildId = token ? resolveSessionGuildId(token) : null;

    if (!guildId) {
      ws.close(4001, 'Invalid or expired session token');
      return;
    }

    if (!roomSockets.has(guildId)) roomSockets.set(guildId, new Set());
    roomSockets.get(guildId)!.add(ws);

    // Send current state immediately on connect
    sendState(ws, guildId);

    ws.on('message', (data: Buffer) => {
      let msg: SyncMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleClientMessage(guildId, msg);
    });

    ws.on('close', () => {
      roomSockets.get(guildId)?.delete(ws);
    });
  });

  // Periodic sync heartbeat — keeps all clients aligned
  setInterval(() => {
    for (const [guildId, sockets] of roomSockets) {
      if (sockets.size === 0) continue;
      const room = getRoom(guildId);
      if (!room || room.state === 'stopped') continue;
      const payload = JSON.stringify({
        type: 'sync',
        state: room.state,
        currentTimeMs: getLiveTimeMs(room),
        ratingKey: currentItem(room)?.id,
      });
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      }
    }
  }, 5_000);
}

function sendState(ws: WebSocket, guildId: string): void {
  const room = getRoom(guildId);
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

function handleClientMessage(guildId: string, msg: SyncMessage): void {
  switch (msg.type) {
    case 'pause': {
      const room = pauseRoom(guildId);
      if (room) broadcast(guildId, { type: 'pause', currentTimeMs: room.currentTimeMs });
      break;
    }
    case 'play': {
      const room = resumeRoom(guildId);
      if (room) broadcast(guildId, { type: 'play', currentTimeMs: room.currentTimeMs });
      break;
    }
    case 'seek': {
      const ms = typeof msg.currentTimeMs === 'number' ? msg.currentTimeMs : 0;
      const room = seekRoom(guildId, ms);
      if (room) broadcast(guildId, { type: 'seek', currentTimeMs: ms });
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
