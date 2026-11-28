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
# followed. Each payload is kept as its own record beside it, never replaced, numbered in the
# order the payloads arrived: the number is reserved the moment one arrives, one past the
# highest already there, by a hard link to an empty file of ours (`ln -n` neither replaces
# nor follows what is at a name, so a taken number moves on to the next). The clock plays no
# part in the order, so no clock resolution or process id can put an older payload first
# (#398 audit). Its time is taken then too, so input that is slow to come never makes an
# old payload look new. The record is filled in place before their command runs; the app reads the
# highest number and treats one not yet complete as no reading. After, only this script's
# own records numbered below it are removed, by name, with `rm -f`: a link goes, never what
# it points at.
if tmp=$(mktemp "$dir/.claude-statusline-in.XXXXXX" 2>/dev/null) && out=$(mktemp "$dir/.claude-statusline.XXXXXX" 2>/dev/null); then
  at=$(date +%s)
  seq=0
  for old in "$dir"/claude-statusline.*.json; do
    n=${old#"$dir"/claude-statusline.}
    n=${n%.json}
    case $n in ''|*[!0-9]*) continue ;; esac
    [ "$n" -ge "$seq" ] 2>/dev/null && seq=$((n + 1))
  done
  tries=0
  until ln -n "$out" "$dir/claude-statusline.$seq.json" 2>/dev/null; do
    seq=$((seq + 1))
    tries=$((tries + 1))
    [ "$tries" -ge 64 ] && { seq=; break; }
  done
  if cat > "$tmp"; then
    if [ -n "$seq" ] \
      && { printf '{"at":%s,"configDir":"%s","payload":' "$at" "$cfg"; cat "$tmp"; printf '}\n'; } > "$out"; then
      for old in "$dir"/claude-statusline.*.json; do
        n=${old#"$dir"/claude-statusline.}
        n=${n%.json}
        case $n in ''|*[!0-9]*) continue ;; esac
        [ "$n" -lt "$seq" ] 2>/dev/null && rm -f "$old"
      done
    elif [ -n "$seq" ]; then
      rm -f "$dir/claude-statusline.$seq.json"
    fi
    rm -f "$out"
    if [ -s "$chain" ]; then
      sh -c "$(cat "$chain")" < "$tmp"
    fi
    rm -f "$tmp"
  else
    [ -n "$seq" ] && rm -f "$dir/claude-statusline.$seq.json"
    rm -f "$out" "$tmp"
    if [ -s "$chain" ]; then
      sh -c "$(cat "$chain")"
    fi
  fi
else
  [ -n "$tmp" ] && rm -f "$tmp"
  if [ -s "$chain" ]; then
    sh -c "$(cat "$chain")"
  fi
fi
exit 0
