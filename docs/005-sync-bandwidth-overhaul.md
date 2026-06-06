# 005 — Sync Bandwidth Overhaul (handoff)

**Status:** Implemented in PR branch `ci/github-actions-deploy`. Manual browser verification pending.
**Audience:** The engineer/agent taking this over. Assume no prior context — everything you need is here.
**Baseline commit:** `7dea8a2` on `main`. Line numbers below are from this commit and may drift — search by function name if they don't match.

---

## TL;DR / Mission

DropIn re-sends the **entire room snapshot (full queue + playlist, ~103 KB)** to every client **once per second**, in two places at once. For ~20 min of listening this burned **~290 MB** of bandwidth — almost all of it DropIn, not YouTube. The room was even paused (`playing: false`) when measured, so YouTube was barely streaming.

The implementation separates the **tiny, frequent "sync"** path (host playhead, ~100 bytes) from the **big, rare "state"** path (queue/playlist changed). Target: the per-second payload shrinks ~1000× and 20 min of listening costs a few MB instead of ~290 MB. Sync correctness (host-authoritative playback) must be preserved exactly.

## Implementation notes

- `server/index.js` now emits a small `sync` SSE payload for heartbeats instead of serializing full room snapshots.
- Successful command responses now return compact acknowledgements such as `{ ok: true, seq }`.
- `public/app.js` handles `sync` as a partial playhead patch and avoids full queue re-renders.
- The polling fallback is cleared when EventSource reconnects.
- Full snapshots no longer include redundant `queue` and `history`; the client derives queue/history display from `playlist + currentIndex`.
- Verified with syntax checks, local boot smoke test, and API probes. Manual two-tab YouTube playback testing remains the final acceptance check.

---

## How DropIn works (1-minute orientation)

- Tiny app: one Node HTTP server + vanilla-JS browser frontend, **no build step**. Node 20+.
- A "room" lives in memory on the server (a `Map`). Clients connect via **SSE** (`EventSource`) for push updates and **POST `/api/rooms/:id/commands`** to issue actions.
- **Host-authoritative playback:** the first person in the room is the host. The host's browser drives playback; it sends a `heartbeat` command (its current playhead position + play/pause) **every 1 second**. Followers receive it and correct their local YouTube player to match.
- DropIn does **not** proxy/stream audio — each browser plays the official YouTube `<iframe>` embed locally. (That part of the bandwidth is YouTube's and is out of scope here.)
- Read [001-architecture.md](001-architecture.md) before touching sync logic; the host-authoritative model is load-bearing.

---

## The problem (evidence)

Network tab after ~18 min in a room with a ~100-track Spotify-imported queue:
- `/api/rooms/:id/commands` responses: **~103 KB each**, recurring every second.
- ~290 MB transferred total; room was **paused** during measurement.

The 103 KB body is the full snapshot — it embeds the entire `queue` **and** `playlist`, each track carrying title, `sourceUrl`, `channelTitle`, and a long proxied thumbnail URL (~600–900 bytes/track).

### Rough math
~103 KB × ~2 sends/sec ≈ **~200 KB/s** → over ~18 min ≈ **~220 MB** from DropIn alone, before any YouTube media. This is the dominant cost.

---

## Root cause (exact locations)

`snapshot(room)` builds the full payload, including **both** `queue` and `playlist` and a `history` slice (redundant):
- `server/index.js` → [`function snapshot(room)`](../server/index.js#L107) (~L107). Returns `{ id, seq, hostId, participants, player, queue, playlist, currentIndex, history, serverTime }`.

That full snapshot is shipped on **every heartbeat (1×/sec)** in **two** places:
1. **SSE broadcast** — `server/index.js` (~L1098): after applying any command (including `heartbeat`), it calls `broadcast(room, "sync")`, and `broadcast()` (~L122) serializes the **full** `snapshot(room)` to **every** connected client.
2. **HTTP response** — `server/index.js` (~L1099): the host's `POST /commands` is answered with `sendJson(res, snapshot(room))` — another full 103 KB, just for the heartbeat.
3. **Poll fallback** — `public/app.js` (~L716 `startPollingFallback`, interval **2500 ms**, L731) fetches `GET /api/rooms/:id` (full snapshot) and, due to a bug, **never stops** once started: it's started on the SSE `error` handler (L679) but the SSE `open` handler (L674) doesn't clear `state.pollTimer`. So after one transient reconnect it polls full snapshots forever, concurrently with SSE.

### The underlying design flaw
The code never distinguishes **"tiny + frequent"** from **"big + rare."** A `heartbeat` only needs to convey the host's playhead: `{ seq, serverTime, player: { videoId, position, playing, updatedAt } }` ≈ ~100 bytes. The queue/playlist only change on add / remove / reorder / skip — those are the only events that justify the big payload.

---

## The fix (design)

Introduce a **sync patch** for the per-second path; keep the full snapshot for genuine state changes.

### Server (`server/index.js`)
1. **Add `syncPayload(room)`** returning only the playhead:
   ```js
   function syncPayload(room) {
     return { seq: room.seq, serverTime: now(), player: effectivePlayer(room.player) };
   }
   ```
2. **Add `broadcastSync(room)`** mirroring `broadcast()` but emitting `event: sync` with `syncPayload(room)` instead of the full snapshot.
3. **Heartbeat → sync only.** In the commands handler (~L1098), branch on command type:
   - `heartbeat` → `broadcastSync(room)` (small).
   - everything else (`load/enqueue/play/pause/seek/next/jump/remove`) → keep `broadcast(room, "state")` (full). These are user-initiated and rare, so full snapshots are fine.
4. **`POST /commands` response.** Replace `sendJson(res, snapshot(room))` (~L1099) with `sendJson(res, { ok: true, seq: room.seq })`. Clients get state via SSE; the HTTP response no longer needs to carry the room.
5. **(Investigate, then) trim `snapshot()`.** Confirm whether `queue`, `playlist`, and `history` carry overlapping data. `playlist` is likely the ordered source list, `queue` the up-next, `history` a slice of `playlist`. If `history` is derivable on the client from `playlist` + `currentIndex` (it is — `room.playlist.slice(0, currentIndex)`), stop sending it. Do **not** remove `queue` or `playlist` without understanding their consumers in `renderRoom`. This is a secondary win; the heartbeat split above is the big one.

### Client (`public/app.js`)
1. **Split the `sync` event out** of the catch-all listener. Currently (L639) every event — including `sync` — runs `applyRoomState(JSON.parse(data), eventName)`, which expects a **full** room (it calls `renderRoom(room)` and reads `room.queue`, etc.). A partial patch would break it.
   - Remove `"sync"` from the L639 array.
   - Add a dedicated `state.eventSource.addEventListener("sync", e => handleSyncPatch(JSON.parse(e.data)))`.
2. **Implement `handleSyncPatch(patch)`** — playhead only, no full re-render:
   - Seq guard: `if (Number.isFinite(patch.seq) && patch.seq < state.lastSeq) return; if (Number.isFinite(patch.seq)) state.lastSeq = patch.seq;`
   - Merge into existing room: `state.room = { ...state.room, player: patch.player, serverTime: patch.serverTime, seq: patch.seq };` (keeps `queue`/`playlist` intact).
   - If `isHost()` → `return` (host is authoritative; mirrors existing L750 guard).
   - Drive the local player exactly like the `sync` branch of `applyRoomState` does today (L740–L770): if `patch.player.videoId` differs from the loaded video → `loadVideoById`; else `correctDrift(effectiveRemotePosition(state.room))`; then `playVideo()`/`pauseVideo()` per `patch.player.playing`.
   - **Do not call `renderRoom`** — the queue didn't change. (Bonus: this also stops re-rendering a 100-row queue every second, a real DOM-perf win.)
   - Verify `effectiveRemotePosition(room)` has what it needs from the merged room (it uses `room.player` + `room.serverTime`); the patch provides both.
3. **Heartbeat response no longer a room.** `sendCommand` (L708–709) does `const room = await response.json(); if (room) applyRoomState(room, ...)`. A `{ ok, seq }` body is truthy and would crash `applyRoomState`. Fix: only apply when it's a real room, e.g. `if (room && room.queue) applyRoomState(room, command.type || "state")`. (Or skip body parsing entirely for `heartbeat`.)
4. **Fix the runaway poll.** In the SSE `open` handler (L674), stop polling once SSE is healthy:
   ```js
   if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
   ```
   Keep `startPollingFallback()` on `error` (L679) as the true fallback. Optionally widen the poll interval.

---

## How to build, test, and ship

### Local dev
```bash
npm install
npm run dev          # serves http://localhost:8787
```
Open the same room link in **two browser tabs** (first tab = host). Test: play, pause, seek, skip (`next`), add a track, remove a track — the follower tab must track the host within ~1 s, and queue changes must appear in both.

### Measure the win (before/after)
In DevTools Network, filter to the DropIn host (the room's own domain, not `googlevideo.com`). Watch the recurring `sync` event / `commands` response size:
- **Before:** ~103 KB every second.
- **After (target):** ~100–300 bytes per `sync`; full snapshot only when you actually add/remove/skip.
Leave a paused room open ~5 min and compare total transferred to the DropIn host.

### CI / deploy (already set up — don't bypass it)
This repo auto-deploys on merge. The flow:
1. Branch from `main`, implement, push, open a PR.
2. CI runs a **boot smoke test** (`npm ci` + server must answer `200`) — required to merge.
3. Repo owner (`@SageTheThird`, via CODEOWNERS) reviews and merges. Branch protection blocks self-merge and red checks.
4. On merge to `main`, CI **auto-deploys** to the VPS (forced-command SSH key → `scripts/deploy.sh` → pull merged commit → `npm ci` → restart `dropin` service → health-check).

You do **not** run any manual deploy. Details: [004-vps-deploy.md](004-vps-deploy.md). Note the VPS is a shared 512 MB box; keep the systemd unit minimal (history in 004 / project memory).

---

## Acceptance criteria

- [x] Per-second `sync` payload (SSE event **and** `/commands` response) is **< ~500 bytes** in a steady room.
- [x] Full queue/playlist crosses the wire **only** on actual changes (add / remove / reorder / skip / load), not on heartbeats.
- [ ] 20 min of listening costs a few MB of DropIn traffic (excluding YouTube media), down from ~290 MB.
- [ ] Two-tab manual test passes: host play/pause/seek/skip followed within ~1 s; queue add/remove reflected in both tabs; late joiner still gets full state on `hello`.
- [x] Poll fallback stops once SSE reconnects (no perpetual full-snapshot polling).
- [x] Boot smoke test green; shipped via PR → review → auto-deploy.

---

## Gotchas / constraints

- **Don't break host-authoritative sync.** The host must keep ignoring inbound sync (existing guard at L750 / replicate in `handleSyncPatch`). Only followers correct to the host.
- **Late joiners need full state.** The SSE `hello` event (server ~L1020) already sends a full `snapshot` on connect — keep that. New clients must receive the whole queue once; only the *recurring* path gets slimmed.
- **`seq` monotonicity.** Both full state and sync patches carry `seq`; the client drops stale `seq`. Keep `seq` increasing on every `touchRoom` so patches and snapshots interleave correctly.
- **`effectivePlayer` / drift.** The follower computes the expected position from `player.position`, `player.updatedAt`, and `serverTime`. The sync patch must include all three (it does, via `effectivePlayer(room.player)` + `serverTime`). Verify `correctDrift` still behaves.
- **Thumbnails** are proxied through `/api/thumb` and stored as URLs in each track — they inflate per-track size but are only in the *full* snapshot, which becomes rare after this fix. Optional later optimization: store only the YouTube `videoId` and build the thumb URL client-side.
- Line numbers will shift as you edit — anchor on function names (`snapshot`, `broadcast`, `applyCommand`/heartbeat case, `applyRoomState`, `startPollingFallback`).

---

## Quick reference — key code locations (commit `7dea8a2`)

| What | File | ~Line | Action |
|---|---|---|---|
| `snapshot()` full payload | server/index.js | 107 | add `syncPayload()`; maybe trim `history` |
| `broadcast()` (full to all SSE) | server/index.js | 122 | add `broadcastSync()` |
| commands handler: heartbeat broadcast | server/index.js | 1098 | heartbeat → `broadcastSync`; else full |
| commands HTTP response | server/index.js | 1099 | return `{ ok, seq }`, not snapshot |
| heartbeat applyCommand | server/index.js | 909 | (reference for patch fields) |
| SSE event listeners (catch-all) | public/app.js | 639 | remove `"sync"`; add dedicated handler |
| `sendCommand` response apply | public/app.js | 708 | guard: apply only real rooms |
| `applyRoomState` (full) | public/app.js | 734 | reference for `handleSyncPatch` logic |
| `startPollingFallback` (2.5 s) | public/app.js | 716 | stop on SSE `open` (L674) |
