# AGENTS.md — install waha-mcp for your user

You are an AI agent (Claude Code or similar) installing waha-mcp: an MCP server that lets your
user's AI read their WhatsApp and send messages for them. It runs next to WAHA (the WhatsApp
HTTP API, GOWS engine) with Docker Compose. Follow the steps in order; each ends with a check.
Humans have the same guide in prose at [docs/self-hosting.md](docs/self-hosting.md).

Rules while you work:

- Never print, echo, log or paste secrets from `.env` (`MASTER_KEY`, `ADMIN_PASSWORD`,
  `WAHA_API_KEY`, `WAHA_WEBHOOK_SECRET`, `WAHA_DASHBOARD_PASSWORD`). Read them into shell
  variables, as shown below, and tell the user where to find them instead.
- Never commit `.env`. Never expose WAHA's port (3001) publicly; the compose file binds it to
  `127.0.0.1` on purpose.
- Ask the user before running anything with `sudo`, opening firewall ports, or deleting volumes.
- Stop and ask when a check fails twice; show the user the exact error line.

## 0. Decide the target

Ask the user one question if you do not know: **VPS with a domain, or this laptop?**

- **VPS** (recommended): needs a domain or subdomain whose DNS `A` record points at the VPS, and
  ports 80/443 open. Works with claude.ai, ChatGPT and Claude Code.
- **Laptop**: no domain; `PUBLIC_BASE_URL=http://localhost:3000`. Works with Claude Code on the
  same machine only (claude.ai cannot reach `localhost`). Webhooks are off.

Also ask for the username they want (3-32 characters of `A-Z a-z 0-9 . - _`); default `owner`.

## 1. Prerequisites

```bash
docker compose version     # Compose v2+
git --version
openssl version
```

Check: all three print a version. If Docker is missing on an Ubuntu VPS, ask the user before
installing it (`curl -fsSL https://get.docker.com | sh`). On a VPS also check the domain:

```bash
getent hosts mcp.example.com     # must print the VPS's public IP
curl -fsS https://api.ipify.org  # the VPS's public IP, to compare
```

## 2. Clone

```bash
git clone https://github.com/stivenrosales/waha-mcp.git
cd waha-mcp
```

Check: `ls docker-compose.yml compose.env.example scripts/init-env.sh` lists all three.

## 3. Generate `.env`

```bash
sh scripts/init-env.sh --domain mcp.example.com --username owner   # VPS
sh scripts/init-env.sh --username owner                            # laptop
```

Check: the script prints `Wrote .../.env (mode 600 ...)` and the `PUBLIC_BASE_URL`. It refuses
to overwrite an existing `.env`; if one exists, ask the user whether to keep it.

Tell the user, in these words or close: "Your login is `<username>`; the password is the
`ADMIN_PASSWORD` line in `.env`. Copy `MASTER_KEY` from `.env` to your password manager now:
without it your encrypted message cache cannot be read."

The install is single-owner (`MULTI_TENANT=false`). Change it only if the user asks to invite
other people.

## 4. Start the stack

```bash
docker compose --profile https up -d --build   # VPS (bundled Caddy terminates HTTPS)
docker compose up -d --build                   # laptop
```

Check (repeat for up to 3 minutes; the first build and pull take a while):

```bash
docker compose ps
```

Expect `(healthy)` in the STATUS of `waha` and `waha-mcp` (and `caddy` `Up` on a VPS).
If `waha-mcp` keeps restarting, run `docker compose logs --tail 30 waha-mcp` and look for
`Invalid configuration:`; each following line names the variable to fix in `.env`.

## 5. Pair WhatsApp (needs the user)

```bash
KEY="$(grep '^WAHA_API_KEY=' .env | cut -d= -f2-)"
SESSION="$(grep '^WAHA_SESSION=' .env | cut -d= -f2-)"; SESSION="${SESSION:-default}"
curl -fsS -H "X-Api-Key: $KEY" "http://127.0.0.1:3001/api/sessions/$SESSION"
```

Read `status`:

- `SCAN_QR_CODE`: get the QR to the user. Best options, in order:
  1. If you can show images to the user, save it and show `qr.png`:
     `curl -fsS -H "X-Api-Key: $KEY" -H "Accept: image/png" "http://127.0.0.1:3001/api/$SESSION/auth/qr" -o qr.png`
  2. Ask the user to run `docker compose logs -f waha` in their own terminal and scan the QR it
     prints.
  3. Laptop: tell them to open `http://localhost:3001/dashboard` (login:
     `WAHA_DASHBOARD_USERNAME` / `WAHA_DASHBOARD_PASSWORD` in `.env`). VPS: they first run
     `ssh -L 3001:127.0.0.1:3001 <user>@<vps>` on their computer, then open the same URL.

  Instructions for the user: "On your phone, open WhatsApp > Settings > Linked devices > Link a
  device, and scan the code." A QR expires within about a minute: fetch a new one if needed.
  Poll the status every 5 seconds until it changes.
- `STARTING`: wait 5 seconds and check again.
- `FAILED` or `STOPPED`: `curl -fsS -X POST -H "X-Api-Key: $KEY" "http://127.0.0.1:3001/api/sessions/$SESSION/restart"`, then check again.
- `WORKING`: paired. Continue.

Then restart waha-mcp once, so it records the account and configures webhooks:

```bash
docker compose restart waha-mcp
```

Delete `qr.png` if you created it.

## 6. Verify

```bash
curl -fsS http://127.0.0.1:3000/health                 # {"status":"ok"}
curl -fsS https://mcp.example.com/health               # VPS only; same answer through HTTPS
docker compose logs waha-mcp | grep 'listening' | tail -1
```

Check: both health calls return `{"status":"ok"}` and the log line contains `engine: GOWS` and
`mode: single-owner`. If the engine is `unknown (WAHA not reachable)`, wait until `waha` is
healthy and restart `waha-mcp`; if it is another engine, see Troubleshooting.

## 7. Connect the MCP to Claude

`<base>` is `PUBLIC_BASE_URL` from `.env` (`grep '^PUBLIC_BASE_URL=' .env`).

- **Claude Code** (on the user's machine):

  ```bash
  claude mcp add --transport http waha <base>/mcp
  ```

  Then the user runs `/mcp` in Claude Code, selects `waha`, and logs in on the page that opens
  with their username and `ADMIN_PASSWORD`. You cannot complete this login for them.
- **claude.ai** (VPS only): Settings > Connectors > Add custom connector, URL `<base>/mcp`, then
  the same login.

Check: after login, a tool call such as `list_chats` returns their chats.

## Troubleshooting

| Symptom                                             | Action                                                                                                                                                                                                                  |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid configuration:` in `waha-mcp` logs         | Fix the named variables in `.env`; `docker compose up -d`.                                                                                                                                                              |
| `engine: unknown (WAHA not reachable)`              | Wait for `waha` healthy; `docker compose restart waha-mcp`.                                                                                                                                                             |
| Engine is `WEBJS` or `NOWEB`                        | Ask the user, then delete the session (`curl -X DELETE -H "X-Api-Key: $KEY" http://127.0.0.1:3001/api/sessions/$SESSION`), `docker compose restart waha`, pair again.                                                   |
| `caddy` certificate errors                          | DNS must point at the VPS; ports 80/443 open (ask before `sudo ufw allow 80,443/tcp`); `DOMAIN` is a bare host name.                                                                                                    |
| `MASTER_KEY does not match the stored tenant keys.` | `.env` has a different key from the data's. Ask the user for the original key; never delete the volume to "fix" it without their consent.                                                                               |
| Login page rejects the password                     | `ADMIN_PASSWORD` is read only on the first start. Ask the user, then set `ADMIN_PASSWORD_RESET=1` with the new `ADMIN_PASSWORD`, `docker compose up -d`, log in, remove `ADMIN_PASSWORD_RESET`, `docker compose up -d`. |
| Port already in use (laptop)                        | Change `WAHA_MCP_PORT` (and the port in `PUBLIC_BASE_URL`) or `WAHA_HOST_PORT` in `.env`.                                                                                                                               |
| Anything else                                       | `docker compose logs --tail 50 waha waha-mcp`; show the user the error lines, after checking that none of them holds a value from `.env`.                                                                               |

More: [docs/self-hosting.md](docs/self-hosting.md) (updating, backups) and
[README](README.md) (tools, configuration, security).
