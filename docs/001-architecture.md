# Architecture

## Overview

DropIn is a shared playback controller. It does not host, proxy, download, or rebroadcast audio.
Each participant loads the same YouTube video in their own browser through the official YouTube iframe player, while the app keeps playback state aligned.

```text
Browser A  ---- POST commands ---->
                                 Room state backend ---- SSE updates ----> Browser A
Browser B  ---- POST commands ---->                    ---- SSE updates ----> Browser B
```

## Runtime Pieces

- `public/` contains the browser UI.
- `server/index.js` is the local development server.
- The same Node server is used for VPS deployment.
- Active room state lives in memory.

## Room State

Each room keeps:

- sequence number for ordering snapshots
- current video id, title, and source url
- playlist and current index
- derived upcoming queue
- playing flag
- current position
- timestamp of the last state update
- host client id
- connected participants

When playback is running, the backend stores the last known position plus the timestamp it was recorded. Clients compute the effective position as:

```text
position + (now - updatedAt)
```

## Sync Strategy

- Local user actions are sent as commands.
- The first active participant becomes the room host.
- Playback is host-authoritative: only the host can load, play, pause, seek, jump, or advance tracks.
- Other listeners can enqueue tracks, but their local player state does not mutate the shared playback clock.
- The host sends a lightweight heartbeat with its current playhead so joiners and followers receive a fresh target position.
- The backend broadcasts a room snapshot to all connected clients.
- Clients apply snapshots to the YouTube player.
- A drift check nudges followers back into sync.
- Snapshots include a sequence number, and clients ignore stale room snapshots.

## Deployment Shape

The deployed website runs as a native Node service on a VPS. A static-only host cannot safely hold the YouTube API key or keep room state between friends.

The VPS deployment keeps rooms in memory. This is cheap and simple for a friend-group MVP, but active rooms reset when the service restarts.

## Passcode Gate

If `SYNC_ROOM_PASSWORD` is set, the backend requires a passcode before allowing API access. The browser submits the passcode to `/api/auth`, and the server sets an HttpOnly `dropin_auth` cookie.

Protected routes include search, room creation, room state, room events, and commands. Static files are intentionally public so the app can show the passcode screen.
