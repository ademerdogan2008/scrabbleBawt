# Local end-to-end harness (plan 02-04)

Runs OUR live client (`npm start`, the real session code from `src/client`) against the **official
ScrabbleBot module** (clockworklabs/scrabblebot `b5ccb36`) on a **local** SpacetimeDB 2.12.0
standalone server. Everything is loopback-only; nothing here ever talks to maincloud.

## Commands

```bash
# 1. Server + module (idempotent; republishes with fresh data every run)
bash e2e/setup-local.sh                 # E2E_PORT=3100 (default), E2E_DB=scrabblebot-local

# 2. Bots through the real team/credential flow (tokens -> .cache/e2e/tokens/<bot>.token, mode 600)
npx tsx e2e/provision.ts --bots 6

# 3. Matches: 6 clients with registry policies starter, greedy, hoarder, random, starter, greedy
npx tsx e2e/run-local.ts --matches 3
npx tsx e2e/run-local.ts --matches 1 --kill-one      # SIGKILL one client mid-match, restart, resume

# Optional match config (admin set_matchmaker_config; applies to matches started afterwards)
npx tsx e2e/run-local.ts --matches 1 --auction-ms 250 --rack 7
npx tsx e2e/run-local.ts --matches 1 --policies greedy,greedy,starter,starter,hoarder,random

# 4. Stop the background server
bash e2e/setup-local.sh --stop
```

`run-local.ts` writes every client's logs to `runs/e2e/<stamp>/<bot>/` (`client.jsonl`,
`match-<id>.jsonl`, `stdout.log`; the restarted client of `--kill-one` uses `<bot>-resume/`) and a
`summary.json`. It exits 1 if any check fails.

## What setup-local.sh does

1. Verifies the pinned CLI `$HOME/.local/share/spacetime/bin/2.12.0/spacetimedb-cli` reports 2.12.0
   and calls that binary directly (the global `spacetime version` default is not touched).
2. Creates an isolated CLI config `.cache/stdb/cli.toml` (passed with `--config-path`) whose only
   server is `e2e = 127.0.0.1:$E2E_PORT`. The user's `~/.config/spacetime` login is never read or changed.
3. Starts `spacetime start --listen-addr 127.0.0.1:$E2E_PORT` in the background, data and JWT keys
   under `.cache/stdb/` (git-ignored); pid in `.cache/stdb/server.pid`, log in `.cache/stdb/server.log`.
4. Non-interactive local login: `POST /v1/identity` on the local server mints a server-issued
   identity; its token goes into the isolated cli.toml and `.cache/stdb/admin.json` (mode 600).
   No browser `spacetime login` is ever triggered.
5. Exports the official module at `b5ccb36` (`git archive` from the research clone, or a fresh
   clone) into `.cache/official/`, runs `npm ci` in `.cache/official/spacetimedb` (pinned lockfile;
   user-approved 2026-11-07 for local E2E only, see PROJECT.md Key Decisions).
6. Applies `e2e/patches/seed-admin.patch`: adds the local identity to `SEED_ADMIN_HEX`, so `init`
   seeds it as admin (on a fresh DB `bootstrap_admin` fails because the hardcoded admin exists).
   Admin is only used for `set_matchmaker_config` (`--auction-ms`, `--rack`).
7. `spacetime publish --server e2e --no-config --yes --delete-data=always scrabblebot-local`
   (`--no-config` because the module's `spacetime.json` names maincloud), then clears stale tokens.

## Safety rules

- `provision.ts` and `run-local.ts` refuse any non-loopback host (`requireLoopback`), and every
  reducer goes through the 02-03 guard (`src/client/guard.ts`), which also allows loopback only.
- Children get an **explicit** environment: `STDB_HOST=http://127.0.0.1:<port>`,
  `ENV_FILE=.cache/e2e/empty.env` (so a repo `.env` that points at maincloud is never read),
  per-bot `BOT_NAME`/`BOT_TOKEN`/`BOT_POLICY`/`MAX_MATCHES`/`LOG_DIR`; `ALLOW_MAINCLOUD_PLAY` is never set.
- Tokens (`.cache/e2e/tokens`, `.cache/stdb/admin.json`) are git-ignored, mode 600, never printed.

## Checks performed by run-local.ts

- every client exits 0 after its matches; every match is `Ended` on the server (`spacetime sql`)
- 0 `Auction window expired` / `Auction closed` / `Match not running` errors in any client log
- every `match-<id>.jsonl` (including the killed client's partial log) replays through
  `src/state` (`replay(eventsFromLog(...))`) with all diagnostics 0, and each finished log's final
  score equals the server's `match_participant.score`
- anchor latency (transaction received -> anchor `submit_bid` sent, from the driver's per-match
  timing record) p99 <= 30 ms for every client-match
- `--kill-one`: the restarted client logs `resumed from snapshot` and finishes the match

Reported: per-match scores and ranks, auctions per match, per-client bids/words sent, rejections by
outcome, anchor/decide latency, late opens, and the unplayed rack value at `Ended` per policy.

## Notes

- Lobbies hold 6 real bots (`lobby_max_size` default), so 6 clients resolve a lobby instantly with
  no sims. Fewer clients wait for the 90 s lobby timeout and get padded with sims.
- `--first-price` is not supported: lobbies are Vickrey-only in the module; FirstPrice needs a
  tournament (`create_tournament` + registration + `start_tournament`), left for a later phase.
