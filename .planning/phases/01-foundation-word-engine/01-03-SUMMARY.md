---
phase: 01-foundation-word-engine
plan: 03
subsystem: state
tags: [tracker, match-view, events, replay, property-test]
requires: [01-01 src/core (types, rack, letters, rng)]
provides: [src/state/tracker.ts MatchTracker, src/state/events.ts MatchEvent/applyEvent/replay/MatchRecorder, src/state/view.ts helpers]
affects: [src/sim (feeds tracker), src/client (adapter rows -> events), src/bots/* (read MatchView)]
tech-stack:
  added: []
  patterns: [incrementally maintained view object, signed Int16Array backing + clamped public Rack, auctionId dedup, plain-comparison oracle in property tests]
key-files:
  created: [src/state/tracker.ts, src/state/view.ts, src/state/events.ts, src/state/index.ts, test/state/basic.test.ts, test/state/tracker.test.ts]
  modified: []
key-decisions:
  - "auctionOpen/auctionResult are deduplicated by auctionId (re-open updates current; duplicate results ignored; result without open still marks the letter seen), so live re-deliveries and history rebuilds are safe"
  - "My own revealedHidden/knownHeld use the same public inference as opponents (what the table can deduce about me); my exact holdings are me.rack"
  - "Unknown player ids and unspellable own words throw before any mutation; all other inconsistencies are clamped and counted in diagnostics"
requirements-completed: [STATE-01, STATE-02]
duration: 12min
completed: 2026-11-07
---

# Phase 1 Plan 03: Match-state tracker Summary

**MatchTracker turns the public event stream into an O(1) incrementally maintained MatchView. It also has a JSON event log that replays to an identical view. 300 seeded random matches were checked against ground-truth racks after every event.**

## Accomplishments
- `MatchTracker(config, myStartRack)`: `auctionOpen`, `auctionResult`, `wordPlay`, `setBalance`, `setMyRack`, `view` (same live object, O(1)), `snapshot()` (deep copy), `bagRemaining`, `auctionsRemaining`, `player(id)`, `diagnostics {balanceMismatches, rackMismatches, hiddenOverflow, unseenNegative}`.
- Hidden-tile attribution: excess = need − knownHeld goes to `revealedHidden`. Total revealed is capped at `startingRackSize`; overflow is counted and clamped. `knownHeld = won + revealedHidden − played` and is never negative.
- `unseen` uses a signed backing array plus a clamped public Rack. Negative counts are counted, never exposed.
- `bagRemaining`: `current ? current.remainingAfter : totalAuctions − auctionsDone`. This is documented on both the tracker and `view.ts`.
- `view.ts`: `leader` (ties resolve by config order), `scoreGapToLeader`, `maxOpponentBalance`, `opponentById`, `isLastAuction`, `rackSizeOf`, `bagRemaining`, `opponentsHiddenUnknown`, `unseenBalance` (invariant check usable in live diagnostics). It re-exports `MatchView`/`PlayerState`/`MyState`.
- `events.ts`: the `MatchEvent` union (racks stored as sorted strings), `startEvent`, `trackerFromStart`, `applyEvent`, `replay` (the first event must be `start`), and `MatchRecorder` (applies and records events, giving a JSON trace).

## Verification / measured numbers
- `npx vitest run`: 3 files, 29 tests, all pass. `npx tsc --noEmit`: clean.
- Scripted 3-player match (83 auctions):
  - Covers wins by all three players, an unbid Z, and Vickrey payments.
  - Opponent A plays ROT (2 hidden tiles); opponent B plays GLEN (2 hidden tiles); I play CHASTE (reward 27).
  - Covers the final auction (remainingAfter 0) and resyncs with true values (0 mismatches).
  - The invariant and `rack == start + won − played` are asserted after every one of the 171 events.
  - End state: unseen is exactly `DIOQUY`, the opponents' unrevealed starting tiles.
- Property test: 300 seeded random matches, with 2–6 players, rack size 0–12, both auction types, random words from true racks, unbid auctions and random resyncs. More than 10k events are each checked against ground truth:
  - exact unseen multiset (undrawn bag + Σ_opp (start − revealed))
  - balances, scores, won and played
  - knownHeld ⊆ true rack; revealed ⊆ true start
  - rack total = knownHeld + hiddenUnknown
  - all diagnostics 0
  
  Runtime is about 0.73 s.
- Replay determinism: 100 random traces plus the scripted trace replay identically, both in memory and after `JSON.parse(JSON.stringify())`. Generating the same seed twice gives a byte-identical trace.
- Mutation check: three hand-injected tracker bugs were each caught by the suite:
  - attributing against `won` instead of `knownHeld`
  - my own reveals reducing unseen
  - ignoring single-tile reveals
- Throughput (tsx, Apple Silicon): replaying a full 6-player match trace (166 events) takes **11.7 µs**, about **14.2M events/s**. `snapshot()` at match end takes **4.2 µs**. Word plays use a reused scratch counts array and allocate no Rack.

## Deviations from Plan
- [Rule 2 - Robustness] Added auctionId dedup for opens and results, plus "result without open" handling. These were not in the plan, but the live client and history rebuild need them; without them a re-delivered row would double-count.
- [Additive] Added `startEvent`, `trackerFromStart`, `MatchRecorder`, `rackSizeOf`, `bagRemaining(view)`, `opponentsHiddenUnknown` and `unseenBalance` beyond the listed helpers.
- Task 1 tests live in `test/state/basic.test.ts`. Task 2's scripted, replay and property tests live in `test/state/tracker.test.ts`, as the plan specifies.

## Known Stubs
None.

## Issues / notes for consumers
- `bagRemaining` while an auction is open trusts `current.remainingAfter`. If the live server's `bag_total` ever disagrees with `totalAuctions − index − 1`, the invariant check (`unseenBalance`) will show it, but no diagnostic counter tracks it.
- `wordPlay` has no event id, so a re-delivered word_play row would double-apply. The live adapter must deduplicate word_play rows by row id before calling the tracker.
- `config.totalAuctions` is trusted as given and is not recomputed from players × rack size.

## Self-Check: PASSED
- Files exist: src/state/{tracker,view,events,index}.ts, test/state/{basic,tracker}.test.ts
- Commits: d6d81ad (Task 1), a12b997 (Task 2)
