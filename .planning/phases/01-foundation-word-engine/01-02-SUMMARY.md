---
phase: 01-foundation-word-engine
plan: 02
subsystem: engine
tags: [dictionary, anagram-trie, packing, branch-and-bound, performance]
requires: [01-01 core (letters, rack, rng), data/wordlist.txt]
provides: [src/engine/dictionary.ts, src/engine/anagram.ts, src/engine/packer.ts, src/engine/index.ts (getEngine), scripts/bench-engine.ts]
affects: [01-03 tracker, simulator (module-exact sim word choice), bots (MC valuation via Packer)]
tech-stack:
  added: []
  patterns: [struct-of-arrays class table, CSR preorder trie, fail-soft alpha memo encoded in one double, counting sort, per-index static tables in WeakMap]
key-files:
  created: [src/engine/dictionary.ts, src/engine/anagram.ts, src/engine/packer.ts, src/engine/index.ts, scripts/bench-engine.ts, test/engine/dictionary.test.ts, test/engine/anagram.test.ts, test/engine/packer.test.ts, test/engine/helpers.ts]
  modified: []
key-decisions:
  - "Anagram classes cover only playable words (A-Z, length >= 2); class id = first appearance in file order, representative = lexicographically smallest member"
  - "packExact pivot 'unused' branch removes ALL copies of the pivot (complete partition, f(R) depends only on R), not one copy"
  - "Upper bound uses per-letter best multiplier among root-fitting classes (dead letters stripped), capped by mult(|R|) for |R| < 7"
  - "Memo entries store exact values with best move or proven upper bounds; shared across calls per minLen; root results cached separately"
  - "packFast = reward-greedy with 16-wide first-word beam (chosen over a budgeted list B&B and a bound-ordered beam after measurement)"
requirements-completed: [ENG-01, ENG-03, ENG-04]
duration: 31min
completed: 2026-11-07
---

# Phase 1 Plan 02: Word engine Summary

**Module-exact dictionary (156,473 anagram classes), 402,716-node typed-array anagram trie with module-exact `findBestPlayable`, and a memoized branch-and-bound word packer. The packer matches brute force on 420 racks. It solves 20-tile racks exactly in 1.7 ms p50.**

## Accomplishments
- `loadDictionary(path|text)`: cached default singleton. `isValid` is a copy of the module's `isValidWord` (ASCII uppercase, UTF-8 byte length >= 2, A-Z only, then lookup). It uses a Set when the file is strictly sorted and falls back to the module's binary search otherwise. Also provides `byLengthDesc` (module `wordsByLength` order, lazy), `classOf`/`classOfKey`, and a SoA `ClassTable` (shared 26-byte count buffer, len/base/reward, sorted keys, per-class word lists in lex order).
- `AnagramIndex`: a preorder trie over the sorted class keys, stored as CSR edge lists. Each node also stores the subtree max length and a child-letter mask. It provides:
  - `collect`, `forEachSubClass` (reentrant) and `subClasses`, which report each class exactly once
  - a pivot-constrained `collect`, used by the packer
  - `findBestPlayable` with exact module semantics (longest word, ties broken by lexicographically smallest word)
  - `bestSingleWord`, plus class accessors
- `Packer`:
  - `packExact`: branch and bound on a canonical pivot, with a fail-soft alpha search. It uses a bounded LRU memo keyed by rack, the `packFast` incumbent and an early stop when the incumbent reaches the bound. `nodeLimit`/`timeLimitMs` return the best complete solution seen, with `exact=false`.
  - `packFast`: a greedy pass ordered by reward, with a beam over the first word.
  - `value()`
  - Results contain valid class-representative words that fit inside the rack together and can be played one after another.
- `getEngine()` builds a shared `{dict, index, packer}` on first use (about 0.35 s).

## Algorithms (as built)
- **Enumeration:** explicit-stack DFS over the trie, decrementing rack counts in place. It skips a child when the subtree max length is below `minLen`, and does not descend when none of the child's edge letters remain in the rack (it still reports a terminal at that node).
- **packExact bound:** at the root, `m2[l]` = 2 × the best length multiplier of any fitting class containing letter `l`. Letters with `m2 = 0` are dead and stripped. `ub(R) = floor(Σ R[l]·VALUE[l]·m2[l] / 2)`, kept up to date as words are applied. For `|R| < 7`, each `m2` is also capped at `2·mult(|R|)`. The bound holds for every sub-rack, so memoized bounds stay valid across calls.
- **Branching:** the pivot is the rack's highest-value letter (ties: the letter in the fewest classes). The branches are "some further word contains the pivot" (one branch per fitting class containing it) and "remove all copies of the pivot". Children are sorted by `reward + ub(rest)` and the loop stops at the first child that cannot beat `max(alpha, best)`.
- **Memo encoding:** `(value*2 + exact) * 2^19 + (move + 2)`, stored in one double. Words are rebuilt by following the stored best moves. If an entry was evicted, it is solved again.
- **packFast:** fitting classes are counting-sorted by reward into contiguous id/mask/length arrays. Each of the 16 highest-reward classes is tried as the first word, then completed greedily (take each class while it fits). A first word is skipped when `reward + ub(rest) <= best`. If an exact result for the rack is already cached, it is returned instead.

## Verification
- `npx vitest run`: 4 files, 35 tests pass (core and engine). `npx tsc --noEmit` is clean.
- isValid matches a binary-search copy of the module's lookup on all 172,820 words, their lowercase and mixed-case forms, words with leading or trailing spaces, all 1- and 2-character ASCII strings, non-ASCII samples and 20,000 random strings.
- Every word belongs to exactly one class. Class stats match `wordReward`/`wordBase`, and representatives are the lex-min members.
- `forEachSubClass` matches a linear-scan oracle on 500 bag racks (1..35 tiles, minLen 2/3); the pivot-constrained collect matches it on 200 racks.
- `findBestPlayable` matches a literal port of the module on 5,000 racks (sizes 0..30, minLen 2/3), plus edge cases.
- `packExact` matches exhaustive brute force on 300 racks (4..11 tiles), and on 120 more racks with minLen 3 and cold 16-entry caches. Warm and cold packers agree on 60 racks of 12..20 tiles. The node- and time-limited paths return valid results that are never below `packFast` (17 of 20 runs aborted, 4 of 20 improved on `packFast`). Results are deterministic.

## Bench (`npx tsx scripts/bench-engine.ts --racks 200`, seed 1, bag-distributed racks, cold Packer per exact call, 300 ms exact limit)
```
dictionary: 172820 words, 156473 classes, 179.8 ms
anagram index: 402716 trie nodes, 139.2 ms; packer tables 30.6 ms
memory delta: heap 110.7 MB, arrayBuffers 30.8 MB, rss 179.5 MB

size | enum p50 / p99 ms (classes avg) | exact p50 / p99 ms, exact-rate @300ms, nodes p50 | fast mean / p99 ms, gap mean / max
  12 | 0.021 / 0.092 (271)   | 0.11 / 0.67,   100.0%, 5    | 0.049 / 0.146, 0.28% / 7.1%
  20 | 0.139 / 0.467 (2437)  | 1.68 / 16.50,  100.0%, 145  | 0.272 / 0.943, 2.47% / 14.3%
  25 | 0.423 / 1.312 (6532)  | 5.47 / 300.94,  99.0%, 615  | 0.784 / 2.287, 5.81% / 15.5%
  30 | 0.799 / 2.031 (12806) | 3.81 / 301.52,  99.0%, 184  | 1.437 / 3.295, 4.63% / 23.9%
  35 | 1.279 / 3.341 (21072) | 9.25 / 303.41,  93.0%, 1019 | 2.334 / 5.503, 4.41% / 17.1%

warm memo, 14 shared + 6 random tiles: packExact mean 1.55 ms, p99 5.42 ms
```
Targets:
- **Enumeration p99 @35 < 5 ms:** met (3.34 ms).
- **packExact p99 @12 < 10 ms:** met (0.67 ms).
- **packExact p99 @20 < 60 ms:** met (16.5 ms).
- **Exact-rate @30 >= 95% within 300 ms:** met (99%; the one miss sets p99 to the limit).
- **packFast mean @20 < 0.3 ms with gap < 3%:** met (0.272 ms, 2.47%).

## Deviations from Plan
1. **[Rule 2 - stronger, still complete] The pivot "unused" branch removes all copies of the pivot, not one.** "No further word uses the pivot" together with "some word contains the pivot" covers every case. Each sub-problem then depends only on the rack, which is what makes the rack-keyed memo correct.
2. **[Rule 3] Added `test/engine/helpers.ts`** (the bag rack sampler shared by the engine tests). The plan's file list only had `*.test.ts`. The bench keeps its own copy so `scripts/` does not import from `test/`.
3. **packFast algorithm chosen by measurement.** At 20 tiles, 400 racks:
   - the plain greedy beam with widths 8/12/16/24 had gaps of 3.61/3.14/2.84/2.42%
   - a budgeted B&B over filtered lists had a 2.42% gap at 0.50 ms
   - a beam ordered by bound (16+8) had a 2.43% gap at 0.44 ms

   Beam-16 is the only setting that meets both targets. `PackerOptions.fastBeam` lets callers trade speed for quality (beam 24 gives a 2.4% gap at about 0.35 ms).
4. **Extra API, added but not requested:**
   - `IntBuffer`
   - `AnagramIndex.collect(rack, minLen, out, pivot)` and `countSubClasses`
   - `Dictionary.classOf`, `classOfKey` and `sorted`
   - `Packer.clearCache`
   - `PackOptions.now`, an injectable clock for tests
   - `asciiUppercase`, `utf8ByteLength`, `binarySearchWords` and `defaultWordlistPath` exports
5. **`findBestPlayable` takes a `Rack` (Uint8Array(26))**, not the module's `Map<letter,count>`. The test converts between them to check equivalence.

## Issues / Follow-ups
- **packExact on 35-tile racks:** 93% exact within 300 ms. The slow cases are vowel-heavy racks such as `AAAAAABCEEEEEFGGHIIIIILNOOOOSTTUWYY`. The per-letter bound counts every vowel at 3×, so the search explores many low-value vowel pivots. I tried two other pivot orders (value×count, and dictionary rarity): neither helped. The next step would be a fractional-packing LP bound (26 rows, column generation over the root classes) or Lagrangian λ tuned at the root.
- **packFast gap grows with rack size:** 4.4–5.8% at 25–35 tiles. Bots that value large racks should use `packExact` with a time limit, or a wider beam.
- `loadDictionary()` with no arguments reads `data/wordlist.txt`, which is file I/O inside `engine/`, as the plan specifies. For pure use, pass the wordlist text instead.

## Self-Check: PASSED
- Files: `src/engine/{dictionary,anagram,packer,index}.ts`, `scripts/bench-engine.ts` and `test/engine/{dictionary,anagram,packer}.test.ts` plus `helpers.ts` all exist.
- Commits: fa48cd4, 49fffb5, 3aed3b2 and bbdd9d7 are all present on branch `worktree-wf_a36e2e4f-d09-1`.
