#!/usr/bin/env bash
# Demo: one full match of Bawt against the live-lobby top-bot clones (LUCENT, Bron, maverick)
# on the OFFICIAL ScrabbleBot module running on a local SpacetimeDB server (loopback only).
# Two sim seats are padded in by the module's lobby timer (about 90 s), then 68 one-second auctions.
#
#   bash scripts/demo-local.sh [policies]     default: bawt,clone:lucent,clone:bron,clone:maverick
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
POLICIES="${1:-bawt,clone:lucent,clone:bron,clone:maverick}"
N=$(echo "$POLICIES" | tr ',' '\n' | wc -l | tr -d ' ')
bash e2e/setup-local.sh
npx tsx e2e/provision.ts --bots "$N"
npx tsx e2e/run-local.ts --matches 1 --policies "$POLICIES" --timeout-min 8
