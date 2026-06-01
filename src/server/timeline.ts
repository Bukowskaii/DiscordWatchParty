import { getActiveRooms, getRoom, getLiveTimeMs, currentItem } from '../rooms/manager';
import { getProviderForGuild } from '../providers';

// Tracks what we last reported per room so we can emit a single `stopped`
// event once a room is no longer playing — otherwise the session would linger
// in the dashboard until the upstream times it out.
interface Reported {
  guildId: string;
  sessionId: string;
  itemId: string;
  durationMs: number;
}
const reported = new Map<string, Reported>(); // roomId -> last report

const INTERVAL_MS = 5_000;

/** Periodically reports playback progress to upstream providers (Plex). */
export function startTimelineReporter(): void {
  setInterval(tick, INTERVAL_MS);
}

function tick(): void {
  const stillActive = new Set<string>();

  for (const room of getActiveRooms()) {
    if (room.state === 'stopped' || !room.transcodeSession) continue;
    const item = currentItem(room);
    if (!item) continue;
    const provider = getProviderForGuild(room.guildId);
    if (!provider?.reportTimeline) continue;

    stillActive.add(room.id);
    reported.set(room.id, {
      guildId: room.guildId,
      sessionId: room.transcodeSession.id,
      itemId: item.id,
      durationMs: item.duration,
    });

    void provider.reportTimeline({
      itemId: item.id,
      sessionId: room.transcodeSession.id,
      state: room.state === 'playing' ? 'playing' : 'paused',
      timeMs: getLiveTimeMs(room),
      durationMs: item.duration,
    }).catch(() => { /* best-effort */ });
  }

  // Emit a final `stopped` for rooms we were reporting that have gone idle.
  for (const [roomId, prev] of reported) {
    if (stillActive.has(roomId)) continue;
    reported.delete(roomId);
    const provider = getProviderForGuild(prev.guildId);
    if (!provider?.reportTimeline) continue;
    const room = getRoom(roomId);
    void provider.reportTimeline({
      itemId: prev.itemId,
      sessionId: prev.sessionId,
      state: 'stopped',
      timeMs: room ? getLiveTimeMs(room) : 0,
      durationMs: prev.durationMs,
    }).catch(() => { /* best-effort */ });
  }
}
