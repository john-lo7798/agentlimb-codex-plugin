#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID=""
NO_START="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_ID="${2:-}"
      shift 2
      ;;
    --no-start)
      NO_START="1"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SERVER_PATH="$PROJECT_ROOT/kernel/bridge/mvp/run-server.js"
CLI_PATH="$PROJECT_ROOT/bin/agentlimb.mjs"
NATIVE_HOST_PATH="$PROJECT_ROOT/bin/native-host.mjs"
BIN_DIR="$HOME/.agentlimb/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/agentlimb" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$CLI_PATH" "\$@"
EOF
chmod +x "$BIN_DIR/agentlimb"

cat > "$BIN_DIR/agentlimb-native-host" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$NATIVE_HOST_PATH"
EOF
chmod +x "$BIN_DIR/agentlimb-native-host"

write_native_manifest() {
  local manifest_dir="$1"
  mkdir -p "$manifest_dir"

  local origins_json='"chrome-extension://hldldfepjhljhbcneojddjkkodkjglof/"'
  if [[ -n "$EXTENSION_ID" ]]; then
    origins_json="$origins_json, \"chrome-extension://$EXTENSION_ID/\""
  fi

  cat > "$manifest_dir/com.agentlimb.bridge.json" <<EOF
{
  "name": "com.agentlimb.bridge",
  "description": "AgentLimb local bridge companion",
  "path": "$BIN_DIR/agentlimb-native-host",
  "type": "stdio",
  "allowed_origins": [$origins_json]
}
EOF
}

case "$(uname -s)" in
  Darwin)
    write_native_manifest "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    PLIST="$HOME/Library/LaunchAgents/com.agentlimb.bridge.plist"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.agentlimb.bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SERVER_PATH</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_ROOT</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/agentlimb-bridge.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/agentlimb-bridge.log</string>
</dict>
</plist>
EOF
    if [[ "$NO_START" != "1" ]]; then
      launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
      launchctl kickstart -k "gui/$(id -u)/com.agentlimb.bridge" 2>/dev/null || launchctl start com.agentlimb.bridge 2>/dev/null || true
    fi
    ;;
  Linux)
    write_native_manifest "$HOME/.config/google-chrome/NativeMessagingHosts"
    if command -v systemctl >/dev/null 2>&1; then
      SERVICE_DIR="$HOME/.config/systemd/user"
      mkdir -p "$SERVICE_DIR"
      cat > "$SERVICE_DIR/agentlimb-bridge.service" <<EOF
[Unit]
Description=AgentLimb local browser bridge

[Service]
WorkingDirectory=$PROJECT_ROOT
ExecStart=$NODE_BIN $SERVER_PATH
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
      if [[ "$NO_START" != "1" ]]; then
        systemctl --user daemon-reload
        systemctl --user enable --now agentlimb-bridge.service
      fi
    fi
    ;;
  *)
    echo "Unsupported OS. Use: $BIN_DIR/agentlimb bridge" >&2
    ;;
esac

echo "AgentLimb Bridge installed."
echo "Project: $PROJECT_ROOT"
echo "CLI: $BIN_DIR/agentlimb"
echo "Bridge URL: http://127.0.0.1:7791"

if [[ -z "$EXTENSION_ID" ]]; then
  echo ""
  echo "If you loaded the extension unpacked, rerun with its chrome://extensions ID:"
  echo "./scripts/install.sh --extension-id <your-extension-id>"
fi
