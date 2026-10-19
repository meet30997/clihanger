#!/usr/bin/env bash
#
# build-and-open.sh — Builds CliHanger, stops any running instance,
# replaces /Applications/CliHanger.app with the fresh build, and launches it.
#
# Usage:
#   bash scripts/build-and-open.sh [options]
#
# Options:
#   --rebuild    Run `npm run rebuild` (native node-pty rebuild) before building
#   --no-open    Do not launch the app after installing
#   --help       Show this help message
#

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

REBUILD=0
AUTO_OPEN=1

for arg in "$@"; do
  case "$arg" in
    --rebuild)
      REBUILD=1
      ;;
    --no-open)
      AUTO_OPEN=0
      ;;
    -h|--help)
      echo "Usage: $0 [--rebuild] [--no-open] [--help]"
      echo ""
      echo "  1. Stops any currently running CliHanger app."
      echo "  2. Builds the macOS package with npm run dist."
      echo "  3. Replaces /Applications/CliHanger.app with the new build."
      echo "  4. Clears quarantine attributes and opens the app automatically."
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      echo "Use --help for usage." >&2
      exit 1
      ;;
  esac
done

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BLUE=$'\033[1;34m'
  C_GREEN=$'\033[1;32m'
  C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[1;31m'
  C_OFF=$'\033[0m'
else
  C_BLUE=''
  C_GREEN=''
  C_YELLOW=''
  C_RED=''
  C_OFF=''
fi

info()  { printf '%s==> %s%s\n' "$C_BLUE" "$1" "$C_OFF"; }
ok()    { printf '%s✓ %s%s\n'   "$C_GREEN" "$1" "$C_OFF"; }
warn()  { printf '%s! %s%s\n'   "$C_YELLOW" "$1" "$C_OFF"; }
err()   { printf '%s✗ %s%s\n'   "$C_RED" "$1" "$C_OFF" >&2; }

# ---------------------------------------------------------------- Step 1: Stop existing app
info "Checking for running CliHanger instances..."

# Graceful quit via AppleScript if running
if pgrep -f 'CliHanger.app/Contents/MacOS/CliHanger' >/dev/null 2>&1; then
  warn "CliHanger is currently running. Requesting graceful quit..."
  osascript -e 'tell application "CliHanger" to quit' >/dev/null 2>&1 || true

  # Wait up to 4 seconds
  stopped=0
  for _ in {1..8}; do
    if ! pgrep -f 'CliHanger.app/Contents/MacOS/CliHanger' >/dev/null 2>&1; then
      stopped=1
      break
    fi
    sleep 0.5
  done

  # Force kill if still lingering
  if [ "$stopped" -eq 0 ] && pgrep -f 'CliHanger.app/Contents/MacOS/CliHanger' >/dev/null 2>&1; then
    warn "CliHanger did not terminate within timeout; sending SIGTERM..."
    pkill -f 'CliHanger.app/Contents/MacOS/CliHanger' >/dev/null 2>&1 || true
    sleep 1
  fi
  ok "Existing CliHanger process stopped."
else
  ok "No running CliHanger instance found."
fi

# ---------------------------------------------------------------- Step 2: Build app
if [ "$REBUILD" -eq 1 ]; then
  info "Rebuilding native dependencies (node-pty)..."
  npm run rebuild
fi

info "Building CliHanger application bundle (npm run dist)..."
npm run dist

# Locate built bundle in dist/
BUILT_APP=""
if [ -d "dist/mac-arm64/CliHanger.app" ]; then
  BUILT_APP="dist/mac-arm64/CliHanger.app"
elif [ -d "dist/mac/CliHanger.app" ]; then
  BUILT_APP="dist/mac/CliHanger.app"
elif [ -d "dist/mac-x64/CliHanger.app" ]; then
  BUILT_APP="dist/mac-x64/CliHanger.app"
else
  BUILT_APP=$(find dist -maxdepth 2 -name "CliHanger.app" -type d 2>/dev/null | head -n 1 || true)
fi

if [ -z "$BUILT_APP" ] || [ ! -d "$BUILT_APP" ]; then
  err "Could not find built CliHanger.app under dist/"
  exit 1
fi

ok "Found built bundle at $BUILT_APP"

# ---------------------------------------------------------------- Step 3: Replace in /Applications
DEST_APP="/Applications/CliHanger.app"
info "Installing to $DEST_APP..."

if [ -d "$DEST_APP" ]; then
  warn "Removing existing $DEST_APP..."
  rm -rf "$DEST_APP"
fi

cp -R "$BUILT_APP" "/Applications/"
xattr -cr "$DEST_APP" >/dev/null 2>&1 || true

if [ ! -d "$DEST_APP" ]; then
  err "Installation failed: $DEST_APP does not exist after copying."
  exit 1
fi

ok "Successfully installed to $DEST_APP"

# ---------------------------------------------------------------- Step 4: Open app
if [ "$AUTO_OPEN" -eq 1 ]; then
  info "Opening $DEST_APP..."
  open "$DEST_APP"
  ok "CliHanger launched!"
else
  ok "Build and installation complete (--no-open specified)."
fi
