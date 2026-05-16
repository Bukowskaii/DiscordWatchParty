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
}

export interface MediaProvider {
  search(query: string, limit?: number): Promise<MediaItem[]>;
  getMetadata(id: string): Promise<MediaItem | null>;
  /** Fetch the HLS master playlist content from the media server */
  fetchHlsPlaylist(id: string): Promise<string>;
  /** Resolves a path from a rewritten M3U8 back to a full authenticated upstream URL */
  resolveStreamUrl(path: string): string;
  /** Full authenticated thumbnail URL, or null */
  getThumbUrl(id: string | undefined): string | null;
}
