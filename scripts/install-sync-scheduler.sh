#!/usr/bin/env bash
# Install the low-frequency sync scheduler for macOS LaunchAgent or Linux user-systemd.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLATFORM="$(uname -s | tr '[:upper:]' '[:lower:]')"
INTERVAL_MINUTES="${OPENCLAW_USAGE_SYNC_INTERVAL_MINUTES:-}"
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-${HOME}/.openclaw}"

usage() {
  cat <<'EOF'
Usage: ./scripts/install-sync-scheduler.sh [options]

Options:
  --platform darwin|linux  Select scheduler explicitly (default: host OS)
  --repo-root PATH         Repository root (default: detected repository)
  --interval-minutes N     Override config interval (default: config or 60)
  --config-dir PATH        OpenClaw config directory (default: ~/.openclaw)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform) PLATFORM="$2"; shift 2 ;;
    --repo-root) REPO_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --interval-minutes) INTERVAL_MINUTES="$2"; shift 2 ;;
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ "$PLATFORM" == "darwin" ]]; then :; elif [[ "$PLATFORM" == "linux" ]]; then :; else
  echo "Error: unsupported scheduler platform: $PLATFORM" >&2
  exit 1
fi
if [[ "$REPO_ROOT" != /* || ! -f "$REPO_ROOT/package.json" ]]; then
  echo "Error: repository root must be an absolute OpenClawUsage checkout." >&2
  exit 1
fi
NODE_PATH="$(command -v node || true)"
if [[ -z "$NODE_PATH" || "$NODE_PATH" != /* ]]; then
  echo "Error: node is required but not found as an absolute executable." >&2
  exit 1
fi
reject_controls() {
  local name="$1" value="$2"
  if [[ "$value" =~ [[:cntrl:]] ]]; then
    echo "Error: $name must not contain control characters." >&2
    return 1
  fi
}
if ! reject_controls "REPO_ROOT" "$REPO_ROOT" || ! reject_controls "CONFIG_DIR" "$CONFIG_DIR" || ! reject_controls "NODE_PATH" "$NODE_PATH" || ! reject_controls "HOME" "$HOME"; then
  exit 1
fi

if [[ -z "$INTERVAL_MINUTES" ]]; then
  if ! INTERVAL_MINUTES="$(OPENCLAW_CONFIG_DIR="$CONFIG_DIR" SYNC_CONFIG_MODULE="$REPO_ROOT/sync-config.js" "$NODE_PATH" --input-type=module -e \
    "import { pathToFileURL } from 'url'; const { loadSyncConfig } = await import(pathToFileURL(process.env.SYNC_CONFIG_MODULE).href); loadSyncConfig().then((c) => process.stdout.write(String(c.settings.intervalMinutes))).catch(() => process.exit(2))")"; then
    echo "Error: unable to read sync interval from configuration." >&2
    exit 1
  fi
fi
if [[ ! "$INTERVAL_MINUTES" =~ ^[0-9]+$ || "$INTERVAL_MINUTES" -lt 1 || "$INTERVAL_MINUTES" -gt 10080 ]]; then
  echo "Error: interval must be an integer from 1 to 10080 minutes." >&2
  exit 1
fi

CLI_PATH="$REPO_ROOT/scripts/openclaw-usage-cli.js"
if ! reject_controls "CLI_PATH" "$CLI_PATH"; then
  exit 1
fi
if [[ "$PLATFORM" == "linux" ]]; then
  exec "$SCRIPT_DIR/install-systemd-user-service.sh" \
    --repo-root "$REPO_ROOT" \
    --interval-minutes "$INTERVAL_MINUTES" \
    --config-dir "$CONFIG_DIR" \
    --sync-only
fi

PLIST_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="$PLIST_DIR/com.openclaw.usage.sync.plist"
LOG_DIR="$CONFIG_DIR/logs/openclaw-usage"
if ! reject_controls "LOG_DIR" "$LOG_DIR"; then
  exit 1
fi
mkdir -p "$PLIST_DIR" "$LOG_DIR"
chmod 700 "$PLIST_DIR" 2>/dev/null || true
chmod 700 "$LOG_DIR" 2>/dev/null || true
INTERVAL_SECONDS=$((INTERVAL_MINUTES * 60))
XML_NODE_PATH="$(printf '%s' "$NODE_PATH" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g")"
XML_CLI_PATH="$(printf '%s' "$CLI_PATH" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g")"
XML_REPO_ROOT="$(printf '%s' "$REPO_ROOT" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g")"
XML_CONFIG_DIR="$(printf '%s' "$CONFIG_DIR" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g")"
XML_LOG_DIR="$(printf '%s' "$LOG_DIR" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g")"
TMP="$(mktemp "$PLIST_DIR/.openclaw-usage-sync.XXXXXX")"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT
cat > "$TMP" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.usage.sync</string>
  <key>ProgramArguments</key>
  <array><string>$XML_NODE_PATH</string><string>$XML_CLI_PATH</string><string>sync</string><string>--scheduled</string></array>
  <key>WorkingDirectory</key><string>$XML_REPO_ROOT</string>
  <key>EnvironmentVariables</key>
  <dict><key>OPENCLAW_CONFIG_DIR</key><string>$XML_CONFIG_DIR</string></dict>
  <key>StartInterval</key><integer>$INTERVAL_SECONDS</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$XML_LOG_DIR/sync.log</string>
  <key>StandardErrorPath</key><string>$XML_LOG_DIR/sync.log</string>
</dict>
</plist>
EOF
chmod 600 "$TMP"
if command -v plutil >/dev/null 2>&1 && ! plutil -lint "$TMP" >/dev/null 2>&1; then
  rm -f "$TMP"
  echo "Error: generated LaunchAgent plist failed plutil validation." >&2
  exit 1
fi
mv -f "$TMP" "$PLIST_PATH"
trap - EXIT
if command -v launchctl >/dev/null 2>&1; then
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  launchctl load "$PLIST_PATH" >/dev/null 2>&1 || true
fi
echo "Installed LaunchAgent: $PLIST_PATH"
