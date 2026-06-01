import {
  ChatInputCommandInteraction,
  ChannelType,
  Client,
  Guild,
  CategoryChannel,
  VoiceBasedChannel,
  VoiceState,
} from 'discord.js';
import {
  Room,
  createRoom,
  getRoom,
  getRoomByOwner,
  deleteRoom,
  setVoiceMembers,
  getActiveRooms,
} from '../rooms/manager';
import { getProviderForGuild } from '../providers';
import { broadcast, getConnectedCount } from '../server/sync';

const CATEGORY_NAME = 'Watch Parties';
const EMPTY_GRACE_MS = 120_000;
const REAP_INTERVAL_MS = 30_000;

// roomId -> timestamp it first went idle (no voice members AND no web viewers)
const idleSince = new Map<string, number>();

/** The user's current party room — by voice presence first, else ownership. */
export async function findUserRoom(interaction: ChatInputCommandInteraction): Promise<Room | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const vcId = member?.voice?.channelId;
  if (vcId) {
    const room = getRoom(vcId);
    if (room) return room;
  }
  return getRoomByOwner(interaction.user.id) ?? null;
}

/** Find the user's party, or create a new voice channel + room for them. */
export async function resolvePartyRoom(interaction: ChatInputCommandInteraction): Promise<Room | null> {
  const existing = await findUserRoom(interaction);
  if (existing) return existing;

  const guild = interaction.guild;
  if (!guild) return null;

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  const ownerName = member?.displayName ?? interaction.user.username;
  const category = await ensureCategory(guild);

  try {
    const channel = await guild.channels.create({
      name: `🎬 ${ownerName}'s Watch Party`.slice(0, 100),
      type: ChannelType.GuildVoice,
      parent: category?.id,
    });
    return createRoom({
      voiceChannelId: channel.id,
      guildId: guild.id,
      guildName: guild.name,
      channelName: channel.name,
      ownerId: interaction.user.id,
    });
  } catch {
    return null; // most likely missing the Manage Channels permission
  }
}

async function ensureCategory(guild: Guild): Promise<CategoryChannel | null> {
  const existing = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME,
  ) as CategoryChannel | undefined;
  if (existing) return existing;
  try {
    return await guild.channels.create({ name: CATEGORY_NAME, type: ChannelType.GuildCategory });
  } catch {
    return null;
  }
}

// ── Voice presence tracking ──────────────────────────────────────────────────

export function handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): void {
  const affected = new Set<string>();
  if (oldState.channelId) affected.add(oldState.channelId);
  if (newState.channelId) affected.add(newState.channelId);

  for (const channelId of affected) {
    if (!getRoom(channelId)) continue;
    const channel = newState.guild.channels.cache.get(channelId) as VoiceBasedChannel | undefined;
    const members = channel
      ? [...channel.members.values()].filter(m => !m.user.bot).map(m => ({ id: m.id, name: m.displayName }))
      : [];
    setVoiceMembers(channelId, members);
    broadcast(channelId, { type: 'participants', names: members.map(m => m.name) });
  }
}

/** A party is "occupied" if anyone is in its voice channel OR has the watch page open. */
function isOccupied(room: Room): boolean {
  return room.voiceMembers.length > 0 || getConnectedCount(room.id) > 0;
}

/**
 * Periodically tears down parties that have been idle (no voice members and no
 * web viewers) for longer than the grace period. Covers every case: abandoned
 * right after creation, everyone left voice, web viewers all closed the page.
 */
export function startPartyReaper(client: Client): void {
  setInterval(() => {
    const now = Date.now();
    for (const room of getActiveRooms()) {
      if (isOccupied(room)) {
        idleSince.delete(room.id);
        continue;
      }
      const since = idleSince.get(room.id) ?? now;
      idleSince.set(room.id, since);
      if (now - since >= EMPTY_GRACE_MS) {
        idleSince.delete(room.id);
        const channel = client.channels.cache.get(room.voiceChannelId);
        const vc = channel?.type === ChannelType.GuildVoice ? (channel as VoiceBasedChannel) : null;
        void teardownParty(room.id, vc);
      }
    }
  }, REAP_INTERVAL_MS);
}

/** Tear down a party: stop the transcode, notify viewers, delete room + channel. */
export async function teardownParty(roomId: string, channel: VoiceBasedChannel | null): Promise<void> {
  const room = getRoom(roomId);
  if (room) {
    if (room.transcodeSession) {
      const provider = getProviderForGuild(room.guildId);
      void provider?.stopSession?.(room.transcodeSession.id).catch(() => {});
    }
    broadcast(roomId, { type: 'stopped' });
    deleteRoom(roomId);
  }
  idleSince.delete(roomId);
  if (channel) await channel.delete().catch(() => {});
}

/** If a party's voice channel is deleted in Discord, clear its room state. */
export function handleChannelDelete(channelId: string): void {
  if (getRoom(channelId)) void teardownParty(channelId, null);
}

/** On startup, remove leftover empty party channels (room state is gone after a restart). */
export async function cleanupOrphanChannels(guild: Guild): Promise<void> {
  const category = guild.channels.cache.find(
    c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME,
  ) as CategoryChannel | undefined;
  if (!category) return;
  for (const channel of category.children.cache.values()) {
    if (channel.type !== ChannelType.GuildVoice) continue;
    const occupied = [...channel.members.values()].filter(m => !m.user.bot).length > 0;
    if (!occupied) await channel.delete().catch(() => {});
  }
}
