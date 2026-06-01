import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Server } from 'http';
import { resolveSession, getRoom, pauseRoom, resumeRoom, seekRoom, getLiveTimeMs, currentItem } from '../rooms/manager';

interface SyncMessage {
  type: string;
  [key: string]: unknown;
}

// roomId -> set of connected sockets
const roomSockets = new Map<string, Set<WebSocket>>();

export function getConnectedCount(roomId: string): number {
  return roomSockets.get(roomId)?.size ?? 0;
}

export function broadcast(roomId: string, msg: SyncMessage): void {
  const sockets = roomSockets.get(roomId);
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
    const room = token ? resolveSession(token) : null;

    if (!room) {
      ws.close(4001, 'Invalid or expired session token');
      return;
    }

    const roomId = room.id;
    if (!roomSockets.has(roomId)) roomSockets.set(roomId, new Set());
    roomSockets.get(roomId)!.add(ws);

    // Send current state + the participant list (driven by Discord voice presence).
    sendState(ws, roomId);
    ws.send(JSON.stringify({ type: 'participants', names: room.voiceMembers.map(m => m.name) }));

    ws.on('message', (data: Buffer) => {
      let msg: SyncMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      handleClientMessage(roomId, msg);
    });

    ws.on('close', () => {
      roomSockets.get(roomId)?.delete(ws);
    });
  });

  // Periodic sync heartbeat — keeps all clients aligned
  setInterval(() => {
    for (const [roomId, sockets] of roomSockets) {
      if (sockets.size === 0) continue;
      const room = getRoom(roomId);
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

function handleClientMessage(roomId: string, msg: SyncMessage): void {
  switch (msg.type) {
    // Participants come from Discord voice presence, not the web page.
    case 'join':
      break;
    case 'pause': {
      const room = pauseRoom(roomId);
      if (room) broadcast(roomId, { type: 'pause', currentTimeMs: room.currentTimeMs });
      break;
    }
    case 'play': {
      const room = resumeRoom(roomId);
      if (room) broadcast(roomId, { type: 'play', currentTimeMs: room.currentTimeMs });
      break;
    }
    case 'seek': {
      const ms = typeof msg.currentTimeMs === 'number' ? msg.currentTimeMs : 0;
      const room = seekRoom(roomId, ms);
      if (room) broadcast(roomId, { type: 'seek', currentTimeMs: ms });
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
