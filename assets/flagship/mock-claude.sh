#!/usr/bin/env bash
# A believable, static Claude Code session for the flagship composite — modelled
# on the real v2.1.210 TUI (rounded header, ❯ prompt, ● assistant marker, diff
# summary, status line). Synthetic content; no real session. THEME=dark|light.
set -u
theme="${THEME:-dark}"
if [ "$theme" = "light" ]; then
  fg=$'\e[38;2;28;36;48m'; dim=$'\e[38;2;90;100;114m'; faint=$'\e[38;2;170;178;189m'
else
  fg=$'\e[38;2;230;230;230m'; dim=$'\e[38;2;139;147;161m'; faint=$'\e[38;2;75;81;92m'
fi
clay=$'\e[38;2;209;119;87m'; grn=$'\e[38;2;58;208;122m'; red=$'\e[38;2;235;90;104m'
b=$'\e[1m'; r=$'\e[0m'
printf '\e[2J\e[H'
printf '\n'
printf ' %s%sClaude Code%s  %s~/code/rubrot · Opus 4.8 · Max 20×%s\n' "$b" "$clay" "$r" "$dim" "$r"
printf '\n'
printf ' %s❯%s %swire the inbox webhook to the bot runner%s\n' "$clay" "$r" "$fg" "$r"
printf '\n'
printf ' %s●%s %sAdded the webhook route and a replay guard.%s\n' "$clay" "$r" "$fg" "$r"
printf '   %s⎿%s  %ssrc/inbox/webhook.ts%s        %s+34%s %s-2%s\n' "$faint" "$r" "$dim" "$r" "$grn" "$r" "$red" "$r"
printf '      %ssrc/inbox/webhook.test.ts%s   %s+51%s\n' "$dim" "$r" "$grn" "$r"
printf '\n'
printf ' %s●%s %sAll 128 tests pass. Deploy to metal?%s\n' "$clay" "$r" "$fg" "$r"
printf '\n'
printf ' %s──────────────────────────────────────────────%s\n' "$faint" "$r"
printf ' %s❯%s %sdo it%s%s▏%s\n' "$clay" "$r" "$fg" "$r" "$dim" "$r"
printf ' %s──────────────────────────────────────────────%s\n' "$faint" "$r"
printf '   %s⏵⏵ accept edits · 2 files · esc to interrupt%s\n' "$dim" "$r"
tput civis 2>/dev/null || true
sleep 3600
