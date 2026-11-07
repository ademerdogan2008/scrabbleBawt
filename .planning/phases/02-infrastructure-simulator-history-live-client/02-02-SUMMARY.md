---
phase: 02-infrastructure-simulator-history-live-client
plan: 02
subsystem: history
tags: [history, fetch, ndjson, validation, kaplan-meier, profiles, replay, benchmark]
requires: [01-02 src/engine (dictionary, findBestPlayable), 01-03 src/state (MatchTracker), src/core (letters, simbots, rng, types)]
provides:
  - src/history/fetch.ts + sql.ts (allow-listed read-only HTTP SQL downloader, schema-driven decoder)
  - src/history/load.ts (streaming loader, shared word-attribution rule, canonical schedule, subset extractor)
  - src/history/validate.ts (23 historical E2E checks)
  - src/history/km.ts, profiles.ts (reverse-KM bid curves, data/profiles.json schema v1)
  - src/history/replay.ts, mimic.ts, stats.ts (counterfactual replay benchmark, Wilson CIs)
  - data/history-sample/*.ndjson.gz (297 matches, 0.47 MB), data/profiles.json (93 bots, 1.85 MB)
affects: [02-01 runMatch (same word attribution rule), 02-03 live adapter (same rule), 03-01 Bawt priors, 03-02 clone bots]
tech-stack:
  added: []
  patterns: [gz-transparent NDJSON streaming with per-match grouping, filter-before-stream loading, injected fetch for network-free tests, histogram KM accumulator, field-model counterfactual replay]
key-files:
  created: [src/history/types.ts, src/history/sql.ts, src/history/fetch.ts, src/history/load.ts, src/history/validate.ts, src/history/km.ts, src/history/profiles.ts, src/history/stats.ts, src/history/replay.ts, src/history/mimic.ts, scripts/history-fetch.ts, scripts/history-validate.ts, scripts/history-sample.ts, scripts/history-profiles.ts, scripts/history-replay.ts, data/history-sample/*.ndjson.gz, data/profiles.json, test/history/fetch.test.ts, test/history/load.test.ts, test/history/validate.test.ts, test/history/profiles.test.ts, test/history/replay.test.ts, test/history/fixtures/api/*.json, test/history/fixtures/mini/*.ndjson.gz]
  modified: [.gitignore]
key-decisions:
  - "Word attribution (shared with 02-01 runMatch and the 02-03 adapter): auctionIndex = #auctions with closedAtUs < playedAtUs; inClose = some close has the same timestamp; canonical order open(k) -> !inClose words -> result(k) -> inClose words"
  - "KM risk set is tie-aware (tieWeight 0.5 = server coin-flip ties); textbook KM biased P(bid>=x) low by 0.02-0.05"
  - "Replay field model: winner != target -> top bid, winner == target -> paid, no winner -> 0; a loss on a target-won auction is fed as winnerId null (unattributed)"
  - "history-fetch --range A:B is inclusive (1:3 = 3 matches); FetchPlan.range stays half-open"
  - "Bot status/auction-type values are the schema's lowercase variant names ('ended', 'vickrey'); load.ts normalizes auction type to 'Vickrey' | 'FirstPrice'"
requirements-completed: [HIST-01, HIST-02, HIST-03, HIST-04]
duration: 82min
completed: 2026-11-07
---

# Phase 2 Plan 02: History infrastructure Summary

**The 25.6k-match live history is now tested infrastructure. A resumable read-only fetcher downloads it and a streaming loader groups it per match. Our engine and tracker reproduce all of it with 0 mismatches. 93 opponent profiles (reverse Kaplan-Meier bid curves) are committed, and a replay benchmark puts any policy in a historical bot's seat. Its mimic check reproduces Bron, LUCENT and Waupus exactly.**

## Accomplishments
- **Fetch** (`src/history/fetch.ts`, `sql.ts`, `scripts/history-fetch.ts`). TypeScript port of the research fetcher, no new dependencies.
  - Mints the identity token via `POST /v1/identity` and keeps it in `.cache/history-ident.json` (git-ignored, mode 0600). Only the token length is logged, and bearer credentials are redacted from error text before it is truncated.
  - Tables are checked against an allow-list of public base tables. `visible_auction_top_bids`, the other views and the private tables are refused before any network call.
  - Queries are built only from allow-listed identifiers and integers, and only `SELECT` statements are sent.
  - Chunks by match-id range. Progress files make it resumable and truncate any partial tail on resume. Supports `--tables`, `--all`, `--range A:B` (inclusive), `--recent N` and `--out` (default `data/history/`, now git-ignored).
- **Load** (`src/history/load.ts`, `types.ts`).
  - Streams plain or `.gz` NDJSON. `loadMatches(dir, {filter, skipWords})` applies the filter to match headers before the big tables are streamed.
  - Each record holds the participants in roster order, the auctions (index, top bid, close time), the words (auctionIndex, inClose), the tournament phase as kind, nReal/nSim and the `complete` flag.
  - The shared word-attribution rule and the canonical event order are documented in the file header.
  - Deleted bot rows load as `{name: "#<id>", isSim: false, missing: true}`.
  - Helpers: `canonicalSchedule`, `auctionInfo`, `matchConfig`, `revealStartTiles` (proven start tiles, in chronological order), `currentVersion(Start)`, `rankOf`, `resolveBot`, `extractSubset` (deterministic gz subset writer).
- **Validation** (`src/history/validate.ts`, `scripts/history-validate.ts`). 23 checks, each returning `{checked, mismatches, examples}`, over complete matches only:
  - **Words:** reward, base, bonus, dictionary membership, length, word played by a participant.
  - **Match totals:** score sums, the balance identity, auctions == 98 − rack·P == current_round with bag_total 0, close order, bag limits (auctioned + proven start tiles), Vickrey only, start-rack overdraw.
  - **Auctions:** top ≥ paid, winner/no-winner shape, winner balance ≥ paid.
  - **Sims:** win and loss bid ranges, words only after the sim's own win (≤ 1 per win, length ≥ 3), and `findBestPlayable(rack, 3)` equality whenever the rack is reconstructible. Coverage is reported.
  - **Real bots:** no word at or after the final close.
  - **Tracker:** one MatchTracker per seat, checking for no throw, zero opponent diagnostics, final balance/score resync with 0 mismatches, and the relaxed unseen invariant at every open.
- **Sample** (`scripts/history-sample.ts`, `data/history-sample/`). 297 matches, 0.47 MB, deterministic (byte-identical rebuild):
  - 120 recent lobby matches with Bron, LUCENT and maverick-bot
  - 120 six-real matches from Oct 24-30 (30 each with Waupus, K-13, Lionel and Nijello)
  - all 51 tournament matches
  - 5 all-sim matches
  - 1 incomplete match
  - deleted-bot matches arrived naturally in this selection
- **Profiles** (`src/history/km.ts`, `profiles.ts`, `scripts/history-profiles.ts`, `data/profiles.json` schema v1, 1.85 MB). Each of the 93 bot profiles contains:
  - reverse-KM curves P(bid ≥ x) for x = 1..60, by 8 letter groups × 5 disjoint phases, plus all phases pooled
  - OLS bid model (nRealOpp is dropped when it is collinear)
  - per-letter point-mass caps
  - penultimate all-in rate, and final-auction win rate plus KM P(bid ≥ 1)
  - buying stats, word length distribution, words per match, timing tenths and last-word timing, unplayed tiles, final balance
  - win rate, average score and average rank split by number of real opponents

  The file also holds market priors: per-letter price quantiles by phase (all/recent) and by number of real bots, and 68-auction index curves (all/recent/real6). Deterministic, with `generatedFrom` metadata (id range, date range, recent window). `checkProfiles()` validates the schema.
- **Replay** (`src/history/replay.ts`, `mimic.ts`, `stats.ts`, `scripts/history-replay.ts`).
  - Replacement mode uses the exact field model and the attribution rules from the plan.
  - Ties are resolved by `coin` (seeded) or `historical`.
  - Non-Vickrey, incomplete and target-absent matches are skipped and counted.
  - Counted per match: rejected words and bids, policy exceptions (treated as no words, bid 0), unattributed losses and tracker diagnostics.
  - Conservative ranks against the other bots' historical scores, and Wilson CIs.
  - The CLI resolves `mimic` built-in. Any other name goes through a dynamic import of `src/bots/registry.js` and exits 2 with "registry not available (02-01 not merged)" when it is absent.

## Verification / measured numbers
- `npx vitest run`: 12 files, **101 tests pass** (47 in test/history), about 10 s. `npx tsc --noEmit`: clean.
- Smoke fetch: `npx tsx scripts/history-fetch.ts --tables match_state --range 1:3 --out .cache/hist-smoke` made 1 request, wrote 3 rows (ids 1-3) in 157 ms, and logged only "token length 371".
- Fetch tests use recorded API fixtures and a mocked fetch, with no network:
  - Option `[0,v]`/`[1,[]]` decoding, enums, `[µs]` timestamps, payload sums and arrays.
  - Resume after a mid-run HTTP 400 plus a garbage tail: 2 of 3 chunks re-fetched, rows 1..7 exact, a third run makes 0 requests.
  - View refusal happens with 0 network calls.
  - The token is absent from all log output through a mint, a 401 re-mint and a 503 error that echoes the Authorization header. The token file has mode 0600.
- **Full-dataset validation** (25,598 matches: 25,597 complete, **1 excluded** as incomplete; 0 non-Vickrey; load 3.6 s + validate 5.8 s):

| check | checked | mismatches |
|---|---|---|
| word.reward / word.base / word.bonus / word.dictionary / word.length / word.player | 402,308 each | 0 |
| score.sum / balance.identity / start.overdraw | 153,572 each | 0 |
| match.auctions / match.closeOrder / match.bag / match.vickrey | 25,597 each | 0 |
| auction.topGePaid / auction.shape | 1,740,646 each | 0 |
| auction.winnerBalance | 1,729,011 | 0 |
| sim.winBid | 65,431 | 0 |
| sim.lossBid | 1,484,765 | 0 |
| sim.wordAfterWin / sim.wordLength | 26,624 each | 0 |
| sim.bestWord (coverage 51,285 / 65,431 sim wins reconstructible) | 51,285 | 0 |
| real.noWordAfterFinal | 375,684 | 0 |
| tracker.seat | 153,572 | 0 |
| **TOTAL** | | **0** |

- **Sample validation:** 297 matches, 296 complete, 1 excluded, 1,766 tracker seats, sim best-word coverage 554/783, every check 0 mismatches and every check exercised. Injected corruptions are caught: reward +1, top < paid, an impossible sim bid, a sim word moved before its win, and a non-dictionary word.
- **Loader:**
  - The full dump (340 MB, 1.74M + 1.74M + 0.4M big-table rows) loads in about 3.4 s with a 285-306 MB heap.
  - On real data, 0 real-bot words share a close timestamp. Every sim word is inClose, except one in the incomplete match.
- **Profiles:** 93 bots (≥ 150 current-version matches, plus the finalists: K-13 has n = 136), built from 25,597 complete matches. Extraction takes 3.6 s.
  - Bron's J/X/Q/Z cap is detected at **30** on all four letters (modal share above 0.25; 5-12% of wins lie above 30 through late escalation).
  - Bron's penultimate all-in rate is 48.7% of its penultimate wins.
  - The sims' curves are exactly 0 above simBid's maximum for every group and phase. Maverick-sim's J cap is 12 (= 8 + 2 + 2).
  - Cross-checks against HISTORICAL.md: Bron 21.97 letters/match at 8.32 average paid and a 39.2% win rate; LUCENT 19.42 at 10.01; Waupus win rate 0.528.
  - KM synthetic recovery: max error < 0.012 with coin-flip ties (tieWeight 0.5) and < 0.01 with always-lost ties (tieWeight 0). Textbook KM was off by more than 0.03.
- **Replay** (full dataset):

| run | n | ours win% [95% CI] | original win% | avg score ours / original | exact score matches |
|---|---|---|---|---|---|
| mimic, Bron, tie-mode historical | 200 | 41.0% [34.4, 47.9] | 41.0% | 134.74 / 134.74 | **200/200** |
| mimic, Bron, tie-mode coin (verify command) | 200 | 22.5% [17.3, 28.8] | 41.0% | 91.46 / 134.74 | 73/200 |
| mimic, LUCENT, recent, historical | 2,000 | 56.9% [54.7, 59.1] | 56.9% | 157.72 / 157.72 | **2000/2000** |
| mimic, Waupus, real6, historical | 242 | 53.3% [47.0, 59.5] | 53.3% | 101.84 / 101.84 | **242/242** |

  - In the historical-tie runs: 0 rejected words, 0 rejected bids, 0 unattributed losses and 0 tracker diagnostics.
  - The coin run loses about half of Bron's 440 ties. That cascades into 277 rejected words (letters missing), 357 rejected bids and 579 unattributed losses. This is the expected behaviour of a fixed-script policy, not a harness error.
  - Replay costs about 1.9 ms per match. Loading Bron's 14,622 matches takes about 3.4 s.
- **Sample replay tests:**
  - mimic in historical tie mode reproduces **all 1,452 real-bot seats** of the sample exactly: score, letters, total paid, 0 rejections, 0 diagnostics.
  - A zero-bid policy never gains a letter, and its unattributed losses equal the target's historical wins.
  - An all-in policy is only credited with letters it won, at price = field (1 when the field is 0) and never above its bid.
  - Non-Vickrey, incomplete and target-absent matches are skipped and counted.
- `grep -rn "visible_auction_top_bids" src/history scripts | grep -v -i "refuse\|deny\|forbid"` finds nothing.
- **`--policy starter` vs Bron (run after the wave-1 merge, registry resolved, full dataset, 200 evenly spaced matches, tie-mode coin, seed 1):**
  `NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/history-replay.ts --policy starter --target Bron --matches 200 --data <dir>`

| run | n | ours win% [95% CI] | original win% | avg rank ours / original | avg score ours / original | delta |
|---|---|---|---|---|---|---|
| starter, Bron, tie-mode coin | 200 | 3.0% [1.4, 6.4] | 41.0% [34.4, 47.9] | 4.375 / 2.250 | 12.91 ± 1.77 / 134.74 ± 9.58 | -121.83 ± 8.73 |

  - Letters/match: 3.38 for starter, 21.70 for Bron. Average price 3.27. Unplayed letters/match 2.69.
  - 0 rejected words, 0 rejected bids, 0 policy errors. 0/200 exact score matches.
  - 3880 unattributed losses. 484 ties, of which 243 were won.
  - Tracker diagnostics: hiddenOverflow 56, unseenNegative 25, in 45 matches. These are expected when opponents replay letters we took.
  - Load took 3.3 s and replay 0.4 s (1.78 ms/match).
  - The starter baseline is far below Bron, so the harness separates a weak policy from a strong one clearly.

## Task Commits
1. Task 1, fetch and load: `aab3518`
2. Task 2, validation suite and sample: `ee25e9a`
3. Task 3, opponent profiles: `86bedbf`
4. Task 4, replay benchmark: `784d1b5`

## Deviations from Plan
- **[Rule 1 - Bug] Token leak via truncation.** A test showed that a 503 error body echoing the Authorization header, truncated at 300 characters before redaction, leaked part of the token. Redaction now runs before truncation, and `Bearer <x>` is scrubbed generically (`fetch.ts`, Task 1).
- **[Rule 1 - Bias] Tie-aware KM risk set.** The textbook reverse KM ported from km.mjs treats a loss censored at a tie as fully at risk, which biased P(bid ≥ x) low by 0.02-0.05 on synthetic data with ties (the server breaks ties at random). A `tieWeight` parameter was added, defaulting to 0.5 for coin-flip ties. Recovery error is now under 0.012 (`km.ts`, Task 3).
- **[Spec reconciliation] `--range A:B` is inclusive.** The verify command `--range 1:3` is expected to write "NDJSON for 3 matches", so the CLI range includes both ends. The internal `FetchPlan.range` stays half-open.
- **[Spec reconciliation] Lowercase variant names.** The server schema delivers status and auction type as lowercase variant names (`"ended"`, `"vickrey"`). Completeness compares the status case-insensitively, and the auction type is normalized to `'Vickrey' | 'FirstPrice'`.
- **[Spec reconciliation] `match.auctions` check.** "auctions == 98 − 5·P" is true by definition for complete matches. The check was strengthened to also compare against match_state.current_round and bag_total == 0.
- **[Spec reconciliation] Cap detector.** Bron's J/X/Q/Z bids are a point mass at 30 with 5-12% of wins above it (late escalation), not a strict maximum. A cap is therefore the modal value ≥ 5 holding ≥ 15% of wins, with ≤ 15% above it and a sharp drop-off right above it (share(c) ≥ 10 × the mean share of c+1..c+3).
- **[Additive]**
  - `validate.ts` has extra checks: word.player, match.closeOrder, start.overdraw, auction.winnerBalance, and sim "no word iff no playable word".
  - `replay.ts` counts `policyErrors`: a throwing policy is treated as no words, bid 0.
  - `history-replay` has `--seed`, `--budget-ms`, `--json` and `--verbose`.
  - `load.ts` gained `extractSubset`, and there is a mini fixture (matches 1, 292 and 42656).
- **[File order]** `src/history/stats.ts` (quantiles, OLS, Wilson) was created in Task 3 because profiles needed quantiles and OLS. Wilson is covered by the Task 4 tests.
- **[Naming]** The sample's bot table is `bot.ndjson.gz` (the table name), not `bots.ndjson`, so the loader needs no special case.
- **[Typecheck]** The dynamic registry import uses a specifier held in a variable rather than a literal `import("../src/bots/registry.js")`. This keeps `tsc` green until 02-01 is merged, and the runtime behaviour is unchanged.

## Known Stubs
None. The starter-vs-Bron benchmark was run after the wave-1 merge (see Replay above).

## Issues / notes for consumers
- After merge, consolidate `src/history/stats.ts` `wilson` with 02-01's `src/sim/stats.ts`.
- In replay, a historical winner W ≠ target keeps its historical `paid`, even when our losing bid would have raised W's Vickrey price. Opponents' balances follow history by design.
- Profile bid models are KM on sealed bids. The low end (bids below ~3-5) and `pNoBid` are weakly identified, so consumers should use the upper tail.
- `penultimate.allInWins` counts top == balance at open **or** right before payment, because real bots can play a word between bidding and the close.
- The full dump needs `NODE_OPTIONS=--max-old-space-size=8192`, which every script header documents. The measured heap was only about 300 MB, so the flag is headroom.

## Self-Check: PASSED
- Files exist: src/history/{types,sql,fetch,load,validate,km,profiles,stats,replay,mimic}.ts; scripts/history-{fetch,validate,sample,profiles,replay}.ts; data/history-sample/ (9 gz files); data/profiles.json; test/history/{fetch,load,validate,profiles,replay}.test.ts
- Commits: aab3518, ee25e9a, 86bedbf, 784d1b5
