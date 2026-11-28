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
rec="$dir/claude-statusline.d"
# mktemp creates each file itself, exclusively, so nothing planted at a guessable name is
# followed. Each payload is kept as its own record, named by the second it arrived and this
# process, and no record is ever replaced: the app reads the latest. Two sessions updating at
# once, or a slow command of theirs, then cannot put an older payload over a newer one
# (#398 audit). The record is written before their command runs; records that arrived before
# this one are removed after, which never removes the latest.
if tmp=$(mktemp "$dir/.claude-statusline-in.XXXXXX" 2>/dev/null) && cat > "$tmp"; then
  at=$(date +%s)
  if mkdir -p "$rec" 2>/dev/null && out=$(mktemp "$rec/.w.XXXXXX" 2>/dev/null); then
    if { printf '{"at":%s,"configDir":"%s","payload":' "$at" "$cfg"; cat "$tmp"; printf '}\n'; } > "$out" \
      && mv -f "$out" "$rec/$at.$$.json" 2>/dev/null; then
      for old in "$rec"/*.json; do
        name=${old##*/}
        case ${name%%.*} in ''|*[!0-9]*) continue ;; esac
        [ "${name%%.*}" -lt "$at" ] && rm -f "$old"
      done
    else
      rm -f "$out"
    fi
  fi
  if [ -s "$chain" ]; then
    sh -c "$(cat "$chain")" < "$tmp"
  fi
  rm -f "$tmp"
else
  [ -n "$tmp" ] && rm -f "$tmp"
  if [ -s "$chain" ]; then
    sh -c "$(cat "$chain")"
  fi
fi
exit 0
