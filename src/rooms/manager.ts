import { randomUUID } from 'crypto';
import { config } from '../config';
import type { MediaItem } from '../providers/types';

export interface Room {
  guildId: string;
  guildName?: string;
  queue: MediaItem[];
  currentIndex: number;
  state: 'playing' | 'paused' | 'stopped';
  /** Playback position in ms at the moment `lastSyncAt` was recorded. */
  currentTimeMs: number;
  /** Date.now() when currentTimeMs was last set. */
  lastSyncAt: number;
}

interface Session {
  token: string;
  guildId: string;
  expiresAt: number;
}

const rooms = new Map<string, Room>();
const sessions = new Map<string, Session>();

// ── Room helpers ─────────────────────────────────────────────────────────────

export function getRoom(guildId: string): Room | undefined {
  return rooms.get(guildId);
}

export function getActiveRooms(): Room[] {
  return [...rooms.values()].filter(r => r.state !== 'stopped' || r.queue.length > 0);
}

export function setGuildName(guildId: string, name: string): void {
  const room = rooms.get(guildId);
  if (room) room.guildName = name;
}

export function getOrCreateRoom(guildId: string): Room {
  if (!rooms.has(guildId)) {
    rooms.set(guildId, {
      guildId,
      queue: [],
      currentIndex: 0,
      state: 'stopped',
      currentTimeMs: 0,
      lastSyncAt: Date.now(),
    });
  }
  return rooms.get(guildId)!;
}

export function addToQueue(guildId: string, item: MediaItem): Room {
  const room = getOrCreateRoom(guildId);
  room.queue.push(item);
  if (room.state === 'stopped') startPlayback(room);
  return room;
}

export function startPlayback(room: Room): void {
  room.state = 'playing';
  room.currentTimeMs = 0;
  room.lastSyncAt = Date.now();
}

export function pauseRoom(guildId: string): Room | null {
  const room = rooms.get(guildId);
  if (!room || room.state !== 'playing') return null;
  room.currentTimeMs = getLiveTimeMs(room);
  room.lastSyncAt = Date.now();
  room.state = 'paused';
  return room;
}

export function resumeRoom(guildId: string): Room | null {
  const room = rooms.get(guildId);
  if (!room || room.state !== 'paused') return null;
  room.lastSyncAt = Date.now();
  room.state = 'playing';
  return room;
}

export function skipRoom(guildId: string): Room | null {
  const room = rooms.get(guildId);
  if (!room) return null;
  room.currentIndex += 1;
  if (room.currentIndex >= room.queue.length) {
    room.state = 'stopped';
    room.currentIndex = 0;
    room.queue = [];
  } else {
    startPlayback(room);
  }
  return room;
}

export function stopRoom(guildId: string): Room | null {
  const room = rooms.get(guildId);
  if (!room) return null;
  room.state = 'stopped';
  room.queue = [];
  room.currentIndex = 0;
  room.currentTimeMs = 0;
  return room;
}

export function seekRoom(guildId: string, ms: number): Room | null {
  const room = rooms.get(guildId);
  if (!room || room.state === 'stopped') return null;
  room.currentTimeMs = ms;
  room.lastSyncAt = Date.now();
  return room;
}

/** Returns the calculated playback position accounting for elapsed wall time. */
export function getLiveTimeMs(room: Room): number {
  if (room.state !== 'playing') return room.currentTimeMs;
  return room.currentTimeMs + (Date.now() - room.lastSyncAt);
}

export function currentItem(room: Room): MediaItem | null {
  return room.queue[room.currentIndex] ?? null;
}

// ── Session helpers ──────────────────────────────────────────────────────────

export function createSession(guildId: string): string {
  purgeExpiredSessions();
  const token = randomUUID();
  sessions.set(token, {
    token,
    guildId,
    expiresAt: Date.now() + config.sessionTtlMs,
  });
  return token;
}

export function resolveSession(token: string): Room | null {
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return rooms.get(session.guildId) ?? null;
}

export function resolveSessionGuildId(token: string): string | null {
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.guildId;
}

function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}
