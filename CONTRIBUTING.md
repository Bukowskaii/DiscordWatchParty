# Contributing to DiscordWatchParty

Thanks for your interest in contributing! This is a self-hosted Discord watch-party
bot that streams from Plex (and, untested, Jellyfin/Emby) to a browser via DASH.

## Before you start

- **Plex is the only validated provider.** New work should target Plex. The
  Jellyfin/Emby (HLS) code paths exist but are **untested** — if you work on them,
  say so clearly in your PR and describe how you tested.
- For anything non-trivial, **open an issue first** to discuss the approach before
  writing code. It saves everyone a round-trip on a PR that might need rework.

## How to contribute code

This is a public project and the repository uses the standard **fork & pull request**
model. You do not have push access to this repo, and that's intentional — everyone
contributes through a fork.

1. **Fork** the repository to your own account.
2. **Clone** your fork and create a branch. We use prefixed branch names:
   - `feature/<short-description>` for new functionality
   - `bugfix/<short-description>` for fixes
   - `chore/<short-description>` / `docs/<short-description>` for everything else
3. Make your changes (see *Development setup* below).
4. **Push** to your fork and open a **pull request** against `main`.

### What to expect on a PR

`main` is protected. For a PR to merge it must:

- pass CI (`typecheck` — `tsc --noEmit`), and
- get an approving review from a code owner (currently the maintainer), and
- have all review conversations resolved.

Maintainers can merge their own changes; external PRs need maintainer approval.
History on `main` is **linear** (no merge commits) — rebase or squash as needed.

## Development setup

Requirements: Node.js 22+ and npm (the CI runners use Node 22). Docker is recommended
for running the full stack (bot + nginx) as documented in the README.

```bash
npm ci            # install dependencies
npm run dev       # run the bot with tsx watch (hot reload)
npm run build     # tsc -> dist/
npx tsc --noEmit  # the exact check CI runs; make sure this is clean before pushing
```

You'll need your own Discord application, a Plex server, and a `.env` to actually run
it end to end. See the README for the full deployment guide.

## Things that must NOT be committed

- **`.env`** and any secrets (Discord token, encryption key, Plex tokens).
- **Setup-specific config** — your `PLEX_URL`, server-specific `docker-compose`
  overrides, etc. These belong to your deployment only.
- **`test-*.mjs`** diagnostic scripts in the repo root — these are local-only.

If you find yourself wanting to commit any of the above, it almost certainly belongs in
your local environment instead.

## Coding conventions

- TypeScript throughout; keep `tsc --noEmit` clean.
- Match the style of the surrounding code — naming, comment density, and structure.
- Keep PRs focused. One logical change per PR is much easier to review than a grab-bag.
- Update the README / `CLAUDE.md` when you change behavior they document.

## Reporting bugs and requesting features

Use the issue templates. For **security issues, do not open a public issue** — see
[SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
project's [GNU AGPL-3.0](LICENSE) license.
