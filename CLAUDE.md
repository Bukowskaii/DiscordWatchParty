# CLAUDE.md — DiscordWatchParty

## Workflow rules

**Never commit without explicit user approval.** Never push either. When the user asks you to make changes, make them and report back — do not commit unless they say so.

**Never commit setup-specific config.** Things like the user's `.env`, their specific `PLEX_URL`, or their server's docker-compose overrides belong to their deployment only. The `test-*.mjs` diagnostic scripts in the repo root are local-only and should not be committed.

**For significant changes, propose before implementing.** Read the relevant code, identify the root cause or approach, explain the plan, and wait for a go-ahead before writing code. Straightforward bug fixes and small additions can proceed directly.

---

## Provider status

**Plex is the only validated provider.** Jellyfin/Emby code paths (HLS) exist but are **untested** in the current build. New work targets Plex; don't assume Jellyfin/Emby works.

---

## Architecture

Two Docker containers:

- **nginx** — public-facing (port `NGINX_PORT`, default 8780). TLS via Cloudflare Tunnel. Proxies DASH segments directly from Plex using the `auth_request` pattern so video bytes never touch Node.js.
- **bot** — internal only (port 3000). Node.js/TypeScript. Runs the Discord bot, Express HTTP server, WebSocket sync server, DASH manifest proxy, and the timeline reporter.

Media flow: browser (Shaka Player, DASH) → nginx → (auth subrequest to bot) → nginx proxies segment bytes from Plex directly.

**Watch parties are per voice channel.** `/play` creates a voice channel (under a "Watch Parties" category) and a room keyed by that channel's id. A server can run many parties at once. Rooms, queue, and sessions are in-memory in `src/rooms/manager.ts` (reset on restart).

Sync flow: browser ↔ WebSocket (`/sync?token=…`) ↔ in-memory room state. The watch-page participant list is driven by **Discord voice presence**, not the web page.

---

## Key files

| File | Purpose |
|---|---|
| `nginx/default.conf` | Routing: `/manifest` → bot; `/dash/…` segments → Plex via auth_request. Single-file bind mount — see inode gotcha below. |
| `public/watch.html` | Single-file watch page (Shaka Player + WebSocket sync UI). Served statically — requires container rebuild to update. |
| `src/server/stream.ts` | `/:token/manifest` (DASH MPD / HLS) + `internalAuthHandler` that maps `/dash/…` segment requests back to the Plex upstream URL. |
| `src/server/sync.ts` | WebSocket server keyed by **roomId**; broadcasts state; participants come from voice presence. |
| `src/server/timeline.ts` | Periodically POSTs Plex `/:/timeline` so parties show in the dashboard / Tautulli. |
| `src/rooms/manager.ts` | In-memory rooms keyed by **voice-channel id**; per-room shared transcode session; watch tokens → roomId. |
| `src/bot/party.ts` | Voice-channel watch-party lifecycle: find/create rooms, voice-presence tracking, idle reaper, teardown, startup orphan cleanup. |
| `src/providers/plex.ts` | Plex DASH (`start.mpd`), shared session, MPD `<BaseURL>` injection, playback-token resolution, timeline, retry. |
| `src/providers/jellyfin.ts` | Jellyfin/Emby provider (HLS). Untested. |
| `src/bot/commands/` | Slash command handlers. `_media.ts` holds the shared search/drill-down picker + enqueue. |
| `src/store/guild-config.ts` | AES-256-GCM encrypted config (SQLite, `data/guild_configs.db`): provider, url, apiKey, playback token + user. |
| `.github/workflows/docker.yml` | CI/CD: version tags → multi-arch Docker build → GHCR + GitHub release. |

---

## Deployment notes

**nginx config only** (no rebuild): copy `nginx/default.conf` to the server, then **restart the nginx container** (`docker restart <nginx>`). A bare `nginx -s reload` is *not* enough after replacing the file — see the inode gotcha.

**Code changes** (rebuild): `docker compose up --build -d`. The bot **registers slash commands automatically** on startup and on `GuildCreate` (per-guild, instant) — no separate deploy step. `npm run deploy-commands` / `node dist/bot/deploy.js` still exist for manual use (guild-scoped if `DISCORD_GUILD_ID` is set, else global).

On a self-hosted deployment the app typically lives in a directory like `/docker/discordwatchparty/`. When building from source on the host, the compose `build:` context points at `./source`, so changed files must be copied under `source/` before rebuilding.

The bot needs the **Manage Channels** permission (create/delete party VCs) and the **Guild Voice States** intent (not privileged).

---

## Known patterns and gotchas

- **DASH `<BaseURL>` injection:** Plex's MPD has no `<BaseURL>` and uses `SegmentTemplate` paths relative to `start.mpd` (e.g. `session/<id>/$RepresentationID$/$Number$.m4s`). `rewriteMpdUrls` injects an absolute `<BaseURL>` of `${proxyBase}/dash/video/:/transcode/universal/` so segments resolve through nginx; the `/dash/` location strips that prefix back to the Plex path.
- **One shared transcode session per room.** All viewers reuse `room.transcodeSession`, so Plex runs a single transcode for the whole party. Plex rejects a *second concurrent* `start.mpd` for the same session-creating flow with a 400 — reuse avoids that and the N-transcodes-per-party CPU blowup.
- **Transient 400 on concurrent session creation:** when two parties start at nearly the same instant, Plex's create lock can 400. `fetchPlaylist` retries with backoff (4×, 400 ms) — clears it. (Configured Plex limits, CPU 5 / GPU 15, are well above realistic load.)
- **Playback identity uses the server-specific accessToken**, NOT the Plex Home switch `authToken` (which 401s on direct API). `fetchPlaybackToken` reads `https://plex.tv/api/servers/<machineId>/shared_servers`; managed users have a blank `username` there, so map display-name → userID via `/api/home/users` first, then match the share by userID. Validate with an auth-required endpoint (`/library/sections`), not `/identity` (unauthenticated).
- **HEVC passthrough:** the Plex transcode is `videoDecision=copy` (remux) + audio transcode — ~5% CPU, parity with Plex Web. Requires HEVC-capable browsers. High CPU at session start is the buffer-fill burst, which then throttles.
- **Plex session id format:** 24-char lowercase alphanumeric (`plexSessionId()`), not a UUID.
- **nginx single-file bind-mount inode trap:** replacing `default.conf` over SMB swaps the inode; the container still sees the old file until restarted. Always `docker restart` nginx after replacing it (not just reload).
- **nginx `proxy_ssl_server_name on`** on segment/direct locations (Cloudflare requires SNI); **`proxy_http_version 1.1` + `Connection ""`** for connection reuse; **`resolver 127.0.0.11 valid=30s ipv6=off`** for Docker DNS.
- **Sessions/rooms are in-memory.** Restarting the bot clears all parties and watch links; on startup the bot deletes leftover empty party VCs in the "Watch Parties" category.
- **Party cleanup** = idle (no voice members AND no connected web viewers) for ~2 min, or `/stop`. The reaper checks both signals.
- **`startPlayback` sets state to `paused`** — new media starts paused at T=0 until someone hits Play.
- **Keep media traffic on the LAN:** the bot's Plex URL must be the internal IP. `location=lan` + LAN source IP gets full-quality treatment; routing through the public tunnel would be slow and wrong.
