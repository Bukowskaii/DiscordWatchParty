import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'guild_configs.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS guild_configs (
    guild_id      TEXT PRIMARY KEY,
    provider      TEXT NOT NULL,
    media_url     TEXT NOT NULL,
    api_key       TEXT NOT NULL,
    configured_at INTEGER NOT NULL
  )
`);

// Migration: optional separate token used for streaming/timeline so playback
// can be attributed to a dedicated Plex user instead of the admin account.
const columns = db.prepare('PRAGMA table_info(guild_configs)').all() as { name: string }[];
if (!columns.some(c => c.name === 'playback_token')) {
  db.exec('ALTER TABLE guild_configs ADD COLUMN playback_token TEXT');
}
// Friendly name of the playback user (not secret) — for display in /setup status.
if (!columns.some(c => c.name === 'playback_user')) {
  db.exec('ALTER TABLE guild_configs ADD COLUMN playback_user TEXT');
}
