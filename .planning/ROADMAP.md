# Roadmap: scrabbleBawt

## Overview

Build the engine and shared interfaces first, then three independent infrastructure streams in parallel (simulator, historical data, live client), then the strategy brain alongside an opponent zoo, then a measured tune-and-iterate loop, and finally end-to-end validation against the real module plus release. Every phase leaves the repo green (tests pass) and is merged to main and pushed after verification.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

- [ ] **Phase 1: Foundation & Word Engine** - Repo toolchain, exact rules core, dictionary/anagram index, optimal word packer, match-state tracker
- [ ] **Phase 2: Infrastructure (Simulator, History, Live Client)** - Three parallel streams: rules-exact simulator + benchmark harness; historical data pipeline + validation; SpacetimeDB client + shadow mode + local E2E harness
- [ ] **Phase 3: Strategy Brain & Opponent Zoo** - Bawt v1 (opponent models, MC valuation, paced bidding, word cashing, endgame, defenses) in parallel with clones and trick bots
- [ ] **Phase 4: Evaluate, Tune & Iterate** - Benchmark suite, loss analysis, paired-seed tuning, reasoned improvement rounds until plateau
- [ ] **Phase 5: E2E Validation & Release** - Local-server E2E vs the official module, maincloud shadow run, historical replay benchmarks, final stats, README, push; live play when token arrives

## Phase Details

### Phase 1: Foundation & Word Engine
**Goal**: A green TypeScript repo with the exact game-rules core, a fast word engine, and the shared match-state tracker that every later stream builds on.
**Depends on**: Nothing (first phase)
**Requirements**: ENG-01, ENG-02, ENG-03, ENG-04, STATE-01, STATE-02
**Success Criteria** (what must be TRUE):
  1. `npm test` passes; scoring and dictionary match the official module byte-for-byte
  2. Word enumeration for 35-tile racks runs p99 < 5 ms; exact packer agrees with brute force on small racks and solves 30-tile racks
  3. `MatchTracker` reproduces opponents' known racks and the unseen pool from a scripted event stream
**Plans**: 3 plans

Plans:
- [ ] 01-01: Repo skeleton, toolchain (spacetimedb 2.12.0, vitest, tsx), vendored wordlist + bindings, `src/core` (letters, rack, rng, types)
- [ ] 01-02: `src/engine` — dictionary, anagram-class trie, word enumeration, exact + fast packers, benchmarks
- [ ] 01-03: `src/state` — MatchTracker / MatchView with inference of hidden tiles and unseen pool

### Phase 2: Infrastructure (Simulator, History, Live Client)
**Goal**: Everything needed to measure and to play: a rules-exact parallel simulator with baselines and stats, the historical dataset with validation and priors, and a working live client with shadow mode and a local-server E2E harness.
**Depends on**: Phase 1
**Requirements**: SIM-01, SIM-02, SIM-03, SIM-04, HIST-01, HIST-02, HIST-03, HIST-04, CLI-01, CLI-02, CLI-03, CLI-04, CLI-05, CLI-06, CLI-07, ZOO-01
**Success Criteria** (what must be TRUE):
  1. `npm run bench` plays ≥ 1000 six-player matches in < 5 minutes with paired seeds and prints win%/rank/score/CI/OpenSkill tables
  2. Historical validation reproduces every fetched word reward and participant score with 0 mismatches; `data/profiles.json` exists for the top bots
  3. Shadow mode spectates a live maincloud match end-to-end and reports latency; the local-server harness completes a full match with our client bot
**Plans**: 4 plans (wave 1: 02-01, 02-02, 02-03 in parallel; wave 2: 02-04)

Plans:
- [ ] 02-01-PLAN.md — `src/sim` + `src/bots/baselines` — match engine, server-sim replicas, baselines (ZOO-01 starter replica + greedy; simple hoarder/random), registry, tournament runner, stats/OpenSkill, bench CLI, host-RNG parity tests
- [ ] 02-02-PLAN.md — `src/history` — fetch tool, dataset loaders, validation tests, profiles, counterfactual replay, committed sample
- [ ] 02-03-PLAN.md — `src/client` core — config, maincloud write guard, connection, clock/deadlines, redacting log, targeted subscriptions, adapter, anytime bids, word flush (+ packer safety flush), reconnect/resume, lifecycle (unit-tested, no network)
- [ ] 02-04-PLAN.md — entrypoints + `e2e/` — `npm start` (guarded), whoami, ghost-observer shadow mode on maincloud, local official-module E2E harness incl. kill-and-resume (depends on 02-01, 02-03)

### Phase 3: Strategy Brain & Opponent Zoo
**Goal**: Bawt v1 that beats every baseline, plus a diverse opponent population (community clones, top-bot behavioral clones, trick bots) to test against.
**Depends on**: Phase 2
**Requirements**: STRAT-01, STRAT-02, STRAT-03, STRAT-04, STRAT-05, STRAT-06, STRAT-07, ZOO-02, ZOO-03, ZOO-04 (ZOO-01 baselines delivered in Phase 2 / 02-01)
**Success Criteria** (what must be TRUE):
  1. Bawt v1 wins ≥ 80% vs 5 server sims and beats the starter replica head-to-head
  2. ≥ 4 community clones, ≥ 3 historical clones, ≥ 6 trick bots registered and runnable in the bench
  3. Decisions respect a 250 ms budget (p99) in simulation
**Plans**: 2 plans (parallel)

Plans:
- [ ] 03-01: `src/bots/bawt` — opponent models, MC valuation, Vickrey/FirstPrice bidding with pacing, word cashing, endgame, denial, trick defenses, params
- [ ] 03-02: `src/bots/{clones,tricks}` — community clones, historical clones, trick bots, named lineups; extends (does not recreate) the 02-01 baselines and registry

### Phase 4: Evaluate, Tune & Iterate
**Goal**: Measured, reasoned improvement of Bawt until gains plateau across all lineups.
**Depends on**: Phase 3
**Requirements**: EVAL-01, EVAL-02, EVAL-03
**Success Criteria** (what must be TRUE):
  1. Benchmark suite covers sims-only, mixed, all-clone, trick, self-play, first-price and variable-config tables
  2. Every iteration logs hypothesis → change → paired-seed result; regressions rejected
  3. Final tuned params committed with before/after statistics
**Plans**: TBD (iterative)

Plans:
- [ ] 04-01: Benchmark suite + loss-analysis tooling
- [ ] 04-02: Paired-seed tuner + improvement rounds

### Phase 5: E2E Validation & Release
**Goal**: Prove the shipped bot works against the real module and real traffic, publish results.
**Depends on**: Phase 4
**Requirements**: EVAL-04, REL-01, REL-02, REL-03
**Success Criteria** (what must be TRUE):
  1. Local-server E2E: our client bot plays full matches against the official module with zero rejected bids/words due to timing
  2. Maincloud shadow run over several live matches completes without errors
  3. README with strategy + statistics pushed; EVAL-04 targets met or gaps documented
**Plans**: 2 plans

Plans:
- [ ] 05-01: E2E runs (local server, shadow, historical replay) + final stats report
- [ ] 05-02: README, release push; live play when BOT_TOKEN is provided

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 (plans inside a phase run in parallel worktrees where they own disjoint directories)

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation & Word Engine | 0/3 | Not started | - |
| 2. Infrastructure | 0/4 | Not started | - |
| 3. Strategy Brain & Opponent Zoo | 0/2 | Not started | - |
| 4. Evaluate, Tune & Iterate | 0/2 | Not started | - |
| 5. E2E Validation & Release | 0/2 | Not started | - |
