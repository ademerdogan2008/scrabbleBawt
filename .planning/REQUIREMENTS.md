# Requirements: scrabbleBawt

**Defined:** 2026-11-07
**Core Value:** Win matches: maximize final placement against strong real bots and sim-padded lobbies, with zero self-inflicted losses.

## v1 Requirements

### Engine (ENG)

- [ ] **ENG-01**: Dictionary is byte-identical to the module's `spacetimedb/wordlist.txt`; `isValid` matches module semantics (ASCII uppercase, A–Z only, length ≥ 2)
- [ ] **ENG-02**: Scoring matches the module exactly (letter values, length multipliers 1/1.5/2/2.5/3, integer floor)
- [ ] **ENG-03**: All dictionary words formable from a rack of up to 35 tiles can be enumerated (p99 < 5 ms)
- [ ] **ENG-04**: Exact optimal word packing (max total reward of disjoint words) for racks ≤ 30 tiles, verified against brute force on small racks; plus a fast approximate packer for Monte Carlo (typical < 0.5 ms)

### State (STATE)

- [ ] **STATE-01**: `MatchTracker` derives balances, scores, won/played letters, revealed hidden tiles, known opponent racks and the unseen pool from public events
- [ ] **STATE-02**: Simulator and live client feed the tracker identical event streams

### Simulator (SIM)

- [ ] **SIM-01**: Simulator reproduces server rules exactly: dealing, alphabetical-index draws, sealed-bid close (ties random, bids > 0), Vickrey/FirstPrice payment and reserve, unbid letters consumed, final letter unusable, sims' exact bids and word plays
- [ ] **SIM-02**: Parallel tournament runner (worker_threads) with paired seeds; ≥ 1000 six-player matches of baseline bots in < 5 minutes
- [ ] **SIM-03**: Statistics: win %, avg rank, avg score, margin vs best opponent, Wilson CIs, OpenSkill PL ratings; JSON + markdown reports
- [ ] **SIM-04**: Parity evidence that the simulator matches official module logic (module test harness and/or historical replays)

### History (HIST)

- [ ] **HIST-01**: In-repo fetch tool downloads historical tables over HTTP SQL into NDJSON (chunked, resumable)
- [ ] **HIST-02**: Validation suite over historical matches: word rewards, dictionary membership and participant score sums reproduce with 0 mismatches
- [ ] **HIST-03**: Opponent profiles (bid behavior, word policy) for the top leaderboard bots generated into `data/profiles.json`
- [ ] **HIST-04**: Counterfactual replay benchmark inserts any Policy into historical auction streams and reports outcomes

### Live client (CLI)

- [ ] **CLI-01**: Connects with BOT_TOKEN (persisted, never logged), resolves bot id, joins lobby, rejoins after match end, registers for a tournament via TOURNAMENT_ID
- [ ] **CLI-02**: Uses targeted subscriptions only (never the full history); detects a new match before its first auction closes
- [ ] **CLI-03**: Bids land before `closes_at` using measured latency + clock offset; quick bid then refined re-bid
- [ ] **CLI-04**: All playable words are flushed before the match ends; rejected submissions are detected and retried
- [ ] **CLI-05**: Reconnects mid-match and resumes from history rows
- [ ] **CLI-06**: Shadow mode spectates live maincloud matches anonymously, runs the policy without submitting, logs latency and decisions
- [ ] **CLI-07**: Local-server E2E harness runs the official module on spacetime 2.12 locally, provisions bots, and plays full matches with our bot

### Strategy (STRAT)

- [ ] **STRAT-01**: Opponent bid models — exact for sims (strategy, jitter, balance cap), online-learned for real bots, seeded by historical priors
- [ ] **STRAT-02**: Monte Carlo marginal letter valuation with common random numbers inside the time budget
- [ ] **STRAT-03**: Vickrey bidding with budget pacing (value of money over time) and endgame all-in; first-price bid shading
- [ ] **STRAT-04**: Word-cashing policy (when to cash 7+ vs shorter words, money needs, guaranteed final flush)
- [ ] **STRAT-05**: Rank-aware denial of the leading opponent
- [ ] **STRAT-06**: Defenses against simple tricks (all-in bidders, price-pushers, bottom-feeders, end-game dumps, top-bid snooping) and adaptivity to match size, rack size, auction length, auction type
- [ ] **STRAT-07**: All tunables in one JSON params object; decisions deterministic given seed

### Opponent zoo (ZOO)

- [ ] **ZOO-01**: Baselines: exact starter-bot replica, greedy variants
- [ ] **ZOO-02**: ≥ 4 community-bot clones from public source code
- [ ] **ZOO-03**: ≥ 3 behavioral clones of top leaderboard bots from historical data
- [ ] **ZOO-04**: ≥ 6 trick bots (all-in, price-pusher, bottom-feeder, hoarder, end-game dumper, random)

### Evaluation (EVAL)

- [ ] **EVAL-01**: Benchmark suite over lineups: sims-only, mixed lobby, all-real tables of clones, trick tables, self-play, first-price, variable match sizes/rack sizes/auction lengths
- [ ] **EVAL-02**: Loss-analysis traces and reports (why each loss happened)
- [ ] **EVAL-03**: Paired-seed parameter tuning with documented improvements per iteration
- [ ] **EVAL-04**: Final bot targets: ≥ 90% wins vs 5 sims; ≥ 2.5× random-chance win rate (≥ 42%) and best avg rank at 6-bot tables of the strongest clones; no table where it ranks below 2nd on average

### Release (REL)

- [ ] **REL-01**: README documents strategy, architecture, setup, usage, and measured statistics
- [ ] **REL-02**: Public repo pushed after each verified phase; no secrets in history
- [ ] **REL-03**: Live play on maincloud once the user provides BOT_TOKEN (post-run stats report)

## v2 Requirements

- **ADV-01**: Learned value network trained on self-play data replacing MC rollouts
- **ADV-02**: Continuous online self-improvement loop on live matches

## Out of Scope

| Feature | Reason |
|---------|--------|
| Snooping `visible_auction_top_bids` via an anonymous 2nd connection | Circumvents intended visibility; fair-play constraint |
| Modifying the game module / server | We compete only through public reducers |
| Spectator/dashboard UI | Headless bot; reports suffice |
| Rust/C# implementations | Toolchains unavailable; single code path sim/live |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ENG-01..04 | Phase 1 | Pending |
| STATE-01..02 | Phase 1 | Pending |
| SIM-01..04 | Phase 2 (02-01) | Pending |
| HIST-01..04 | Phase 2 (02-02) | Pending |
| CLI-01..05 | Phase 2 (02-03; CLI-01/CLI-05 E2E exercise in 02-04) | Pending |
| CLI-06..07 | Phase 2 (02-04) | Pending |
| STRAT-01..07 | Phase 3 | Pending |
| ZOO-01 | Phase 2 (02-01) | Pending |
| ZOO-02..04 | Phase 3 (03-02; extends 02-01 baselines) | Pending |
| EVAL-01..03 | Phase 4 | Pending |
| EVAL-04 | Phase 5 | Pending |
| REL-01..03 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 39 total
- Mapped to phases: 39
- Unmapped: 0

---
*Requirements defined: 2026-11-07*
*Last updated: 2026-11-07 after phase-2 plan check (ZOO-01 moved to Phase 2; client split into 02-03/02-04)*
