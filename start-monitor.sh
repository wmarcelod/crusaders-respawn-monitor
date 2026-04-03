#!/bin/sh
set -e

echo "[Monitor] Crusaders Respawn Monitor starting..."
echo "[Monitor] TS Host: ${TS_HOST:-localhost}:${TS_QUERY_PORT:-25639}"

# Wait for TS3 ClientQuery to be available (if running with ts3client container)
if [ "${TS_HOST}" != "localhost" ] && [ "${TS_HOST}" != "127.0.0.1" ] && [ -n "${TS_HOST}" ]; then
  echo "[Monitor] Waiting for TS3 ClientQuery at ${TS_HOST}:${TS_QUERY_PORT:-25639}..."
  for i in $(seq 1 60); do
    if nc -z "${TS_HOST}" "${TS_QUERY_PORT:-25639}" 2>/dev/null; then
      echo "[Monitor] TS3 ClientQuery is ready!"
      break
    fi
    if [ "$i" -eq 60 ]; then
      echo "[Monitor] WARNING: TS3 ClientQuery not available after 60s, starting anyway..."
    fi
    sleep 2
  done

  # Read API key from shared volume if available
  if [ -f /shared/cq_apikey.txt ]; then
    SHARED_KEY=$(cat /shared/cq_apikey.txt)
    if [ -n "$SHARED_KEY" ]; then
      export TS_APIKEY="$SHARED_KEY"
      echo "[Monitor] Using API key from shared volume"
    fi
  fi
fi

echo "[Monitor] Starting web server..."
exec npx tsx src/web-server.ts
