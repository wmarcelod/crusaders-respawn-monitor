#!/bin/bash
set -e

NICKNAME="${TS_NICKNAME:-CrusaderMonitor}"
SERVER="${TS_SERVER:-crusaders.expto.com.br}"
SERVER_PORT="${TS_SERVER_PORT:-9987}"
CQ_APIKEY="${TS_CQ_APIKEY:-CRUSADER-MONITOR-2024}"

echo "============================================"
echo "  TeamSpeak 3 Headless Client"
echo "============================================"
echo "  Server:    ${SERVER}:${SERVER_PORT}"
echo "  Nickname:  ${NICKNAME}"
echo "  CQ Port:   25639"
echo "============================================"

# --- Start virtual display ---
echo "[TS3] Starting Xvfb virtual display..."
Xvfb :99 -screen 0 1024x768x24 -nolisten tcp &
XVFB_PID=$!
sleep 2

if ! kill -0 $XVFB_PID 2>/dev/null; then
  echo "[TS3] ERROR: Xvfb failed to start!"
  exit 1
fi
echo "[TS3] Xvfb started (PID: $XVFB_PID)"

# --- Configure TS3 client ---
TS3DIR="$HOME/.ts3client"
TS3APP="/opt/TeamSpeak3-Client-linux_amd64"
mkdir -p "$TS3DIR"

# Accept license agreement via settings.db
echo "[TS3] Pre-configuring TS3 client..."
sqlite3 "$TS3DIR/settings.db" "CREATE TABLE IF NOT EXISTS Misc (key TEXT PRIMARY KEY, value TEXT);"
sqlite3 "$TS3DIR/settings.db" "INSERT OR REPLACE INTO Misc (key, value) VALUES ('LicenseAccepted', '1');"
sqlite3 "$TS3DIR/settings.db" "INSERT OR REPLACE INTO Misc (key, value) VALUES ('LastShownLicense', '99999');"

# Configure ClientQuery plugin to listen on all interfaces
CQ_DIR="$TS3DIR/plugins/clientquery_plugin"
mkdir -p "$CQ_DIR"
printf '[General]\nhost=0.0.0.0\nport=25639\napi_key=%s\n' "$CQ_APIKEY" > "$CQ_DIR/settings.ini"

echo "[TS3] ClientQuery configured on 0.0.0.0:25639"

# --- Write API key to shared volume for monitor app ---
if [ -d "/shared" ]; then
  printf '%s' "$CQ_APIKEY" > /shared/cq_apikey.txt
  echo "[TS3] API key written to /shared/cq_apikey.txt"
fi

# --- Start TS3 client ---
echo "[TS3] Launching TS3 client..."
cd "$TS3APP"

export QT_QPA_PLATFORM=xcb
export LD_LIBRARY_PATH="$TS3APP:$LD_LIBRARY_PATH"

./ts3client_linux_amd64 "ts3server://${SERVER}:${SERVER_PORT}?nickname=${NICKNAME}" &
TS3_PID=$!

echo "[TS3] TS3 client started (PID: $TS3_PID)"

# --- Wait for ClientQuery to become available ---
echo "[TS3] Waiting for ClientQuery port 25639..."
for i in $(seq 1 30); do
  if nc -z 127.0.0.1 25639 2>/dev/null; then
    echo "[TS3] ClientQuery is ready!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[TS3] WARNING: ClientQuery not available after 30s"
  fi
  sleep 1
done

# --- Extract actual API key if TS3 generated a different one ---
sleep 3
if [ -f "$TS3DIR/settings.db" ]; then
  ACTUAL_KEY=$(sqlite3 "$TS3DIR/settings.db" "SELECT value FROM Misc WHERE key LIKE '%apikey%' OR key LIKE '%api_key%' OR key LIKE '%ApiKey%' LIMIT 1;" 2>/dev/null || true)
  if [ -n "$ACTUAL_KEY" ] && [ "$ACTUAL_KEY" != "$CQ_APIKEY" ]; then
    echo "[TS3] Detected actual API key from TS3: ${ACTUAL_KEY}"
    CQ_APIKEY="$ACTUAL_KEY"
    if [ -d "/shared" ]; then
      printf '%s' "$CQ_APIKEY" > /shared/cq_apikey.txt
      echo "[TS3] Updated API key in shared volume"
    fi
  fi
fi

echo "[TS3] Ready. Monitoring TS3 client process..."

# --- Keep alive: restart TS3 if it crashes ---
while true; do
  if ! kill -0 $TS3_PID 2>/dev/null; then
    echo "[TS3] TS3 client stopped! Restarting in 10s..."
    sleep 10
    cd "$TS3APP"
    ./ts3client_linux_amd64 "ts3server://${SERVER}:${SERVER_PORT}?nickname=${NICKNAME}" &
    TS3_PID=$!
    echo "[TS3] TS3 client restarted (PID: $TS3_PID)"
  fi
  sleep 5
done
