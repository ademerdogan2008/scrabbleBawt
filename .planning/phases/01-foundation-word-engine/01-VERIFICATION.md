---
phase: 01-foundation-word-engine
verified: 2026-11-07T14:55:00Z
status: passed
score: 3/3 roadmap success criteria verified; 15/15 merged must-haves verified (STATE-02 partly deferred to Phase 2)
overrides_applied: 0
deferred:
  - truth: "STATE-02: Simulator and live client feed the tracker identical event streams"
    addressed_in: "Phase 2"
    evidence: "Phase 2 goal ('rules-exact parallel simulator ... working live client'). The 02-01 must_have says 'every policy seat owns a MatchTracker fed via applyEvent with the same MatchEvent stream format the live client produces'. The 02-03 must_have says 'Every live MatchConfig/MatchTracker event stream is identical in shape to the simulator's (same MatchEvent log format...)'."
---

# Phase 1: Foundation & Word Engine Verification Report

**Phase Goal:** A green TypeScript repo with the exact game-rules core, a fast word engine, and the shared match-state tracker that every later stream builds on.
**Verified:** 2026-11-07, at commit 4dfe78f9f8696434273b40b84a8e5ae7e094b0e1, in a scratch worktree (now removed; the main checkout was not touched).
**Status:** passed
**Re-verification:** No. This is the initial verification.

The SUMMARY claims were not taken as evidence. I ran an independent cross-check harness that imports the official module source directly: `clockworklabs/scrabblebot` @ `b5ccb36`, cloned at `scratchpad/ref/official`. The harness does not reuse the repo's ports or oracles.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: `npm test` passes. Scoring and dictionary match the official module byte-for-byte. | VERIFIED | `vitest run` passes: 7 files, 54 tests, 10.07 s. `tsc --noEmit` exits 0. `cmp data/wordlist.txt official/spacetimedb/wordlist.txt` reports IDENTICAL (sha256 b819e7b6…, 1,743,328 bytes). `wordReward` was checked against the official `letterValue`/`lengthMultiplier` BigInt formula on 192,820 strings (all 172,820 words plus 20k random): 0 mismatches. `dict.isValid` was checked against the official `isValidWord` on 1,276,265 probes (case variants, padding, all 1–2 char ASCII strings, unicode, random): 0 mismatches. |
| 2 | SC2a: enumerating words for 35-tile racks runs at p99 < 5 ms. | VERIFIED | Bench (my run): 35 tiles p50 1.290 ms, p99 3.352 ms. Enumeration results on 40 random 35-tile racks were compared with a linear scan of the official wordlist: 0 mismatches. |
| 3 | SC2b: the exact packer agrees with brute force on small racks and solves 30-tile racks. | VERIFIED | My own memoized brute force on 150 racks of 4–11 tiles gave 0 mismatches. Returned words are valid, disjoint, fit the rack, and their scores sum correctly. With no limits, 60/60 random 30-tile racks were solved exactly (p50 3.79 ms, max 1124 ms). The bench's known-hard 35-tile rack was also solved exactly (162 points, 3.97 s, 828k nodes). Under the bench's 300 ms limit, the exact rate is 99% at 30 tiles. |
| 4 | SC3: `MatchTracker` reproduces opponents' known racks and the unseen pool from a scripted event stream. | VERIFIED | `src/state/tracker.ts` is 336 lines of real code, not a stub. Hidden-tile attribution uses knownHeld (capped), and unseen = BAG − start − auctioned letters − opponents' revealed tiles. Tests pass: the scripted 83-auction match (end unseen = `DIOQUY`) and a 300-seed property test against ground truth (>10k events, exact unseen multiset, knownHeld ⊆ true rack). |
| 5 | 01-01: wordlist is byte-identical, guarded by a test. | VERIFIED | `test/core/core.test.ts:211-212` checks the sha256. |
| 6 | 01-01: `wordReward` equals the module reward. | VERIFIED | Covered by truth 1: all dictionary words, lengths 2–15. |
| 7 | 01-01: Rng is deterministic per seed, and `int` is inclusive. | VERIFIED | `test/core/core.test.ts` passes ("int is inclusive and roughly uniform"). |
| 8 | 01-01: `types.ts` exports the architecture types (Policy, MatchConfig, AuctionInfo, AuctionOutcome, WordPlayEvent, Decision, DecideContext, PolicyFactory). | VERIFIED | Exports are present. Rack is imported from `rack.js` and Rng from `rng.js`. |
| 9 | 01-02: `isValid` agrees with the module on all words plus random non-words. | VERIFIED | Truth 1 (my probe set is larger than the plan's). |
| 10 | 01-02: `findBestPlayable` equals the module's result. | VERIFIED | The official `findBestPlayable` (actual module code, wordlist import swapped for `readFileSync`) was run on 1,500 bag racks of 0–35 tiles, minLen 2 and 3: 0 mismatches. The repo's own test covers 5,000 more racks against its port. |
| 11 | 01-02: `packExact` equals brute force on ≥300 racks. | VERIFIED | The repo test (300 + 120 racks) passes. My independent check of 150 racks also passes. |
| 12 | 01-02: bench numbers are recorded in the SUMMARY. | VERIFIED | My bench rerun matches the SUMMARY table to within noise. For example, at 35 tiles: enum p99 3.352 vs 3.341 claimed; exact rate 93% vs 93%. |
| 13 | 01-03: the unseen invariant holds; my rack = start + won − played. | VERIFIED | `expectInvariant` runs after every event in the scripted and property tests, and both pass. |
| 14 | 01-03: overflow letters are attributed to revealedHidden, capped at startingRackSize. | VERIFIED | `tracker.ts` `wordPlay` has the cap and the hiddenOverflow diagnostic. This is covered by the diagnostics test. |
| 15 | 01-03: a recorded MatchEvent[] trace replays into an identical view. | VERIFIED | `events.ts` has `replay`/`MatchRecorder`. 100 traces replay identically, both in memory and after a JSON round trip. Trace generation is byte-deterministic. |

**Score:** 3/3 roadmap success criteria and 15/15 must-haves verified.

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | STATE-02, end to end: the simulator and the live client actually emit identical streams | Phase 2 | Neither `src/sim` nor a client adapter exists yet. Phase 1 delivered the shared contract: the `MatchEvent` union, `applyEvent`, `replay`, `MatchRecorder`. The 02-01 and 02-03 plan must_haves require both producers to use it. |

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `data/wordlist.txt` | VERIFIED | Byte-identical to the official file. |
| `src/core/{letters,rack,rng,types,simbots,index}.ts` | VERIFIED | Real code; exports present. |
| `src/client/module_bindings/**` | VERIFIED | Generated by spacetimedb cli 2.12.0 (header). |
| `src/engine/dictionary.ts` (254 lines) | VERIFIED | `loadDictionary`, `Dictionary`, module-exact validity check. |
| `src/engine/anagram.ts` (390 lines) | VERIFIED | `AnagramIndex`: 402,716-node trie, 156,473 classes. |
| `src/engine/packer.ts` (737 lines) | VERIFIED | `Packer`, `PackResult`, `PackOptions`. |
| `src/engine/index.ts` | VERIFIED | `getEngine()` builds the shared dictionary, index and packer. |
| `scripts/bench-engine.ts` | VERIFIED | Runs in 19 s and prints the full table. |
| `src/state/{tracker,events,view,index}.ts` | VERIFIED | Real code; exports present. |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `src/core/types.ts` | `rack.ts`, `rng.ts` | type imports | WIRED |
| `packer.ts` | `AnagramIndex` | `this.index.collect(...)` at lines 297 and 412: the same trie enumeration as `forEachSubClass`, plus a pivot variant | WIRED |
| `anagram.ts` | `Dictionary` | constructor uses `dict.classes` | WIRED |
| `tracker.ts` | `core/types.ts` MatchView / PlayerState / MyState | type imports; the view object implements them | WIRED |
| `events.ts` | `MatchTracker` | `applyEvent`/`replay` | WIRED |

### Data-Flow Trace (Level 4)

Not applicable: this phase has no rendering or UI artifacts. The engine's data source is the vendored wordlist, which loads real data (172,820 words).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Test suite | `npx vitest run` | 54/54 pass | PASS |
| Typecheck | `npx tsc --noEmit` | exit 0 | PASS |
| Engine bench | `npx tsx scripts/bench-engine.ts` | at 35 tiles: enum p99 3.352 ms; exact 93% within 300 ms; fast packer mean 2.381 ms | PASS |
| Independent cross-check vs official module | `tsx scratchpad/xcheck/check.ts` | FAILS 0 (scoring, isValid, findBestPlayable, enumeration, brute force, 30-tile exact) | PASS |
| Fast packer speed at typical rack sizes (no cache) | same | mean 0.015 / 0.032 / 0.054 / 0.105 / 0.326 ms at 5 / 10 / 12 / 15 / 20 tiles | PASS |

### Probe Execution

None declared. There is no `scripts/*/tests/probe-*.sh` and no probe reference in the PLAN or SUMMARY files.

### Requirements Coverage

| Req | Source Plan | Status | Evidence |
|-----|-------------|--------|----------|
| ENG-01 | 01-01, 01-02 | SATISFIED | Byte-identical wordlist; `isValid` matches the official `isValidWord` with 0 mismatches. |
| ENG-02 | 01-01 | SATISFIED | 0 mismatches against the official BigInt scoring. |
| ENG-03 | 01-02 | SATISFIED | p99 3.35 ms at 35 tiles; enumeration complete against a linear scan. |
| ENG-04 | 01-02 | SATISFIED | Exact packer matches brute force. All 30-tile racks are solved with no limits. The fast packer is < 0.5 ms mean up to 20 tiles. |
| STATE-01 | 01-03 | SATISFIED | Balances, scores, won and played letters, revealed hidden tiles, known racks and unseen pool are all checked against ground truth. |
| STATE-02 | 01-03 | PARTIAL (deferred) | The shared stream format exists and replays deterministically. Proof that both producers emit identical streams needs Phase 2's simulator and client. |

There are no orphaned requirements: every Phase-1 ID appears in a plan.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (src/core, src/engine, src/state, scripts, test) | – | TBD / FIXME / XXX / TODO / HACK / placeholder | none found | – |
| `package.json` | scripts | `bench` → `src/sim/cli.ts` and `start` → `src/client/main.ts` do not exist yet | Info | Phase-2 entrypoints. `npm run bench` fails until Phase 2 lands; the engine bench is `scripts/bench-engine.ts`. |
| `src/engine/packer.ts` | – | The fast packer's mean exceeds 0.5 ms on 25–35 tile racks (0.81 / 1.43 / 2.38 ms), and its gap to the exact packer grows to 4–6% | Info | ENG-04 says "typical"; game racks are usually ≤ 20 tiles. Monte Carlo code that values big racks should use `packExact` with a time limit or a wider beam, as the SUMMARY notes. |
| `src/engine/packer.ts` | – | `packExact` exact rate at 35 tiles under a 300 ms limit is 93% (vowel-heavy racks) | Info | Not a Phase-1 criterion. A tighter LP bound is the noted follow-up. |
| `src/state/tracker.ts` | `wordPlay` | `WordPlayEvent` has no id, so a re-delivered row would be applied twice | Info | Already handed off: the 02-03 adapter dedupes word_play rows by row id. |

### Human Verification Required

None.

### Gaps Summary

No blocking gaps. All three roadmap success criteria hold in the codebase. I confirmed them against the official module source with an independent harness, not the repo's own oracles.

The only open item is STATE-02. Its end-to-end form, that the simulator and live client emit identical streams, cannot be proven until Phase 2 builds them. Phase 1 delivered the shared contract (`MatchEvent`, `applyEvent`, `replay`), and the 02-01 and 02-03 plan must_haves require both producers to use it. I recorded it as deferred, not as a gap.

Traceability note: the Phase-2 roadmap success criteria do not list STATE-02, so REQUIREMENTS.md should not mark it complete until the 02-01 and 02-03 checks pass.

---

## Verification Complete

**Status:** passed
**Score:** 3/3 roadmap success criteria and 15/15 must-haves verified. STATE-02 end-to-end is deferred to Phase 2.
**Report:** content above. I did not write a file, per the harness note. The intended path is `/Users/adem/Documents/GitHub/scrabbleBawt/.planning/phases/01-foundation-word-engine/01-VERIFICATION.md`.
**Cross-check harness:** `/private/tmp/claude-501/-Users-adem-Documents-GitHub-scrabbleBawt/f0cb5422-db12-4105-b246-d1edf5490e36/scratchpad/xcheck/check.ts`
**Scratch worktree:** `/Users/adem/Documents/GitHub/scrabbleBawt/.claude/verify-p1` has been removed. The main checkout was not modified. Nothing was committed.