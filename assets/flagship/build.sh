#!/usr/bin/env bash
# Composes the flagship layout inside the current terminal and attaches:
#   left        = the real tokenmaxx dashboard (fixture, no daemon)
#   right-top   = a mock Claude Code session
#   right-bottom= a mock Codex session
# All three panes are created before their commands run, so each renders at its
# final size (the tokenmaxx fixture does not repaint on resize).
set -u
theme="${THEME:-dark}"
now="${TOKENMAXX_NOW:-1784133720000}"
dir="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$dir/../.." && pwd)"
bun="$(command -v bun)"
cols=$(tput cols)
rows=$(tput lines)
[ "$theme" = "light" ] && border="fg=#c7cedb" || border="fg=#2a3038"

tmux kill-session -t fs 2>/dev/null || true
tmux new-session -d -s fs -x "$cols" -y "$rows"
tmux set -t fs status off \; set -t fs pane-border-style "$border" \; \
  set -t fs pane-active-border-style "$border"

# Right column at 46% (tokenmaxx keeps the wider left), then split it in half.
tmux split-window -h -t fs:0.0 -l 46%
tmux split-window -v -t fs:0.1 -l 52%

tmux send-keys -t fs:0.0 \
  "clear; TOKENMAXX_FIXTURE=oneHot TOKENMAXX_THEME=$theme TOKENMAXX_NOW=$now TZ=America/Los_Angeles $bun run $repo/src/index.ts" Enter
tmux send-keys -t fs:0.1 "clear; THEME=$theme bash $dir/mock-claude.sh" Enter
tmux send-keys -t fs:0.2 "clear; THEME=$theme bash $dir/mock-codex.sh" Enter
tmux select-pane -t fs:0.0
sleep 6
tmux attach -t fs
