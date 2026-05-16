import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';
import type { MediaItem, MediaProvider } from './types';

const DEVICE_ID = 'discordwatchparty-bot';

interface JellyfinItem {
  Id: string;
  Name: string;
  ProductionYear?: number;
  Type: string;
  RunTimeTicks?: number;
  SeriesName?: string;
  IndexNumber?: number;
  ParentIndexNumber?: number;
}

function mapItem(raw: JellyfinItem): MediaItem {
  return {
    id: raw.Id,
    title: raw.Name,
    year: raw.ProductionYear,
    type: raw.Type.toLowerCase() as MediaItem['type'],
    duration: raw.RunTimeTicks ? Math.floor(raw.RunTimeTicks / 10_000) : 0,
    grandparentTitle: raw.SeriesName,
    index: raw.IndexNumber,
    parentIndex: raw.ParentIndexNumber,
    partKey: `/Videos/${raw.Id}/stream`,
  };
}

export class JellyfinProvider implements MediaProvider {
  private readonly http: AxiosInstance;

  constructor(
    private readonly variant: 'jellyfin' | 'emby',
    private readonly url: string,
    private readonly apiKey: string,
  ) {
    this.http = axios.create({
      baseURL: url,
      headers: {
        Accept: 'application/json',
        'X-Emby-Token': apiKey,
        'X-Emby-Client': 'DiscordWatchParty',
        'X-Emby-Device-Name': 'DiscordWatchParty Bot',
        'X-Emby-Device-Id': DEVICE_ID,
        'X-Emby-Client-Version': '1.0.0',
      },
    });
  }

  async search(query: string, limit = 8): Promise<MediaItem[]> {
    const res = await this.http.get('/Items', {
      params: {
        SearchTerm: query,
        IncludeItemTypes: 'Movie,Episode,Audio',
        Recursive: true,
        Fields: 'RunTimeTicks,SeriesName',
        Limit: limit,
      },
    });
    return (res.data?.Items ?? []).map(mapItem);
  }

  async getMetadata(id: string): Promise<MediaItem | null> {
    const res = await this.http.get(`/Items/${id}`, {
      params: { Fields: 'RunTimeTicks,SeriesName' },
    });
    return res.data ? mapItem(res.data as JellyfinItem) : null;
  }

  getHlsUrl(id: string): string {
    const params = new URLSearchParams({
      api_key: this.apiKey,
      VideoCodec: 'h264',
      AudioCodec: 'aac,mp3',
      MaxStreamingBitrate: '8000000',
      deviceId: DEVICE_ID,
      PlaySessionId: randomUUID(),
    });
    return `${this.url}/Videos/${id}/master.m3u8?${params}`;
  }

  resolveStreamUrl(path: string): string {
    let resolved = path;
    if (path.startsWith('http')) {
      const u = new URL(path);
      resolved = u.pathname + u.search;
    }
    const sep = resolved.includes('?') ? '&' : '?';
    return `${this.url}${resolved}${sep}api_key=${this.apiKey}`;
  }

  getThumbUrl(id: string | undefined): string | null {
    if (!id) return null;
    return `${this.url}/Items/${id}/Images/Primary?api_key=${this.apiKey}&width=200`;
  }
}
