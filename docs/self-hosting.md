# Self-hosting Zenbox with Docker Compose

Run WAHA (the WhatsApp HTTP API, GOWS engine) and waha-mcp together on one machine, with one
`docker compose` command. A VPS is the main target: you get a public HTTPS URL that claude.ai,
ChatGPT and Claude Code can all reach. A laptop works too, for Claude Code on that laptop.

If you want an AI agent (Claude Code, for example) to do the install for you, point it at
[`AGENTS.md`](../AGENTS.md): it has the same steps as commands with checks.

## What you get

| Service    | What it is                                   | Reachable at                              |
| ---------- | -------------------------------------------- | ----------------------------------------- |
| `waha`     | WAHA with the GOWS engine (your WhatsApp)    | `127.0.0.1:3001` only (API and dashboard) |
| `waha-mcp` | This MCP server, built from the `Dockerfile` | `127.0.0.1:3000` (behind the proxy)       |
| `caddy`    | Optional HTTPS proxy (profile `https`)       | ports 80 and 443, at your domain          |

State lives in Docker volumes: `waha-sessions` and `waha-media` (WAHA), `waha-mcp-data` (logins
and your encrypted message cache, SQLite) and `caddy-data` (certificates). There is no database
server to run.

A fresh install is **single-owner**: it serves your own WhatsApp account only. To invite other
people later, each with their own WhatsApp, set `MULTI_TENANT=true` in `.env` and restart (see
[Multi-tenant](../README.md#multi-tenant)).

## Before you start

- A Linux VPS with 1 GB of RAM or more (Ubuntu 24.04 works), or a laptop with Docker Desktop.
- Docker Engine with the Compose plugin (`docker compose version` prints v2 or later), `git` and
  `openssl`.
- VPS only: a domain or subdomain (for example `mcp.example.com`) whose DNS `A` record points at
  the VPS, and ports 80 and 443 open in the firewall.
- Your phone with WhatsApp, to scan a QR code.

## 1. Get the code

```bash
git clone https://github.com/stivenrosales/zenbox.git
cd zenbox
```

## 2. Create `.env`

`scripts/init-env.sh` copies `compose.env.example` to `.env` and fills in every secret with a
random value. It prints no secret, writes the file with mode 600 and never overwrites one.

```bash
# VPS (HTTPS at your domain, webhooks on)
sh scripts/init-env.sh --domain mcp.example.com --username yourname

# Laptop (http://localhost:3000, webhooks off)
sh scripts/init-env.sh --username yourname
```

Your login is the username you chose and the `ADMIN_PASSWORD` line of `.env`
(`grep ADMIN_PASSWORD .env`). **Copy `MASTER_KEY` somewhere safe and offline**: it encrypts
your message cache, and without it that cache cannot be read (WhatsApp itself is not affected).

Prefer to edit by hand? `cp compose.env.example .env`, then replace each `<generate>`:
`openssl rand -base64 32` for `MASTER_KEY`, `openssl rand -hex 32` for the others. Every
setting in [README > Configuration](../README.md#configuration) can be added to `.env`.

## 3. Start

```bash
# VPS with the bundled HTTPS proxy
docker compose --profile https up -d --build

# Laptop, or a VPS where you already run a reverse proxy (point it at 127.0.0.1:3000)
docker compose up -d --build
```

The first start builds the waha-mcp image and pulls WAHA, which takes a few minutes. Check that
everything is healthy:

```bash
docker compose ps
```

`waha` and `waha-mcp` should say `healthy` (and `caddy` `running`, on a VPS).

## 4. Pair your WhatsApp

WAHA starts your session (`WAHA_SESSION`, `default` unless you changed it) and waits for a QR
scan. On your phone open WhatsApp > Settings > Linked devices > Link a device, then use one of:

- **Terminal:** `docker compose logs -f waha` prints the QR code; scan it from the screen.
- **Image:** save the QR as a PNG and open it:

  ```bash
  KEY="$(grep '^WAHA_API_KEY=' .env | cut -d= -f2-)"
  curl -fsS -H "X-Api-Key: $KEY" -H "Accept: image/png" \
    http://127.0.0.1:3001/api/default/auth/qr -o qr.png
  ```

- **WAHA dashboard:** on a laptop open `http://localhost:3001/dashboard`. On a VPS, open an SSH
  tunnel first (`ssh -L 3001:127.0.0.1:3001 you@your-vps`), then the same URL on your computer.
  The login is `WAHA_DASHBOARD_USERNAME` and `WAHA_DASHBOARD_PASSWORD` from `.env`.

A QR expires after a minute or so; fetch a new one if it does. Check the session:

```bash
curl -fsS -H "X-Api-Key: $KEY" http://127.0.0.1:3001/api/sessions/default
```

`"status": "WORKING"` means you are paired. Then restart waha-mcp once, so it records your
WhatsApp account and points the session's webhooks at itself:

```bash
docker compose restart waha-mcp
```

## 5. Check the server

```bash
curl -fsS http://127.0.0.1:3000/health          # {"status":"ok"}
curl -fsS https://mcp.example.com/health        # VPS, through HTTPS
docker compose logs waha-mcp | grep listening
```

The startup line should show `engine: GOWS` and `mode: single-owner`.

## 6. Connect Claude

Let `<base>` be `PUBLIC_BASE_URL` from `.env` (`https://mcp.example.com`, or
`http://localhost:3000` on a laptop).

- **Claude Code:** `claude mcp add --transport http waha <base>/mcp`, then run `/mcp` inside
  Claude Code, choose `waha` and log in with your username and `ADMIN_PASSWORD`.
- **claude.ai:** Settings > Connectors > Add custom connector, URL `<base>/mcp`. This needs the
  VPS (public HTTPS); claude.ai cannot reach `localhost`.
- ChatGPT and Gemini CLI: see [Connect your client](../README.md#connect-your-client).

Ask Claude "list my WhatsApp chats" to try it.

## Updating

```bash
git pull
docker compose --profile https up -d --build   # or without --profile on a laptop
```

Your volumes are kept. To update WAHA, pin a newer `WAHA_IMAGE` in `.env` (or
`docker compose pull waha` when you use an unpinned tag) and run the same command. WAHA's GOWS
image is per CPU: `devlikeapro/waha:gows` is amd64 only and `devlikeapro/waha:gows-arm` is
arm64 (Apple Silicon, ARM VPS); `scripts/init-env.sh` picks the right one for the machine.

## Backups

Back up the three volumes together with `.env` (it holds `MASTER_KEY`):

```bash
docker compose stop
for v in waha-sessions waha-media waha-mcp-data; do
  docker run --rm -v "waha-mcp_$v":/v -v "$PWD":/backup alpine tar czf "/backup/$v.tgz" -C /v .
done
docker compose start
```

A backup that holds `waha-mcp-data` and `MASTER_KEY` can decrypt your cached messages: store it
like the secret it is.

## Troubleshooting

| Symptom                                                               | Fix                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waha-mcp` restarts with `Invalid configuration:` in its logs         | Each line names a variable in `.env`; fix it and run `docker compose up -d`. A leftover `<generate>` means `.env` was copied by hand and not filled in.                                                     |
| Startup line says `engine: unknown (WAHA not reachable)`              | `docker compose ps`: wait for `waha` to be healthy, then `docker compose restart waha-mcp`.                                                                                                                 |
| Startup line names an engine other than `GOWS`                        | The session was created with another engine. Delete it (dashboard, or `curl -X DELETE -H "X-Api-Key: $KEY" http://127.0.0.1:3001/api/sessions/default`), then `docker compose restart waha` and pair again. |
| The QR is gone or the session is `FAILED` / `STOPPED`                 | `curl -X POST -H "X-Api-Key: $KEY" http://127.0.0.1:3001/api/sessions/default/restart`, then fetch a new QR.                                                                                                |
| Tools say WhatsApp is not connected                                   | Same as above: check the session status and pair again.                                                                                                                                                     |
| `caddy` logs certificate errors                                       | The domain's DNS must point at this server and ports 80 and 443 must be open (`sudo ufw allow 80,443/tcp`). `DOMAIN` in `.env` must be the bare host name.                                                  |
| `MASTER_KEY does not match the stored tenant keys.`                   | `.env` has a different `MASTER_KEY` from the one the data was created with. Restore the original key.                                                                                                       |
| Forgot the admin password                                             | Set `ADMIN_PASSWORD` to a new value and `ADMIN_PASSWORD_RESET=1` in `.env`, `docker compose up -d`, log in, then remove `ADMIN_PASSWORD_RESET` and run `docker compose up -d` again.                        |
| Port 3000 or 3001 already in use (laptop)                             | Change `WAHA_MCP_PORT` or `WAHA_HOST_PORT` in `.env`. If you change `WAHA_MCP_PORT`, set `PUBLIC_BASE_URL` to the same port.                                                                                |
| Edits, deletions and reactions made on the phone do not show (laptop) | Webhooks are off on a laptop: WAHA cannot reach `localhost` from its container. Reads still refresh the recent window (`CACHE_REFRESH_HOURS`).                                                              |
