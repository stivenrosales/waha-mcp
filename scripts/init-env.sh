#!/usr/bin/env sh
# Writes the .env that docker-compose.yml reads, from compose.env.example, with every secret
# generated (MASTER_KEY, ADMIN_PASSWORD, WAHA_API_KEY, WAHA_WEBHOOK_SECRET, WAHA dashboard
# password). Nothing secret is printed; the file is mode 600 and never overwritten.
#
#   sh scripts/init-env.sh [--domain <domain>] [--username <name>] [--output <file>]
#
#   --domain    VPS: PUBLIC_BASE_URL=https://<domain> (for the bundled Caddy, or your own
#               proxy) and webhooks on. Without it: laptop, PUBLIC_BASE_URL=http://localhost:3000
#               and webhooks off (WAHA cannot reach "localhost" from its container).
#   --username  Admin login (default "owner"): 3-32 of A-Z a-z 0-9 . - _
#   --output    Default: .env next to docker-compose.yml.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE="$ROOT/compose.env.example"
DOMAIN=""
USERNAME="owner"
OUT="$ROOT/.env"

usage() {
  echo "Usage: sh scripts/init-env.sh [--domain <domain>] [--username <name>] [--output <file>]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) [ $# -ge 2 ] || usage; DOMAIN="$2"; shift 2 ;;
    --username) [ $# -ge 2 ] || usage; USERNAME="$2"; shift 2 ;;
    --output) [ $# -ge 2 ] || usage; OUT="$2"; shift 2 ;;
    -h | --help) usage ;;
    *) echo "Unknown option: $1" >&2; usage ;;
  esac
done

case "$USERNAME" in
  *[!A-Za-z0-9._-]* | "") echo "Username may only contain letters, digits, '.', '_' and '-'." >&2; exit 1 ;;
esac
if [ "${#USERNAME}" -lt 3 ] || [ "${#USERNAME}" -gt 32 ]; then
  echo "Username must be 3 to 32 characters." >&2
  exit 1
fi
if [ -n "$DOMAIN" ]; then
  case "$DOMAIN" in
    *[!A-Za-z0-9.-]* | .* | *. | *..*)
      echo "Domain must be a bare host name such as mcp.example.com (no scheme, port or path)." >&2
      exit 1 ;;
  esac
  case "$DOMAIN" in
    *.*) ;;
    *) echo "Domain must be a bare host name such as mcp.example.com (no scheme, port or path)." >&2; exit 1 ;;
  esac
fi
if [ ! -f "$TEMPLATE" ]; then
  echo "$TEMPLATE not found; run this script from a waha-mcp checkout." >&2
  exit 1
fi
if [ -e "$OUT" ]; then
  echo "$OUT already exists; move it away or pass --output <file>." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl is required." >&2; exit 1; }

# URL-safe random strings: no quoting needed in .env.
token() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'; }

MASTER_KEY="$(openssl rand -base64 32)"
ADMIN_PASSWORD="$(token 18)"
WAHA_API_KEY="$(openssl rand -hex 32)"
DASHBOARD_PASSWORD="$(token 18)"
if [ -n "$DOMAIN" ]; then
  PUBLIC_BASE_URL="https://$DOMAIN"
  WEBHOOK_SECRET="$(openssl rand -hex 32)"
else
  PUBLIC_BASE_URL="http://localhost:3000"
  WEBHOOK_SECRET=""
fi

# WAHA publishes its GOWS image per CPU: "gows" is amd64 only, "gows-arm" is arm64.
case "$(uname -m)" in
  arm64 | aarch64) WAHA_IMAGE="devlikeapro/waha:gows-arm" ;;
  *) WAHA_IMAGE="devlikeapro/waha:gows" ;;
esac

umask 077
TMP="$OUT.tmp.$$"
trap 'rm -f "$TMP"' EXIT
# Values go through the environment, not the awk program text.
MASTER_KEY="$MASTER_KEY" ADMIN_PASSWORD="$ADMIN_PASSWORD" WAHA_API_KEY="$WAHA_API_KEY" \
  DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD" PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
  WEBHOOK_SECRET="$WEBHOOK_SECRET" USERNAME="$USERNAME" DOMAIN="$DOMAIN" WAHA_IMAGE="$WAHA_IMAGE" \
  awk '
    BEGIN {
      v["MASTER_KEY"] = ENVIRON["MASTER_KEY"]
      v["ADMIN_PASSWORD"] = ENVIRON["ADMIN_PASSWORD"]
      v["ADMIN_USERNAME"] = ENVIRON["USERNAME"]
      v["WAHA_API_KEY"] = ENVIRON["WAHA_API_KEY"]
      v["WAHA_WEBHOOK_SECRET"] = ENVIRON["WEBHOOK_SECRET"]
      v["WAHA_DASHBOARD_PASSWORD"] = ENVIRON["DASHBOARD_PASSWORD"]
      v["PUBLIC_BASE_URL"] = ENVIRON["PUBLIC_BASE_URL"]
      v["DOMAIN"] = ENVIRON["DOMAIN"]
      v["WAHA_IMAGE"] = ENVIRON["WAHA_IMAGE"]
    }
    /^[A-Z_]+=/ {
      key = substr($0, 1, index($0, "=") - 1)
      if (key in v) { print key "=" v[key]; next }
    }
    { print }
  ' "$TEMPLATE" >"$TMP"
if grep -q '^[A-Z_]*=<generate>' "$TMP"; then
  echo "Internal error: a <generate> placeholder was left in the template." >&2
  exit 1
fi
mv "$TMP" "$OUT"
trap - EXIT

echo "Wrote $OUT (mode 600, readable only by you)."
echo "PUBLIC_BASE_URL=$PUBLIC_BASE_URL"
echo "WAHA image: $WAHA_IMAGE (matches this machine's CPU)."
echo "Admin login: $USERNAME (password: the ADMIN_PASSWORD line in $OUT)."
if [ -n "$DOMAIN" ]; then
  echo "Webhooks: on. Point $DOMAIN at this server, then: docker compose --profile https up -d --build"
else
  echo "Webhooks: off (laptop). Next: docker compose up -d --build"
fi
echo "Keep an offline copy of MASTER_KEY: without it the encrypted message cache cannot be read."
