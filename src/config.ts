import 'dotenv/config';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

// Validate encryption key length before anything else touches the DB
required('ENCRYPTION_KEY');

export const config = {
  discord: {
    token: required('DISCORD_BOT_TOKEN'),
    clientId: required('DISCORD_CLIENT_ID'),
  },
  server: {
    port: 3000,
    publicUrl: required('PUBLIC_URL').replace(/\/$/, ''),
  },
  sessionTtlMs: parseInt(optional('SESSION_TTL_MINUTES', '360'), 10) * 60 * 1000,
};
