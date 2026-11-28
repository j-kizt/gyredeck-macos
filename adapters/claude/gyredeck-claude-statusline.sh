#!/bin/sh
# Claude Code's status-line command (#398). Claude Code hands it a JSON payload on stdin on
# every update; its rate_limits are kept, private, where the app reads usage before asking
# the API, with the config dir it ran under and the time it was written, so the app can
# tell whose they are and how old. The payload then goes to the person's own status line if
# they had one, whose output is what Claude Code draws. Every exit is 0, so a failure here
# never blanks their line.
umask 077
dir="$HOME/.config/gyredeck"
chain="$dir/claude-statusline.chain"
cfg=$(printf '%s' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" | sed 's/\\/\\\\/g; s/"/\\"/g')
# mktemp creates each file itself, exclusively, so nothing planted at a guessable name is
# followed.
if tmp=$(mktemp "$dir/.claude-statusline-in.XXXXXX" 2>/dev/null) && cat > "$tmp"; then
  if [ -s "$chain" ]; then
    sh -c "$(cat "$chain")" < "$tmp"
  fi
  if out=$(mktemp "$dir/.claude-statusline.XXXXXX" 2>/dev/null); then
    if { printf '{"at":%s,"configDir":"%s","payload":' "$(date +%s)" "$cfg"; cat "$tmp"; printf '}\n'; } > "$out"; then
      mv -f "$out" "$dir/claude-statusline.json" 2>/dev/null || rm -f "$out"
    else
      rm -f "$out"
    fi
  fi
  rm -f "$tmp"
else
  [ -n "$tmp" ] && rm -f "$tmp"
  if [ -s "$chain" ]; then
    sh -c "$(cat "$chain")"
  fi
fi
exit 0
