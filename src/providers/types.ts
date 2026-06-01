export interface MediaItem {
  /** Provider-agnostic item ID (ratingKey for Plex, ItemId for Jellyfin/Emby) */
  id: string;
  title: string;
  year?: number;
  type: 'movie' | 'episode' | 'season' | 'show' | 'track' | string;
  duration: number; // milliseconds
  /** Show/series name for episodes */
  grandparentTitle?: string;
  /** Episode number */
  index?: number;
  /** Season number */
  parentIndex?: number;
  /** Provider-specific key used for direct-play fallback */
  partKey?: string;
  /** Short synopsis, when available */
  summary?: string;
}

export interface MediaProvider {
  search(query: string, limit?: number): Promise<MediaItem[]>;
  getMetadata(id: string): Promise<MediaItem | null>;
  /**
   * Fetch the streaming manifest. Returns content and the protocol used.
   * `sessionId` is a stable per-room transcode session — all viewers of the
   * same room share it so the upstream only runs one transcode (Plex rejects
   * a second concurrent `start.mpd` session with a 400).
   */
  fetchPlaylist(id: string, proxyBase: string, sessionId?: string): Promise<{ content: string; protocol: 'hls' | 'dash' }>;
  /** Fetch a sub-playlist (second-level M3U8) — HLS providers only */
  fetchSubPlaylist?(path: string): Promise<string>;
  /** Tear down an upstream transcode session (best-effort) — Plex only */
  stopSession?(sessionId: string): Promise<void>;
  /** Resolves a provider-relative path to a full authenticated upstream URL */
  resolveStreamUrl(path: string): string;
  /** Full authenticated thumbnail URL, or null */
  getThumbUrl(id: string | undefined): string | null;
  /** Children of a container item (show → seasons, season → episodes) */
  getChildren?(id: string): Promise<MediaItem[]>;
  /**
   * Report playback progress to the upstream so the watch party appears in the
   * server's "Now Playing" dashboard and tools like Tautulli — Plex only.
   */
  reportTimeline?(update: TimelineUpdate): Promise<void>;
}

export interface TimelineUpdate {
  /** Provider item ID (Plex ratingKey) */
  itemId: string;
  /** The shared transcode/session identifier for this room */
  sessionId: string;
  state: 'playing' | 'paused' | 'stopped' | 'buffering';
  /** Current playback position in ms */
  timeMs: number;
  /** Total duration in ms */
  durationMs: number;
}
