import { Router, Request, Response } from 'express';
import { resolveSession, currentItem } from '../rooms/manager';
import { config } from '../config';
import { getProvider } from '../providers';

export const streamRouter = Router();

// ── Token gate middleware ─────────────────────────────────────────────────────

function tokenGate(req: Request, res: Response, next: () => void): void {
  const token = req.params.token;
  if (!resolveSession(token)) {
    res.status(401).json({ error: 'Invalid or expired session token' });
    return;
  }
  next();
}

// ── HLS playlist proxy ────────────────────────────────────────────────────────
// Segments and direct streams are handled by nginx (see nginx/default.conf).
// Playlists still go through Node.js because the M3U8 segment URLs must be
// rewritten to point at our proxy rather than the upstream media server.

streamRouter.get('/:token/hls/playlist.m3u8', tokenGate, async (req: Request, res: Response) => {
  const room = resolveSession(req.params.token)!;
  const item = currentItem(room);
  if (!item) {
    res.status(404).json({ error: 'Nothing is playing' });
    return;
  }

  try {
    const provider = getProvider(room.guildId);
    const playlist = await provider.fetchHlsPlaylist(item.id);

    const proxyBase = `${config.server.publicUrl}/stream/${req.params.token}/hls`;
    const rewritten = rewriteM3U8(playlist, proxyBase);

    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (err) {
    console.error('HLS playlist fetch failed:', err);
    res.status(502).json({ error: 'Failed to fetch playlist from media server' });
  }
});

// ── Sub-playlist proxy ────────────────────────────────────────────────────────
// Plex uses two-level HLS: master playlist → media playlist (index.m3u8) → .ts
// segments. Sub-playlists must be fetched and rewritten by Node.js (so the .ts
// URLs inside them are also proxied), rather than passed raw through nginx.

streamRouter.get('/:token/hls/subplaylist', tokenGate, async (req: Request, res: Response) => {
  const room = resolveSession(req.params.token)!;
  const segPath = req.query.path as string | undefined;
  if (!segPath) {
    res.status(400).json({ error: 'Missing path parameter' });
    return;
  }

  try {
    const provider = getProvider(room.guildId);
    const playlist = await provider.fetchSubPlaylist(segPath);
    const proxyBase = `${config.server.publicUrl}/stream/${req.params.token}/hls`;
    const rewritten = rewriteM3U8(playlist, proxyBase);
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Cache-Control', 'no-cache');
    res.send(rewritten);
  } catch (err) {
    console.error('Sub-playlist fetch failed:', err);
    res.status(502).json({ error: 'Failed to fetch sub-playlist from media server' });
  }
});

// ── M3U8 URL rewriter ─────────────────────────────────────────────────────────

function rewriteM3U8(content: string, proxyBase: string): string {
  return content
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return line;

      let segPath: string;
      if (trimmed.startsWith('http')) {
        const u = new URL(trimmed);
        segPath = u.pathname + u.search;
      } else {
        segPath = trimmed;
      }

      // Sub-playlists go through Node.js for URL rewriting; .ts segments go
      // through nginx auth_request for direct proxying.
      const endpoint = segPath.includes('.m3u8') ? 'subplaylist' : 'segment';
      return `${proxyBase}/${endpoint}?path=${encodeURIComponent(segPath)}`;
    })
    .join('\n');
}

// ── nginx auth subrequest handler ─────────────────────────────────────────────
// Called by nginx's auth_request for /stream/:token/hls/segment and
// /stream/:token/direct. Validates the session token and returns the full
// authenticated upstream URL in X-Upstream-URL so nginx can proxy the bytes
// directly — Node.js is not in the data path for segments or direct streams.

export async function internalAuthHandler(req: Request, res: Response): Promise<void> {
  const originalUri = req.headers['x-original-uri'] as string | undefined;
  if (!originalUri) {
    res.sendStatus(400);
    return;
  }

  // Extract session token from the URI path: /stream/:token/hls/segment or /stream/:token/direct
  const tokenMatch = originalUri.match(/^\/stream\/([^/?]+)/);
  if (!tokenMatch) {
    res.sendStatus(400);
    return;
  }

  const token = tokenMatch[1];
  const room = resolveSession(token);
  if (!room) {
    res.sendStatus(401);
    return;
  }

  let provider;
  try {
    provider = getProvider(room.guildId);
  } catch {
    res.sendStatus(401);
    return;
  }

  const parsed = new URL(originalUri, 'http://localhost');

  // Segment request: ?path= holds the provider-relative path
  const segPath = parsed.searchParams.get('path');
  if (segPath) {
    res.set('X-Upstream-URL', provider.resolveStreamUrl(segPath));
    res.sendStatus(200);
    return;
  }

  // Direct stream request: resolve from the current queue item's part key
  const item = currentItem(room);
  if (!item?.partKey) {
    res.sendStatus(404);
    return;
  }
  res.set('X-Upstream-URL', provider.resolveStreamUrl(item.partKey));
  res.sendStatus(200);
}
