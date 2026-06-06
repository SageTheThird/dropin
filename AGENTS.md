# AGENTS.md

## Project Shape

DropIn is a small shared listening room for friends. It serves one vanilla HTML/CSS/JS frontend from a Node 20 HTTP server. There is no build step and no database.

The app does not proxy, download, or rebroadcast audio. Each browser plays the official YouTube iframe locally; the server only coordinates room state, queue state, participants, and playback sync.

## Commands

- Install: `npm install`
- Run locally: `npm run dev`
- Production start: `npm start`
- Health check: `GET /api/health`
- Manual sync test: open `http://localhost:8787` in two tabs on the same `?room=` link.

There is no dedicated test suite right now. CI runs a boot smoke test: `npm ci`, start `server/index.js`, and require `http://localhost:8787/` to return 200.

## Runtime Architecture

- `server/index.js` is the Node server, static file server, API router, in-memory room store, YouTube/Spotify resolver, and SSE broadcaster.
- `server/spotify.js` fetches Spotify playlist metadata/tracks, preferring Spotify's public web token flow, then optional client credentials, then `spotify-url-info` scraping.
- `public/index.html` defines the single-page UI and inline SVG icon sprite.
- `public/app.js` owns browser state, SSE, YouTube iframe control, search/import UI, queue rendering, and drift correction.
- `public/styles.css` is the full responsive UI styling.
- `docs/001-architecture.md` documents the host-authoritative model and should be read before sync changes.
- `docs/005-sync-bandwidth-overhaul.md` is the current handoff for the pending bandwidth fix.

Rooms live in memory in `const rooms = new Map()`. Restarting the service clears rooms, queues, participants, and playback state.

## Important API Paths

- `GET /api/auth/status` and `POST /api/auth` implement the optional passcode gate.
- `GET /api/search?q=...` searches YouTube, resolves YouTube URLs/playlists, and returns normalized track items.
- `POST /api/rooms` creates a new random room id.
- `GET /api/rooms/:id` returns a full room snapshot.
- `GET /api/rooms/:id/events` opens the SSE stream and sends an initial `hello` full snapshot.
- `POST /api/rooms/:id/commands` applies room commands.
- `POST /api/rooms/:id/spotify-import` starts an async Spotify-to-YouTube import and streams `import-progress` / `import-complete` SSE events.
- `GET /api/thumb?url=...` proxies allowed YouTube thumbnail hosts.

## Sync Invariants

The host-authoritative playback model is load-bearing.

- The first active SSE client becomes host.
- Only the host may run playback commands: `load`, `play`, `pause`, `seek`, `next`, `jump`, `heartbeat`.
- Non-host clients can `enqueue`, `remove` non-current tracks, join, and update presence.
- The host sends a heartbeat about once per second from `sendHostHeartbeat()` in `public/app.js`.
- Followers correct drift in `watchLocalDrift()` and `correctDrift()`; the host should ignore inbound heartbeat/sync corrections.
- `seq` is the stale-update guard. Keep it monotonic when mutating shared room state.
- Late joiners need a full snapshot from the SSE `hello` event.

When changing sync, manually test two tabs: host play/pause/seek/next, follower catch-up, queue add/remove, and a late joiner.

## Current Bandwidth Work: Doc 005

`docs/005-sync-bandwidth-overhaul.md` identifies the next major fix. Today heartbeats send the full `snapshot(room)` through both SSE and the HTTP command response. With large queues this can send roughly 100 KB every second, per room/client path.

The intended fix is to split frequent tiny sync patches from rare full state snapshots:

- Add a small server sync payload with only `seq`, `serverTime`, and effective `player`.
- Broadcast that small payload for `heartbeat` instead of `broadcast(room, "sync")`.
- Return a small `{ ok: true, seq }` response from command posts, instead of always returning `snapshot(room)`.
- Teach the client to handle `sync` as a partial playhead patch without calling `renderRoom()`.
- Keep full snapshots for `hello`, `GET /api/rooms/:id`, presence/queue/playback state changes, playlist imports, and late joiners.
- Stop the polling fallback after SSE reconnects so full snapshots do not continue forever after a transient EventSource error.

Preserve host-authoritative behavior while doing this. The bandwidth reduction should not change who controls playback.

Current implementation note: full snapshots send `playlist + currentIndex`; `queue` and `history` are redundant/derivable and are not part of the wire payload.

## Notes And Drift

- `docs/003-youtube-search.md` appears stale. Current code uses `youtubei.js` Innertube search and YouTube oEmbed/direct URL resolution; no `YOUTUBE_API_KEY` is required by the current implementation.
- README still mentions a PowerShell VPS deploy script, but the tracked deployment script is `scripts/deploy.sh`, invoked by GitHub Actions on the VPS.
- `.env` is local and must not be committed. `.env.example` documents `SYNC_ROOM_PASSWORD` plus optional Spotify credentials.

## Deployment

The repo is set up for reviewed PRs and auto-deploy on merge to `main`.

- `.github/workflows/ci-deploy.yml` runs the boot smoke test on PRs and pushes.
- On push to `main`, CI connects to the VPS using a forced-command SSH key and passes the target commit.
- `scripts/deploy.sh` runs on the VPS: fetches `main`, resets to the requested commit, runs `npm ci --omit=dev`, restarts `dropin`, and health-checks `http://127.0.0.1:8787/`.
- `.github/CODEOWNERS` requires `@SageTheThird` review for all changes.

Do not perform manual deploys unless the user explicitly asks.

## Code Style

- ES modules.
- Two-space indentation.
- Existing JavaScript uses semicolons.
- Keep changes small and in the existing style.
- Avoid adding a build system unless explicitly requested.
- Treat user/untracked work as owned by the user. At the time this file was created, `docs/005-sync-bandwidth-overhaul.md` was untracked.
