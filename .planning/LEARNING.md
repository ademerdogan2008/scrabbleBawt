# Learning journal

Append-only iteration log of the loss-learning cycle (`npx tsx scripts/learn-cycle.ts`, or
`npm run learn` for the watcher). The cycle appends one "Losses diagnosed" block and one "Cycle"
block per run below the line at the end of this header. Do not edit old entries.

## How the bot learns from its losses

The live client plays an arm chosen by Thompson sampling over a small pool of parameter sets
(at most 6 active, `default` always present). After every match it records the result and
updates that arm's discounted Beta posterior (reward = (players - rank) / (players - 1),
gamma = 0.97). This offline cycle adds new arms to the pool. It runs next to the client and never
inside a live decision:

1. **Ingest.** Read `runs/live/match-<id>.jsonl` and the LearnState file (`.cache/learn/state.json`,
   or `LEARN_STATE`). A log counts only after its `match ended` record exists, and a half-written
   last line is skipped. If the client did not record a finished match (learning hook off), the
   cycle backfills it after a 120 s grace period and gives its arm the same bandit update.
2. **Diagnose** each new lost match (strictly beaten: a shared top score is not a loss). Matches
   where we made no decisions are never backfilled (the live learner skips them too). The cycle reports who
   won and how: bingos, letters won and price per letter against ours, unspent money, unplayed
   rack value, near misses on key letters, overpays, and cheap uncontested wins. It maps the
   evidence to hypothesis categories:

   | category | fires when | knob direction |
   |---|---|---|
   | overspent-early | balance <= 10 before half the auctions | kappaHi-, kappaLo-, reserve+, incomeShare-, floorB- |
   | underspent-hoarded-cash | final balance >= 25% of start | kappaHi+, kappaLo+, reserve-, incomeShare+, tableScale+ |
   | lost-key-letters-to-X | >= 3 key-letter (face >= 4) near misses (<= 2 coins), and >= 1.5x our key-letter wins | tableScale+, floorA+, floorB+, lambdaScale-, maxWinShare+ |
   | words-not-cashed | unplayed value >= 8 or >= 4 tiles | tableScale-, maxWinShare-, floorA- |
   | denial-missing | <= 4 real seats; winner took >= 5 letters at <= 3 while we held >= 20 and did not contest | denyScale+ |
   | opponent-mispriced | >= 3 overpays (>= 1.6x the reference price and >= 6), or our price per letter >= 1.3x the winner's | lambdaScale+, tableScale-, kappaLo- |

3. **Candidates.** The incumbent is the eligible arm with the highest posterior mean. The cycle
   proposes 2-4 candidates from it: the combined diagnosed direction (1 step), the primary
   category alone (1 step), the combined direction at 2 steps, and one seeded random perturbation.
   One step is 15% of the knob's range. Every value is clamped to its range in the single
   `LEARNABLE` whitelist (`src/learn/arms.ts`, shared with the live client); `denyScale` stays a
   multiplier on the resolved profile's denyWeights. Some knobs are set by a built-in profile: kappaHi, reserve,
   floorA and floorB. An arm param overrides every profile, so the cycle moves these only when
   the incumbent already sets them. Otherwise their direction goes to a relative knob:
   kappaHi to lambdaScale, reserve to incomeShare, floors to tableScale.
4. **Sim gate (the no-regression rule).** Each candidate is compared with the incumbent on paired
   seeds: same seeds, same seat rotation, same letters. The lineups are `lobbyNow`, `lobbySims`,
   `fullTable`, `tricks` and a **live mirror** built from the opponents met in the last 20 live
   matches. LUCENT, Bron, maverick-bot, K-13, Lionel and other known bots map to their clones.
   Sims map to `sim:<Strategy>`. Profiled bots map to `profile:<Name>`, and anything else maps to
   `clone:fieldVolume`. Defaults: 200 seeds per lineup, 4 workers, 200 ms decision budget (the
   same budget as the bench). Arms are simulated as `bawt-arm:{params}`, which applies them through
   the same `armOverrides` as the live wrapper. The incumbent is simulated once and shared by all candidates. A
   candidate passes when all of these hold (goal since 2026-11-07: wins first, rank as tiebreak):
   - the pooled win-rate delta (candidate - incumbent) is >= +0.5 points, with a 95% CI lower
     bound >= -1 point;
   - the pooled rank delta has a 95% CI upper bound <= 0.10 (placement not clearly worse);
   - no lineup has a significantly lower win rate (per-lineup win-delta CI upper bound >= 0);
   - the live mirror's win rate is not worse;
   - the candidate's lobbySims win rate is >= 98%.

   The live bandit reward is win-first too: 1st = 1, 2nd = 0.35, 3rd = 0.1, worse = 0.
5. **Pool update.** Passing candidates join as `origin: 'cycle'` arms. Each records its parent
   and gate stats and gets a mild prior: alpha = 1 + min(0.5, 2 x the sim rank gain). With more
   than 6 active arms, the arm with the lowest posterior mean is retired. `default` is never
   retired. Analysed matches get `analyzed: true`, so each loss is used once.
6. **Journal.** Every step is written below: hypothesis, candidate params, paired-seed result, and
   accepted or rejected with the reasons.

The live bandit then decides with real results which gated arm plays. A candidate that only looked
good in simulation loses posterior mass and is retired when the pool is full.

Safety: the cycle is offline. It reads logs and writes the state file atomically (tmp file and
rename, read-modify-write with no await in between). It never connects to a server and never runs
inside the client. `--watch` polls every 30 s at nice 19, and a file lock stops two cycles from
running at once. Failures back off exponentially.

```
npx tsx scripts/learn-cycle.ts --once                    # one cycle
npx tsx scripts/learn-cycle.ts --watch                   # npm run learn
npx tsx scripts/learn-cycle.ts --once --fake-loss 900001 --logs /tmp/x/live --state /tmp/x/state.json --journal /tmp/x/L.md
```

### Live-only mode (default since 2026-11-07)

The old simulator's clones no longer match the live field (a sim gain from 72% to 90% became a
live drop from 21% to 15%). So `npm run learn` (`--watch --live-only`, the script default) skips
step 4 and lets the live bandit do the testing (`src/learn/cycle/live.ts`):

- Ingest and diagnose work as above, and the journal heading reads `(live-only)`.
- **Rate limit:** at most one cycle per 3 new finished live matches. The marker file is
  `<state>.live-cycle.json`. The pool never holds more than 2 untested arms (plays < 5). This
  lets each new arm collect real plays before the next one arrives.
- **Parent:** the tested arm (plays >= 5, or `default`) with the highest posterior mean.
- **Candidates** are tried in this order:
  1. keyEdge +1 coin, only when lost-key-letters-to-X fired.
  2. phase ("push early, harvest late"): earlyScale down, endWindow and endKappaLo up, one step.
  3. The standard diagnosed, primary, x2 and random steps.
- Every candidate is clamped by `LEARNABLE`.
- **Dedupe:** a candidate is dropped when its params equal any existing arm's params within
  1e-9. Retired arms count too, and so does the parent.
- **Adding arms:** at most 2 per cycle, as `origin: 'cycle'` with gate stub
  `{lineups: ['live-only'], matches: 1}`, which makes them live-eligible. The prior is Beta(1, 1).
- **Pool cap 6:** when the pool is full, the cycle retires the arm with the lowest posterior mean
  among arms with >= 8 plays. It never retires `default`. If no arm qualifies, nothing is added.
- `--sim-gate` restores the old gated mode.

---

### Losses diagnosed 2026-11-08T00:11:58.376Z

#### Loss 43157 (arm G): rank 3/6, 6 real, reward 0.60

- winner Rowin'Boats: 111 pts, 2 bingos, 12 letters @ 14.6, 36 left, words PRETZEL AQUIVER
- us Malicious: 82 pts, 2 bingos, 15 letters @ 10.9, 19 left, words BONFIRE DIABOLO ITHER; gap 29
- unspent 19, unplayed 1 tiles / value 1, min balance 1st half 68
- near misses 38 (S#4 11->11 SoapConsumers, L#5 10->10 SoapConsumers, M#6 15->16 Jaeger, J#7 30->30 cosine, I#8 6->8 cosine, M#9 17->17 Jaeger, L#10 10->10 Rowin'Boats, E#12 9->9 Rowin'Boats); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-cosine** (strength 1.00): 6 key-letter near misses (<= 2 coins: J@30 vs 30, V@19 vs 19, V@20 vs 20, Y@18 vs 16, X@24 vs 24, W@19 vs 19) vs 1 key letters won; mostly to cosine

#### Loss 43164 (arm G): rank 3.5/6, 6 real, reward 0.50

- winner Rowin'Boats: 85 pts, 2 bingos, 14 letters @ 11.6, 23 left, words OVERFED AGENDUM UREAL
- us Malicious: 75 pts, 2 bingos, 13 letters @ 11.8, 21 left, words APISHLY ORATION BI YE; gap 10
- unspent 21, unplayed 0 tiles / value 0, min balance 1st half 69
- near misses 26 (B#1 15->15 Karppa, I#2 7->9 cosine, I#4 7->9 Jaeger, I#5 7->8 cosine, E#8 10->10 Karppa, O#13 8->8 cosine, E#14 7->8 cosine, O#19 6->6 Karppa); overpays 1 (Y#66 32 vs ~19.4); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-cosine** (strength 0.50): 3 key-letter near misses (<= 2 coins: F@15 vs 15, K@22 vs 22, J@22 vs 22) vs 1 key letters won; mostly to cosine

#### Loss 43171 (arm G): rank 5/6, 6 real, reward 0.20

- winner N1gel: 89 pts, 1 bingos, 14 letters @ 12.4, 15 left, words FANJET PINOCLE VOX AIR
- us Malicious: 64 pts, 1 bingos, 10 letters @ 11.8, 46 left, words CAMPIER BEGLAD; gap 25
- unspent 46, unplayed 2 tiles / value 11, min balance 1st half 42
- near misses 26 (F#0 21->21 Jaeger, E#1 12->12 N1gel, N#2 10->10 N1gel, A#5 11->11 N1gel, P#6 17->17 N1gel, A#7 10->11 Jaeger, E#8 9->11 Rowin'Boats, V#10 15->16 N1gel); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.92): 46 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Jaeger** (strength 0.75): 4 key-letter near misses (<= 2 coins: F@21 vs 21, V@16 vs 15, Z@31 vs 29, Y@18 vs 18) vs 1 key letters won; mostly to Jaeger
- hypothesis **words-not-cashed** (strength 0.69): unplayed rack 'EQ' (2 tiles, value 11)

#### Loss 43177 (arm G): rank 2/6, 6 real, reward 0.80

- winner Lucy: 126 pts, 2 bingos, 16 letters @ 12.8, 21 left, words EQUALIZES DEEMING IMPS
- us Malicious: 98 pts, 2 bingos, 14 letters @ 12.2, 27 left, words HABITED NERVILY BEVOR; gap 28
- unspent 27, unplayed 0 tiles / value 0, min balance 1st half 31
- near misses 26 (O#0 12->12 Nhat, A#1 13->13 Nhat, S#2 15->15 Nhat, E#3 10->12 Lucy, H#4 19->20 N1gel, I#6 10->10 N1gel, N#8 10->10 Nhat, E#9 13->13 Lucy); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.54): 27 coins unspent at the end (>= 25)

#### Loss 43183 (arm G): rank 3/6, 6 real, reward 0.60

- winner Lbender: 127 pts, 2 bingos, 14 letters @ 15.1, 16 left, words OBLIQUE ZINCING JIG AW
- us Malicious: 86 pts, 2 bingos, 14 letters @ 12.4, 13 left, words FORDONE EXEDRAE EM PA; gap 41
- unspent 13, unplayed 1 tiles / value 1, min balance 1st half 38
- near misses 24 (T#2 7->8 Primey, L#3 11->12 peanuts, O#5 10->11 peanuts, S#6 14->14 peanuts, R#13 12->12 Primey, L#14 12->13 Lbender, R#16 14->14 peanuts, V#21 13->14 Primey); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-Primey** (strength 0.75): 3 key-letter near misses (<= 2 coins: V@14 vs 13, V@15 vs 13, Y@9 vs 9) vs 0 key letters won; mostly to Primey

#### Loss 43190 (arm G): rank 4/6, 6 real, reward 0.40

- winner Lucy: 123 pts, 2 bingos, 19 letters @ 11.2, 11 left, words QUEASY ALCOVED SCUTAGE OBIT
- us Malicious: 66 pts, 2 bingos, 12 letters @ 10.8, 36 left, words SHOUTED ALEATORY; gap 57
- unspent 36, unplayed 2 tiles / value 9, min balance 1st half 32
- near misses 33 (N#0 11->11 Primey, L#1 12->13 Primey, T#2 6->7 Primey, N#3 10->10 Primey, Q#4 30->30 Lucy, U#5 7->9 Lucy, X#6 33->33 Lbender, G#9 12->12 Primey); overpays 2 (D#13 11 vs ~6.5, I#46 10 vs ~6.1); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-Lbender** (strength 1.00): 7 key-letter near misses (<= 2 coins: Q@30 vs 30, X@33 vs 33, V@17 vs 16, F@14 vs 13, V@14 vs 12, H@14 vs 14, W@12 vs 12) vs 2 key letters won; mostly to Lbender
- hypothesis **underspent-hoarded-cash** (strength 0.72): 36 coins unspent at the end (>= 25)
- hypothesis **words-not-cashed** (strength 0.56): unplayed rack 'IJ' (2 tiles, value 9)

#### Loss 43197 (arm G): rank 2/6, 6 real, reward 0.80

- winner Lucy: 135 pts, 2 bingos, 21 letters @ 11.1, 1 left, words AQUIVER PIEDFORT OXIDS RANTS
- us Malicious: 112 pts, 2 bingos, 17 letters @ 11.9, 10 left, words JADEITE MICROWAVE ANISE; gap 23
- unspent 10, unplayed 1 tiles / value 1, min balance 1st half 38
- near misses 31 (O#0 10->10 Primey, E#1 10->10 Primey, U#2 13->13 Lucy, E#3 11->11 Primey, O#4 6->7 Primey, R#6 9->9 Lucy, R#8 7->7 Lucy, O#9 4->4 Lucy); overpays 1 (N#39 10 vs ~4.5); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-Cruds** (strength 0.25): 3 key-letter near misses (<= 2 coins: H@18 vs 18, Z@12 vs 10, H@6 vs 6) vs 2 key letters won; mostly to Cruds

#### Loss 43204 (arm G): rank 2/6, 6 real, reward 0.80

- winner Primey: 120 pts, 2 bingos, 19 letters @ 11.1, 9 left, words JAUPING ROWTHS CURDIER MOAS
- us Malicious: 88 pts, 1 bingos, 17 letters @ 9.5, 27 left, words KREMLIN ANYONE AE TOWAGE; gap 32
- unspent 27, unplayed 1 tiles / value 1, min balance 1st half 41
- near misses 26 (I#0 12->12 Primey, S#1 13->14 Primey, R#4 12->12 Primey, N#6 8->10 Primey, A#7 13->13 Barracuda, I#9 13->13 Barracuda, I#11 11->11 Barracuda, O#28 8->8 Primey); overpays 1 (O#10 14 vs ~7); winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.54): 27 coins unspent at the end (>= 25)

#### Loss 43218 (arm G): rank 4/6, 6 real, reward 0.40

- winner Lexicoin: 108 pts, 2 bingos, 17 letters @ 11.6, 10 left, words QUEERED BUOYANT VIREO PIU
- us Malicious: 65 pts, 1 bingos, 10 letters @ 12.0, 45 left, words HINGERS DEXIE NOW; gap 43
- unspent 45, unplayed 0 tiles / value 0, min balance 1st half 21
- near misses 26 (I#0 10->10 SoapConsumers, M#1 15->17 SoapConsumers, O#6 11->11 SoapConsumers, B#7 16->16 cosine, E#8 10->10 cosine, D#13 12->12 Lexicoin, A#16 9->11 Lexicoin, I#17 10->12 Lexicoin); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.90): 45 coins unspent at the end (>= 25)

#### Loss 43225 (arm g2-nodetect): rank 3/6, 6 real, reward 0.60

- winner RackMaw: 112 pts, 2 bingos, 15 letters @ 12.9, 18 left, words OVERJOYS DAMAGES UNFIT
- us Malicious: 82 pts, 2 bingos, 14 letters @ 11.6, 20 left, words TRIFORM ALOETIC QUAI; gap 30
- unspent 20, unplayed 1 tiles / value 1, min balance 1st half 25
- near misses 24 (J#0 28->28 RackMaw, R#5 9->10 Lexicoin, G#7 10->10 cosine, R#12 8->10 Lexicoin, I#14 9->11 Lexicoin, T#15 8->10 Lexicoin, A#18 8->10 Lexicoin, E#20 13->13 RackMaw); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-RackMaw** (strength 1.00): 6 key-letter near misses (<= 2 coins: J@28 vs 28, Y@24 vs 24, W@14 vs 14, Y@18 vs 18, H@13 vs 11, F@18 vs 18) vs 2 key letters won; mostly to RackMaw

#### Loss 43232 (arm G): rank 3/6, 6 real, reward 0.60

- winner gas: 123 pts, 2 bingos, 18 letters @ 11.8, 10 left, words PLOTZES MONACID FUGLED SEW
- us Malicious: 83 pts, 1 bingos, 10 letters @ 15.5, 28 left, words UNIQUELY FID JATO; gap 40
- unspent 28, unplayed 0 tiles / value 0, min balance 1st half 5
- near misses 8 (I#0 11->11 Milo :3, G#11 12->12 gas, T#13 9->10 gas, A#16 9->10 cosine, N#20 9->10 Milo :3, R#21 10->11 Milo :3, N#65 5->5 Milo :3, B#66 12->12 Milo :3); overpays 0; winner's uncontested cheap wins 0
- hypothesis **overspent-early** (strength 0.75): balance fell to 5 before auction 34 of 68
- hypothesis **underspent-hoarded-cash** (strength 0.56): 28 coins unspent at the end (>= 25)
- hypothesis **opponent-mispriced** (strength 0.52): we paid 15.5/letter vs winner 11.8 (x1.31); 0 overpays

#### Loss 43239 (arm g2-nodetect): rank 6/6, 6 real, reward 0.00

- winner cosine: 103 pts, 2 bingos, 16 letters @ 12.4, 4 left, words EQUATED SHEITAN WAITER
- us Malicious: 54 pts, 1 bingos, 12 letters @ 11.3, 19 left, words TROUPIAL BONIER DUO; gap 49
- unspent 19, unplayed 0 tiles / value 0, min balance 1st half 39
- near misses 30 (N#0 7->8 cosine, F#2 18->18 Lbender, T#4 7->7 cosine, S#5 10->11 cosine, R#6 9->9 Abhi-AuctionLab, U#9 11->11 Milo :3, H#11 18->19 Lbender, A#13 11->11 Milo :3); overpays 1 (D#66 24 vs ~14); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-Lbender** (strength 1.00): 11 key-letter near misses (<= 2 coins: F@18 vs 18, H@19 vs 18, Q@30 vs 30, V@17 vs 15, F@20 vs 18, Z@42 vs 42, H@21 vs 21, J@24 vs 23, X@23 vs 23, V@14 vs 14, W@14 vs 14) vs 0 key letters won; mostly to Lbender
