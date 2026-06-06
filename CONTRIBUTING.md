# Contributing to DropIn

Thanks for poking around! DropIn is small on purpose — a single Node server, vanilla browser frontend, no build step. Easy to read, easy to change.

## Local Setup

Requires Node 20+.

1. Install deps:

   ```bash
   npm install
   ```

2. Optionally copy `.env.example` to `.env` and set `SYNC_ROOM_PASSWORD` if you want a passcode gate.
3. Start the server:

   ```bash
   npm run dev
   ```

4. Open `http://localhost:8787` in two browser tabs to test sync.

Search uses YouTube's Innertube API via [`youtubei.js`](https://github.com/LuanRT/YouTube.js) — no API key, no quota.

## Project Layout

- [server/index.js](server/index.js) — HTTP + SSE server, room state, YouTube search proxy, passcode auth.
- [public/](public/) — static frontend (HTML/CSS/JS, no build).
- [scripts/deploy.sh](scripts/deploy.sh) — runs on the VPS; CI invokes it to pull, install, restart, and health-check.
- [docs/](docs/) — architecture notes and deployment guide.

Read [docs/001-architecture.md](docs/001-architecture.md) before changing sync logic — host-authoritative playback is load-bearing.

## Pull Requests

- Fork the repo, branch from `main`. Keep PRs focused — one change per PR.
- Match existing style: ES modules, 2-space indent, no semicolons-optional debates (existing code uses semicolons).
- If you change sync behavior, manually test with two browser tabs on the same room.
- Every PR runs a **boot smoke test** in CI (`npm ci` + server must answer `200`). It must be green to merge.

## How deploys work

1. You open a PR → CI runs the smoke test on a GitHub-hosted runner (fork code never touches the server).
2. The repo owner reviews and approves. Branch protection blocks self-merge and red checks.
3. On merge to `main`, CI auto-deploys: a forced-command SSH key triggers [scripts/deploy.sh](scripts/deploy.sh) on the VPS, which checks out the merged commit, runs `npm ci`, restarts the `dropin` service, and health-checks it. A failed health check turns the deploy red.

## Secret Hygiene

- **Never commit `.env`** or any file that contains a real API key, password, or token. `.gitignore` excludes them, but double-check `git status` before pushing.
- `.env.example` is the only env file that should be tracked. Add new keys there with empty values.
- If you accidentally commit a secret, rotate the key immediately — git history is forever.

## Reporting Bugs

Open a GitHub issue with: what you expected, what actually happened, and the steps to reproduce (room link, browsers used, anything in the server log).
