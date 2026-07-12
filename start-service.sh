#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PORT="${PORT:-4000}"
HOST="${HOST:-0.0.0.0}"
PUBLIC_IP="${PUBLIC_IP:-100.87.19.163}"
PUBLIC_URL="${PUBLIC_URL:-http://${PUBLIC_IP}:${PORT}/}"
IFACE="${IFACE:-eth0}"

if command -v ip >/dev/null 2>&1; then
  if ! ip -4 addr show dev "$IFACE" | grep -q "${PUBLIC_IP}/"; then
    echo "Assigning ${PUBLIC_IP}/32 to ${IFACE}..."
    if ip addr add "${PUBLIC_IP}/32" dev "$IFACE" 2>/dev/null; then
      :
    elif command -v sudo >/dev/null 2>&1; then
      sudo ip addr add "${PUBLIC_IP}/32" dev "$IFACE" 2>/dev/null || true
    fi
  fi
fi

export PORT HOST PUBLIC_URL
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "$NODE_BIN" ] && [ -x /home/ubuntu/.nvm/versions/node/v22.22.2/bin/node ]; then
  NODE_BIN=/home/ubuntu/.nvm/versions/node/v22.22.2/bin/node
fi
if [ -z "$NODE_BIN" ]; then
  echo "node not found in PATH" >&2
  exit 1
fi
echo "Starting OpenCharacters on ${PUBLIC_URL}"
exec "$NODE_BIN" server.js
