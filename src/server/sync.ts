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

// ws → display name (set on join)
const socketNames = new Map<WebSocket, string>();

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
      handleClientMessage(guildId, ws, msg);
    });

    ws.on('close', () => {
      const name = socketNames.get(ws);
      roomSockets.get(guildId)?.delete(ws);
      socketNames.delete(ws);
      if (name) {
        broadcast(guildId, { type: 'notification', text: `${name} left` });
        broadcastParticipants(guildId);
      }
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

function broadcastParticipants(guildId: string): void {
  const sockets = roomSockets.get(guildId);
  const names = sockets
    ? [...sockets]
        .filter(s => s.readyState === WebSocket.OPEN && socketNames.has(s))
        .map(s => socketNames.get(s)!)
    : [];
  broadcast(guildId, { type: 'participants', names });
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

function handleClientMessage(guildId: string, ws: WebSocket, msg: SyncMessage): void {
  switch (msg.type) {
    case 'join': {
      const raw = typeof msg.name === 'string' ? msg.name.trim().slice(0, 32) : '';
      const name = raw || 'Someone';
      socketNames.set(ws, name);
      broadcast(guildId, { type: 'notification', text: `${name} joined` });
      broadcastParticipants(guildId);
      break;
    }
    case 'pause': {
      const room = pauseRoom(guildId);
      if (room) {
        const name = socketNames.get(ws) ?? 'Someone';
        broadcast(guildId, { type: 'pause', currentTimeMs: room.currentTimeMs });
        broadcast(guildId, { type: 'notification', text: `${name} paused` });
      }
      break;
    }
    case 'play': {
      const room = resumeRoom(guildId);
      if (room) {
        const name = socketNames.get(ws) ?? 'Someone';
        broadcast(guildId, { type: 'play', currentTimeMs: room.currentTimeMs });
        broadcast(guildId, { type: 'notification', text: `${name} resumed` });
      }
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
