import http from 'http';
import path from 'path';
import express from 'express';
import { config } from '../config';
import { streamRouter, internalAuthHandler } from './stream';
import { attachSyncServer } from './sync';
import { startTimelineReporter } from './timeline';
import { startPacer } from './pacer';
import { resolveSession, currentItem, getActiveRooms, getLiveTimeMs } from '../rooms/manager';
import { getConnectedCount } from './sync';

export function startServer(): void {
  const app = express();

  // Static assets
  app.use(express.static(path.join(__dirname, '../../public')));
  app.use('/img', express.static(path.join(__dirname, '../../img')));

  // Stream proxy routes
  app.use('/stream', streamRouter);

  // nginx auth_request endpoint — validates session tokens for segment/direct
  // requests and returns the authenticated upstream URL in a response header.
  // nginx then proxies the bytes directly without involving Node.js.
  app.get('/internal/auth', internalAuthHandler);

  // Watch party page — serve the SPA and let the client pull state via WebSocket
  app.get('/watch', (req, res) => {
    const token = req.query.token as string | undefined;
    if (!token || !resolveSession(token)) {
      res.status(401).send('<h1>Invalid or expired watch link.</h1>');
      return;
    }
    res.sendFile(path.join(__dirname, '../../public/watch.html'));
  });

  // Status page
  app.get('/', (_req, res) => {
    const rooms = getActiveRooms();
    const cards = rooms.map(room => {
      const item = currentItem(room);
      const viewers = getConnectedCount(room.id);
      const posMs = getLiveTimeMs(room);
      const name = `${room.guildName ?? `Server ${room.guildId}`} — ${room.channelName}`;
      const title = item ? formatTitle(item) : 'Nothing playing';
      const queue = room.queue.length;
      const pos = item ? `${fmtMs(posMs)} / ${fmtMs(item.duration)}` : '';
      const stateIcon = room.state === 'playing' ? '▶' : room.state === 'paused' ? '⏸' : '⏹';
      return `
        <div class="card">
          <div class="server">${esc(name)}</div>
          <div class="title">${esc(title)}</div>
          ${pos ? `<div class="pos">${stateIcon} ${pos}</div>` : ''}
          <div class="meta">
            <span>${viewers} viewer${viewers !== 1 ? 's' : ''}</span>
            <span>${queue} in queue</span>
          </div>
        </div>`;
    }).join('');

    const body = rooms.length
      ? cards
      : '<p class="empty">No active watch sessions.</p>';

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>DiscordWatchParty</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f0f0f;color:#e0e0e0;font-family:system-ui,sans-serif;padding:2rem;max-width:800px;margin:0 auto}
    header{display:flex;align-items:center;gap:1rem;margin-bottom:2rem}
    header img{width:56px;height:56px;border-radius:50%;object-fit:cover}
    header h1{font-size:1.5rem;font-weight:700}
    header p{font-size:.85rem;color:#888;margin-top:.2rem}
    .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:1.25rem;margin-bottom:1rem}
    .server{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:.4rem}
    .title{font-size:1.1rem;font-weight:600;margin-bottom:.4rem}
    .pos{font-size:.85rem;color:#aaa;margin-bottom:.6rem}
    .meta{display:flex;gap:1.5rem;font-size:.8rem;color:#666}
    .empty{color:#555;text-align:center;margin-top:4rem;font-size:1rem}
  </style>
</head>
<body>
  <header>
    <img src="/img/logo.jpg" alt="logo" />
    <div>
      <h1>DiscordWatchParty</h1>
      <p>Active sessions — refreshes every 5s</p>
    </div>
  </header>
  ${body}
</body>
</html>`);
  });

  // Health check
  app.get('/health', (_req, res) => res.json({ ok: true }));

  function fmtMs(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${pad(m % 60)}:${pad(s % 60)}`;
    return `${m}:${pad(s % 60)}`;
  }
  function pad(n: number) { return String(n).padStart(2, '0'); }
  function esc(s: string) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function formatTitle(item: { grandparentTitle?: string; parentIndex?: number; index?: number; title: string; year?: number }): string {
    if (item.grandparentTitle) return `${item.grandparentTitle} S${item.parentIndex}E${item.index} – ${item.title}`;
    return item.year ? `${item.title} (${item.year})` : item.title;
  }

  const httpServer = http.createServer(app);
  attachSyncServer(httpServer);
  startTimelineReporter();
  startPacer();

  httpServer.listen(config.server.port, () => {
    console.log(`Web server listening on port ${config.server.port}`);
    console.log(`Public URL: ${config.server.publicUrl}`);
  });
}
