#!/usr/bin/env bash
# Live supervisor: runs the live client (npm start) and restarts it when it exits or stalls.
# Stall = no write to any file in runs/live for STALL_S seconds (default 300; a lobby wait plus a
# full match is < 4 min). Logs go to runs/live/supervisor.log. Needs ALLOW_MAINCLOUD_PLAY=1 set.
#   ALLOW_MAINCLOUD_PLAY=1 BOT_POLICY=bawt bash scripts/live-supervisor.sh
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
STALL_S="${STALL_S:-300}"
LOG=runs/live/supervisor.log
mkdir -p runs/live
child=""
stop() { [ -n "$child" ] && kill -INT "$child" 2>/dev/null; sleep 2; [ -n "$child" ] && kill -9 "$child" 2>/dev/null; pkill -9 -f "src/client/main.ts" 2>/dev/null; }
trap 'stop; exit 0' INT TERM
while true; do
  echo "[$(date '+%F %T')] start client" >> "$LOG"
  npx tsx src/client/main.ts >> runs/live/client-stdout.log 2>&1 &
  child=$!
  while kill -0 "$child" 2>/dev/null; do
    sleep 15
    newest=$(ls -t runs/live 2>/dev/null | grep -v -e supervisor.log -e client-stdout.log | head -1)
    [ -z "$newest" ] && continue
    age=$(( $(date +%s) - $(stat -f %m "runs/live/$newest") ))
    if [ "$age" -gt "$STALL_S" ]; then
      echo "[$(date '+%F %T')] stall: no log write for ${age}s (newest $newest) -> restart" >> "$LOG"
      stop
      break
    fi
  done
  echo "[$(date '+%F %T')] client exited/restarting" >> "$LOG"
  sleep 3
done
