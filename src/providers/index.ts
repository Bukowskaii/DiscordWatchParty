import type { MediaProvider } from './types';
import { getGuildConfig } from '../store/guild-config';
import { PlexProvider } from './plex';
import { JellyfinProvider } from './jellyfin';

export type { MediaItem, MediaProvider } from './types';

// Provider instances are cached per guild — recreated only when /setup is re-run.
const cache = new Map<string, MediaProvider>();

export function getProvider(guildId: string): MediaProvider {
  if (cache.has(guildId)) return cache.get(guildId)!;

  const cfg = getGuildConfig(guildId);
  if (!cfg) throw new Error(`Guild ${guildId} has no media server configured`);

  let provider: MediaProvider;
  switch (cfg.provider) {
    case 'plex':
      provider = new PlexProvider(cfg.mediaUrl, cfg.apiKey, cfg.playbackToken);
      break;
    case 'jellyfin':
      provider = new JellyfinProvider('jellyfin', cfg.mediaUrl, cfg.apiKey);
      break;
    case 'emby':
      provider = new JellyfinProvider('emby', cfg.mediaUrl, cfg.apiKey);
      break;
    default:
      throw new Error(`Unknown provider: ${(cfg as { provider: string }).provider}`);
  }

  cache.set(guildId, provider);
  return provider;
}

/** Returns null instead of throwing — use in commands to show a friendly error. */
export function getProviderForGuild(guildId: string): MediaProvider | null {
  try {
    return getProvider(guildId);
  } catch {
    return null;
  }
}

/** Call after saving new guild config so the stale instance isn't reused. */
export function invalidateProvider(guildId: string): void {
  cache.delete(guildId);
}
