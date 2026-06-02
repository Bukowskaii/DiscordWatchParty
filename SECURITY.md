# Security Policy

DiscordWatchParty handles sensitive material: Discord bot tokens, Plex access tokens,
an AES-256-GCM-encrypted guild config store, and traffic routed through a Cloudflare
Tunnel. Please treat security issues with care.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, the impact, and steps to reproduce.

This opens a private advisory visible only to you and the maintainers.

Please include, where possible:

- The component affected (bot, nginx proxy, auth subrequest flow, token storage, etc.).
- A proof of concept or clear reproduction steps.
- The potential impact (token disclosure, unauthorized stream access, RCE, etc.).

## What to expect

- **Acknowledgement:** within about 7 days.
- **Assessment & fix:** as fast as is practical for a hobby/community project; we'll keep
  you updated through the advisory.
- **Credit:** we're happy to credit you in the advisory and release notes unless you'd
  prefer to remain anonymous.

## Scope

Most relevant areas:

- **Secret handling** — Discord token, encryption key, and Plex playback/access tokens.
- **The encrypted config store** (`data/guild_configs.db`, AES-256-GCM).
- **The nginx `auth_request` flow** — segment requests are authorized by a bot subrequest
  before nginx proxies bytes from Plex. Anything that lets a request reach Plex media
  without proper authorization is in scope.
- **Watch tokens / room access** — gaining access to a stream or room you shouldn't.

## Out of scope

- Vulnerabilities in third-party dependencies that already have a public advisory and fix
  (please just bump the dependency via a normal PR).
- Issues that require physical access to the host or an already-compromised Plex/Discord
  account.
- Misconfiguration of a user's own deployment (e.g. exposing the bot's port `3000`
  publicly, or committing their own `.env`).

## Good operational hygiene for self-hosters

- Keep the bot container **internal only** (port `3000` must not be public). Only nginx
  (default `8780`) faces the tunnel.
- Keep your encryption key and `.env` out of version control.
- Keep the Plex URL on the LAN/internal IP — see the README and `CLAUDE.md`.
