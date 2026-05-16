# CLAUDE.md — DiscordWatchParty

## Workflow rules

**Never commit without explicit user approval.** Never push either. When the user asks you to make changes, make them and report back — do not commit unless they say so.

**Never commit setup-specific config.** Things like the user's `.env`, their specific `PLEX_URL`, or their server's docker-compose overrides belong to their deployment only.

**For significant changes, propose before implementing.** Read the relevant code, identify the root cause or approach, explain the plan, and wait for a go-ahead before writing code. Straightforward bug fixes and small additions can proceed directly.

---

## Architecture

Two Docker containers:

- **nginx** — public-facing (port `NGINX_PORT`, default 8780). Handles TLS termination via Cloudflare Tunnel. Proxies HLS segments directly from the upstream media server using the `auth_request` pattern so video bytes never touch Node.js.
- **bot** — internal only (port 3000). Node.js/TypeScript. Runs the Discord bot, Express HTTP server, WebSocket sync server, and HLS playlist proxy.

Media flow: browser → nginx → (auth subrequest to bot) → nginx proxies segment bytes from Plex/Jellyfin/Emby directly.

Sync flow: browser ↔ WebSocket (`/sync`) ↔ in-memory room state in `src/rooms/manager.ts`.

---

## Key files

| File | Purpose |
|---|---|
| `nginx/default.conf` | nginx routing: HLS playlists → bot, segments → upstream via auth_request. Hot-reloadable without rebuild. |
| `public/watch.html` | Single-file watch page (hls.js + WebSocket sync UI). Served statically — requires container rebuild to update. |
| `src/server/stream.ts` | HLS playlist and segment routes, including `/subplaylist` for two-level M3U8. |
| `src/server/sync.ts` | WebSocket server: room state broadcast, participant tracking, action notifications. |
| `src/rooms/manager.ts` | In-memory room/queue state. Sessions are not persisted across restarts. |
| `src/providers/plex.ts` | Plex HLS playlist fetch + relative URL resolution. |
| `src/providers/jellyfin.ts` | Jellyfin/Emby provider. |
| `src/bot/commands/` | Discord slash command handlers. |
| `src/store/guild-config.ts` | AES-256-GCM encrypted guild config (SQLite, `data/guild_configs.db`). |
| `.github/workflows/docker.yml` | CI/CD: version tags trigger multi-arch Docker build + push to GHCR + GitHub release. |

---

## Deployment notes

**nginx config only** (no rebuild needed):
```bash
# Copy nginx/default.conf to server, then:
docker exec <nginx-container> nginx -s reload
```

**Code changes** (requires rebuild):
```bash
docker compose up --build -d
```

**Slash commands changed:**
```bash
npm run deploy-commands
```

Server logs are at `\\BUKO-PMS\docker\discordwatchparty\` (nginx.log + bot output).

---

## Known patterns and gotchas

- **HLS is two-level:** Plex returns a master playlist (`start.m3u8`) that references a sub-playlist (`index.m3u8`) which references `.ts` segments. The `/subplaylist` route handles the middle layer; nginx handles segment bytes.
- **Relative URLs in Plex M3U8s** are relative to the playlist fetch path, not the server root. `resolveRelativeM3U8` in `plex.ts` handles this.
- **nginx `proxy_ssl_server_name on`** is required on segment/direct locations because Cloudflare requires SNI. Without it, TLS handshakes fail with SSL alert 40.
- **`proxy_http_version 1.1` + `Connection ""`** on segment locations enables connection reuse across segment fetches (avoids per-segment TLS handshake overhead).
- **`resolver 127.0.0.11 valid=30s ipv6=off`** — Docker's embedded DNS. `ipv6=off` prevents failed connection attempts to Cloudflare's IPv6 addresses when the Docker network has no IPv6.
- **URL normalization in `/setup configure`** auto-upgrades http→https by following the redirect during the connection test and storing the canonical URL.
- **Sessions are in-memory only.** Restarting the bot invalidates all active watch links.
- **`startPlayback` sets state to `paused`** — new media always starts paused at T=0 until someone hits Play.
