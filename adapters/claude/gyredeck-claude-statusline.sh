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
# followed. Each payload is kept as its own record beside it, never replaced, named by when it
# arrived (nanoseconds where `date` gives them) and this process: the app reads the latest
# arrival, whatever order the writers finish in (#398 audit). The record is written before
# their command runs. After, only this script's own records that arrived earlier are removed,
# by name, in this folder: never the latest, never anything through a link. The record is
# placed with a hard link, which never replaces and never follows what is at its name.
if tmp=$(mktemp "$dir/.claude-statusline-in.XXXXXX" 2>/dev/null) && cat > "$tmp"; then
  ns=$(date +%s%N 2>/dev/null)
  case $ns in ''|*[!0-9]*) ns="$(date +%s)000000000" ;; esac
  at=${ns%?????????}
  name="$dir/claude-statusline.$ns.$$.json"
  if out=$(mktemp "$dir/.claude-statusline.XXXXXX" 2>/dev/null); then
    if { printf '{"at":%s,"configDir":"%s","payload":' "$at" "$cfg"; cat "$tmp"; printf '}\n'; } > "$out" \
      && ln -n "$out" "$name" 2>/dev/null; then
      rm -f "$out"
      for old in "$dir"/claude-statusline.*.*.json; do
        stamp=${old#"$dir"/claude-statusline.}
        stamp=${stamp%%.*}
        case $stamp in ''|*[!0-9]*) continue ;; esac
        pid=${old#"$dir"/claude-statusline.$stamp.}
        case ${pid%.json} in ''|*[!0-9]*) continue ;; esac
        [ "$stamp" -lt "$ns" ] 2>/dev/null && rm -f "$old"
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
