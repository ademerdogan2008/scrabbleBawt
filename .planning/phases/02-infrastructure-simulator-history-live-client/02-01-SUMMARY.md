---
phase: 02-infrastructure-simulator-history-live-client
plan: 01
subsystem: sim
tags: [simulator, tournament, worker-threads, statistics, openskill, baselines, host-rng-parity]
requires: [01-01 core (letters, rack, rng, simbots, types), 01-02 engine (findBestPlayable, bestSingleWord, packExact), 01-03 state (MatchTracker, MatchEvent, applyEvent, replay)]
provides:
  - src/sim/match.ts (runMatch, runMatchCore, MatchSpec, SeatSpec, MatchResult, drawLetter, closeAuction, awardLetter, simWordPlay, tryPlayWord)
  - src/sim/rngStreams.ts (MatchRngSource, BidOrderModel, IndependentStreams, SeatOrderModel, seatRng)
  - src/sim/tournament.ts (runTournament, comparePaired, runJobs, runJob, deterministicPart)
  - src/sim/stats.ts (summarize, wilson, plackettLuce, meanCI, pairedT, signTest, chiSquareP, tQuantile)
  - src/sim/cli.ts + scripts/bench.ts (npm run bench)
  - src/bots/registry.ts (createPolicy, parseSeat, listPolicies)
  - src/bots/baselines/{starter,greedy,hoarder,random,index}.ts
  - src/sim/hostRng.ts, src/sim/hostReplay.ts (test-only, not in the sim barrel)
  - test/fixtures/allsim/{extract.ts,matches.json}
affects: [02-02 history (replay uses the same engine), 02-03/02-04 live client (same MatchEvent stream, registry), 03-01 Bawt (bench + paired compare), 03-02 opponent zoo (extends baselines, fills tricks/clones)]
tech-stack:
  added: []
  patterns: [injected RNG source + iteration-order model shared by sim and host replay, per-auction tie stream for pairing, worker_threads pool with tsx loader and in-process fallback, seed-ordered aggregation, deterministic/timing split of results]
key-files:
  created: [src/sim/match.ts, src/sim/rngStreams.ts, src/sim/index.ts, src/sim/tournament.ts, src/sim/worker.ts, src/sim/stats.ts, src/sim/cli.ts, src/sim/hostRng.ts, src/sim/hostReplay.ts, scripts/bench.ts, src/bots/registry.ts, src/bots/baselines/starter.ts, src/bots/baselines/greedy.ts, src/bots/baselines/hoarder.ts, src/bots/baselines/random.ts, src/bots/baselines/index.ts, src/bots/bawt/index.ts, src/bots/clones/index.ts, src/bots/tricks/index.ts, test/sim/helpers.ts, test/sim/match.test.ts, test/sim/stats.test.ts, test/sim/tournament.test.ts, test/sim/hostParity.test.ts, test/sim/fairplayGuard.test.ts, test/bots/baselines.test.ts, test/fixtures/allsim/extract.ts, test/fixtures/allsim/matches.json]
  modified: []
key-decisions:
  - "runMatchCore takes a MatchRngSource (deal/draw/simJitter/tieShuffle + beginTx hook) and a BidOrderModel (participant iteration order); runMatch and hostReplay differ only in these two objects"
  - "Tie-break stream is forked per auction (hashSeed(seed,'tie',index)) so one auction's bid count never shifts another auction's tie-breaks"
  - "Policy bids/words are validated like submit_bid/submit_word: asciiUppercase + dictionary + rack; non-integer, negative or over-balance bids are rejected (counted), 0 = no bid"
  - "onAuctionClosed is called after the result AND any sim word of that close (whole close transaction applied), before the next open"
  - "Tournament results split into a deterministic part and `timing` (wallMs, decide() percentiles); byte-identity is asserted on deterministicPart()"
  - "Roster order is shuffled per seed (Rng(hashSeed(seed,'roster'))); seat ids stay = lineup slot + 1 so labels are stable"
  - "parseSeat returns a distributive Omit (SeatTemplate) so the policy/sim union survives; also accepts oracle:<spec>"
requirements-completed: [SIM-01, SIM-02, SIM-03, SIM-04, ZOO-01]
duration: 20min
completed: 2026-11-07
---

# Phase 2 Plan 01: Simulator, harness, baselines and host parity Summary

**The deterministic match simulator, a parallel paired-seed tournament harness with OpenSkill stats, the bench CLI and the baseline bots are built. The simulator runs 1000 six-player matches in 839 ms wall on 8 workers. Its own step functions, driven by the server RNG, replay all 61 historical all-sim matches bit-exactly: 4148/4148 auctions, 990 top-ties, 1386 sim words, and every final balance and score.**

## Accomplishments

- **Match engine (`src/sim/match.ts`).** `runMatch(spec, seats, seed)` implements the rules in RULES.md §6-§9 and §15:
  - deal in roster order, then the first draw;
  - sim bids at each open using `simBid` plus jitter;
  - simultaneous `decide()` calls on the same pre-decision state, then each seat's words and its bid, in seat order;
  - module close (filter > 0, module shuffle, stable sort, Vickrey `second ?? min(1, top)` or FirstPrice top, balance check);
  - sim word only right after a win (`findBestPlayable(rack, 3)`);
  - unbid letters are consumed, and the match ends inside the final close.
- **Shared step functions.** `drawLetter`, `closeAuction`, `awardLetter`, `simWordPlay` and `tryPlayWord` are exported. `runMatchCore(spec, seats, source, order)` is the only match loop; runMatch and hostReplay both use it.
- **Pairing.** The deal and the letter sequence come from a bag stream that depends only on the seed. Sim jitter has its own stream and is always consumed. Tie-breaks use a per-auction stream. Each policy seat gets `new Rng(hashSeed(seed,'seat',pos))`.
- **Trackers.** Each policy seat owns a `MatchTracker` that is fed only through `applyEvent` (start/open/result/word). With `trace: true`, `trace.events[seatId]` replays into a view that deep-equals the live one, with 0 diagnostics.
- **Other match features:**
  - oracle seats get every true rack before each decide;
  - `enforceBudget` voids slow decisions;
  - per-seat `decideMs` {n, mean, p50, p99, max}.
- **Baselines (ZOO-01 plus two simple ones):**
  - `starter`: an exact bot-starter port. The bid is computed from the pre-word state and is placed on every auction, including the final one. A `pendingAttempt` flag is set at match start and on its own win. It plays one word with `findBestPlayable(rack, 2)`.
  - `greedy`: repeats `bestSingleWord` while one fits.
  - `hoarder`: holds its letters until `remainingAfter <= 1`, then plays `packExact`.
  - `random`: plays from `ctx.rng`.
  - All take JSON params.
- **Registry.** Accepts `name`, `name:{json}`, `oracle:<spec>` and `sim:<Strategy>`. It merges the `policies` maps of baselines, bawt, clones and tricks; the last three are stubs, and duplicate names throw.
- **Tournament harness:**
  - a `worker_threads` pool started with `execArgv: [...process.execArgv, '--import', 'tsx']`, or `workers: 0` to run in-process;
  - dynamic job feeding, with results stored by job index;
  - aggregation in seed order and per-seed roster shuffling;
  - `comparePaired` uses identical seeds, rosters and policy seeds for A and B, and reports paired t 95% CIs for Δscore, Δrank and Δwin plus an exact sign test.
- **Stats.** Wilson intervals, Student-t (incomplete beta), chi-square (incomplete gamma), the exact sign test, and a port of the module's `plackettLuce`, run sequentially in seed order. Display = `round(1500 + 29.4809(mu-25))`.
- **CLI.** `npm run bench -- --lineup ... | --compare A,B --template ...` prints a markdown table and `wallMs=<n>`, and can write JSON and trace files.
- **Host parity (SIM-04, test-only):**
  - `hostRng.ts`: pcg32 → pure-rand xoroshiro128plus → `integerInRange` with rejection, plus the module shuffle.
  - `hostReplay.ts`: one `HostRandom` per transaction (started_at, then each closed_at). It runs the lobby-timeout padding shuffle (S−1 = 5 calls) and uses the RULES §4.3 swap_remove/push `HostOrderModel`. It runs through `runMatchCore` and has no loop of its own.

## Measured numbers

**Bench, plan verification command** (`npm run bench -- --lineup "starter,sim:Aggressive,sim:Aggressive,sim:ValueBidder,sim:ValueBidder,sim:Cheapskate" --matches 1000 --workers 8 --seed 1 --json runs/perf.json`):
- `wallMs=839` (target < 300000); `/usr/bin/time` real 1.14 s.
- digest `95df7fcd`. A first run reported `wallMs=946` with the same digest.

| seat | win% [95% CI] | avg rank | avg score | OpenSkill |
|---|---|---|---|---|
| starter | 0.0 [0.0, 0.4] | 3.57 ± 0.05 | 17.3 ± 0.5 | 1253 |
| sim:Aggressive#1 | 49.8 [46.7, 52.9] | 1.50 ± 0.03 | 69.2 ± 0.9 | 3000 |
| sim:Aggressive#2 | 52.2 [49.1, 55.3] | 1.48 ± 0.03 | 69.9 ± 0.9 | 2955 |
| sim:ValueBidder#1/#2 | 0.0 | 4.14 / 4.22 | 10.5 / 9.8 | 909 / 880 |
| sim:Cheapskate | 0.0 | 5.30 | 1.0 | 461 |

Starter decide() timing: p50 < 0.001 ms, p99 0.007 ms, max 0.7 ms.

**Other benches:**
- Baselines plus sims (`starter,greedy,hoarder,random,sim:Aggressive,sim:ValueBidder`, 1000 matches, seed 2): `wallMs=2060`.
  - hoarder 99.9% wins at 123.6 pts; random 45.4; greedy 35.7; sim:Aggressive 32.1; starter 9.2.
  - hoarder decide p99 is 1.69 ms and its max is 461.7 ms (one `packExact` on a large final rack).
  - 0 rejected words or bids for any seat.
- Paired comparison (`--compare greedy,starter`, lobby template, 1000 seeds, 8 workers):
  - Δscore +54.29 [52.90, 55.68], Δrank −2.309 [−2.366, −2.252], Δwin +0.825 [0.801, 0.849];
  - sign test +995/−5/=0, p = 1.55e−288.
- Fidelity against history: a 6-sim lobby (2 Aggressive, 2 ValueBidder, 2 Cheapskate) over 2000 simulated matches compared with the 61 historical all-sim matches (122 seats per strategy):

| strategy | simulated avg score | historical avg score |
|---|---|---|
| Aggressive | 75.7 / 75.9 | 74.83 |
| ValueBidder | 13.6 / 13.4 | 13.80 |
| Cheapskate | 4.6 / 4.4 | 4.25 |

**Host-parity replay:**
- Fixtures: all 61 historical all-sim matches (ids 1–49, 51–56, 58–61, 28962, 33893), 177,903 bytes in `test/fixtures/allsim/matches.json`. The extractor takes 3.3 s over the 376 MB dataset.
- Result: 61/61 matches and 4148/4148 auctions bit-exact (letter, winner, paid, top bid), with **0 mismatches**.
  - 990 auctions had a top tie, and the module shuffle resolved every one exactly as history shows.
  - All 1386 sim words match in bot, word, reward and transaction timestamp.
  - All 366 final balance and score pairs match.
  - The lobby padding shuffle predicts the roster order in 61/61 matches.

**Analytic sim-distribution check:**
- Setup: 3000 six-sim matches through `runJobs` on 4 workers; only auctions where every sim's balance is at least 14 (balances non-binding).
- All 26 letters were tested, with n = 2094 (X) to 24843 (E) samples.
- Clearing-price mean versus the analytic second order statistic: worst deviation 0.026 (Z: 11.665 vs 11.639). The bounds are ≤ 4 SE and ≤ 0.15.
- Max-sim-bid chi-square p-values range from 0.078 (D) to 0.974 (F); all are > 0.001.

**OpenSkill port:**
- It reproduces the live `rating_history` of match 1 to 11 decimals.
- Run sequentially through `summarize`, it reproduces match 2 to 5 decimals; the summary rounds mu and sigma to 6 dp.

**Tests:**
- `npx vitest run`: 13 files, 163 tests pass in 10.5 s. This plan adds 6 files and 109 tests; 61 of them are per-match parity tests.
- `npx tsc --noEmit` is clean.
- `grep -rnE "sim/(hostRng|hostReplay)|sim/index" src/bots src/client` finds nothing.

## Task Commits

1. **Task 1: Match engine:** `1674fff` feat(02-01): deterministic match engine with shared step functions
2. **Task 2: Baselines + registry (TDD):** RED `44e88bf` test(02-01): add failing tests for baseline bots and registry; GREEN `7b0f5b6` feat(02-01): baseline bots (starter replica, greedy, hoarder, random) and registry
3. **Task 3: Tournament, stats, CLI:** `ed30131` feat(02-01): tournament runner, paired comparison, stats and bench CLI
4. **Task 4: Host-RNG parity:** `e0deeb2` test(02-01): bit-exact host-RNG parity replay of 61 all-sim matches

## Deviations from Plan

1. **[Rule 2 - correctness] Tie-break stream forked per auction.** The plan's "tieRng (n−1 calls)" becomes one stream per auction index. A single sequential tie stream would let one auction's positive-bid count shift every later tie-break between A/B variants, which weakens pairing. The distribution is identical.
2. **[Rule 3 - typing] `parseSeat` returns `SeatTemplate`**, a distributive `Omit<SeatSpec,'id'>`. A plain `Omit` over the union drops `policy` and `simStrategy`. It also takes an optional `seed` (default 0) for the policy factory.
3. **[Rule 2] Extra API beyond the plan:**
   - `tryPlayWord` (submit_word validation, including the module's asciiUppercase);
   - `MatchSpec.keepDecideSamples` (exact decide() percentiles across matches);
   - `trace.startRacks`;
   - `runJobs`/`runJob`/`deterministicPart`/`lineupLabels`/`rosterOrder`/`matchSeed`;
   - `percentiles`, `tCdf`, `betaInc`, `gammaP`, `lgamma`;
   - CLI `--duration-ms`, `--latency-ms`, `--no-rotate`, `--trace-limit` and `--quiet`.
4. **[Rule 3] `test/sim/helpers.ts` added** (scripted policies and seat builders shared by the sim tests). It is not in the plan's file list but sits under `test/sim/**`.
5. **Determinism test scope.** The plan says unit tests use workers 0 or 2, but also requires workers 1 vs 4 byte-identity. The test compares workers 0, 1 and 4. Threads load `worker.ts` through tsx (`--import tsx`), not through vitest transforms. It works under vitest in about 2 s.
6. **`--players N`** pads a lineup with the module lobby sims in bot-id order (Cheapskate, ValueBidder, Aggressive, ValueBidder, Aggressive, Cheapskate). `auto` means the lineup as given.
7. **Fixture layout.** There is one combined file, `test/fixtures/allsim/matches.json` (61 matches, 178 KB), instead of one file per match. It still matches the `test/fixtures/allsim/*.json` glob.
8. **Reference scripts.** The plan cites `rules-scripts/{stdbrng,tiecheck,dealcheck,simbids}.mjs`. `stdbrng.mjs` and `tiecheck.mjs` were ported; the order model comes from `tiecheck.mjs` and RULES §4.3.
9. **Worktree branch name.** The branch is `worktree-wf_31be710d-d45-2`, not `worktree-agent-*`. Commits went ahead per the orchestrator's setup check: the branch is not main/master/gsd/phase-*.

## Known Stubs

- `src/bots/bawt/index.ts`, `src/bots/clones/index.ts` and `src/bots/tricks/index.ts` export empty `policies` maps. This is intentional, per the plan: 03-01 fills bawt, and 03-02 fills clones and tricks.

## Threat Flags

None. `hostRng` and `hostReplay` are not in the `src/sim/index.ts` barrel, and the fair-play guard test also fails on synthetic violations. The fixtures contain only public historical rows: bot ids, words, scores and timestamps. They contain no tokens.

## Issues / Follow-ups

- **Hoarder max decide time.** It peaks at 461.7 ms: `packExact` on a 20+ tile final rack with a cold memo. That is fine for a baseline, but it would exceed the live 250 ms budget. 03-02 trick variants should pass `timeLimitMs`.
- **Coarse timings.** Decide-time p50 values below 1 µs print as 0.000 ms (sub-µs baselines).
- **Model scope.** The host order model is only verified on all-sim matches. With real bots, word transactions call `onWord`, and bid replacement is not modelled because a policy submits one bid per auction in the simulator.

## Self-Check: PASSED

- All 28 created files exist (`git diff --stat 4dfe78f..HEAD`: 28 files, +3695).
- Commits 1674fff, 44e88bf, 7b0f5b6, ed30131 and e0deeb2 are present on `worktree-wf_31be710d-d45-2`.
