import http from 'http';
import path from 'path';
import express from 'express';
import { config } from '../config';
import { streamRouter, internalAuthHandler } from './stream';
import { attachSyncServer } from './sync';
import { resolveSession, currentItem } from '../rooms/manager';

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

  // Health check
  app.get('/health', (_req, res) => res.json({ ok: true }));

  const httpServer = http.createServer(app);
  attachSyncServer(httpServer);

  httpServer.listen(config.server.port, () => {
    console.log(`Web server listening on port ${config.server.port}`);
    console.log(`Public URL: ${config.server.publicUrl}`);
  });
}
