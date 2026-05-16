# VPS Deployment

## Why VPS Instead Of Cloudflare

The room sync uses long-lived Server-Sent Events connections. On Cloudflare Durable Objects, those live connections can incur duration. A normal VPS is a better fit for a small friend-group app because a single Node process can keep in-memory rooms and open SSE connections without duration-based platform limits.

## Runtime

- Node server: `server/index.js`
- Static files: `public/`
- Room state: in-memory `Map`
- Process manager: `systemd`
- Default port: `8787`
- Default service name: `dropin`
- Default remote dir: `/opt/dropin`

Rooms are intentionally ephemeral. Restarting the service clears active rooms and queues.

## Requirements

Local machine:

- PowerShell
- `ssh.exe`
- `scp.exe`
- `tar.exe`
- `.env` with `YOUTUBE_API_KEY`

Remote VPS:

- Ubuntu/Debian-style system with `apt-get`
- root SSH, or a user with enough permissions to install Node and write systemd units

## Deploy

Deploy to an IP (or SSH alias):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-vps.ps1 -HostName 203.0.113.10 -User root
```

Deploy with options:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-vps.ps1 -HostName 203.0.113.10 -User root -AppPort 8787 -RemoteDir /opt/dropin -ServiceName dropin
```

Deploy with HTTPS on a free `nip.io` hostname:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy-vps.ps1 -HostName 203.0.113.10 -User root -ConfigureCaddy
```

This generates:

```text
https://dropin-203-0-113-10.nip.io
```

## What The Script Does

1. Finds `ssh.exe`, `scp.exe`, and `tar.exe`.
2. Builds a tarball of the app.
3. Creates a production `.env` containing only:
   - `NODE_ENV`
   - `PORT`
   - `YOUTUBE_API_KEY`
   - `SYNC_ROOM_PASSWORD` when present
4. Uploads the app and env file.
5. Installs Node 20 if needed.
6. Writes `/etc/systemd/system/dropin.service`.
7. Enables and restarts the service.
8. Opens the app port through `ufw` when `ufw` is active.
9. With `-ConfigureCaddy`, installs Caddy, writes `/etc/caddy/Caddyfile`, opens ports `80` and `443`, and enables HTTPS.

## Useful VPS Commands

```bash
systemctl status dropin
journalctl -u dropin -f
systemctl restart dropin
systemctl status caddy
journalctl -u caddy -f
```

## Open The App

```text
http://203.0.113.10:8787
```

HTTPS is preferred for the browser player path. A real domain is best long-term, but a free wildcard DNS hostname works for MVP testing:

```text
https://dropin-203-0-113-10.nip.io
```
