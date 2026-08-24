#!/bin/bash
#
# Gyredeck installer — download the latest release and install it to
# /Applications. Meant to be piped straight from the repo:
#
#   curl -fsSL https://raw.githubusercontent.com/j-kizt/gyredeck-macos/main/scripts/install.sh | bash
#
set -euo pipefail

REPO="j-kizt/gyredeck-macos"
APP="Gyredeck.app"
APP_DEST="/Applications/$APP"

if [ "$(uname)" != "Darwin" ]; then
  echo "Gyredeck is macOS-only." >&2
  exit 1
fi

echo "Finding the latest Gyredeck release…"
asset_url="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
  | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]+\.app\.tar\.gz"' \
  | sed -E 's/.*"(https[^"]+)"$/\1/' \
  | head -1)"

if [ -z "$asset_url" ]; then
  echo "Could not find a release asset to download." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading…"
curl -fsSL "$asset_url" -o "$tmp/app.tar.gz"
tar -xzf "$tmp/app.tar.gz" -C "$tmp"

src="$(find "$tmp" -maxdepth 1 -name '*.app' -print | head -1)"
if [ -z "$src" ]; then
  echo "Downloaded archive did not contain an .app." >&2
  exit 1
fi

echo "Installing to /Applications…"
osascript -e "quit app \"Gyredeck\"" 2>/dev/null || true
rm -rf "$APP_DEST"
cp -R "$src" "/Applications/"

# Not Apple-notarized, so strip the quarantine flag to avoid the Gatekeeper prompt.
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

open "$APP_DEST"
echo "Installed Gyredeck → $APP_DEST"
