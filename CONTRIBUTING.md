# Contributing to DropIn

Thanks for poking around! DropIn is small on purpose — a single Node server, vanilla browser frontend, no build step. Easy to read, easy to change.

## Local Setup

Requires Node 20+.

1. Copy `.env.example` to `.env` and fill in:
   - `YOUTUBE_API_KEY` — from [Google Cloud Console](https://console.cloud.google.com/) → enable **YouTube Data API v3** → create an API key.
   - `SYNC_ROOM_PASSWORD` — optional. If set, the app requires a shared passcode before letting clients in.
2. Start the server:

   ```bash
   npm run dev
   ```

3. Open `http://localhost:8787` in two browser tabs to test sync.

No `npm install` needed — the server uses only Node's standard library.

## Project Layout

- [server/index.js](server/index.js) — HTTP + SSE server, room state, YouTube search proxy, passcode auth.
- [public/](public/) — static frontend (HTML/CSS/JS, no build).
- [scripts/deploy-vps.ps1](scripts/deploy-vps.ps1) — one-shot VPS deploy (Windows host, Linux target).
- [docs/](docs/) — architecture notes and deployment guide.

Read [docs/001-architecture.md](docs/001-architecture.md) before changing sync logic — host-authoritative playback is load-bearing.

## Pull Requests

- Branch from `main`. Keep PRs focused — one change per PR.
- Match existing style: ES modules, 2-space indent, no semicolons-optional debates (existing code uses semicolons).
- If you change sync behavior, manually test with two browser tabs on the same room.
- If you change the deploy script, test against a throwaway VPS.

## Secret Hygiene

- **Never commit `.env`** or any file that contains a real API key, password, or token. `.gitignore` excludes them, but double-check `git status` before pushing.
- `.env.example` is the only env file that should be tracked. Add new keys there with empty values.
- If you accidentally commit a secret, rotate the key immediately — git history is forever.

## Reporting Bugs

Open a GitHub issue with: what you expected, what actually happened, and the steps to reproduce (room link, browsers used, anything in the server log).
