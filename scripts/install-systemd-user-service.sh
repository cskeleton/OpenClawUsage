#!/usr/bin/env bash
# Install OpenClawUsage user-systemd Web and sync units with absolute paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST="127.0.0.1"
PORT="3001"
INTERVAL_MINUTES="60"
CONFIG_DIR="${OPENCLAW_CONFIG_DIR:-${HOME}/.openclaw}"
SYNC_ONLY=0

usage() {
  cat <<'EOF'
Usage: ./scripts/install-systemd-user-service.sh [options]

Installs openclaw-usage.service, openclaw-usage-sync.service, and the timer
under ~/.config/systemd/user. Existing generated units are replaced atomically.

Options:
  --repo-root PATH       Repository root (default: detected repository)
  --host HOST            Safe Web bind default (default: 127.0.0.1)
  --port PORT            Web port (default: 3001)
  --interval-minutes N   Sync timer interval (default: 60)
  --config-dir PATH      OPENCLAW_CONFIG_DIR default (default: ~/.openclaw)
  --sync-only            Install only the sync service and timer
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$(cd "$2" && pwd)"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --interval-minutes) INTERVAL_MINUTES="$2"; shift 2 ;;
    --config-dir) CONFIG_DIR="$2"; shift 2 ;;
    --sync-only) SYNC_ONLY=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ "$REPO_ROOT" != /* || ! -f "$REPO_ROOT/package.json" ]]; then
  echo "Error: repository root must be an absolute OpenClawUsage checkout." >&2
  exit 1
fi
NODE_PATH="$(command -v node || true)"
if [[ -z "$NODE_PATH" || "$NODE_PATH" != /* ]]; then
  echo "Error: node is required but not found as an absolute executable." >&2
  exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ || "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
  echo "Error: port must be an integer from 1 to 65535." >&2
  exit 1
fi
if [[ ! "$INTERVAL_MINUTES" =~ ^[0-9]+$ || "$INTERVAL_MINUTES" -lt 1 || "$INTERVAL_MINUTES" -gt 10080 ]]; then
  echo "Error: interval must be an integer from 1 to 10080 minutes." >&2
  exit 1
fi

reject_controls() {
  local name="$1" value="$2"
  if [[ "$value" =~ [[:cntrl:]] ]]; then
    echo "Error: $name must not contain control characters." >&2
    return 1
  fi
}

for value_spec in \
  "HOST:$HOST" \
  "REPO_ROOT:$REPO_ROOT" \
  "CONFIG_DIR:$CONFIG_DIR" \
  "NODE_PATH:$NODE_PATH" \
  "HOME:$HOME"; do
  value_name="${value_spec%%:*}"
  value_text="${value_spec#*:}"
  if ! reject_controls "$value_name" "$value_text"; then
    exit 1
  fi
done

if ! HOST_TO_VALIDATE="$HOST" SERVER_MODULE="$REPO_ROOT/server.js" "$NODE_PATH" --input-type=module -e \
  "import { pathToFileURL } from 'url'; const { resolveListenHost } = await import(pathToFileURL(process.env.SERVER_MODULE).href); resolveListenHost(process.env.HOST_TO_VALIDATE);" \
  >/dev/null 2>&1; then
  echo "Error: invalid OPENCLAW_USAGE_HOST: $HOST" >&2
  exit 1
fi

systemd_quote() {
  local value="$1"
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "Error: paths and values must not contain control characters." >&2
    return 1
  fi
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//%/%%}"
  printf '"%s"' "$value"
}

sed_escape() { printf '%s' "$1" | sed 's/[&|\\]/\\&/g'; }
quote_for_sed() {
  local quoted escaped
  if ! quoted="$(systemd_quote "$1")"; then
    return 1
  fi
  if ! escaped="$(sed_escape "$quoted")"; then
    return 1
  fi
  printf '%s' "$escaped"
}

if ! ROOT_ESC="$(quote_for_sed "$REPO_ROOT")"; then exit 1; fi
if ! NODE_ESC="$(quote_for_sed "$NODE_PATH")"; then exit 1; fi
if ! SERVER_ESC="$(quote_for_sed "$REPO_ROOT/server.js")"; then exit 1; fi
if ! CLI_ESC="$(quote_for_sed "$REPO_ROOT/scripts/openclaw-usage-cli.js")"; then exit 1; fi
if ! HOST_ESC="$(quote_for_sed "$HOST")"; then exit 1; fi
if ! PORT_ESC="$(quote_for_sed "$PORT")"; then exit 1; fi
if ! CONFIG_ESC="$(quote_for_sed "$CONFIG_DIR")"; then exit 1; fi
if ! INTERVAL_ESC="$(sed_escape "$INTERVAL_MINUTES")"; then exit 1; fi

UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "$UNIT_DIR"
chmod 700 "${HOME}/.config" 2>/dev/null || true
chmod 700 "$UNIT_DIR" 2>/dev/null || true

write_unit() {
  local source="$1" destination="$2"
  local temp_base temp suffix
  suffix="${destination##*.}"
  temp_base="$(mktemp "$UNIT_DIR/.openclaw-usage.XXXXXX")"
  temp="${temp_base}.${suffix}"
  if ! mv -f "$temp_base" "$temp"; then
    rm -f "$temp_base"
    echo "Error: could not prepare temporary systemd unit: $destination" >&2
    exit 1
  fi
  sed \
    -e "s|@REPO_ROOT_QUOTED@|$ROOT_ESC|g" \
    -e "s|@NODE_PATH_QUOTED@|$NODE_ESC|g" \
    -e "s|@SERVER_PATH_QUOTED@|$SERVER_ESC|g" \
    -e "s|@CLI_PATH_QUOTED@|$CLI_ESC|g" \
    -e "s|@HOST_QUOTED@|$HOST_ESC|g" \
    -e "s|@PORT_QUOTED@|$PORT_ESC|g" \
    -e "s|@CONFIG_DIR_QUOTED@|$CONFIG_ESC|g" \
    -e "s|OnUnitActiveSec=60min|OnUnitActiveSec=${INTERVAL_ESC}min|g" \
    "$source" > "$temp"
  if command -v systemd-analyze >/dev/null 2>&1 && ! systemd-analyze verify "$temp" >/dev/null 2>&1; then
    rm -f "$temp"
    echo "Error: generated systemd unit failed systemd-analyze verify: $destination" >&2
    exit 1
  fi
  chmod 600 "$temp"
  mv -f "$temp" "$destination"
}

if [[ "$SYNC_ONLY" -ne 1 ]]; then
  write_unit "$REPO_ROOT/deploy/openclaw-usage.service" "$UNIT_DIR/openclaw-usage.service"
fi
write_unit "$REPO_ROOT/deploy/openclaw-usage-sync.service" "$UNIT_DIR/openclaw-usage-sync.service"
write_unit "$REPO_ROOT/deploy/openclaw-usage-sync.timer" "$UNIT_DIR/openclaw-usage-sync.timer"

echo "Installed user-systemd units in $UNIT_DIR"
if command -v systemctl >/dev/null 2>&1; then
  if systemctl --user daemon-reload >/dev/null 2>&1; then
    if [[ "$SYNC_ONLY" -ne 1 ]]; then
      systemctl --user enable --now openclaw-usage.service >/dev/null 2>&1 || true
    fi
    systemctl --user enable --now openclaw-usage-sync.timer >/dev/null 2>&1 || true
  else
    echo "Note: systemd user manager unavailable; units were installed but not started." >&2
  fi
fi
