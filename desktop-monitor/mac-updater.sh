#!/bin/sh
# Independent macOS bundle updater. This runs outside the app bundle after DENVique exits.
set -eu

ZIP_PATH="${1:-}"
APP_EXECUTABLE="${2:-}"
USER_DATA="${3:-}"
VERSION="${4:-}"
EXPECTED_SHA="${5:-}"
PARENT_PID="${6:-}"
TRANSACTION_ID="${7:-}"
EXPECTED_BUNDLE_ID="${8:-}"
MODE="${9:-}"

[ -n "$ZIP_PATH" ] && [ -n "$APP_EXECUTABLE" ] && [ -n "$USER_DATA" ] && [ -n "$VERSION" ] || exit 2
case "$VERSION" in *[!0-9.]*|'') exit 2 ;; esac
case "$EXPECTED_SHA" in *[!a-fA-F0-9]*|'') exit 2 ;; esac
case "$TRANSACTION_ID" in *[!a-fA-F0-9-]*|'') exit 2 ;; esac

/bin/mkdir -p "$USER_DATA/mac-app-updates"
LOG_FILE="$USER_DATA/mac-app-updates/updater.log"
exec >>"$LOG_FILE" 2>&1
log() { printf '[%s] %s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

APP_BUNDLE="${APP_EXECUTABLE%/Contents/MacOS/*}"
if [ "$APP_BUNDLE" = "$APP_EXECUTABLE" ] || [ ! -d "$APP_BUNDLE" ]; then
  log "Cannot determine the installed application bundle."
  exit 3
fi
APP_PARENT="$(/usr/bin/dirname "$APP_BUNDLE")"
NEW_APP_NAME="DENVique Desktop Monitor.app"
STAGE_DIR="$APP_PARENT/.DENVique-update-$TRANSACTION_ID"
BACKUP_APP="$APP_BUNDLE.backup-$TRANSACTION_ID"
SUCCESS_FILE="$USER_DATA/mac-app-updates/success-$TRANSACTION_ID.json"
STARTUP_TIMEOUT_SECONDS="${DENVique_UPDATER_STARTUP_TIMEOUT:-60}"
case "$STARTUP_TIMEOUT_SECONDS" in *[!0-9]*|'') STARTUP_TIMEOUT_SECONDS=60 ;; esac

wait_for_parent() {
  if [ -n "$PARENT_PID" ]; then
    COUNT=0
    while /bin/kill -0 "$PARENT_PID" 2>/dev/null; do
      COUNT=$((COUNT + 1))
      [ "$COUNT" -lt 120 ] || { log "Timed out waiting for DENVique to exit."; return 1; }
      /bin/sleep 1
    done
  fi
  return 0
}

install_bundle() {
  log "Checking downloaded archive digest."
  [ -f "$ZIP_PATH" ] || { log "Update archive is missing."; return 1; }
  ACTUAL_SHA="$(/usr/bin/shasum -a 256 "$ZIP_PATH" | /usr/bin/awk '{print $1}')"
  [ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || { log "Archive SHA-256 mismatch."; return 1; }

  /bin/rm -rf "$STAGE_DIR"
  /bin/mkdir -p "$STAGE_DIR"
  /usr/bin/ditto -x -k "$ZIP_PATH" "$STAGE_DIR"

  NEW_APP="$STAGE_DIR/$NEW_APP_NAME"
  [ -d "$NEW_APP/Contents" ] || { log "Expected .app bundle is missing from the archive."; return 1; }
  NEW_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$NEW_APP/Contents/Info.plist" 2>/dev/null || true)"
  NEW_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$NEW_APP/Contents/Info.plist" 2>/dev/null || true)"
  [ "$NEW_BUNDLE_ID" = "$EXPECTED_BUNDLE_ID" ] || { log "Unexpected bundle identifier."; return 1; }
  [ "$NEW_VERSION" = "$VERSION" ] || { log "Unexpected app version."; return 1; }
  /usr/bin/codesign --verify --deep --strict "$NEW_APP" >/dev/null 2>&1 || {
    log "The replacement app failed its code-signature integrity check."
    return 1
  }

  [ ! -e "$BACKUP_APP" ] || { log "Rollback backup already exists."; return 1; }
  log "Moving current app into rollback backup."
  /bin/mv "$APP_BUNDLE" "$BACKUP_APP"
  if /bin/mv "$NEW_APP" "$APP_BUNDLE"; then
    log "Replacement app installed."
    /bin/rm -rf "$STAGE_DIR"
    return 0
  fi

  log "Replacement failed; restoring previous app."
  /bin/rm -rf "$APP_BUNDLE"
  /bin/mv "$BACKUP_APP" "$APP_BUNDLE"
  return 1
}

if ! wait_for_parent; then log "Update cancelled because DENVique did not exit cleanly."; exit 1; fi

if [ "$MODE" = "--install-only" ]; then
  install_bundle
  exit $?
fi

if [ ! -w "$APP_PARENT" ]; then
  log "Protected install location; requesting administrator authorization."
  set +e
  /usr/bin/osascript - "$0" "$ZIP_PATH" "$APP_EXECUTABLE" "$USER_DATA" "$VERSION" "$EXPECTED_SHA" "$PARENT_PID" "$TRANSACTION_ID" "$EXPECTED_BUNDLE_ID" --install-only <<'APPLESCRIPT'
on run argv
  set commandText to "/bin/sh " & quoted form of (item 1 of argv)
  repeat with i from 2 to count of argv
    set commandText to commandText & " " & quoted form of (item i of argv)
  end repeat
  do shell script commandText with administrator privileges
end run
APPLESCRIPT
  INSTALL_STATUS=$?
  set -e
  if [ "$INSTALL_STATUS" -ne 0 ]; then
    log "Authorization or replacement failed; reopening the existing app."
    /usr/bin/open -a "$APP_BUNDLE" --args "--user-data-dir=$USER_DATA" || true
    exit 1
  fi
else
  if ! install_bundle; then
    log "Replacement failed; reopening the existing app."
    /usr/bin/open -a "$APP_BUNDLE" --args "--user-data-dir=$USER_DATA" || true
    exit 1
  fi
fi

log "Launching the updated application."
/usr/bin/open -a "$APP_BUNDLE" --args "--user-data-dir=$USER_DATA" || {
  log "Updated app could not be launched; rolling back."
  /bin/rm -rf "$APP_BUNDLE"
  [ ! -d "$BACKUP_APP" ] || /bin/mv "$BACKUP_APP" "$APP_BUNDLE"
  /usr/bin/open -a "$APP_BUNDLE" --args "--user-data-dir=$USER_DATA" || true
  exit 1
}

COUNT=0
while [ "$COUNT" -lt "$STARTUP_TIMEOUT_SECONDS" ]; do
  if [ -f "$SUCCESS_FILE" ]; then
    SUCCESS_VERSION="$(/usr/bin/plutil -extract version raw -o - "$SUCCESS_FILE" 2>/dev/null || true)"
    SUCCESS_TX="$(/usr/bin/plutil -extract transactionId raw -o - "$SUCCESS_FILE" 2>/dev/null || true)"
    if [ "$SUCCESS_VERSION" = "$VERSION" ] && [ "$SUCCESS_TX" = "$TRANSACTION_ID" ]; then
      log "New app startup acknowledged. Removing rollback backup."
      /bin/rm -rf "$BACKUP_APP" "$ZIP_PATH" "$SUCCESS_FILE" "$USER_DATA/mac-app-updates/pending.json"
      exit 0
    fi
  fi
  COUNT=$((COUNT + 1))
  /bin/sleep 1
done

log "New app did not acknowledge startup; restoring the previous app."
/usr/bin/osascript -e 'tell application id "com.denvique.desktopmonitor" to quit' >/dev/null 2>&1 || true
/bin/sleep 3
FAILED_APP="$APP_BUNDLE.failed-$TRANSACTION_ID"
/bin/mv "$APP_BUNDLE" "$FAILED_APP" || true
if [ -d "$BACKUP_APP" ]; then /bin/mv "$BACKUP_APP" "$APP_BUNDLE"; fi
/bin/rm -rf "$FAILED_APP" "$STAGE_DIR" "$ZIP_PATH" "$USER_DATA/mac-app-updates/pending.json" "$SUCCESS_FILE"
/usr/bin/open -a "$APP_BUNDLE" --args "--user-data-dir=$USER_DATA" || true
log "Rollback completed."
exit 1