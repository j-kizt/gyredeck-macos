#!/bin/sh
# Antigravity's status-line command (#230). agy hands it a JSON payload on stdin on every
# TUI update; the payload is kept, whole and private, where the app reads its quota, then
# handed to the person's own status line if they had one, whose output is what agy draws.
# Every exit is 0: agy turns a status line off after repeated failures, and that would take
# the usage tab with it.
umask 077
dir="$HOME/.config/gyredeck"
tmp="$dir/.agy-statusline.$$"
chain="$dir/agy-statusline.chain"
if cat > "$tmp" 2>/dev/null; then
  if [ -s "$chain" ]; then
    sh -c "$(cat "$chain")" < "$tmp"
  fi
  mv -f "$tmp" "$dir/agy-statusline.json" 2>/dev/null || rm -f "$tmp"
else
  rm -f "$tmp"
  if [ -s "$chain" ]; then
    sh -c "$(cat "$chain")"
  fi
fi
exit 0
