#!/usr/bin/env sh
# Generates the secrets waha-mcp 0.4.0 needs and writes them, ready to paste into
# Easypanel (Environment), to a private file. Nothing secret is printed to the terminal.
#
#   sh scripts/generate-secrets.sh [admin-username] [output-file]
#
# Defaults: username "admin", file ~/waha-mcp-secrets.env (mode 600). Refuses to overwrite.
set -eu

USERNAME="${1:-admin}"
OUT="${2:-$HOME/waha-mcp-secrets.env}"

case "$USERNAME" in
  *[!A-Za-z0-9._-]* | "") echo "Username may only contain letters, digits, '.', '_' and '-'." >&2; exit 1 ;;
esac
if [ "${#USERNAME}" -lt 3 ] || [ "${#USERNAME}" -gt 32 ]; then
  echo "Username must be 3 to 32 characters." >&2
  exit 1
fi
if [ -e "$OUT" ]; then
  echo "$OUT already exists; move it away or pass another output file." >&2
  exit 1
fi

# 32 random bytes in base64 (the envelope-encryption key).
MASTER_KEY="$(openssl rand -base64 32)"
# 24 random URL-safe characters (~144 bits) for the admin password.
ADMIN_PASSWORD="$(openssl rand -base64 18 | tr '+/' '-_')"

umask 077
cat >"$OUT" <<EOF
# waha-mcp secrets — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Paste these lines into Easypanel > waha-mcp > Environment.
# Keep an offline copy of MASTER_KEY: without it the encrypted cache cannot be read.
MASTER_KEY=$MASTER_KEY
ADMIN_USERNAME=$USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF

echo "Secrets written to $OUT (readable only by you)."
echo "Open it, paste the three lines into Easypanel, and log in to waha-mcp as '$USERNAME'."
