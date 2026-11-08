# 04 — Bawt tune vs the calibrated live field (win-first)

Date: 2026-11-07, 18:55–19:45 CST. Main checkout, branch `gsd/phase-03-strategy-zoo`.

## Merge

- `cac4a66` merge: live-only learn cycle (task L, `worktree-wf_deea1e36-22c-1` @ 6c6c6ab)
- `c4336f8` merge: live:<Name> clones and liveField lineups (task F, `worktree-wf_deea1e36-22c-2` @ 52375a1)
- No conflicts. `npx tsc --noEmit` clean, `npx vitest run` 38 files / 456 tests green.
- `bc215b8` pacing-sweep prints the paired win delta with 95% CI and wall time, and adds the `lobbySims` template.

## Method

- `nice npx tsx scripts/pacing-sweep.ts --templates <t> --matches N --workers 6 '<json>'`. This is `comparePaired`: the same seeds and seat rotation for the variant and for plain `bawt` (v1, default arm). `winΔ` is the paired per-match win difference with a 95% t-interval.
- Objective tables: `liveField` (LexiconWarrior, Odysseus's Voyage, RackMaw, cosine, Primey) and `liveFieldB` (peanuts, Lucy, GodOfThudner, aipom, Lbender). Both are `live:<Name>` clones from task F.
- Guard tables: `lobbySims` (must stay >= 98%), `baitSpiteH2H`, `baiterH2H` and `baiterTable` (no significantly fewer wins).
- Search, about 30 minutes of sim in total:
  - Round 1: a coordinate screen of 12 configs at 300 seeds.
  - Round 2: refinement around the best phase pacing, 8 configs at 300 seeds.
  - Guard pass on the top 3.
  - Round 3: the guard failed, so an ablation and guard-fix pass at 200 seeds, with deadline pressure.

## Calibration caveat (read first)

Task F's sanity check fails. Plain `bawt` (v1) wins 37.7% in liveField and 49.0% in liveFieldB in sim. Live Malicious wins 17.6–21%. The clones are today's lobby, but the strong ones are too weak:

- RackMaw, GodOfThudner, Lucy and aipom score 33–40% below their live scores.
- Their Q4 prices are too cheap (sim 8–10, live 11–13).

Absolute sim win rates are about twice the live ones. Treat the deltas as directional only. Last time, variant G gained in sim (lobby 72% to 90%) and lost live (21% to 15%). The big effect found here, early-phase shading, does match the live-data finding: the field pushes early and harvests late, and winners buy cheap in Q4. That makes it more plausible than G was, but it is still unproven live.

## Every tried config

Columns: win% variant vs v1, then winΔ [95% CI] in percentage points. Each row is paired against the same v1 run. v1 is 37.7 / 49.0 at n=300 and 37.0 / 50.0 at n=200.

### Round 1 (n=300, liveField / liveFieldB)

| config | liveField | liveFieldB |
|---|---|---|
| `{"keyEdge":1}` | 35.0 vs 37.7, −2.7 [−6.6, 1.3] | 51.0 vs 49.0, +2.0 [−2.3, 6.3] |
| `{"keyEdge":2}` | 38.7, +1.0 [−3.3, 5.3] | 50.3, +1.3 [−3.5, 6.2] |
| `{"earlyScale":0.8,"endWindow":17,"endKappaLo":1.3}` (live arm `harvest`) | 50.7, +13.0 [7.0, 19.0] | 64.0, +15.0 [8.4, 21.6] |
| `{"earlyScale":0.7,"endWindow":20,"endKappaLo":1.6}` | **56.0, +18.3 [12.4, 24.2]** | **68.0, +19.0 [12.8, 25.2]** |
| `{"earlyScale":0.85,"endWindow":15,"endKappaLo":1.2}` | 47.7, +10.0 [4.2, 15.8] | 60.0, +11.0 [4.5, 17.5] |
| `{"reserve":8,"incomeShare":0.5}` | 35.7, −2.0 [−7.7, 3.7] | 49.0, 0.0 [−5.6, 5.6] |
| `{"kappaLo":0.8}` | 37.3, −0.3 [−1.0, 0.3] | 48.7, −0.3 [−1.5, 0.8] |
| `{"earlyScale":0.8,"endWindow":17,"endKappaLo":1.3,"keyEdge":1}` | 53.7, +16.0 [10.0, 22.0] | 66.3, +17.3 [10.9, 23.7] |
| `{"tableScale":1.15}` | 43.7, +6.0 [0.2, 11.8] | 56.3, +7.3 [1.6, 13.1] |
| `{"tableScale":0.85}` | 32.7, −5.0 [−10.5, 0.5] | 39.7, −9.3 [−15.5, −3.2] |
| `{"floorA":2,"floorB":3}` | 38.3, +0.7 [−2.4, 3.7] | 48.7, −0.3 [−3.5, 2.8] |
| G `{"reserve":5,"incomeShare":0.55,"kappaLo":0.8,"greedMinSeats":3,"baitRatio":0.9,"baitShade":0.85}` | 37.0, −0.7 [−6.1, 4.8] | 45.3, −3.7 [−9.5, 2.2] |

### Round 2 (n=300), around P = `{"earlyScale":0.7,"endWindow":20,"endKappaLo":1.6}`

| config | liveField | liveFieldB |
|---|---|---|
| `{"earlyScale":0.6,"endWindow":25,"endKappaLo":2}` | 49.0, +11.3 [4.8, 17.9] | 66.3, +17.3 [10.7, 24.0] |
| `{"earlyScale":0.65,"endWindow":20,"endKappaLo":1.8}` | 51.7, +14.0 [7.7, 20.3] | 68.0, +19.0 [12.8, 25.2] |
| P + `keyEdge:1` | 55.7, +18.0 [12.1, 23.9] | 66.7, +17.7 [11.4, 23.9] |
| P + `tableScale:1.15` | 54.7, +17.0 [10.5, 23.5] | 66.7, +17.7 [11.2, 24.1] |
| P + `keyEdge:1, tableScale:1.15` | 53.3, +15.7 [9.2, 22.2] | 67.7, +18.7 [12.3, 25.0] |
| `{"earlyScale":0.7,"endWindow":30,"endKappaLo":1.6}` | 56.3, +18.7 [12.4, 24.9] | 64.7, +15.7 [9.5, 21.8] |
| `{"earlyScale":0.6,"endWindow":20,"endKappaLo":1.6,"keyEdge":1,"tableScale":1.15}` | 49.7, +12.0 [5.5, 18.5] | 68.0, +19.0 [12.6, 25.4] |
| P + `earlyUntil:0.6, rampEnd:0.85` (not whitelisted) | 54.7, +17.0 [10.9, 23.1] | 67.3, +18.3 [11.9, 24.8] |

Phase pacing plateaus at earlyScale about 0.7, endWindow 20–30 and endKappaLo 1.6. Lower earlyScale (0.6) hurts liveField. keyEdge, tableScale and a later ramp add nothing beyond noise on top of P. earlyUntil and rampEnd gave no gain, so they were not whitelisted.

### Guards (n=300 for P, then n=200)

| config | lobbySims | baitSpiteH2H | baiterH2H | baiterTable |
|---|---|---|---|---|
| P | 100 vs 100 | 76.3 vs 93.0, **−16.7 [−22.1, −11.3]** | 90.7 vs 85.7, +5.0 [0.5, 9.5] | 26.0 vs 68.3, **−42.3 [−49.3, −35.4]** |
| P + `greedMinSeats:3, baitRatio:0.9, baitShade:0.85` | (= P, sims ungated) | 90.5 vs 92.5, −2.0 [−6.4, 2.4] | – | 28.5 vs 71.5, **−43.0 [−51.3, −34.7]** |

The same config with greedMinSeats 3 and the bait guard on the live fields (n=200): liveField 56.0 vs 37.0, +19.0 [11.6, 26.4]; liveFieldB 69.5 vs 50.0, +19.5 [12.0, 27.0].

### Ablation (n=200): which part of P causes the baiterTable loss

| config | baiterTable | liveField | liveFieldB |
|---|---|---|---|
| `{"endWindow":20,"endKappaLo":1.6,"greedMinSeats":3}` | 70.0 vs 71.5, −1.5 [−5.3, 2.3] | 39.0, +2.0 [−2.6, 6.6] | 54.0, +4.0 [−0.2, 8.2] |
| `{"earlyScale":0.7,"greedMinSeats":3}` | 24.5 vs 71.5, **−47.0 [−55.1, −38.9]** | **57.5, +20.5 [13.2, 27.8]** | **71.0, +21.0 [13.5, 28.5]** |
| `{"earlyScale":0.85,"endWindow":15,"endKappaLo":1.2,"greedMinSeats":3}` | 56.5 vs 71.5, **−15.0 [−23.4, −6.6]** | (300: +10.0) | (300: +11.0) |
| `{"tableScale":1.15,"endWindow":20,"endKappaLo":1.6,"greedMinSeats":3}` | 70.0 vs 71.5, −1.5 [−9.0, 6.0] | 45.0, +8.0 [1.0, 15.0] | 58.0, +8.0 [1.0, 15.0] |
| … same, lobbySims / baitSpiteH2H | 100 vs 100 / 87.5 vs 92.5, −5.0 [−10.2, 0.2] | | |
| `{"tableScale":1.15}` | 69.5 vs 71.5, −2.0 [−9.4, 5.4] | 42.5, +5.5 [−1.8, 12.8] | 56.0, +6.0 [−0.9, 12.9] |
| … same, lobbySims / baitSpiteH2H | 100 vs 100 / 92.0 vs 92.5, −0.5 [−4.6, 3.6] | | |

**earlyScale accounts for all of the live-field gain and all of the baiterTable loss.** In baiterTable, two `trick:baiter` seats push the greediest spender early and then harvest late. That is the same niche Bawt takes when it shades early. Three bidders with spare coins in Q4 means Bawt no longer gets the cheap letters, and the bait detector (`baitRatio` 0.9) does not fire there. endWindow/endKappaLo alone is guard-safe but worth only +2 to +4 (n.s.). greedMinSeats 3 fixes the H2H guards: with fewer than 3 seats, greedy pacing is off and Bawt behaves as v1 except for tableScale and the bait shade.

## Top 3 (all keys in LEARNABLE, all values inside their ranges)

1. **Objective-best, fails the baiterTable guard.**
   - Params: `{"earlyScale":0.7,"endWindow":20,"endKappaLo":1.6,"greedMinSeats":3,"baitRatio":0.9,"baitShade":0.85}`
   - liveField +19.0, liveFieldB +19.5 (n=200). P without the guard knobs scored +18.3 / +19.0 at n=300.
   - lobbySims 100. baitSpiteH2H −2.0 (n.s.). baiterTable −43.
2. **Simplest, the same idea.**
   - Params: `{"earlyScale":0.7,"greedMinSeats":3}`
   - liveField +20.5, liveFieldB +21.0 (n=200). baiterTable −47.
   - In 2-seat tables, greedy pacing is off, so H2H play is identical to v1. With all-sim tables, earlyScale is not applied, so lobbySims is unchanged.
3. **Guard-safe.**
   - Params: `{"tableScale":1.15,"endWindow":20,"endKappaLo":1.6,"greedMinSeats":3}`
   - liveField +8.0 [1.0, 15.0], liveFieldB +8.0 [1.0, 15.0]. lobbySims 100. baiterTable −1.5 (n.s.). baitSpiteH2H −5.0 [−10.2, 0.2], borderline but not significant.

### Recommendation

- The constraint as written (no bait table significantly worse) admits only #3.
- The live field does not seem to contain two coordinated late harvesters: the winners are harvest-late buyers and the rest overpay early. The live data shows Bawt drained early, which is the failure that earlyScale fixes.
- The bandit therefore already tests the right hypothesis. The `harvest` arm (`{"earlyScale":0.8,"endWindow":17,"endKappaLo":1.3}`) is in the pool with 3 plays.
- Best move inside the deadline: add #1 or #2 as a live arm through the learner, using `learn-add-arm` / `updateState`, next to `harvest`. Let the win-first Thompson bandit decide on live wins, since sim deltas are about 2x inflated.
- Keep #3 as the guard-safe fallback.
- Not done here: making earlyScale bait-aware, for example switching it off when 2 or more seats keep coins late. That is the follow-up that could make #1 pass baiterTable.
