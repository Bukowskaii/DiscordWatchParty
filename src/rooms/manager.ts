import { randomUUID } from 'crypto';
import { config } from '../config';
import type { MediaItem } from '../providers/types';

export interface VoiceMember {
  id: string;
  name: string;
}

export interface Room {
  /** Room id — same as the voice channel id. */
  id: string;
  guildId: string;
  guildName?: string;
  voiceChannelId: string;
  channelName: string;
  /** Discord user id of whoever started the party. */
  ownerId: string;
  queue: MediaItem[];
  currentIndex: number;
  state: 'playing' | 'paused' | 'stopped';
  /** Playback position in ms at the moment `lastSyncAt` was recorded. */
  currentTimeMs: number;
  /** Date.now() when currentTimeMs was last set. */
  lastSyncAt: number;
  /** Shared upstream transcode session for the current item (one per room). */
  transcodeSession?: { id: string; itemId: string };
  /** Members currently connected to the party's voice channel. */
  voiceMembers: VoiceMember[];
}

interface Session {
  token: string;
  roomId: string;
  expiresAt: number;
}

const rooms = new Map<string, Room>();        // roomId (= voiceChannelId) -> Room
const ownerIndex = new Map<string, string>(); // ownerId -> roomId
const sessions = new Map<string, Session>();   // token -> session

// ── Room lifecycle ─────────────────────────────────────────────────────────────

export function createRoom(opts: {
  voiceChannelId: string;
  guildId: string;
  guildName?: string;
  channelName: string;
  ownerId: string;
}): Room {
  const room: Room = {
    id: opts.voiceChannelId,
    guildId: opts.guildId,
    guildName: opts.guildName,
    voiceChannelId: opts.voiceChannelId,
    channelName: opts.channelName,
    ownerId: opts.ownerId,
    queue: [],
    currentIndex: 0,
    state: 'stopped',
    currentTimeMs: 0,
    lastSyncAt: Date.now(),
    voiceMembers: [],
  };
  rooms.set(room.id, room);
  ownerIndex.set(opts.ownerId, room.id);
  return room;
}

export function getRoom(roomId: string): Room | undefined {
  return rooms.get(roomId);
}

export function getRoomByOwner(ownerId: string): Room | undefined {
  const roomId = ownerIndex.get(ownerId);
  return roomId ? rooms.get(roomId) : undefined;
}

export function getActiveRooms(): Room[] {
  return [...rooms.values()];
}

export function deleteRoom(roomId: string): Room | undefined {
  const room = rooms.get(roomId);
  if (!room) return undefined;
  rooms.delete(roomId);
  if (ownerIndex.get(room.ownerId) === roomId) ownerIndex.delete(room.ownerId);
  for (const [token, s] of sessions) if (s.roomId === roomId) sessions.delete(token);
  return room;
}

export function setGuildName(roomId: string, name: string): void {
  const room = rooms.get(roomId);
  if (room) room.guildName = name;
}

export function setVoiceMembers(roomId: string, members: VoiceMember[]): void {
  const room = rooms.get(roomId);
  if (room) room.voiceMembers = members;
}

// ── Queue & playback ───────────────────────────────────────────────────────────

export function addToQueue(roomId: string, item: MediaItem): Room | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.queue.push(item);
  if (room.state === 'stopped') startPlayback(room);
  return room;
}

export function startPlayback(room: Room): void {
  room.state = 'paused';
  room.currentTimeMs = 0;
  room.lastSyncAt = Date.now();
}

export function pauseRoom(roomId: string): Room | null {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return null;
  room.currentTimeMs = getLiveTimeMs(room);
  room.lastSyncAt = Date.now();
  room.state = 'paused';
  return room;
}

export function resumeRoom(roomId: string): Room | null {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'paused') return null;
  room.lastSyncAt = Date.now();
  room.state = 'playing';
  return room;
}

export function skipRoom(roomId: string): Room | null {
  const room = rooms.get(roomId);
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

export function stopRoom(roomId: string): Room | null {
  const room = rooms.get(roomId);
  if (!room) return null;
  room.state = 'stopped';
  room.queue = [];
  room.currentIndex = 0;
  room.currentTimeMs = 0;
  return room;
}

export function seekRoom(roomId: string, ms: number): Room | null {
  const room = rooms.get(roomId);
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

// ── Session (watch token) helpers ────────────────────────────────────────────

export function createSession(roomId: string): string {
  purgeExpiredSessions();
  const token = randomUUID();
  sessions.set(token, { token, roomId, expiresAt: Date.now() + config.sessionTtlMs });
  return token;
}

export function resolveSession(token: string): Room | null {
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return rooms.get(session.roomId) ?? null;
}

export function resolveSessionRoomId(token: string): string | null {
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session.roomId;
}

function purgeExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt < now) sessions.delete(token);
  }
}
