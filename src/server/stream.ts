import { Router, Request, Response } from 'express';
import { resolveSession, currentItem } from '../rooms/manager';
import { config } from '../config';
import { getProvider } from '../providers';
import { plexSessionId } from '../providers/plex';

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

// ── Manifest proxy ────────────────────────────────────────────────────────────
// Returns either a DASH MPD or HLS M3U8 depending on the provider.
// Segment URLs inside the manifest are rewritten to point at our proxy.

streamRouter.get('/:token/manifest', tokenGate, async (req: Request, res: Response) => {
  const room = resolveSession(req.params.token)!;
  const item = currentItem(room);
  if (!item) {
    res.status(404).json({ error: 'Nothing is playing' });
    return;
  }

  try {
    const provider = getProvider(room.guildId);

    // Reuse one upstream transcode session per room. The media server only
    // allows a single live transcode at a time (a 2nd start.mpd → 400), so
    // every viewer/reload of the same item must share it. When the playing
    // item changes, retire the old session before minting a new one.
    if (room.transcodeSession && room.transcodeSession.itemId !== item.id) {
      const stale = room.transcodeSession.id;
      void provider.stopSession?.(stale).catch(() => { /* best-effort */ });
      room.transcodeSession = undefined;
    }
    if (!room.transcodeSession) {
      room.transcodeSession = { id: plexSessionId(), itemId: item.id };
    }

    const proxyBase = `${config.server.publicUrl}/stream/${req.params.token}`;
    const { content, protocol } = await provider.fetchPlaylist(item.id, proxyBase, room.transcodeSession.id);

    if (protocol === 'dash') {
      res.set('Content-Type', 'application/dash+xml');
      res.set('Cache-Control', 'no-cache');
      res.send(content);
    } else {
      const hlsProxyBase = `${proxyBase}/hls`;
      const rewritten = rewriteM3U8(content, hlsProxyBase);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'no-cache');
      res.send(rewritten);
    }
  } catch (err) {
    console.error('Manifest fetch failed:', err);
    res.status(502).json({ error: 'Failed to fetch manifest from media server' });
  }
});

// ── HLS sub-playlist proxy ────────────────────────────────────────────────────
// Jellyfin uses two-level HLS: master → media playlist → .ts segments.

streamRouter.get('/:token/hls/subplaylist', tokenGate, async (req: Request, res: Response) => {
  const room = resolveSession(req.params.token)!;
  const segPath = req.query.path as string | undefined;
  if (!segPath) {
    res.status(400).json({ error: 'Missing path parameter' });
    return;
  }

  try {
    const provider = getProvider(room.guildId);
    if (!provider.fetchSubPlaylist) {
      res.status(501).json({ error: 'Provider does not support HLS sub-playlists' });
      return;
    }
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

      const endpoint = segPath.includes('.m3u8') ? 'subplaylist' : 'segment';
      return `${proxyBase}/${endpoint}?path=${encodeURIComponent(segPath)}`;
    })
    .join('\n');
}

// ── nginx auth subrequest handler ─────────────────────────────────────────────
// Called by nginx for both HLS segments (?path=) and DASH segments (/dash/...).

export async function internalAuthHandler(req: Request, res: Response): Promise<void> {
  const originalUri = req.headers['x-original-uri'] as string | undefined;
  if (!originalUri) {
    res.sendStatus(400);
    return;
  }

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

  // DASH segment: /stream/:token/dash/video/:/transcode/universal/...
  const dashMatch = originalUri.match(/^\/stream\/[^/?]+\/dash(\/[^?]*)/);
  if (dashMatch) {
    const segPath = dashMatch[1] + (parsed.search || '');
    res.set('X-Upstream-URL', provider.resolveStreamUrl(segPath));
    res.sendStatus(200);
    return;
  }

  // HLS segment: ?path=<provider-relative-path>
  const segPath = parsed.searchParams.get('path');
  if (segPath) {
    res.set('X-Upstream-URL', provider.resolveStreamUrl(segPath));
    res.sendStatus(200);
    return;
  }

  // Direct stream fallback
  const item = currentItem(room);
  if (!item?.partKey) {
    res.sendStatus(404);
    return;
  }
  res.set('X-Upstream-URL', provider.resolveStreamUrl(item.partKey));
  res.sendStatus(200);
}
