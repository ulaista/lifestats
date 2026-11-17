#!/bin/zsh
# lifestats autostart: opened in Terminal at login (Terminal has the disk access the iCloud folder needs).
# Keeps the Mac awake while running and restarts the bot if it ever exits.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
while true; do
  caffeinate -is npm run dev
  echo "[lifestats] бот остановился, перезапуск через 10 с…"
  sleep 10
done
