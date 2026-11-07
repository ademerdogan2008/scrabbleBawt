---
phase: 02-infrastructure-simulator-history-live-client
plan: 03
subsystem: client
tags: [spacetimedb, live-client, guard, subscriptions, adapter, anytime-bidding, resume, lifecycle]
requires: [01-01 src/core, 01-02 src/engine (getEngine().packer), 01-03 src/state (MatchTracker, MatchRecorder, applyEvent)]
provides:
  - src/client/config.ts loadConfig/parseDotEnv/classifyHost/defaultEnvPath
  - src/client/guard.ts callReducer/isBlocked/MaincloudGuardError/lazyReducerHost/BINDING_REDUCERS/GAME_REDUCERS
  - src/client/connection.ts ConnectionSupervisor/persistToken/backoffDelay
  - src/client/clock.ts ClientClock (rttP90, offsetEst, observeLiveOpen, deadlineFor, budgetFor)
  - src/client/log.ts redact/Logger/MatchLog/eventsFromLog
  - src/client/subscriptions.ts identityQueries/myBotQueries/bootQueries/perMatchQueries/rangeProbeQueries/assertQueriesAllowed/subscribeQueries
  - src/client/adapter.ts MatchDriver, rebuildFromSnapshot, buildMatchConfig, row normalizers, summarizeStats
  - src/client/words.ts Reservations, planSafetyFlush, loadDefaultFlushPacker, unplayedValue
  - src/client/session.ts SessionCore, bindConnection, cacheSnapshot, runSession, acquireLock/releaseLock
affects: [02-04 entrypoints (main/whoami/shadow, local E2E), 05 live play]
tech-stack:
  added: []
  patterns:
    - normalized plain rows (bigint µs timestamps) between the SDK and the driver, so everything is testable without the SDK
    - per-transaction batching (split by ctx.event.id, flushed in a microtask)
    - snapshot read from the cache in onApplied; initial-row callbacks ignored
    - default-deny reducer guard keyed on the host
    - in-memory fake server reproducing the module's per-transaction deltas and error strings
key-files:
  created:
    - src/client/config.ts
    - src/client/guard.ts
    - src/client/connection.ts
    - src/client/clock.ts
    - src/client/log.ts
    - src/client/subscriptions.ts
    - src/client/adapter.ts
    - src/client/words.ts
    - src/client/session.ts
    - .env.example
    - test/client/config.test.ts
    - test/client/guard.test.ts
    - test/client/clock.test.ts
    - test/client/log.test.ts
    - test/client/subscriptions.test.ts
    - test/client/adapter.test.ts
    - test/client/resume.test.ts
    - test/client/session.test.ts
    - test/client/fixtures/sample.env
    - test/client/fixtures/fakeServer.ts
    - test/client/fixtures/harness.ts
  modified: []
key-decisions:
  - "Maincloud guard allow-list is EMPTY: every reducer (all 27 in the bindings plus unknown/future names) is blocked on any spacetimedb.com or non-loopback host unless the real process env has ALLOW_MAINCLOUD_PLAY=1"
  - "ALLOW_MAINCLOUD_PLAY is never taken from a .env file; loadConfig reads a file only when given an explicit envPath and never mutates process.env"
  - "Rebuild rule: a word with played_at == closed_at(k) counts as a close-transaction word of k only when its player won auction k (only sims play in close transactions). This removes the same-µs ambiguity."
  - "A word the server rejected is never resubmitted in the same auction. After 'Insufficient balance', later bids for that auction are capped at the tracked balance."
  - "On reconnect, drivers are disposed and rebuilt from fresh snapshots with a fresh policy instance (policyFactory). The open auction's bid is always resubmitted on resume, even when it is 0, because pending_bid cannot be read."
  - "Late tagging has three triggers: initial-row/snapshot delivery, event-loop lag above clock.stallMs (150 ms), or an arrival lag above offsetEst + stallMs."
requirements-completed: [CLI-01, CLI-02, CLI-03, CLI-04, CLI-05]
duration: 29min
completed: 2026-11-07
---

# Phase 2 Plan 03: Live SpacetimeDB client core Summary

**The guarded live client core is built and tested without a network: targeted subscriptions behind a FORBIDDEN check, a row→MatchEvent adapter that emits the same stream shape as the simulator, anytime bidding with late-aware deadlines, a final-auction flush with a packer safety net, snapshot resume that deep-equals the uninterrupted tracker, and the lobby/tournament lifecycle.**

## Accomplishments

### Task 1: config, guard, connection, clock, log
- **config.ts**
  - Minimal `.env` parser: `export` prefix, quotes, inline comments. It never overrides an env value that is already set.
  - `loadConfig({envPath?, env?, tokenDir?, isPolicyRegistered?})` reads a file only when `envPath` is given. Entrypoints pass `defaultEnvPath()`.
  - Token comes from `BOT_TOKEN` or from `.token-<BOT_NAME>`. It is a non-enumerable field, and `toString`/`toJSON`/`inspect` show only its length.
  - `classifyHost`:
    - `isLocal` covers 127.x, localhost and ::1.
    - `isMaincloud` = matches `(^|\.)spacetimedb\.com$` OR is non-loopback. Unparseable hosts count as maincloud.
- **guard.ts**
  - `callReducer(conn, name, args, target, {env?})` is the only reducer path. It throws `MaincloudGuardError` synchronously, before `conn.reducers` is even read.
  - `BINDING_REDUCERS` is unit-checked against `module_bindings/index.ts`: 27 names.
  - `GAME_REDUCERS` adds `leave_lobby` by name.
  - `lazyReducerHost` covers reconnects.
- **connection.ts**
  - `ConnectionSupervisor` builds a fresh `DbConnection` with `withCompression('none')` and `withConfirmedReads(false)`.
  - Reconnect backoff is 0.5/1/2/5/10 s, with a resubscribe hook (`onConnected`) and redacted error logs.
  - `persistToken` writes mode 600, and only when the token did not come from env and the connection is not anonymous.
- **clock.ts** (`ClientClock`)
  - RTT: EWMA plus p90 over a 64-sample window. The default is 100 ms until samples exist.
  - Arrival-lag samples come only from steady-state live opens. `offsetEst` is the p10 of that window.
  - `deadlineFor = min(recv + duration, closesAt + offsetEst) − rttP90 − margin(120)`.
    - Late deliveries use the `closesAt + offsetEst` branch.
    - If no offset estimate exists yet, they use the recv branch minus 250 ms.
  - `budgetFor = deadline − now − submitCost`.
- **log.ts**
  - `redact()` scrubs JWTs, `token=` params, `Bearer` headers and registered exact secrets. `addSecret` covers tokens learned at connect.
  - `Logger` writes buffered JSONL to `client.jsonl`. `MatchLog` writes `match-<id>.jsonl` records: event, decision, submit, timing, error, info.
  - `eventsFromLog()` feeds `replay()`.
- **.env.example** documents every key. `ALLOW_MAINCLOUD_PLAY` is commented out, with a Phase-5-only warning.

### Task 2: subscriptions, adapter, words, session, resume
- **subscriptions.ts**
  - SQL is rendered byte-identical to the SDK typed builder (asserted with `toSql(tables.*.where(...))`).
  - Boot runs in two stages:
    1. `bot_credential WHERE identity = 0x…`, `bot`, `open_lobbies`, `open_lobby_members`, `my_rack`, `tournament`.
    2. `match_participant WHERE bot_id = ME` and `tournament_entry WHERE bot_id = ME`.
  - `perMatchQueries(M)` covers six match_id/id-filtered tables. 02-04 reuses it for the ghost observer.
  - `rangeProbeQueries(X)` = `auction WHERE match_id > X`. 02-04 runs it and records the result.
  - `assertQueriesAllowed` runs on every list. It rejects the leak view in any spelling, any unfiltered history table, and queries with no table.
- **adapter.ts** (`MatchDriver`, one per match)
  - Live order within a transaction is results → words (deduped by row id) → balances → my_rack → open.
  - Shared `auctionIndex` rule: a word in result(k)'s transaction gets k and is applied after the result; otherwise it gets the open auction's index.
  - Config:
    - Players come in match_participant id order, with sim strategies from `bot`.
    - `totalAuctions = 98 − rack·P`.
    - `kind` comes from the tournament_match phase.
    - `remainingAfter = match_state.bag_total`.
  - Anchor pass: decide with a 15 ms budget → reservation-checked words → bid.
    - Refine passes, at most 4 per auction, are scheduled after the anchor and after any mid-auction state change. Their budget is `min(250, budgetFor(deadline))`. The bid is resent only when it changes; 0 withdraws.
    - No submission is ever sent at or after the deadline.
  - "Insufficient balance" gets one resubmit with `min(bid, tracked balance)`.
  - Reducer promises are wrapped in a 2500 ms timeout. Errors are classified with the module's exact strings: late, balance, match-over, rejected, timeout, unknown.
  - Stats: decide ms, anchor latency (recv → anchor bid sent), event-loop lag, and counters for timing errors, rejections, flush words, replans and late opens.
- **rebuildFromSnapshot**
  - Auctions are sorted by id. Each `open(a)` is followed by its words and then its result.
  - Words are sorted by (played_at, id) and placed after the last open with opens_at ≤ played_at:
    - before that auction's result if played_at < closed_at;
    - after the previous result if played_at == closed_at and the player was that auction's winner.
  - `myStartRack = my_rack(M) + letters I played − letters I won`.
  - The driver then resyncs balances and the rack, and plays the open auction (tagged late), forcing a bid when `resume`.
- **words.ts**
  - `Reservations` multiset: release on echo, release on rejection, and release of settled or timed-out calls at the next my_rack resync.
  - `planSafetyFlush` runs `getEngine().packer.packExact` on `rack − reserved`, loaded lazily.
  - `unplayedValue` is logged at Ended, from my_rack filtered by match_id.
  - Final auction (`remainingAfter == 0`):
    - All policy words go first, then the safety flush, then the bid.
    - A rejected word triggers one re-plan from the refreshed rack; words that were already rejected are skipped.
  - The penultimate auction gets no forced flush.
- **session.ts**
  - `SessionCore` lifecycle:
    - `start()` refuses with "read-only: refusing to play" when the guard would block `join_lobby`. This happens before any subscription or reducer call.
    - Boot, then resolve the bot id from the credential row.
    - Only the newest match seat can still be Running, so only it is checked (resume path).
    - New matches are detected from our participant rows (lobby or tournament).
    - `join_lobby` is called when idle and not in the open lobby, with no tournament hold, no NO_LADDER, and below MAX_MATCHES.
    - Quiet handling of "already in a running match" and tournament refusals: the latter sets a hold that clears when tournament or entry rows change.
    - `TOURNAMENT_ID=<id>|auto` registers once per tournament in Registration.
    - The lobby is rejoined after Ended. The per-match unsubscribe runs 3 s after the log flush.
    - On reconnect, drivers are disposed and rebuilt.
  - pid lock `.cache/client-<BOT_NAME>.lock`: a live holder is refused, a stale lock is taken over, and the lock is released on exit.
  - `bindConnection`:
    - Batches SDK row callbacks per `ctx.event.id` into a `GlobalTx` and flushes it in a microtask.
    - Ignores SubscribeApplied/UnsubscribeApplied row callbacks.
    - `cacheSnapshot`/`matchSlice` build the snapshots.
  - `runSession({cfg, policyFactory})` is the 02-04 entrypoint. If refused, it resolves `'refused'` without connecting. Otherwise it takes the lock, preloads the engine, starts the supervisor and binds the connection.

## Verification / measured numbers
- **Tests and typecheck**
  - `npx vitest run` (whole suite): 15 files, **156 tests, all pass**, in about 10.2 s.
  - The client share is 8 files and 102 tests: config 21, guard 15, clock 10, log 7, subscriptions 6, adapter 21, resume 7, session 15.
  - `npx tsc --noEmit`: clean.
- **Plan verification greps:** all return nothing.
  - `\.reducers\.` outside guard.ts and the bindings
  - `visible_auction_top_bids` outside FORBIDDEN lines
  - `subscribeToAllTables`
  - `eyJ[A-Za-z0-9_-]{10,}\.`
  - `BOT_TOKEN=` in src/test

  JWT-shaped strings and the token key in tests are assembled at runtime.
- **Guard**
  - All 27 binding reducers, `leave_lobby` and an unknown name throw on 4 maincloud host forms, including `wss://`.
  - The `conn.reducers` getter is never touched (spy).
  - Loopback (127.0.0.1, localhost, [::1]) passes through, and so does `ALLOW_MAINCLOUD_PLAY=1`. The value `'true'` is rejected.
- **Clock**
  - With offset 40 ms, a delivery 400 ms later than on-time has at least 400 ms less remaining time.
  - A late auction's deadline never exceeds `closesAt + offsetEst − rttP90 − margin` for any recv time.
  - With no offset estimate, a late delivery gets −250 ms.
- **Full scripted matches** (fake server: 4 seats with 2 sims, Vickrey, rack 5, 78 auctions)
  - The tracker matches server truth for every balance, score and our exact rack.
  - The JSONL match log replays (`replay(eventsFromLog)`) to a deep-equal snapshot.
  - Diagnostics are all 0; there are 0 rejected calls and 0 timing errors.
  - Sims played words inside close transactions. Each such word is preceded by result(k) with the same index and followed by open(k+1).
- **Variable config:** 2 players, rack 7, 250 ms FirstPrice auctions, 84 auctions. Diagnostics are 0, and every submission was sent before its deadline.
- **Resume:** shuffled snapshots after auctions 5, 17, 40 and 76 (the last one resumes into the final auction).
  - The rebuilt tracker deep-equals the uninterrupted tracker at the same point and again at match end.
  - Diagnostics are 0, there is exactly one bid (re)submission for the open auction, and 0 timing errors.
  - A 0 bid is still resubmitted on resume, while a fresh start never sends a 0 bid.
  - A snapshot of an already-Ended match finishes with 0 decisions.
- **Final auction**
  - Anchor-pass words come strictly before the anchor bid: policy words, then `anchor-flush` words.
  - The server rejected the non-word with `'XX' is not in the dictionary`. That caused 1 re-plan.
  - The leftover rack has a packExact score of 0 at the end, and there were 0 "Match not running" errors.
- **Driver cost** (`tsx`, Apple Silicon; throwaway script, not committed): 30 fake matches, 2,340 auctions, ScriptedPolicy using engine `findBestPlayable`.
  - Synchronous close-transaction processing, including the anchor decide and submit dispatch: **p50 0.019 ms, p90 0.035 ms, p99 0.11 ms, max 0.54 ms**.
  - Snapshot rebuild (applySnapshot, n = 234): **p50 0.25 ms, p99 0.52 ms, max 0.57 ms**.
  - Across those matches: 0 diagnostics, 0 timing errors, 0 rejected calls.
  - An earlier run let disposed probe drivers submit words for the same bot. It produced 7 "Not enough" rejections, which reproduces PITFALLS M15 (two actors on one bot); the pid lock exists for exactly this reason. The measurement was redone with a no-op host.

## Task Commits
1. `dcc159e` feat(02-03): client config, maincloud guard, connection, clock, redacting log
2. `2c925bd` feat(02-03): targeted subscriptions, row->event adapter, anytime bidding, safe words, resume, session lifecycle

## Deviations from Plan
1. **[Rule 1 - Bug] Close-transaction word disambiguation in rebuild.** Our own word sent right after an open could share its µs timestamp with the previous close. The rebuild then misattributed it to the closed auction. The fix requires the word's player to be that auction's winner (only sim winners play in close transactions). The fake server also now issues strictly increasing transaction timestamps, as the real one does.
2. **[Rule 2 - Correctness] Rejected words are not resubmitted within the same auction.** Without this, the final-auction re-plan resent the same rejected word, and the safety flush could not use its letters.
3. **[Rule 2 - Correctness] Bid cap after "Insufficient balance".** Without the cap, a refine pass resent the rejected amount after the one allowed retry.
4. **[Rule 2 - Correctness] Event-loop-stall late tagging.** Opens processed more than 150 ms after their callback are tagged late, along with the plan's snapshot and offset rules.
5. **[Design] Reconnect uses our own supervisor, with a fresh `DbConnection` per attempt and the plan's 0.5/1/2/5/10 s schedule, not SDK auto-reconnect.** The one tested resume path (snapshot rebuild) therefore covers both process restarts and reconnects.
6. **[Design] Stricter than the plan:**
   - `ALLOW_MAINCLOUD_PLAY` from a `.env` file is ignored.
   - The guard allow-list is empty, because the module has no read-only reducer.
   - `loadConfig` without `envPath` reads no file at all.
7. **[Scope] Extra tests, all inside `test/client/**`:** `session.test.ts` (lifecycle, runSession refusal, bindConnection batching, lock), and connection tests (token persistence, backoff) inside `config.test.ts`.
8. **[Environment] Worktree branch name.** The branch is `worktree-wf_31be710d-d45-4`, assigned by the harness. It is not protected, but it is not in the `worktree-agent-*` namespace either. Commits were made on it as instructed.

## Known Stubs
None. `bindConnection`, `cacheSnapshot`, `ConnectionSupervisor` and `runSession` have not been run against a real server in this plan; it makes no network calls by design. The 02-04 local E2E and shadow runs exercise them.

## Notes for 02-04
- Entrypoint: `runSession({ cfg: loadConfig({ envPath: defaultEnvPath(), isPolicyRegistered }), policyFactory })` gives `{ core, stop, done }`, where `done` resolves `'refused' | 'done' | 'stopped' | 'error'`. A `'refused'` result should map to a non-zero exit.
- Ghost observer: `perMatchQueries(M)` plus `MatchDriver`/`rebuildFromSnapshot` with a synthetic ghost seat. Use a reducer host whose calls are never made, e.g. a policy that returns bid 0 and no words on a non-resume driver.
- Log replay: `eventsFromLog(fileText)` → `replay()`.
- Latency stats: `summarizeStats(driver.stats)` gives anchor p50/p99, loop-lag p99, and the timing-error and match-over counts.
- Verify live:
  - `onApplied` fires before the initial-row callbacks, with the cache already full.
  - The `my_rack` view arrives in the same transaction message as the per-match rows.
  - Run the range probe.

## Threat Flags
None beyond the plan's threat model. No new network endpoints; every reducer path goes through the guard (T-02-03-01), redaction covers logs (T-02-03-02), tests use fixtures and temp files only (T-02-03-03), queries pass the FORBIDDEN check (T-02-03-04), and the pid lock is implemented (T-02-03-05).

## Self-Check: PASSED
- All 9 src/client modules, .env.example, 8 client test files and 3 fixtures exist.
- Commits dcc159e and 2c925bd are present on the branch.
