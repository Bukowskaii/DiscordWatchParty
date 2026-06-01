import axios, { AxiosInstance } from 'axios';
import { randomBytes } from 'crypto';

/** Generates a 24-char lowercase-alphanumeric ID in Plex's session format. */
export function plexSessionId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(randomBytes(24), b => chars[b % chars.length]).join('');
}
import * as http from 'http';
import * as https from 'https';
import type { MediaItem, MediaProvider, TimelineUpdate } from './types';

const CLIENT_ID = 'discordwatchparty-bot';

const xmlAttr = (tag: string, name: string): string =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? '';

/**
 * Resolves the token to use for playback as another user, by name.
 *
 * The server authorizes a shared user via a *server-specific* access token
 * (from its `shared_servers` record) — NOT the user's generic account token.
 * So we look up the share for this server and return that accessToken. Managed
 * Home users have a blank username in the share list, so we map their display
 * name → userID via the Home users list first. Returns null if no share matches.
 */
export async function fetchPlaybackToken(
  adminToken: string,
  serverUrl: string,
  userName: string,
): Promise<string | null> {
  const headers = { 'X-Plex-Client-Identifier': CLIENT_ID, Accept: 'application/xml' };
  const wanted = userName.trim().toLowerCase();

  // Need the server's machine identifier to query its shares (/identity is
  // unauthenticated).
  let machineId: string | undefined;
  try {
    const idRes = await axios.get(`${serverUrl}/identity`, { headers: { Accept: 'application/json' }, timeout: 8_000 });
    machineId = idRes.data?.MediaContainer?.machineIdentifier;
  } catch { return null; }
  if (!machineId) return null;

  // Fetch the server's shared users — each carries a server-specific accessToken.
  let shares: { userID: string; username: string; accessToken: string }[];
  try {
    const res = await axios.get<string>(
      `https://plex.tv/api/servers/${machineId}/shared_servers?X-Plex-Token=${encodeURIComponent(adminToken)}`,
      { headers, responseType: 'text', timeout: 10_000 },
    );
    shares = (res.data.match(/<SharedServer\b[^>]*>/g) ?? []).map(tag => ({
      userID: xmlAttr(tag, 'userID'),
      username: xmlAttr(tag, 'username'),
      accessToken: xmlAttr(tag, 'accessToken'),
    }));
  } catch { return null; }

  // 1. Full (invited) accounts carry a username in the share list.
  let match = shares.find(s => s.username.toLowerCase() === wanted);

  // 2. Managed Home users have a blank share username — map name → userID via
  //    the Home users list, then match the share by userID.
  if (!match) {
    try {
      const home = await axios.get<string>(
        `https://plex.tv/api/home/users?X-Plex-Token=${encodeURIComponent(adminToken)}`,
        { headers, responseType: 'text', timeout: 10_000 },
      );
      for (const tag of home.data.match(/<User\b[^>]*>/g) ?? []) {
        const title = xmlAttr(tag, 'title').toLowerCase();
        const uname = xmlAttr(tag, 'username').toLowerCase();
        if (title === wanted || uname === wanted) {
          const userID = xmlAttr(tag, 'id');
          match = shares.find(s => s.userID === userID);
          break;
        }
      }
    } catch { /* fall through to null */ }
  }

  return match?.accessToken || null;
}

interface PlexRawMetadata {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  duration?: number;
  grandparentTitle?: string;
  index?: number;
  parentIndex?: number;
  summary?: string;
  Media?: { Part?: { key: string }[] }[];
}

interface PlexSearchHub {
  type: string;
  Metadata?: PlexRawMetadata[];
}

function rewriteMpdUrls(mpd: string, _plexUrl: string, proxyDashBase: string): string {
  // Plex's DASH MPD uses SegmentTemplate paths that are *relative to the
  // start.mpd location* (/video/:/transcode/universal/), e.g.
  //   media="session/<id>/$RepresentationID$/$Number$.m4s"
  // and ships no <BaseURL>. Because we serve the manifest from
  // /stream/<token>/manifest, those relative paths would resolve against the
  // wrong base. Inject an absolute <BaseURL> pointing through our /dash proxy
  // at the transcode directory so every segment request routes nginx → Plex.
  // nginx strips the /stream/<token>/dash prefix back to /video/:/transcode/...
  const baseUrl = `${proxyDashBase}/video/:/transcode/universal/`;
  return mpd.replace(/(<MPD\b[^>]*>)/, `$1\n\t<BaseURL>${baseUrl}</BaseURL>`);
}

function mapMetadata(raw: PlexRawMetadata): MediaItem {
  return {
    id: raw.ratingKey,
    title: raw.title,
    year: raw.year,
    type: raw.type as MediaItem['type'],
    duration: raw.duration ?? 0,
    grandparentTitle: raw.grandparentTitle,
    index: raw.index,
    parentIndex: raw.parentIndex,
    partKey: raw.Media?.[0]?.Part?.[0]?.key,
    summary: raw.summary,
  };
}

export class PlexProvider implements MediaProvider {
  private readonly http: AxiosInstance;
  /** Token used for playback (streaming + timeline). Falls back to the admin
   *  token when no dedicated playback user is configured. */
  private readonly playbackToken: string;

  constructor(private readonly url: string, private readonly token: string, playbackToken?: string) {
    this.playbackToken = playbackToken || token;
    this.http = axios.create({
      baseURL: url,
      params: { 'X-Plex-Token': token },
      headers: {
        Accept: 'application/json',
        'X-Plex-Client-Identifier': CLIENT_ID,
        'X-Plex-Product': 'Plex Web',
        'X-Plex-Version': '4.159.0',
        'X-Plex-Platform': 'Chrome',
        'X-Plex-Platform-Version': '148.0',
        'X-Plex-Features': 'external-media,indirect-media,hub-style-list',
        'X-Plex-Model': 'bundled',
        'X-Plex-Device': 'Windows',
        'X-Plex-Device-Name': 'Chrome',
      },
    });
  }

  async search(query: string, limit = 8): Promise<MediaItem[]> {
    const res = await this.http.get('/hubs/search', { params: { query, limit } });
    const hubs: PlexSearchHub[] = res.data?.MediaContainer?.Hub ?? [];

    // Only surface movies and shows. Individual episodes are reachable by
    // drilling into a show (show → season → episode), so we don't clutter
    // results with loose episode matches.
    const buckets: Record<string, MediaItem[]> = {};
    for (const hub of hubs) {
      if (!['movie', 'show'].includes(hub.type)) continue;
      buckets[hub.type] ??= [];
      for (const item of hub.Metadata ?? []) buckets[hub.type].push(mapMetadata(item));
    }

    const ordered = [...(buckets.movie ?? []), ...(buckets.show ?? [])];
    return ordered.slice(0, limit);
  }

  async getMetadata(id: string): Promise<MediaItem | null> {
    const res = await this.http.get(`/library/metadata/${id}`);
    const raw: PlexRawMetadata | undefined = res.data?.MediaContainer?.Metadata?.[0];
    return raw ? mapMetadata(raw) : null;
  }

  async getChildren(id: string): Promise<MediaItem[]> {
    const res = await this.http.get(`/library/metadata/${id}/children`);
    const items: PlexRawMetadata[] = res.data?.MediaContainer?.Metadata ?? [];
    // Skip synthetic "All episodes" type entries that have no playable index
    return items.filter(i => i.ratingKey).map(mapMetadata);
  }

  async fetchPlaylist(id: string, proxyBase: string, sessionId?: string): Promise<{ content: string; protocol: 'dash' }> {
    // One value drives both `session` (transcode session) and
    // `X-Plex-Session-Identifier` (playback session). Reusing the same value
    // across requests makes Plex return the existing transcode instead of
    // trying to start a second one (which it rejects with 400).
    const session = sessionId ?? plexSessionId();
    const clientProfile =
      'add-limitation(scope=videoCodec&scopeName=hevc&type=upperBound&name=video.bitDepth&value=10&replace=true)' +
      '+add-limitation(scope=videoCodec&scopeName=*&type=upperBound&name=video.bitrate&value=20000&replace=true)' +
      '+append-transcode-target-codec(type=videoProfile&context=streaming&protocol=dash&videoCodec=hevc)' +
      '+append-transcode-target-codec(type=videoProfile&context=streaming&videoCodec=h264,hevc&audioCodec=aac&protocol=dash)';

    // Use URLSearchParams (not axios params) to match Plex Web's exact URL encoding.
    // Axios leaves ( and ) unencoded; URLSearchParams encodes them as %28/%29 which Plex requires.
    const qs = new URLSearchParams({
      'X-Plex-Token': this.playbackToken,
      'X-Plex-Client-Identifier': CLIENT_ID,
      'X-Plex-Product': 'Plex Web',
      'X-Plex-Version': '4.159.0',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Platform-Version': '148.0',
      'X-Plex-Features': 'external-media,indirect-media,hub-style-list',
      'X-Plex-Model': 'bundled',
      'X-Plex-Device': 'Windows',
      'X-Plex-Device-Name': 'Chrome',
      'X-Plex-Incomplete-Segments': '1',
      'X-Plex-Session-Identifier': session,
      'X-Plex-Client-Profile-Extra': clientProfile,
      hasMDE: '1',
      path: `/library/metadata/${id}`,
      mediaIndex: '0',
      partIndex: '0',
      protocol: 'dash',
      fastSeek: '1',
      directPlay: '0',
      directStream: '1',
      subtitleSize: '100',
      audioBoost: '700',
      location: 'lan',
      maxVideoBitrate: '20000',
      addDebugOverlay: '0',
      autoAdjustQuality: '1',
      directStreamAudio: '0',
      mediaBufferSize: '102400',
      session,
      subtitles: 'auto',
    });

    const mpdUrl = new URL(`${this.url}/video/:/transcode/universal/start.mpd?${qs.toString()}`);
    const transport = mpdUrl.protocol === 'https:' ? https : http;

    const requestOnce = (): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = transport.get({
          hostname: mpdUrl.hostname,
          port: mpdUrl.port || (mpdUrl.protocol === 'https:' ? 443 : 80),
          path: mpdUrl.pathname + mpdUrl.search,
          headers: { 'X-Plex-Session-Identifier': session },
        }, res => {
          let body = '';
          res.on('data', (c: Buffer) => body += c.toString());
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
      });

    // Plex briefly locks while creating a transcode session, so a near-simultaneous
    // start (e.g. two parties beginning at once) can collide and return a transient
    // 4xx. Retry a few times before giving up.
    let last = { status: 0, body: '' };
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 400));
      last = await requestOnce();
      if (last.status === 200) {
        const content = rewriteMpdUrls(last.body, this.url, `${proxyBase}/dash`);
        return { content, protocol: 'dash' };
      }
    }
    throw new Error(`Plex DASH returned ${last.status}: ${last.body.slice(0, 200)}`);
  }

  /** Best-effort teardown so an old transcode doesn't block the next one. */
  async stopSession(sessionId: string): Promise<void> {
    const qs = new URLSearchParams({
      'X-Plex-Token': this.playbackToken,
      'X-Plex-Client-Identifier': CLIENT_ID,
      session: sessionId,
    });
    const stopUrl = new URL(`${this.url}/video/:/transcode/universal/stop?${qs.toString()}`);
    const transport = stopUrl.protocol === 'https:' ? https : http;
    await new Promise<void>(resolve => {
      const req = transport.get({
        hostname: stopUrl.hostname,
        port: stopUrl.port || (stopUrl.protocol === 'https:' ? 443 : 80),
        path: stopUrl.pathname + stopUrl.search,
      }, res => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
    });
  }

  /**
   * Report playback progress via Plex's /:/timeline endpoint so the session
   * shows up in Now Playing / Tautulli. Identity (client + session id) matches
   * the start.mpd request so Plex correlates it with the live transcode.
   * Best-effort: failures are swallowed.
   */
  async reportTimeline(update: TimelineUpdate): Promise<void> {
    const qs = new URLSearchParams({
      ratingKey: update.itemId,
      key: `/library/metadata/${update.itemId}`,
      state: update.state,
      time: String(Math.max(0, Math.floor(update.timeMs))),
      duration: String(Math.max(0, Math.floor(update.durationMs))),
      hasMDE: '1',
      'X-Plex-Token': this.playbackToken,
      'X-Plex-Client-Identifier': CLIENT_ID,
      'X-Plex-Session-Identifier': update.sessionId,
      'X-Plex-Product': 'Plex Web',
      'X-Plex-Version': '4.159.0',
      'X-Plex-Platform': 'Chrome',
      'X-Plex-Platform-Version': '148.0',
      'X-Plex-Device': 'Windows',
      'X-Plex-Device-Name': 'Discord Watch Party',
    });
    const url = new URL(`${this.url}/:/timeline?${qs.toString()}`);
    const transport = url.protocol === 'https:' ? https : http;
    await new Promise<void>(resolve => {
      const req = transport.get({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers: { 'X-Plex-Session-Identifier': update.sessionId },
      }, res => {
        res.on('data', () => {});
        res.on('end', () => resolve());
      });
      req.on('error', () => resolve());
    });
  }

  resolveStreamUrl(path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const sep = normalizedPath.includes('?') ? '&' : '?';
    return `${this.url}${normalizedPath}${sep}X-Plex-Token=${this.playbackToken}`;
  }

  getThumbUrl(id: string | undefined): string | null {
    if (!id) return null;
    return `${this.url}/photo/:/transcode?url=${encodeURIComponent(`/library/metadata/${id}/thumb`)}&width=200&height=300&X-Plex-Token=${this.token}`;
  }
}
