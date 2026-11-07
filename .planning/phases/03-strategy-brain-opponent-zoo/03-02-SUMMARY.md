---
phase: 03-strategy-brain-opponent-zoo
plan: 02
subsystem: bots/zoo
tags: [opponent-zoo, clones, calibration, trick-bots, lineups, registry]
requires: [02-01 simulator + registry + baselines, 02-02 data/profiles.json, 01-02 engine (Packer, AnagramIndex), 01-03 state (MatchView)]
provides:
  - src/bots/clones/{common,lionel,nijello,lala,sookra,lambi,k13,blackswan,fieldbot,families}.ts (community clones)
  - src/bots/clones/{fitted,lucent,bron,maverick,calibration,profile}.ts (data-fitted + profile clones, calibration harness)
  - src/bots/tricks/{allin,shadow,late,jitter,sniper,endgameDumper,oracleDenier,spite,baselineWrappers,util}.ts
  - src/bots/lineups.ts (named lineups for Phase 4: LINEUPS, BENCH_LINEUPS, resolveLineup)
  - scripts/zoo-calibrate.ts, scripts/zoo-sanity.ts
  - registry: names containing ':' (clone:<x>, trick:<x>) and '<family>:*' wildcards (profile:<Bot>)
affects: [03-01 Bawt benchmarks, 04 tuning loop (lineups + zoo), 02-04 client (BOT_POLICY may name zoo bots)]
tech-stack:
  added: []
  patterns: [Turn helper (words applied to a local rack/balance before the bid), bounded exact packing (node limit + time limit, fast packer above 24 tiles), memoized best-word lookups for rack+E extension enumeration, coordinate-wise bisection on common seeds, NOW table-mix calibration, registry wildcard families]
key-files:
  created: [src/bots/clones/common.ts, src/bots/clones/lionel.ts, src/bots/clones/nijello.ts, src/bots/clones/lala.ts, src/bots/clones/sookra.ts, src/bots/clones/lambi.ts, src/bots/clones/k13.ts, src/bots/clones/blackswan.ts, src/bots/clones/fieldbot.ts, src/bots/clones/families.ts, src/bots/clones/fitted.ts, src/bots/clones/lucent.ts, src/bots/clones/bron.ts, src/bots/clones/maverick.ts, src/bots/clones/calibration.ts, src/bots/clones/profile.ts, src/bots/tricks/util.ts, src/bots/tricks/allin.ts, src/bots/tricks/shadow.ts, src/bots/tricks/late.ts, src/bots/tricks/jitter.ts, src/bots/tricks/sniper.ts, src/bots/tricks/endgameDumper.ts, src/bots/tricks/oracleDenier.ts, src/bots/tricks/spite.ts, src/bots/tricks/baselineWrappers.ts, src/bots/lineups.ts, scripts/zoo-calibrate.ts, scripts/zoo-sanity.ts, test/bots/clones.test.ts, test/bots/clones-calibration.test.ts, test/bots/tricks.test.ts]
  modified: [src/bots/clones/index.ts, src/bots/tricks/index.ts, src/bots/registry.ts]
key-decisions:
  - "Registry spec grammar extended: params start at the first ':' followed by '{', so names may contain ':' (clone:lucent); '<prefix>:*' entries are wildcard families resolving '<prefix>:<arg>' with opts.arg (profile:Waupus). listPolicies() excludes families; listFamilies() lists them."
  - "Data-fitted clones are calibrated in the NOW table mix (599 matches: LBM+3 sims 309, LBM+dead+2 sims 55, LB+dead 53, BM+dead 53, LB 73, BM 56), not in pure 3-real tables: there the three targets need 71.7 tiles of 68 and tuning ran into a bidding arms race."
  - "Fitted clones get a pacing cap bid <= 14·balance/(B+1); without it tiles/match is non-monotone in κ (a high-κ clone is broke by r20) and bisection fails."
  - "κ is bisected per clone (coordinate-wise, 3 passes, common seeds); the B == 1 fraction stays at the spec values (0.82/0.68/0.99): moving it 0.98 -> 0.32 changed end balances by < 1 coin. The optional rack-need term (needW) is off: on grids it lowered scores (LUCENT 140 -> 127)."
  - "Every exact packing in the zoo is bounded (nodeLimit 60k deterministic + timeLimitMs 20 safety; fast packer above 24 tiles), and the hoarder trick recomputes the baseline's flush with that bounded packer."
  - "trick:hoarder / trick:random / trick:bottomFeeder wrap the 02-01 baseline factories; src/bots/baselines/** is unchanged."
  - "zoo-sanity defaults to 4 workers: decide() timings are part of its result, and 8 workers on the M1 Pro (8 P + 2 E cores) doubled K-13's p99."
requirements-completed: [ZOO-02, ZOO-03, ZOO-04]
duration: ~50min
completed: 2026-11-07
---

# Phase 3 Plan 02: Opponent zoo Summary

**The opponent zoo has 15 community clones, 3 data-fitted clones of the live top bots, a `profile:<Bot>` clone for all 93 profiled bots, 11 trick bots and 15 named lineups. The data-fitted clones match NOW tiles/match within 3.3% and 9 of 12 calibrated metrics within ±15%, and their finishing order is LUCENT > Bron > maverick, as in history. All 15 lineups ran 200 matches each with `starter` focal: 0 exceptions, 0 rejected words or bids, and every one of the 35 zoo policies had decide p99 < 50 ms.**

## Accomplishments

### Task 1: community clones (`clone:<name>`)
Every clone is re-implemented from the COMPETITORS.md §4 spec; no upstream code was copied. Each file's header comment records its approximations.
- **`clone:lionel`** (gaucho, §4.3): implements the exact `pot()` rule. It is evaluated as the max over extensions E (|E| ≤ 2) of best(rack+E)·Πpc[E], which is exact for |E| ≤ 1; pairs are drawn from the 8 most likely letters. It has the linear bid with pacing, the behind-target floor, the denial term, A ≤ 2 dump logic, all-in at A = 1, and hoarding below 40.55. The worked example (E, empty rack, A = 66) gives 5.5-6.6 (test).
- **`clone:nijello`** (gen 180, §4.4): Q(r), value(L), the chooseWords net rule, all-in at B = 1, endN multiplier and the late ×exp(0.25z). The 3nvyx `seatScale` variant is an option.
- **`clone:lala`** (v2.7.5, §4.5): both data tables are transcribed. It has the Poisson-tail plan value V, the μ shadow price with in-match price scaling, the 1.25× cap and 1.4× completion floor, the T == 2 all-in/common-words rule, the starvation cash, and the FirstPrice Φ-shading.
- **`clone:sookra`** (§4.6): pack value plus 0.35·LEAVE_W7, κ = 3.8·√r with the ×0.7 early and ×2 late rules. It also has the sims-only, broke-rival and B = 1 rules, duel spite, the FirstPrice 20% quantile, the hold/liquidity/dump policy.
- **`clone:lambi`** (§4.7): Karthik's class fits with ×0.6 for useless letters, the exact word triggers, and a heads-up drain floor with denial.
- **`clone:k13`** (palace-simplified, §4.8):
  - Monte Carlo letter value with common random numbers over the unseen pool.
  - λ found by bisection on expected spend against balance plus income share.
  - Rival models: exact for sims, generic N(8+2.5·face, 3) otherwise, with PIT calibration.
  - Selfish argmax bid, then placement-weighted price-driving capped at +4.
  - Play-vs-hold with a 0.32λ coin bonus.
  - Final-tile denial of sims.
- **`clone:blackswan`**: the floor bidder (0.95 × market × phase multiplier, a 40-coin reserve, ×1.6 in the last 7 auctions).
- **Karthik components:** the FieldBot presets `clone:field{Shark,Volume,Grinder,Spender,Nibbler}` and the fitted families `clone:{ramp,flat,hunter}`.
- **`common.ts`:** the `Turn` helper, bounded `partition()`, a memoized best word, the NOW / ALLREAL / FIELD market tables, phase multipliers, sim-max helpers and `clampBid`.

### Task 2: data-fitted clones, profile clone and calibration
- **`clone:lucent`, `clone:bron`, `clone:maverick`** (§4.9):
  - bid = κ·exp(fit + sd·z), using the §2.4 coefficients;
  - bid 0 at B = 0, and penFrac·balance at B = 1 on a useful letter;
  - mid-match words 7+ (maverick also cashes some 5-6 letter words with altProb 0.05);
  - dump timing per bot (LUCENT and maverick in the last 3 auctions, Bron at B = 0);
  - Bron's 30-coin J/X/Q/Z cap;
  - a pacing cap.
- **`clone:k13` vs `profile:K-13`:** both exist. The first is the code-based clone, the second the data-driven one.
- **`profile:<BotName>`:**
  - Bids are inverse-CDF draws from the bot's KM survival curve for (letter group, phase), times a rack-need factor in [0.78, 1.44]. Sparse curves fall back to the all-phases curve.
  - At the penultimate auction it goes all-in when the bot does so on most of its wins.
  - Its word policy comes from the profile's lenDist and timing.
  - It works for all 93 profiled bots (test plays every one).
- **`scripts/zoo-calibrate.ts`** runs a coordinate-wise bisection of log κ on tiles/match: 3 passes × 3 clones × 7 steps × 200 matches, on common seeds. `--write` stores the constants, then a held-out 500-match table is printed (seed 1001).

### Task 3: trick zoo and lineups
- **Trick bots (`trick:<name>`):**
  - `allin`: 1.5-2 × ALLREAL on face ≤ 2 letters, never plays words.
  - `shadow`: bids 0.85 × the leader's estimated value (RivalBidModel); never wants letters.
  - `late`: bids 0, then dominates the last 15 auctions.
  - `jitter`: truthful ±30%.
  - `sniper`: bids simMax + 1 when only sims can compete, otherwise ≤ face + 1.
  - `bottomFeeder`: the greedy baseline with bid 1.
  - `endgameDumper`: thrifty, then spreads its balance over the last 10 auctions.
  - `oracleDenier`: uses `onOracle` true racks to deny 7+ completions to the leader, with bids of at least 20.
  - `spite`: bids just under the opponent's predicted bid on letters it does not need.
  - `hoarder`, `random`: wrappers of the baselines.
- **`src/bots/lineups.ts`:**
  - the 9 plan lineups (`BENCH_LINEUPS`): lobbyNow, lobbySims, fullTable, bigTable (7 seats), headsUpK13 (88 auctions), tricks, oracle (seated as `oracle:trick:oracleDenier`), firstPrice (spec FirstPrice), starterFlood;
  - 6 coverage lineups, so every zoo policy is exercised;
  - `resolveLineup(lineup, focal)`.
- **`scripts/zoo-sanity.ts`** runs every lineup with a focal policy and prints the sanity and per-policy tables. It exits 1 on any exception, rejected word or bid, or a p99 of 50 ms or more.

## Measured numbers

### Calibration (`npx tsx scripts/zoo-calibrate.ts --matches 500 --write`, then re-run with `--no-tune`: byte-identical tables)
Tuned constants:
- LUCENT κ = 0.7034, penFrac 0.82
- Bron κ = 0.8728, penFrac 0.68
- maverick κ = 0.6201, penFrac 0.99, altProb 0.05

The table comes from 500 held-out matches in the NOW table mix. Tuning took 93.2 s on 8 workers; the validation alone took 0.95 s.

| clone | metric | target (NOW) | achieved | error | within ±15% |
|---|---|---|---|---|---|
| LUCENT | tiles/match | 25.6 | 26.19 | +2.3% | yes |
| LUCENT | paid/tile | 9.3 | 7.91 | -14.9% | yes |
| LUCENT | end balance | 27.5 | 39.23 | +42.6% | **no** |
| LUCENT | words/match | 4.69 | 5.01 | +6.9% | yes |
| Bron | tiles/match | 26.4 | 25.52 | -3.3% | yes |
| Bron | paid/tile | 7.53 | 7.72 | +2.6% | yes |
| Bron | end balance | 58.9 | 48.69 | -17.3% | **no** |
| Bron | words/match | 4.83 | 4.71 | -2.4% | yes |
| maverick | tiles/match | 19.7 | 20.20 | +2.5% | yes |
| maverick | paid/tile | 10.32 | 8.77 | -15.0% | **no** (by 0.02 pp) |
| maverick | end balance | 24.8 | 27.36 | +10.3% | yes |
| maverick | words/match | 4.0 | 4.50 | +12.6% | yes |

These metrics are informational only (not tuned):

| clone | score (target) | first-word round (target) | balance at r20 / r45 / r56 (target) |
|---|---|---|---|
| LUCENT | 146.5 (165.5) | 10.1 (17.5) | 76.6 / 45.6 / 31.7 (66 / 50 / 44) |
| Bron | 145.8 (157.8) | 19.0 (13.8) | 85.9 / 60.1 / 42.2 (88 / 71 / 62) |
| maverick | 104.5 (128.1) | 20.2 (17.8) | 87.0 / 57.8 / 34.3 (85 / 62 / 40) |

Head-to-head (higher score in shared matches) against history (NOW: 324-160, 320-149, 282-78):

| pair | sim | history |
|---|---|---|
| LUCENT > Bron | 59.4% (n = 409) | 66.9% |
| Bron > maverick | 75.3% (n = 395) | 68.2% |
| LUCENT > maverick | 81.7% (n = 304) | 78.3% |

The finishing order matches history. The plan quoted "LUCENT > Bron 61%"; the raw counts give 66.9%.

### Zoo sanity (`npx tsx scripts/zoo-sanity.ts --matches 200`; focal `starter`, seed 1, 4 workers, wall 110.9 s)

| lineup | seats | matches | exceptions | starter avg score | starter avg rank | rejected w/b | slowest zoo seat: decide p99 / max ms |
|---|---|---|---|---|---|---|---|
| lobbyNow | 6 | 200 | 0 | 8.9 | 4.83 | 0/0 | clone:bron 0.09 / 30.9 |
| lobbySims | 6 | 200 | 0 | 16.6 | 3.64 | 0/0 | - |
| fullTable | 6 | 200 | 0 | 8.8 | 6.00 | 0/0 | clone:lala 20.92 / 50.8 |
| bigTable | 7 | 200 | 0 | 9.0 | 6.99 | 0/0 | clone:lala 18.88 / 74.0 |
| headsUpK13 | 2 | 200 | 0 | 12.9 | 2.00 | 0/0 | clone:k13 20.80 / 63.2 |
| tricks | 6 | 200 | 0 | 14.2 | 3.53 | 0/0 | trick:shadow 0.35 / 16.0 |
| oracle | 6 | 200 | 0 | 8.7 | 6.00 | 0/0 | clone:lala 20.76 / 97.3 |
| firstPrice | 6 | 200 | 0 | 8.9 | 6.00 | 0/0 | clone:lala 23.56 / 85.0 |
| starterFlood | 6 | 200 | 0 | 30.9 | 3.33 (22.0% wins) | 0/0 | - |
| tricksLate | 6 | 200 | 0 | 8.7 | 4.99 | 0/0 | trick:jitter 1.61 / 17.0 |
| tricksMixed | 6 | 200 | 0 | 9.6 | 4.79 | 0/0 | trick:spite 3.13 / 26.4 |
| spiteHeadsUp | 2 | 200 | 0 | 40.0 | 2.00 | 0/0 | trick:spite 2.65 / 24.9 |
| community | 6 | 200 | 0 | 8.9 | 6.00 | 0/0 | clone:blackswan 4.29 / 26.0 |
| fieldFamilies | 6 | 200 | 0 | 9.5 | 6.00 | 0/0 | clone:fieldSpender 0.13 / 16.9 |
| profiles | 6 | 200 | 0 | 9.0 | 6.00 | 0/0 | profile:Bron 0.13 / 10.4 |

Totals: `exceptions=0 rejected=0 zoo policies=35 p99>=50ms: none`.

Per policy (worst lineup):

| policy | seat-matches | avg score | win% | decide p50 / p99 / max ms |
|---|---|---|---|---|
| clone:k13 | 1000 | 149.3 | 23.0 | 1.99 / 20.80 / 66.7 |
| clone:lala | 800 | 95.3 | 27.3 | 0.98 / 23.56 / 97.3 |
| clone:lionel | 800 | 91.0 | 22.6 | 0.64 / 16.69 / 78.7 |
| clone:nijello | 800 | 99.8 | 44.5 | 0.07 / 1.06 / 25.3 |
| clone:sookra | 200 | 52.0 | 1.0 | 0.03 / 0.25 / 12.7 |
| clone:lambi | 200 | 67.6 | 2.5 | 0.002 / 0.10 / 4.3 |
| clone:blackswan | 200 | 133.1 | 86.5 | 0.23 / 4.29 / 26.0 |
| clone:lucent / bron / maverick | 400 / 200 / 200 | 128.6 / 121.2 / 91.7 | 46.0 / 36.0 / 7.5 | p99 0.07 / 0.09 / 0.05 |
| clone:field* (5), ramp / flat / hunter | 200 each | 45-70 | 0.5-34.5 | p99 ≤ 0.13 |
| profile:* (6 bots) | 1600 | 60-87 | 3.3-30.5 | p99 ≤ 0.20 |
| oracle:trick:oracleDenier | 200 | 78.6 | 8.5 | 0.20 / 3.08 / 27.7 |
| trick:shadow / spite / jitter / sniper | 200-400 | 105.4 / 265.5 / 332.7 / 9.8 | 99.0 / 79.0 / 100 / 0 | p99 0.35 / 3.13 / 1.61 / 0.96 |
| trick:allin / bottomFeeder / late / endgameDumper / hoarder / random | 200 each | 0.0 / 9.7 / 27.6 / 27.7 / 94.3 / 16.0 | 0-6.5 | p99 ≤ 0.35 |

**Timing caveats.**
- Other worktree agents ran on the same machine during these measurements, so timings are noisy.
- With 8 workers, the same lineups gave K-13 heads-up p99 48.2 ms; with 4 workers they gave 23.3 ms.
- Single-thread p99 for K-13 is 17.7 ms heads-up and 6.3 ms at 7 seats.
- Maxima of 50-100 ms are rare cold-cache or GC outliers. They stay below the 250 ms decision budget.

### Tests and typecheck
- `npx vitest run`: 30 files, **359 tests pass** in 17.2 s. This plan adds 3 files and 37 tests (clones 13, clones-calibration 9, tricks 15).
- `npx tsc --noEmit`: clean.
- `git diff dafa4e9 -- src/bots/baselines`: empty, so the baselines are unchanged.

## Task Commits

1. **Task 1 (community clones):** `b502797` feat(03-02): community-bot clones from COMPETITORS specs
2. **Task 2 (data-fitted, profile and calibration):** `4bcfbc0` feat(03-02): data-fitted LUCENT/Bron/maverick clones, profile:<Bot> clone, calibration
3. **Performance guards:** `acbab68` perf(03-02): bound clone decide() cost on big racks; `d1f94d3` perf(03-02): K-13 clone λ table from one sampled future per rack
4. **Task 3 (tricks, lineups, sanity):** `e1ecf1c` feat(03-02): trick zoo, named lineups and zoo sanity run

## Deviations from Plan

1. **[Rule 3 - blocking] `src/bots/registry.ts` edited.** It is outside this plan's files_modified. The 02-01 grammar split every spec at its first ':', so `clone:lucent` was parsed as policy `clone` with invalid JSON params, and the plan's lineup names could not resolve. The fix is minimal and backward-compatible:
   - params start at the first `:` followed by `{`;
   - `<prefix>:*` wildcard families (for `profile:<Bot>`);
   - `listFamilies()`.

   The existing registry tests pass unchanged.
2. **[Rule 1] Calibration table mix.** The plan said "3-real + 3-sim tables". There the targets are infeasible (71.7 tiles of 68), and the first tuning run pushed LUCENT and Bron κ to the 3.0 bound. The harness now reproduces the NOW composition the targets were measured on (calibration.ts `NOW_TABLES`). The published counts are inconsistent by one match, so the mix has 599 matches.
3. **[Rule 1] Pacing cap on the fitted clones** (bid ≤ 14·balance/(B+1)). It is not in §4.9. Without it, tiles/match is non-monotone in κ and bisection diverges.
4. **Only κ is bisected.** The B == 1 fraction carries no signal (< 1 coin of end balance across 0.32-0.98), so it stays at the spec's measured values. A rack-need knob (needW) was tried and is off; see key-decisions.
5. **Calibration gaps (documented):**
   - LUCENT end balance is +42.6% and Bron's is -17.3%. End balance = 100 − spend + score, and the fitted bidders score 7-12% below their targets: they bid on fitted prices, not on rack need.
   - maverick paid/tile is -15.0%, i.e. 0.02 pp outside tolerance.
6. **[Rule 2] Compute guards beyond the specs** (needed for p99 < 50 ms):
   - K-13: kCap 6, sampled racks ≤ 16 tiles, quick samples 6, a one-sample λ table cached per rack, and a hoard valve at ≥ 16 tiles. Heads-up against a weak rival its play rule never fires, and the rack grew past 40 tiles (p99 187 ms → 17.7 ms single-thread).
   - Lala: 5 pair letters and 5 word candidates.
   - Lionel: pairs drawn from the 8 most likely letters.
   - Shadow: dumps its accidental hoard at 12 tiles.
   - `partition()`: falls back to the fast packer above 24 tiles.
7. **zoo-sanity runs on 4 workers by default.** The timing caveats are above.
8. **Extra lineups.** Six coverage lineups were added so that "every zoo policy runs 200 matches" holds literally. The 9 plan lineups are exported separately as `BENCH_LINEUPS`.
9. **`clone:lambi` bid.** Per the spec, it uses Karthik's winning-bid fits with κ = 1. It was not calibrated (it is not one of the plan's three data-fitted clones).
10. **Worktree branch name.** The branch is `worktree-wf_7786279d-440-3`, not `worktree-agent-*`. Commits went ahead under the orchestrator's own check (the branch is not main/master/gsd/phase-*).

## Known Stubs

None. Every registered policy is complete; approximations are documented in each file's header.

## Threat Flags

None. `onOracle` stays SIMULATOR-ONLY: only `trick:oracleDenier` implements it, and only an `oracle:` seat receives racks. The zoo adds no network, auth or file-write surface. `profile.ts` only reads the committed `data/profiles.json`.

## Issues / Follow-ups

- **Clone strength vs reality.** The fitted clones score below their live counterparts. In particular, `clone:k13` is a middling bot in our tables (average rank 3.37 and 23.0% wins over its 5 lineups, heads-up included), while the real K-13 won tournament #1. Phase 4 should treat `fullTable` as a lower bound on tournament strength and keep the profile and code clones side by side.
- **Trick-heavy lineups are soft.** `trick:jitter` (332.7, 100% wins in tricksLate) and `trick:spite` (265.5 heads-up vs starter) dominate weak lineups. The coverage lineups test robustness, not strength.
- **Bisection noise.** With 200 matches per step, κ is resolved to about ±2%. The calibration is deterministic: same seeds give byte-identical tables.

## Self-Check: PASSED

- All 32 created files exist, and the 3 modified files are committed (`git diff --stat dafa4e9`: 35 files, +4284/−10).
- Commits b502797, 4bcfbc0, acbab68, d1f94d3 and e1ecf1c are present on `worktree-wf_7786279d-440-3`.
