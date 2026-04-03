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
sqlite3 "$TS3DIR/settings.db" << 'EOSQL'
CREATE TABLE IF NOT EXISTS Misc (key TEXT PRIMARY KEY, value TEXT);
INSERT OR REPLACE INTO Misc (key, value) VALUES ('LicenseAccepted', '1');
INSERT OR REPLACE INTO Misc (key, value) VALUES ('LastShownLicense', '99999');
EOSQL

# Configure ClientQuery plugin to listen on all interfaces
CQ_DIR="$TS3DIR/plugins/clientquery_plugin"
mkdir -p "$CQ_DIR"
cat > "$CQ_DIR/settings.ini" << EOF
[General]
host=0.0.0.0
port=25639
api_key=${CQ_APIKEY}
EOF

echo "[TS3] ClientQuery configured on 0.0.0.0:25639"

# --- Write API key to shared volume for monitor app ---
SHARED_DIR="/shared"
if [ -d "$SHARED_DIR" ]; then
  echo "$CQ_APIKEY" > "$SHARED_DIR/cq_apikey.txt"
  echo "[TS3] API key written to ${SHARED_DIR}/cq_apikey.txt"
fi

# --- Start TS3 client ---
echo "[TS3] Launching TS3 client..."
cd "$TS3APP"

# Connect to server with nickname
./ts3client_linux_amd64 "ts3server://${SERVER}:${SERVER_PORT}?nickname=${NICKNAME}" &
TS3_PID=$!

echo "[TS3] TS3 client started (PID: $TS3_PID)"

# --- Wait for ClientQuery to become available ---
echo "[TS3] Waiting for ClientQuery port 25639..."
for i in $(seq 1 30); do
  if bash -c "echo > /dev/tcp/127.0.0.1/25639" 2>/dev/null; then
    echo "[TS3] ClientQuery is ready!"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "[TS3] WARNING: ClientQuery not available after 30s"
  fi
  sleep 1
done

# --- Extract actual API key if settings.ini approach didn't work ---
# Try to read the generated API key from TS3 settings
sleep 3
ACTUAL_KEY=""
if [ -f "$TS3DIR/settings.db" ]; then
  ACTUAL_KEY=$(sqlite3 "$TS3DIR/settings.db" "SELECT value FROM Misc WHERE key LIKE '%apikey%' OR key LIKE '%api_key%' OR key LIKE '%ApiKey%' LIMIT 1;" 2>/dev/null || echo "")
fi

if [ -n "$ACTUAL_KEY" ] && [ "$ACTUAL_KEY" != "$CQ_APIKEY" ]; then
  echo "[TS3] Detected actual API key from TS3: ${ACTUAL_KEY}"
  if [ -d "$SHARED_DIR" ]; then
    echo "$ACTUAL_KEY" > "$SHARED_DIR/cq_apikey.txt"
    echo "[TS3] Updated API key in shared volume"
  fi
fi

echo "[TS3] Ready. Monitoring TS3 client process..."

# --- Keep alive: restart TS3 if it crashes ---
while true; do
  if ! kill -0 $TS3_PID 2>/dev/null; then
    echo "[TS3] TS3 client crashed! Restarting in 10s..."
    sleep 10
    cd "$TS3APP"
    ./ts3client_linux_amd64 "ts3server://${SERVER}:${SERVER_PORT}?nickname=${NICKNAME}" &
    TS3_PID=$!
    echo "[TS3] TS3 client restarted (PID: $TS3_PID)"
  fi
  sleep 5
done
