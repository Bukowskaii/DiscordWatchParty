import axios, { AxiosInstance } from 'axios';
import type { MediaItem, MediaProvider } from './types';

const CLIENT_ID = 'discordwatchparty-bot';

interface PlexRawMetadata {
  ratingKey: string;
  title: string;
  year?: number;
  type: string;
  duration?: number;
  grandparentTitle?: string;
  index?: number;
  parentIndex?: number;
  Media?: { Part?: { key: string }[] }[];
}

interface PlexSearchHub {
  type: string;
  Metadata?: PlexRawMetadata[];
}

function resolveRelativeM3U8(content: string, base: string): string {
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('http') || trimmed.startsWith('/')) return line;
    return base + trimmed;
  }).join('\n');
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
  };
}

export class PlexProvider implements MediaProvider {
  private readonly http: AxiosInstance;

  constructor(private readonly url: string, private readonly token: string) {
    this.http = axios.create({
      baseURL: url,
      params: { 'X-Plex-Token': token },
      headers: {
        Accept: 'application/json',
        'X-Plex-Client-Identifier': CLIENT_ID,
        'X-Plex-Product': 'DiscordWatchParty',
        'X-Plex-Version': '1.0.0',
        'X-Plex-Platform': 'Web',
        'X-Plex-Device-Name': 'DiscordWatchParty Bot',
      },
    });
  }

  async search(query: string, limit = 8): Promise<MediaItem[]> {
    const res = await this.http.get('/hubs/search', { params: { query, limit } });
    const hubs: PlexSearchHub[] = res.data?.MediaContainer?.Hub ?? [];
    const results: MediaItem[] = [];

    for (const hub of hubs) {
      if (!['movie', 'episode', 'track'].includes(hub.type)) continue;
      for (const item of hub.Metadata ?? []) {
        results.push(mapMetadata(item));
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  async getMetadata(id: string): Promise<MediaItem | null> {
    const res = await this.http.get(`/library/metadata/${id}`);
    const raw: PlexRawMetadata | undefined = res.data?.MediaContainer?.Metadata?.[0];
    return raw ? mapMetadata(raw) : null;
  }

  async fetchHlsPlaylist(id: string): Promise<string> {
    const playlistBase = '/video/:/transcode/universal/';
    const res = await this.http.get(`${playlistBase}start.m3u8`, {
      params: {
        path: `/library/metadata/${id}`,
        protocol: 'hls',
        copyts: '1',
        hasMDE: '1',
      },
      responseType: 'text',
    });
    // Resolve relative paths to absolute so downstream handlers use the right URL
    return resolveRelativeM3U8(res.data as string, playlistBase);
  }

  async fetchSubPlaylist(path: string): Promise<string> {
    const res = await this.http.get(path, { responseType: 'text' });
    const base = path.substring(0, path.lastIndexOf('/') + 1);
    return resolveRelativeM3U8(res.data as string, base);
  }

  resolveStreamUrl(path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const sep = normalizedPath.includes('?') ? '&' : '?';
    return `${this.url}${normalizedPath}${sep}X-Plex-Token=${this.token}`;
  }

  getThumbUrl(id: string | undefined): string | null {
    if (!id) return null;
    return `${this.url}/photo/:/transcode?url=${encodeURIComponent(`/library/metadata/${id}/thumb`)}&width=200&height=300&X-Plex-Token=${this.token}`;
  }
}
