# DropIn

A tiny synced YouTube room for friends. Share a link, queue tracks, listen together.

DropIn does **not** proxy, download, or rebroadcast audio. Each listener plays the official YouTube embed locally while the server keeps everyone's playback state aligned — play, pause, seek, next, queue, current track.

## Features

- **Synced playback** — host-authoritative. The first person in the room drives playback for everyone.
- **Shared queue** — anyone in the room can search YouTube and add tracks.
- **Live updates** — Server-Sent Events push room snapshots; no polling.
- **Optional passcode gate** — a single shared password locks the app for friends-only use.
- **Local volume** — each listener controls their own volume.
- **No build step** — vanilla JS frontend, minimal Node server.

## Quick Start

Requires Node 20+.

```bash
npm install
cp .env.example .env   # optional — only needed if you want a passcode gate

npm run dev
```

Open `http://localhost:8787`. Open the same room link in a second tab to test sync.

Search uses YouTube's internal Innertube API (via [`youtubei.js`](https://github.com/LuanRT/YouTube.js)) — no API key, no daily quota.

### Environment variables

| Key                  | Required | Purpose                                                  |
| -------------------- | -------- | -------------------------------------------------------- |
| `SYNC_ROOM_PASSWORD` | no       | If set, clients must enter this passcode before joining. |
| `PORT`               | no       | Defaults to `8787`.                                      |

## Deploy to a VPS

The included PowerShell script packages the app, uploads it over SSH, installs Node 20 if missing, writes a `systemd` unit, and starts the service. Requires `ssh.exe`, `scp.exe`, and `tar.exe` on the local Windows host, and an Ubuntu/Debian VPS with root access.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-vps.ps1 `
  -HostName 203.0.113.10 -User root
```

For HTTPS without buying a domain, use the built-in Caddy setup with a free `nip.io` hostname:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-vps.ps1 `
  -HostName 203.0.113.10 -User root -ConfigureCaddy
```

This serves at `https://dropin-203-0-113-10.nip.io`.

Full deploy details: [docs/004-vps-deploy.md](docs/004-vps-deploy.md).

## Architecture

- **Server** ([server/index.js](server/index.js)) — Node HTTP server, in-memory room `Map`, SSE for broadcast.
- **Frontend** ([public/](public/)) — static HTML/CSS/JS, talks to `/api/*`, embeds the YouTube iframe player.
- **Sync** — host-authoritative. The host heartbeats its playhead ~1×/sec; followers correct drift.

More: [docs/001-architecture.md](docs/001-architecture.md).

### Why not Cloudflare Workers?

Long listening sessions keep SSE connections open. Cloudflare Durable Objects charge by connection duration, which is a poor fit. A small VPS with a single Node process has no duration meter ticking in the background.

## Contributing

PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, project layout, and PR guidelines.

## License

[MIT](LICENSE).
