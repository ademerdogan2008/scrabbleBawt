#!/usr/bin/env bash
# Local E2E server setup (plan 02-04): the OFFICIAL ScrabbleBot module (pinned b5ccb36) on a local
# SpacetimeDB 2.12.0 standalone server bound to 127.0.0.1 only.
#
#   bash e2e/setup-local.sh            start server (if needed) + build + publish scrabblebot-local
#   bash e2e/setup-local.sh --stop     stop the background server started by this script
#
# Isolation / safety:
#   * Uses the pinned 2.12.0 binary directly ($HOME/.local/share/spacetime/bin/2.12.0/spacetimedb-cli);
#     never changes the global `spacetime version` default.
#   * Uses its OWN CLI config (.cache/stdb/cli.toml, --config-path) whose only server is the loopback
#     E2E server; the user's ~/.config/spacetime login (maincloud) is never read or modified.
#   * Non-interactive local login: a server-issued identity from POST /v1/identity on the local
#     server (never a browser `spacetime login`). Its token lives only in .cache/stdb (mode 600).
#   * Every CLI call passes --server e2e and --no-config (the module's spacetime.json says maincloud).
#   * Official module deps: `npm ci` inside .cache/official/spacetimedb only (user-approved
#     2026-11-07, PROJECT.md Key Decisions; local E2E only; never added to our package.json).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${E2E_PORT:-3100}"
DB="${E2E_DB:-scrabblebot-local}"
PIN="b5ccb36"
CACHE="$ROOT/.cache"
STDB="$CACHE/stdb"
CFG="$STDB/cli.toml"
OFFICIAL="$CACHE/official"
OFFICIAL_SRC="${OFFICIAL_SRC:-/private/tmp/claude-501/-Users-adem-Documents-GitHub-scrabbleBawt/f0cb5422-db12-4105-b246-d1edf5490e36/scratchpad/ref/official}"
OFFICIAL_REPO="${OFFICIAL_REPO:-https://github.com/clockworklabs/scrabblebot.git}"
CLI="${SPACETIME_BIN:-$HOME/.local/share/spacetime/bin/2.12.0/spacetimedb-cli}"
BASE="http://127.0.0.1:$PORT"

log() { printf '[setup-local] %s\n' "$*"; }
die() { printf '[setup-local] ERROR: %s\n' "$*" >&2; exit 1; }
stdb() { "$CLI" --config-path "$CFG" "$@"; }

mkdir -p "$STDB"
chmod 700 "$STDB"

if [[ "${1:-}" == "--stop" ]]; then
  if [[ -f "$STDB/server.pid" ]] && kill -0 "$(cat "$STDB/server.pid")" 2>/dev/null; then
    kill "$(cat "$STDB/server.pid")" && log "stopped server pid $(cat "$STDB/server.pid")"
  else
    log "no server running from this script"
  fi
  rm -f "$STDB/server.pid"
  exit 0
fi

# 1. Pinned CLI 2.12.0
[[ -x "$CLI" ]] || die "spacetime CLI 2.12.0 not found at $CLI (spacetime version install 2.12.0)"
"$CLI" --version 2>/dev/null | grep -q 'tool version 2.12.0;' || die "$CLI is not 2.12.0"
log "spacetime CLI 2.12.0: $CLI"

# 2. Isolated CLI config: one loopback server, no tokens from the user's global login.
if [[ ! -f "$CFG" ]]; then
  umask 077
  cat >"$CFG" <<EOF
default_server = "e2e"

[[server_configs]]
nickname = "e2e"
host = "127.0.0.1:$PORT"
protocol = "http"
EOF
fi
chmod 600 "$CFG"

# 3. Local server (background, data under .cache/stdb, loopback only).
if curl -sf -o /dev/null "$BASE/v1/ping"; then
  log "server already up on $BASE"
else
  log "starting local server on 127.0.0.1:$PORT (data: $STDB/data)"
  nohup "$CLI" --config-path "$CFG" start \
    --listen-addr "127.0.0.1:$PORT" \
    --data-dir "$STDB/data" \
    --jwt-pub-key-path "$STDB/id_ecdsa.pub" \
    --jwt-priv-key-path "$STDB/id_ecdsa" \
    --non-interactive >"$STDB/server.log" 2>&1 &
  echo $! >"$STDB/server.pid"
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "$BASE/v1/ping" && break
    sleep 0.5
  done
  curl -sf -o /dev/null "$BASE/v1/ping" || { tail -20 "$STDB/server.log" >&2; die "server did not come up"; }
  log "server up (pid $(cat "$STDB/server.pid"))"
fi

# 4. Non-interactive local login: server-issued identity, token kept in .cache/stdb (mode 600).
if [[ ! -s "$STDB/admin.json" ]] || ! grep -q '"token"' "$STDB/admin.json"; then
  umask 077
  curl -sf -X POST "$BASE/v1/identity" >"$STDB/admin.json" || die "identity mint failed"
  chmod 600 "$STDB/admin.json"
fi
ADMIN_HEX="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(j.identity).replace(/^0x/,"").toLowerCase())' "$STDB/admin.json")"
[[ "$ADMIN_HEX" =~ ^[0-9a-f]{64}$ ]] || die "bad admin identity"
node -e '
  const fs=require("fs"); const [cfg, adm]=process.argv.slice(1);
  const tok=JSON.parse(fs.readFileSync(adm,"utf8")).token;
  let t=fs.readFileSync(cfg,"utf8").replace(/^spacetimedb_token = .*\n/m,"");
  t=`spacetimedb_token = "${tok}"\n`+t;
  fs.writeFileSync(cfg,t,{mode:0o600});
' "$CFG" "$STDB/admin.json"
log "local CLI identity (admin): $ADMIN_HEX"

# 5. Official module at the pinned commit.
if [[ ! -f "$OFFICIAL/.pinned-$PIN" ]]; then
  rm -rf "$OFFICIAL"
  mkdir -p "$OFFICIAL"
  if [[ -d "$OFFICIAL_SRC/.git" ]] && [[ "$(git -C "$OFFICIAL_SRC" rev-parse --short=7 "$PIN^{commit}" 2>/dev/null)" == "$PIN" ]]; then
    log "exporting official module $PIN from $OFFICIAL_SRC"
    git -C "$OFFICIAL_SRC" archive "$PIN" spacetimedb | tar -x -C "$OFFICIAL"
  else
    log "cloning $OFFICIAL_REPO at $PIN"
    git clone --quiet "$OFFICIAL_REPO" "$OFFICIAL/.src"
    git -C "$OFFICIAL/.src" archive "$PIN" spacetimedb | tar -x -C "$OFFICIAL"
    rm -rf "$OFFICIAL/.src"
  fi
  touch "$OFFICIAL/.pinned-$PIN"
fi
MOD="$OFFICIAL/spacetimedb"
[[ -f "$MOD/package-lock.json" ]] || die "official module missing at $MOD"

# 6. Official module deps (pinned lockfile; local E2E only).
if [[ ! -d "$MOD/node_modules/spacetimedb" ]]; then
  log "npm ci in $MOD (official module deps, pinned lockfile)"
  (cd "$MOD" && npm ci --no-audit --no-fund --loglevel=error)
fi

# 7. Seed-admin patch (re-applied from pristine game.ts every run).
if [[ ! -f "$MOD/src/game.ts.orig-$PIN" ]]; then cp "$MOD/src/game.ts" "$MOD/src/game.ts.orig-$PIN"; fi
cp "$MOD/src/game.ts.orig-$PIN" "$MOD/src/game.ts"
patch --silent -p1 -d "$OFFICIAL" <"$ROOT/e2e/patches/seed-admin.patch" || die "seed-admin.patch failed"
sed -i.bak "s/__LOCAL_ADMIN_HEX__/$ADMIN_HEX/" "$MOD/src/game.ts" && rm -f "$MOD/src/game.ts.bak"
grep -q "$ADMIN_HEX" "$MOD/src/game.ts" || die "admin hex not in game.ts"
log "seed-admin patch applied"

# 8. Publish to the LOCAL server only (fresh data every run).
log "publishing $DB to $BASE (delete data)"
stdb publish --server e2e --no-config --yes --delete-data=always -p "$MOD" "$DB" >"$STDB/publish.log" 2>&1 || {
  tail -30 "$STDB/publish.log" >&2
  die "publish failed"
}
tail -3 "$STDB/publish.log"
# Fresh data => previously provisioned bot tokens are no longer credentials.
rm -rf "$CACHE/e2e/tokens"

# 9. Sanity: sims seeded by init, our admin row present, one open lobby.
stdb sql --server e2e --no-config "$DB" "SELECT id, name FROM bot" | tail -n +1 | head -12
stdb sql --server e2e --no-config "$DB" "SELECT * FROM admin" >/dev/null 2>&1 || true
log "ready: STDB_HOST=$BASE STDB_DB=$DB"
