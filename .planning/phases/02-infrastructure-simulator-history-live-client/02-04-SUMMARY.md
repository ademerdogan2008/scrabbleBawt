---
phase: 02-infrastructure-simulator-history-live-client
plan: 04
subsystem: client
tags: [spacetimedb, live-client, entrypoint, whoami, shadow, ghost-observer, e2e, official-module, kill-and-resume]
requires:
  - 02-01 src/bots/registry (createPolicy, listPolicies)
  - 02-03 src/client core (loadConfig, guard, ConnectionSupervisor, runSession, bindConnection, perMatchQueries, rebuildFromSnapshot, MatchLog/eventsFromLog)
  - 01-03 src/state (MatchRecorder, replay, diagnostics)
provides:
  - src/client/main.ts (npm start live entrypoint, SHADOW=1, ENV_FILE, latency dump)
  - src/client/shadow.ts (GhostObserver, ghostMatchConfig, shadowQueries, AnonSql, findRunningMatches, runShadow)
  - scripts/client-whoami.ts, scripts/client-shadow.ts
  - e2e/{setup-local.sh, provision.ts, run-local.ts, lib.ts, README.md}, e2e/patches/seed-admin.patch
affects: [03 strategy tuning (live shadow logs), 05 live play (entrypoint, E2E gate)]
tech-stack:
  added: []
  patterns:
    - ghost seat (id -1) appended to the real roster; totalAuctions from the real player count
    - observer with no reducer host at all (structurally cannot call a reducer)
    - isolated spacetime CLI config (--config-path) so the user's maincloud login is never touched
    - explicit child environment for E2E clients (ENV_FILE=<empty>, loopback host, no ALLOW_MAINCLOUD_PLAY)
    - raw per-auction latency dump per match, pooled across clients for the p99 gate
key-files:
  created:
    - src/client/main.ts
    - src/client/shadow.ts
    - scripts/client-whoami.ts
    - scripts/client-shadow.ts
    - test/client/shadow.test.ts
    - e2e/setup-local.sh
    - e2e/provision.ts
    - e2e/run-local.ts
    - e2e/lib.ts
    - e2e/README.md
    - e2e/patches/seed-admin.patch
  modified: []
key-decisions:
  - "The ghost observer is its own small class in shadow.ts. It reuses the adapter's builders (buildMatchConfig, rebuildFromSnapshot, auctionInfo, outcomeOf) and the same per-transaction order. MatchDriver was not reused because it requires our participant row and derives totalAuctions from all players, and adapter.ts is outside this plan's files."
  - "Running-match discovery uses anonymous HTTP SQL: open_lobbies -> lobby.resolved_match_id (id >= L-8) -> match_state (id >= newest-16). match_state.status cannot be filtered in SQL: a literal is not parsed as the enum type."
  - "Entrypoints accept ENV_FILE=<path> to override the repo-root .env. E2E children get ENV_FILE=<empty file>, so a maincloud .env is never read."
  - "The anchor-latency gate is the pooled p99 over every anchor of every client-match, from raw samples dumped by main.ts. The per-client-match p99 (n = 68, so it equals the max) is also reported. That max is driven by the hoarder baseline overrunning its own 15 ms decide budget."
  - "E2E uses an isolated CLI config (.cache/stdb/cli.toml) and a server-issued local identity. The user's ~/.config/spacetime (maincloud login) is never read or modified."
requirements-completed: [CLI-06, CLI-07, CLI-01, CLI-05]
duration: ~40min
completed: 2026-11-07
---

# Phase 2 Plan 04: Live entrypoints, ghost-observer shadow mode and official-module local E2E Summary

**`npm start` refuses maincloud before connecting. whoami resolved our live bot (id 168, "Malicious") without calling a reducer. An anonymous ghost observer followed 4 live maincloud matches (3 of them full) and replayed them with 0 diagnostics. On the official b5ccb36 module, 6 of our clients played 3 full matches, and a SIGKILLed client restarted on the same token resumed the match. Both runs had 0 timing errors, 0 rejected calls and all diagnostics at 0. Pooled anchor-bid p99 was 2.3 ms.**

## Accomplishments

### Task 1: Entrypoints and shadow mode
- **`npm start` (src/client/main.ts)**
  - Loads `loadConfig({envPath: ENV_FILE ?? <repo>/.env})`.
  - `BOT_POLICY` (plus `BOT_PARAMS` as inline JSON) resolves through `createPolicy` from the registry. The spec is validated once, so an unknown policy fails fast.
  - Runs `runSession`. `SIGINT`/`SIGTERM` stop it cleanly.
  - Exit codes: 0 = done/stopped, 1 = error, 3 = refused.
  - Against maincloud it prints `read-only: refusing to play` and exits 3. It never connects.
  - `SHADOW=1` runs shadow mode instead, with `MAX_MATCHES` matches, `SHADOW_TIMEOUT_MIN` and `SHADOW_SEAT`.
  - After every match it played, it writes `LOG_DIR/latency-<match>.json` with the raw anchorMs, decideMs and loopLagMs.
- **whoami (scripts/client-whoami.ts)**
  - Subscribes to `bot_credential WHERE identity = me`, then `bot WHERE id = B` and `bot_credential WHERE bot_id = B`.
  - Prints the bot id, name, credential count and how many credentials are connected, then disconnects.
  - It never imports the reducer path.
- **Shadow mode (src/client/shadow.ts, scripts/client-shadow.ts)**
  - **Identity:** an anonymous supervisor connection. The token is server-minted and never persisted. HTTP SQL uses a separate in-memory anonymous identity.
  - **Queries:** `shadowQueries(M)` = `perMatchQueries(M)` + `SELECT * FROM "bot"`, passed through `assertQueriesAllowed`.
  - **GhostObserver:**
    - Rebuilds a mid-match join with `rebuildFromSnapshot`, using an empty rack.
    - Applies each live transaction in the same order as MatchDriver: results, then words (deduped, same attribution), then balances, then the new open, then the end.
    - Per auction it runs an anchor `decide` (15 ms budget) plus one refine pass, and logs would-be bids and words.
    - Optional `SHADOW_SEAT` adds the seat's real balance and score to every decision, plus `seat won` records with the price paid.
    - Logs receive latency (localRecv − opens_at), late flags, decide ms and anchor ms.
  - **Discovery and runner:**
    - `findRunningMatches` uses read-only anonymous SQL. `AnonSql` refuses non-SELECT statements and the FORBIDDEN tables.
    - `runShadow` prefers matches at round ≤ 3. Without `--full-only` it falls back to the newest match after 30 s.
    - After each match it replays the JSONL log and compares scores and balances with the live tracker.
    - It exits 2 with `no running match found` when the timeout passes.
  - The range-predicate probe runs once per run.
- **Tests (test/client/shadow.test.ts, 10 tests):**
  - Ghost config: ghost seat last, `myId = -1`, totalAuctions 78 for 4 real players at rack 5 and 56 for 6 players at rack 7.
  - Full fake match observed from the start (4 seats, 2 sims, 78 auctions):
    - 0 reducer calls and 0 diagnostics; the unseen invariant holds after every transaction.
    - The server's scores and balances equal the tracker's.
    - The replay deep-equals the live tracker.
    - 78 anchor decisions, each with a seat label.
  - Mid-match joins after 17, 40 and 77 closes from shuffled snapshots: same results.
  - A throwing policy is survived.
  - The query list never contains the leak view.
  - Discovery runs against a fake SQL API.
  - Plus tests for `httpBase`, policySpec/registryFactory, ENV_FILE and `dumpLatency`.

### Task 2: Local-server E2E harness
- **setup-local.sh**
  - Uses the pinned binary `$HOME/.local/share/spacetime/bin/2.12.0/spacetimedb-cli`, checked to report 2.12.0. The global default is untouched.
  - Uses an isolated `--config-path .cache/stdb/cli.toml` whose only server is `e2e = 127.0.0.1:3100`.
  - Starts a background `start --listen-addr 127.0.0.1:3100`; data and JWT keys live under `.cache/stdb`.
  - Mints the local identity with `POST /v1/identity`, so there is no browser login.
  - Exports the official module with `git archive b5ccb36 spacetimedb` into `.cache/official` and runs `npm ci` there (64 packages).
  - Applies `seed-admin.patch` from pristine `game.ts` every run, substituting the local identity hex.
  - Publishes with `publish --server e2e --no-config --yes --delete-data=always scrabblebot-local`, then clears stale tokens.
  - `--stop` stops the server.
- **provision.ts**
  - Per bot: a fresh human identity, then `create_team`, then `mint_credential_nonce`, then `my_nonces`.
  - A fresh bot identity then calls `claim_credential` and is verified through `bot_credential`.
  - The token is written to `.cache/e2e/tokens/e2eN.token` with mode 600.
  - All calls go through the 02-03 guard. Non-loopback hosts are refused.
- **run-local.ts**
  - Refuses non-loopback hosts.
  - Sets `set_matchmaker_config` as admin, which covers `--rack` and `--auction-ms`.
  - Spawns 6 `npm start` clients in their own process groups. Each gets an explicit environment: STDB_HOST loopback, `ENV_FILE=.cache/e2e/empty.env`, token, policy, MAX_MATCHES and LOG_DIR. ALLOW_MAINCLOUD_PLAY is asserted absent.
  - `--kill-one` sends SIGKILL to client e2e1's process group after 20 opens, then restarts it with the same token and a `-resume` log dir.
  - Collects server truth through `spacetime sql`: status, auctions, scores and ranks.
  - Replays every client match log. Logs from the boot resume-check of an already-Ended match are replayed but not counted.
  - Gates on:
    - timing-error strings in any log
    - diagnostics
    - each client's final score matching the server
    - client exit codes
    - pooled anchor p99 ≤ 30 ms
    - for `--kill-one`, a resumed and finished match
  - Prints tables and writes `summary.json`.

## Measured results

### whoami (maincloud, read-only)
`whoami: bot id=168 name=Malicious credentials=1 connected=1`. No reducers were called. The connect flips `bot_credential.connected` through the module's own lifecycle hook.

### npm start on maincloud
With no `ALLOW_MAINCLOUD_PLAY` set, it printed `[error] read-only: refusing to play {"host":"wss://maincloud.spacetimedb.com"}` and then `read-only: refusing to play`, and exited 3. It made no connection.

### Range-predicate probe (RULES §16)
**Accepted.** `SELECT * FROM "auction" WHERE "auction"."match_id" > X` was applied over the WS subscription:
- run 1: X = 42731, 40 rows, applied in 131 ms
- run 2: X = 42734, 2 rows, 134 ms

HTTP SQL also accepts `id >= N` ranges.

### Shadow on maincloud
Four live matches, all with 6 real bots and 68 auctions. Each was observed anonymously as a ghost (policy `starter`) with no reducer calls.

| match | joined at round | events (open/result/word/balance) | live opens / late | recv lag p50 / p90 / p99 ms | decide p50 / p99 ms | anchor p50 / p99 ms | replay diag (bal/rack/hid/unseen) | replay == live |
|---|---|---|---|---|---|---|---|---|
| 42732 | 41 (mid-match) | 199 (68/68/18/44) | 27 / 1 | −85.7 / −7.6 / 28.8 | 0.01 / 0.23 | 0.37 / 2.87 | 0/0/0/0 | yes |
| 42733 | 1 | 242 (68/68/16/89) | 67 / 1 | −74.9 / −36.8 / 17.7 | 0.01 / 0.07 | 0.45 / 1.67 | 0/0/0/0 | yes |
| 42735 | 2 | 245 (68/68/18/90) | 66 / 1 | −97.0 / −53.7 / 2.6 | 0.01 / 0.28 | 0.68 / 4.00 | 0/0/0/0 | yes |
| 42736 (seat label: Bron 114) | 1 | 240 (68/68/15/88) | 67 / 1 | −87.0 / −48.3 / −8.6 | 0.01 / 0.75 | 0.57 / 4.32 | 0/0/0/0 | yes |

- **Late opens:** the single late open in each match is the snapshot delivery of the auction that was open at join time.
- **Receive lag is negative:** offsetEst is −98.3 ms (run 1) and −101.9 ms (run 2). Under the clock model (lag = skew + downlink), this machine's clock runs about 100 ms behind maincloud's row timestamps. It is not a measurement of absolute latency. The relevant number is the spread: p99 − p50 is about 70–115 ms.
- **Deadlines:** 0 anchor decisions were past the deadline, and the event-loop lag p99 stayed at or below 1.7 ms.
- **SHADOW_SEAT:** in match 42736 all 135 decisions carry the Bron seat label, and 15 `seat won` records were logged.

### Local E2E on the official module (b5ccb36, CLI 2.12.0, 127.0.0.1:3100)
Final verification chain, run from scratch on the committed code: `bash e2e/setup-local.sh && npx tsx e2e/provision.ts --bots 6 && npx tsx e2e/run-local.ts --matches 3 && npx tsx e2e/run-local.ts --matches 1 --kill-one`, then an extra run with `--matches 1 --auction-ms 250 --rack 7`. Every run printed **E2E OK** and the chain exited 0.

Lineup: starter, greedy, hoarder, random, starter, greedy. Six real bots, no sims, Vickrey.

| run | matches (auctions) | client-match logs (finished / partial) | timing errors | rejected calls | diagnostics | anchor pooled p50 / p90 / p99 / max ms | >30 ms | late opens | wall |
|---|---|---|---|---|---|---|---|---|---|
| `--matches 3` | 1, 2, 3 (68 each, all Ended) | 18 / 0 | **0** | 0 | all 0 | 0.43 / 0.88 / **2.28** / 33.43 | 1 of 1224 | 18 (1 per client-match: the first auction) | 206.1 s |
| `--matches 1 --kill-one` | 4 (68, Ended) | 6 / 1 (killed) | **0** | 0 | all 0 (partial log too) | 0.58 / 1.36 / **4.53** / 14.44 | 0 of 388 | 6 | 69.8 s |
| `--auction-ms 250 --rack 7` | 5 (56, Ended) | 6 / 0 | **0** | 0 | all 0 | 0.42 / 0.73 / 2.91 / 55.48 | 1 of 330 | 6 | 15.7 s |

**Final scores (server truth, `spacetime sql`):**
- Match 1: hoarder 156, random 57, greedy 25, greedy 25, starter 6, starter 0
- Match 2: hoarder 145, random 45, greedy 29, greedy 25, starter 18, starter 7
- Match 3: hoarder 102, random 62, greedy 29, greedy 20, starter 12, starter 6

Every client's tracked final score equals its `match_participant.score`.

**Kill-and-resume (match 4):**
- e2e1 was SIGKILLed after 20 opens, during auction 19, after its auction-19 bid had already been sent.
- It was restarted with the same token; the old process group exited 28 ms after the signal.
- The new process connected in under 1 s, found the newest seat via the boot resume-check and logged `resumed from snapshot` (history 48 events, 20 results, 7 words).
- It resubmitted its bid into auction 20, which was still open (opened 33 ms before the resume; 966 ms before it closed). It played the remaining 48 auctions and finished with score 7, equal to the server.
- 0 auctions were missed, 0 timing errors and 0 rejections.
- The killed process's partial log (81 events) also replays with 0 diagnostics.

**Anchor latency** (transaction received → anchor `submit_bid` sent):
- Pooled p99 is 2.3–4.5 ms across the runs.
- Every sample above 15 ms belongs to the **hoarder** baseline, on its penultimate auction, where it packs its whole hoarded rack into 3 words. Its own `decide` took 33.0 ms (final run, match 3, index 66), 54.9 ms (250 ms run, index 54 of 56) and 29.3 ms (an earlier run), all against a 15 ms anchor budget. That is a property of the 02-01 baseline, not of the client path. The client overhead (anchor p50 − decide p50) is about 0.4 ms.

**Unplayed rack value at Ended, per policy:**
- Final `--matches 3` run (mean over 6/6/3/3 client-matches): starter 4.17, greedy 5.50, hoarder 8.67, random 6.33.
- Kill run: starter 6.5, greedy 9.0, hoarder 4.0, random 4.0.
- Safety-flush words were needed 0 times.

**250 ms auctions:** each client skipped its bid on the first auction (6 `bidsSkippedDeadline`). The first auction arrives via the subscription snapshot and is tagged late. With no offset estimate yet, the conservative rule applies (deadline = recv + 250 − rttP90(100 default) − 120 − 250 late-extra), which leaves no time. This is a Phase 5 note for fast-auction events.

**Earlier runs of the same harness**, during development:
- runs/e2e/m3: matches 3–5
- runs/e2e/m3b: matches 8–10
- runs/e2e/kill1b: match 11

All had 0 timing errors, 0 rejections and all diagnostics at 0. Pooled p99 was 5.2 ms (m3b, kill1b).

### Tests / typecheck
- `npx vitest run`: **27 files, 322 tests, all pass** (about 11 s). The shadow suite has 10 tests.
- `npx tsc --noEmit`: clean.
- Secret greps:
  - `git grep -n "BOT_TOKEN=" -- . ':!.env.example'` matches only the planning docs that quote the grep.
  - `git grep -nE "eyJ[A-Za-z0-9_-]{10,}\."` finds nothing.
  - No logs or tokens are committed: `runs/`, `.cache/` and `node_modules` are git-ignored.

## Task Commits
1. `53695b4` feat(02-04): live entrypoint, whoami, anonymous ghost-observer shadow mode
2. `5219560` feat(02-04): local-server E2E harness on the official module, incl. kill-and-resume

## Deviations from Plan
1. **[Rule 3 - Blocking] Ghost observer is a separate class, not MatchDriver.**
   - MatchDriver refuses a snapshot without our participant row, and it computes `totalAuctions` from every config player (the ghost would add `rack` to the count).
   - Fixing that would need `adapter.ts`, which is outside this plan's files.
   - `GhostObserver` reuses the adapter's exported builders and copies its transaction order and word-attribution rule (about 60 lines). The fake-stream tests prove it exact, including mid-match joins with close-transaction sim words.
2. **[Rule 1 - Bug] E2E analysis counted boot resume-check logs.**
   - At boot, every client opens a per-match log for its newest seat; for an already-Ended match that log has 0 decisions.
   - The first `--kill-one` run therefore failed with "finished logs 12 != 6".
   - These logs are now classified `bootCheck`: they are replayed (diagnostics 0) but excluded from the finished, score and unplayed counts.
3. **[Rule 1 - Bug] The anchor p99 gate used the max of per-client-match p99s.**
   - With n = 68, a per-match p99 is the max. One hoarder decide overrun (30.3 ms) failed that first kill run.
   - The plan's metric is the p99 of anchor latency. main.ts now dumps raw samples (`latency-<match>.json`), and run-local gates on the **pooled** p99. The per-client-match max is still reported, and the worst samples are named.
4. **[Rule 2 - Safety] `ENV_FILE` override and an empty env file for E2E children.**
   - The worktree has no `.env`, and children must never read a `.env` that points at maincloud.
   - Entrypoints honour `ENV_FILE`. run-local passes an empty file plus explicit values for every key.
5. **[Rule 2 - Safety] Isolated CLI config.** Server-issued login is not a CLI option in 2.12, and the user's global config holds the maincloud login. setup-local therefore uses `--config-path .cache/stdb/cli.toml` with a token minted from the local server's `/v1/identity`, and `--no-config` on every call (the module's `spacetime.json` says maincloud).
6. **[Scope] Added `--full-only` to client-shadow.**
   - The first shadow run joined match 42732 at round 41 via the 30 s fallback.
   - The second run used `--full-only`, so ≥ 2 full live matches were observed (42733, 42735, 42736).
7. **[Scope] `--first-price` is not implemented.** Lobbies are Vickrey-only in the module; FirstPrice needs a tournament flow. The flag errors with an explanation, and the README documents it. `--auction-ms` and `--rack` work: a 56-auction match at 250 ms ran cleanly.
8. **[Scope] Extra files:**
   - `e2e/lib.ts`, shared loopback helpers, inside `e2e/**`.
   - `main.ts` latency dump (Task 2 commit) and its test in `shadow.test.ts`.
9. **[Environment]**
   - The worktree branch is `worktree-wf_31be710d-d45-6`, assigned by the harness. It is not in the `worktree-agent-*` namespace, but commits were made on it as instructed.
   - The worktree base was reset to eae8c1c as instructed.

## Issues / Notes for later phases
- **Hoarder baseline (02-01 / 03-02):** `decide` ignores its budget on large racks (29–55 ms with a 15 ms anchor budget). It also bids on the final auction (bid 19 for a letter it cannot use). Neither changes the client path, but both inflate the anchor-latency tail.
- **Fast auctions (Phase 5):** at 250 ms, the snapshot-delivered first auction is always skipped by the conservative late-deadline rule. Consider seeding offsetEst from the shadow/whoami connection, or a smaller late-extra for the first auction.
- **Clock:** this machine reads about 100 ms behind maincloud. The clock model handles that through offsetEst. Absolute receive lag cannot be measured without NTP-level sync.
- **Lobby timeout:** an all-sim match (id 7 in an earlier run) appeared from a lobby timeout between harness runs. It is not ours and is excluded by construction (run-local only analyses its own clients' logs).

## Known Stubs
None.

## Threat Flags
None beyond the plan's threat model:
- **T-02-04-01:** guard plus `requireLoopback`. The child environment is explicit and asserted.
- **T-02-04-02:** `perMatchQueries` plus the bot roster only. Unit tests assert that the leak view is never subscribed. The ghost has no reducer host.
- **T-02-04-03:**
  - Tokens are only ever in `.cache` (mode 600) or env.
  - whoami and stdout print no tokens.
  - Shadow tokens are never persisted.
  - AnonSql redacts its token from errors.
- **T-02-04-SC:** `npm ci` ran only in `.cache/official/spacetimedb`, from the pinned lockfile.
- **T-02-04-05:** shadow uses targeted read-only subscriptions with a timeout.

## Self-Check: PASSED
- Files exist: src/client/main.ts, src/client/shadow.ts, scripts/client-whoami.ts, scripts/client-shadow.ts, test/client/shadow.test.ts, e2e/setup-local.sh, e2e/provision.ts, e2e/run-local.ts, e2e/lib.ts, e2e/README.md, e2e/patches/seed-admin.patch.
- Commits 53695b4 and 5219560 are present on the branch.
- The local server is stopped (`setup-local.sh --stop`; port 3100 free), and no client processes remain.
