#!/usr/bin/env bash
# A believable, static Codex session for the flagship composite — modelled on the
# real v0.144.1 TUI (>_ OpenAI Codex banner with model/directory/permissions, •
# notices, › prompt, status line). Synthetic content. THEME=dark|light.
set -u
theme="${THEME:-dark}"
if [ "$theme" = "light" ]; then
  fg=$'\e[38;2;28;36;48m'; dim=$'\e[38;2;90;100;114m'; faint=$'\e[38;2;170;178;189m'
else
  fg=$'\e[38;2;230;230;230m'; dim=$'\e[38;2;139;147;161m'; faint=$'\e[38;2;75;81;92m'
fi
cyan=$'\e[38;2;120;196;196m'; grn=$'\e[38;2;58;208;122m'
b=$'\e[1m'; r=$'\e[0m'
printf '\e[2J\e[H'
printf '\n'
printf ' %s╭────────────────────────────────────────────╮%s\n' "$faint" "$r"
printf ' %s│%s %s%s>_ OpenAI Codex%s %s(v0.144.1)%s                 %s│%s\n' "$faint" "$r" "$b" "$cyan" "$r" "$dim" "$r" "$faint" "$r"
printf ' %s│%s %smodel:%s       gpt-5.6-sol   %s/model%s          %s│%s\n' "$faint" "$r" "$dim" "$r" "$dim" "$r" "$faint" "$r"
printf ' %s│%s %sdirectory:%s   ~/code/rubrot                 %s│%s\n' "$faint" "$r" "$dim" "$r" "$faint" "$r"
printf ' %s╰────────────────────────────────────────────╯%s\n' "$faint" "$r"
printf '\n'
printf ' %s› %sextract the selector into a pure function%s\n' "$cyan" "$fg" "$r"
printf '\n'
printf ' %s•%s %sExtracted selectRotation; added 7 cases.%s\n' "$cyan" "$r" "$fg" "$r"
printf '   %s└%s %ssrc/selection.ts%s   %s· 74 passing%s\n' "$faint" "$r" "$dim" "$r" "$grn" "$r"
printf '\n'
printf ' %s•%s %sThreshold check is now side-effect free.%s\n' "$cyan" "$r" "$fg" "$r"
printf '\n'
printf ' %s› %s%srun /review on my changes%s\n' "$cyan" "$r" "$dim" "$r"
printf '\n'
printf ' %sgpt-5.6-sol default · ~/code/rubrot%s\n' "$faint" "$r"
tput civis 2>/dev/null || true
sleep 3600
