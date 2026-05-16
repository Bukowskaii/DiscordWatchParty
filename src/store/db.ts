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
