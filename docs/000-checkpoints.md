# Checkpoints

## 2026-04-25 - Web-First MVP

- Current direction: a normal website for synced YouTube rooms.
- Friends join by opening the same room link.
- Playback uses the official YouTube iframe player in each listener's browser.
- Room sync supports search, queue, play, pause, next, jump-to-track, and large seek broadcasts.
- Volume remains local per listener.
- The app now runs on the native Node server for local and VPS deployments.

## 2026-04-25 - Website Cleanup

- Removed the embedded-client integration path.
- Removed the SDK adapter, generated config script, invite button, and proxied YouTube player.
- Simplified routing to static files plus `/api/*`.
- Added `New Room` next to `Copy Link`.
- Search now returns the single YouTube `search.list` response without requesting embeddable-only filtering.
- Added an optional shared passcode gate through `SYNC_ROOM_PASSWORD`.

## 2026-04-25 - Mobile-First Polish

- Rebuilt the CSS around a mobile-first layout.
- Restored mobile Search/Queue tabs.
- Adding a search result switches to the Queue tab so the queued item is visible.
- Moved playback controls back into the player area as a compact row.
- Moved listeners into a compact room strip in the side panel.
- Kept desktop as a two-column player plus side rail layout.
- Increased touch target sizes for room actions, playback controls, forms, and tabs.
- Added `SYNC_ROOM_PASSWORD` passcode auth for the Node server.

## 2026-04-25 - Search and Queue

- Added YouTube Data API search through `/api/search`.
- Search returns up to 50 results, enriched with duration and statistics.
- Clicking a result queues it, or starts playback when the room is empty.
- Queue keeps played/current/upcoming tracks visible until the page is refreshed.

## 2026-04-26 - VPS Pivot

- Removed Cloudflare Worker deployment files.
- Removed Durable Object room state.
- Standardized deployment around the native Node server.
- Added `scripts/deploy-vps.ps1`.
- Deploy script packages the app, uploads it with `scp.exe`, installs Node 20 when needed, writes a systemd service, and starts the app.
- VPS rooms are in-memory and reset on service restart.

## 2026-04-26 - Host-Authoritative Sync

- Playback commands are now host-authoritative: only the room host can play, pause, seek, jump, load immediately, or advance tracks.
- Non-host listeners can still add items to the queue.
- Followers no longer broadcast their local player drift back into the room.
- Added a host heartbeat that refreshes the backend playhead about once per second.
- Tightened follower drift correction so joiners and listeners snap closer to the host's current position.
- Room snapshots now include a sequence number so stale updates can be ignored by clients.

## 2026-04-26 - HTTPS Front Door

- Added Caddy on the VPS as an HTTPS reverse proxy.
- Updated the VPS deploy script with `-ConfigureCaddy` so a fresh IP can use a generated free `nip.io` hostname.
- Kept the Node service on localhost/app port `8787` behind Caddy.
