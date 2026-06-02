import * as http from 'http';
import * as https from 'https';
import { config } from '../config';
import { getActiveRooms, getRoom, getLiveTimeMs, createSession } from '../rooms/manager';
import { getConnectedCount } from './sync';

// The pacer is a synthetic front-runner. For each playing room with at least one
// connected viewer it walks the DASH segment sequence through nginx — taking the
// edge MISS / transcode latency itself and warming the shared segment cache — so
// every real viewer (held LIVE_DELAY_MS behind by the client) reads fully-cached
// segments. One Plex transcode produces ~at real time, so the pacer naturally
// rides the production frontier; the win is that humans never sit on it.

const SUPERVISE_MS = 2_000;
// Plex universal DASH transcode representations: 0 = video, 1 = audio (observed,
// stable). Override via PACER_REPS (comma-separated) if a server differs.
const REPS = (process.env.PACER_REPS ?? '0,1').split(',').map(s => s.trim()).filter(Boolean);
// Approximate segment duration (seconds). Only used to map playback time -> the
// segment index; the exact value isn't critical. Override via PACER_SEGMENT_SECONDS.
const SEGMENT_SECONDS = Number(process.env.PACER_SEGMENT_SECONDS ?? '5') || 5;
const START_NUMBER = 0;
// Stay at most this many segments ahead of the live playback position. Kept small
// on purpose: the pacer must never request far beyond Plex's production frontier,
// or it could cache an incomplete segment. The real viewers' cached margin comes
// from the client-side LIVE_DELAY, not from this lead.
const LEAD_SEGMENTS = 3;
// How far BELOW the live room position the pacer keeps the cache warm. Real
// viewers play LIVE_DELAY (~20s, watch.html) behind the live edge, so the
// segment a client actually requests sits this many segments below playN.
// Default 30s (= 6 segments at 5s) covers the 20s live-delay plus a 10s
// back-hop. Override via PACER_BEHIND_MS.
const BEHIND_SEGMENTS = Math.ceil(
  (Number(process.env.PACER_BEHIND_MS ?? '30000') || 30000) / 1000 / SEGMENT_SECONDS,
);
const FETCH_TIMEOUT_MS = 25_000;

interface Pacer { sessionId: string; cancelled: boolean; }
const pacers = new Map<string, Pacer>(); // roomId -> pacer

/** Boot the pacer supervisor. Call once at server start. */
export function startPacer(): void {
  setInterval(supervise, SUPERVISE_MS);
}

function supervise(): void {
  for (const room of getActiveRooms()) {
    const session = room.transcodeSession;
    const want = room.state !== 'stopped' && !!session && getConnectedCount(room.id) > 0;
    const cur = pacers.get(room.id);

    // Session changed (item switched / restart) — cancel so we relaunch fresh.
    if (cur && session && cur.sessionId !== session.id) {
      cur.cancelled = true;
      pacers.delete(room.id);
    }

    if (want && !pacers.has(room.id)) {
      void launch(room.id, session!.id);
    } else if (!want && cur) {
      cur.cancelled = true;
      pacers.delete(room.id);
    }
  }
  // Drop pacers for rooms that no longer exist.
  for (const [roomId, p] of pacers) {
    if (!getRoom(roomId)) {
      p.cancelled = true;
      pacers.delete(roomId);
    }
  }
}

async function launch(roomId: string, sessionId: string): Promise<void> {
  const pacer: Pacer = { sessionId, cancelled: false };
  pacers.set(roomId, pacer);

  // Synthetic watch token (no viewer -> never shows in the participant list).
  const token = createSession(roomId);

  try {
    // Warm the init segments once.
    for (const rep of REPS) {
      if (pacer.cancelled) return;
      await fetchSegment(token, sessionId, rep, 'header');
    }

    let nextN = START_NUMBER;
    let lastPlayN = START_NUMBER;
    let endN = Infinity; // set once we run off the end of the stream

    while (!pacer.cancelled) {
      const room = getRoom(roomId);
      if (!room || room.state === 'stopped' || room.transcodeSession?.id !== sessionId) break;

      const playN = START_NUMBER + Math.floor(getLiveTimeMs(room) / 1000 / SEGMENT_SECONDS);
      // Real viewers read LIVE_DELAY behind the live room position, so the segment
      // a client actually requests sits BEHIND_SEGMENTS *below* playN. Keep the
      // pacer's floor there (not at playN) so the pacer — not a real viewer —
      // takes any MISS across the whole trailing read window.
      const floorN = Math.max(START_NUMBER, playN - BEHIND_SEGMENTS);
      // Backward seek (clients can only hop back in 10s steps — no forward seek)
      // or a fresh launch mid-party: drop the pacer back to the trailing window so
      // it re-warms the rewound/old segments itself. A 10s hop moves the room ~10s,
      // but the client's read target sits a further LIVE_DELAY back — which is why
      // re-pacing from playN alone left a real viewer to take the MISS. playN is
      // monotonic during play and frozen while paused, so a decrease means a
      // rewind. Re-fetching still-cached segments is a cheap nginx HIT, so
      // over-covering the window is harmless.
      if (playN < lastPlayN || nextN < floorN) nextN = floorN;
      lastPlayN = playN;
      const leadN = Math.min(endN, playN + LEAD_SEGMENTS);

      if (nextN > leadN) { await sleep(500); continue; } // caught up — idle

      let hitEnd = false;
      for (const rep of REPS) {
        if (pacer.cancelled) break;
        const status = await fetchSegment(token, sessionId, rep, `${nextN}.m4s`);
        if (status === 404) hitEnd = true;           // past the end of the media
      }
      if (hitEnd) { endN = nextN; await sleep(1_000); continue; }
      nextN++;
    }
  } catch {
    /* best-effort; the supervisor will relaunch if still wanted */
  } finally {
    if (pacers.get(roomId) === pacer) pacers.delete(roomId);
    // The synthetic token is left to expire via session TTL; deleteRoom purges it on teardown.
  }
}

/**
 * GET a segment through nginx so the response is cached for real viewers. Drains
 * and discards the body. Resolves to the HTTP status (0 on transport error/timeout);
 * never rejects.
 */
function fetchSegment(token: string, sessionId: string, rep: string, seg: string): Promise<number> {
  const url = new URL(
    `${config.server.nginxInternalUrl}/stream/${token}/dash/video/:/transcode/universal/session/${sessionId}/${rep}/${seg}`,
  );
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise<number>(resolve => {
    const req = transport.get(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
      },
      res => {
        res.on('data', () => { /* drain */ });
        res.on('end', () => resolve(res.statusCode ?? 0));
        res.on('error', () => resolve(0));
      },
    );
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy());
    req.on('error', () => resolve(0));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
