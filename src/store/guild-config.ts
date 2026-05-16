import { db } from './db';
import { encrypt, decrypt } from './crypto';

export interface GuildConfig {
  guildId: string;
  provider: 'plex' | 'jellyfin' | 'emby';
  mediaUrl: string;
  apiKey: string;
  configuredAt: number;
}

const get = db.prepare<[string], {
  guild_id: string; provider: string; media_url: string; api_key: string; configured_at: number;
}>('SELECT * FROM guild_configs WHERE guild_id = ?');

const upsert = db.prepare(
  `INSERT INTO guild_configs (guild_id, provider, media_url, api_key, configured_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(guild_id) DO UPDATE SET
     provider = excluded.provider,
     media_url = excluded.media_url,
     api_key = excluded.api_key,
     configured_at = excluded.configured_at`,
);

const remove = db.prepare('DELETE FROM guild_configs WHERE guild_id = ?');

export function getGuildConfig(guildId: string): GuildConfig | null {
  const row = get.get(guildId);
  if (!row) return null;
  return {
    guildId: row.guild_id,
    provider: row.provider as GuildConfig['provider'],
    mediaUrl: row.media_url,
    apiKey: decrypt(row.api_key),
    configuredAt: row.configured_at,
  };
}

export function saveGuildConfig(
  guildId: string,
  provider: GuildConfig['provider'],
  mediaUrl: string,
  apiKey: string,
): void {
  upsert.run(guildId, provider, mediaUrl.replace(/\/$/, ''), encrypt(apiKey), Date.now());
}

export function deleteGuildConfig(guildId: string): boolean {
  const result = remove.run(guildId);
  return result.changes > 0;
}
