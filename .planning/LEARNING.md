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

### Losses diagnosed 2026-11-08T01:52:15.982Z (live-only)

#### Loss 45430 (arm dump): rank 5/6, 6 real, reward 0.00

- winner RackMaw: 101 pts, 1 bingos, 12 letters @ 16.0, 9 left, words EMBOWED JACKER APES
- us Malicious: 62 pts, 2 bingos, 12 letters @ 10.3, 39 left, words CADGING ELATION ABO; gap 39
- unspent 39, unplayed 0 tiles / value 0, min balance 1st half 59
- near misses 22 (L#0 10->10 Binter, R#1 10->10 Abhi-AuctionLab, D#4 13->13 RackMaw, I#5 9->10 Lucy, T#6 10->10 Binter, U#7 10->10 cosine, T#8 7->8 cosine, T#13 7->8 cosine); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.78): 39 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Binter** (strength 0.75): 3 key-letter near misses (<= 2 coins: H@20 vs 18, Z@28 vs 27, F@15 vs 15) vs 0 key letters won; mostly to Binter

#### Loss 45438 (arm harvest2): rank 5/6, 6 real, reward 0.00

- winner Abhi-AuctionLab: 92 pts, 1 bingos, 13 letters @ 12.4, 31 left, words IMPROVE FAWNED TAKEN
- us Malicious: 59 pts, 1 bingos, 10 letters @ 13.4, 25 left, words ADORING JINGO HUT; gap 33
- unspent 25, unplayed 0 tiles / value 0, min balance 1st half 100
- near misses 29 (O#15 8->10 Lucy, M#16 11->13 cosine, F#21 14->16 Lexicoin, X#22 26->27 Lucy, R#23 9->11 Lucy, U#24 9->10 Lexicoin, C#26 17->17 cosine, D#27 10->12 Lucy); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.50): 25 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Abhi-AuctionLab** (strength 0.25): 3 key-letter near misses (<= 2 coins: F@16 vs 14, X@27 vs 26, W@15 vs 15) vs 2 key letters won; mostly to Abhi-AuctionLab

#### Loss 45446 (arm default): rank 4/6, 6 real, reward 0.00

- winner Lexicoin: 96 pts, 2 bingos, 14 letters @ 12.9, 15 left, words PAROQUET WETTING NITE
- us Malicious: 60 pts, 0 bingos, 9 letters @ 15.4, 21 left, words COMAKE YOUSE EX; gap 36
- unspent 21, unplayed 1 tiles / value 1, min balance 1st half 8
- near misses 14 (N#1 8->10 Lexicoin, F#3 19->19 aipom, N#8 10->11 Lexicoin, I#9 11->11 Lucy, R#10 12->12 Lexicoin, E#12 13->13 Lucy, R#13 12->12 Lucy, T#14 9->9 cosine); overpays 2 (O#26 13 vs ~8, O#31 14 vs ~8); winner's uncontested cheap wins 0
- hypothesis **overspent-early** (strength 0.60): balance fell to 8 before auction 34 of 68

#### Loss 45454 (arm key1-dump): rank 2/6, 6 real, reward 0.35

- winner wordgoat: 108 pts, 2 bingos, 17 letters @ 11.6, 10 left, words HYPODERMS PLUGGED WAIR ET
- us Malicious: 88 pts, 2 bingos, 14 letters @ 12.1, 19 left, words DIOCESE BANJOES ANTRE; gap 20
- unspent 19, unplayed 0 tiles / value 0, min balance 1st half 13
- near misses 22 (O#0 10->12 wordgoat, L#1 13->13 Lexicoin, A#4 13->13 evol, G#7 12->12 Lexicoin, O#10 11->11 Lexicoin, R#12 11->12 wordgoat, T#14 10->10 Lexicoin, O#17 9->9 Lexicoin); overpays 0; winner's uncontested cheap wins 0
- hypothesis: unexplained (no rule fired; random perturbation only)

#### Loss 45462 (arm key1): rank 2.5/6, 6 real, reward 0.22

- winner evol: 111 pts, 2 bingos, 15 letters @ 12.6, 22 left, words AQUIFERS ENHALOED VIEW
- us Malicious: 80 pts, 1 bingos, 10 letters @ 15.1, 29 left, words WINGTIPS ZEBEC OR; gap 31
- unspent 29, unplayed 0 tiles / value 0, min balance 1st half 8
- near misses 17 (D#0 14->14 Milo :3, A#2 14->15 rackpilot-live, E#10 12->13 Milo :3, A#11 12->12 Milo :3, J#24 26->26 rackpilot-live, E#25 9->9 rackpilot-live, I#27 11->11 evol, E#29 13->13 Milo :3); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-rackpilot-live** (strength 0.75): 4 key-letter near misses (<= 2 coins: J@26 vs 26, V@14 vs 14, F@14 vs 14, V@17 vs 15) vs 1 key letters won; mostly to rackpilot-live
- hypothesis **overspent-early** (strength 0.60): balance fell to 8 before auction 34 of 68
- hypothesis **underspent-hoarded-cash** (strength 0.58): 29 coins unspent at the end (>= 25)

#### Loss 45470 (arm harvest): rank 4.5/6, 6 real, reward 0.00

- winner evol: 113 pts, 1 bingos, 16 letters @ 12.1, 19 left, words HEJIRAS ZOUAVE DISTIL
- us Malicious: 61 pts, 1 bingos, 8 letters @ 11.3, 71 left, words PIVOTMAN GUACO; gap 52
- unspent 71, unplayed 0 tiles / value 0, min balance 1st half 83
- near misses 36 (I#0 10->11 Milo :3, T#2 9->9 Milo :3, N#3 9->9 Milo :3, I#5 10->10 rackpilot-live, D#7 8->10 Milo :3, N#8 5->7 Milo :3, K#10 17->19 rackpilot-live, R#11 7->8 evol); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 1.00): 71 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-LexForge-Shade-v1** (strength 1.00): 4 key-letter near misses (<= 2 coins: K@19 vs 17, H@20 vs 18, W@20 vs 20, Y@30 vs 30) vs 0 key letters won; mostly to LexForge-Shade-v1

#### Loss 45478 (arm key1): rank 6/6, 6 real, reward 0.00

- winner LexForge-Cash-v1: 107 pts, 1 bingos, 14 letters @ 13.1, 24 left, words TRAPEZE ADJURE DOOLY
- us Malicious: 53 pts, 1 bingos, 12 letters @ 10.3, 29 left, words OLEINES VISA OUTSAW; gap 54
- unspent 29, unplayed 0 tiles / value 0, min balance 1st half 46
- near misses 28 (E#1 7->8 QuertyBot, U#2 9->9 QuertyBot, N#5 5->7 evol, S#6 9->10 Jake, B#7 14->14 QuertyBot, H#8 20->20 evol, L#10 8->8 LexForge-Cash-v1, E#11 6->6 Jake); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-evol** (strength 0.75): 4 key-letter near misses (<= 2 coins: H@20 vs 20, K@21 vs 20, F@24 vs 24, Q@24 vs 24) vs 1 key letters won; mostly to evol
- hypothesis **underspent-hoarded-cash** (strength 0.58): 29 coins unspent at the end (>= 25)

#### Loss 45486 (arm harvest2): rank 5/6, 6 real, reward 0.00

- winner scrabblefish: 108 pts, 2 bingos, 15 letters @ 11.7, 32 left, words EQUABLE FAVORED WRIT IT
- us Malicious: 60 pts, 2 bingos, 10 letters @ 15.2, 8 left, words NOIRISH UNPOSED; gap 48
- unspent 8, unplayed 1 tiles / value 8, min balance 1st half 100
- near misses 24 (A#7 7->7 rackpilot-live, G#10 8->9 evol, L#13 7->8 evol, S#15 9->10 evol, L#16 7->7 LexForge-Cash-v1, R#20 7->8 evol, B#22 10->12 scrabblefish, C#28 15->15 evol); overpays 1 (X#66 48 vs ~27.9); winner's uncontested cheap wins 0
- hypothesis **words-not-cashed** (strength 0.50): unplayed rack 'X' (1 tiles, value 8)

#### Loss 45494 (arm harvest): rank 6/6, 6 real, reward 0.00

- winner Tow57-Auctioneer: 78 pts, 2 bingos, 15 letters @ 10.7, 18 left, words SICKEST VOLITANT AUTO
- us Malicious: 55 pts, 2 bingos, 12 letters @ 11.7, 15 left, words AEROBES UNGULAE AB; gap 23
- unspent 15, unplayed 1 tiles / value 1, min balance 1st half 68
- near misses 27 (X#5 27->27 Lucy, T#7 6->7 Tow57-Auctioneer, M#9 15->15 evol, N#10 8->8 Tow57-Auctioneer, D#11 11->12 evol, T#12 7->8 Tow57-Auctioneer, A#14 9->9 Tow57-Auctioneer, I#18 7->8 Tow57-Auctioneer); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-evol** (strength 1.00): 4 key-letter near misses (<= 2 coins: X@27 vs 27, F@15 vs 14, Q@27 vs 27, W@15 vs 15) vs 0 key letters won; mostly to evol

#### Loss 45502 (arm key1-dump): rank 6/6, 6 real, reward 0.00

- winner aipom: 98 pts, 1 bingos, 14 letters @ 11.5, 37 left, words MATZOS HYALINE TOTING
- us Malicious: 56 pts, 2 bingos, 11 letters @ 13.4, 9 left, words AEDILES HURLIES NU; gap 42
- unspent 9, unplayed 0 tiles / value 0, min balance 1st half 62
- near misses 26 (M#5 17->18 aipom, I#6 10->11 wordgoat, Y#9 22->22 aipom, I#10 12->12 Lucy, O#12 10->10 Bron, R#13 8->8 Bron, E#14 9->9 Lucy, T#15 9->9 aipom); overpays 2 (L#62 19 vs ~10.6, U#66 20 vs ~9.9); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-aipom** (strength 0.75): 4 key-letter near misses (<= 2 coins: Y@22 vs 22, H@17 vs 17, V@16 vs 16, Q@37 vs 37) vs 1 key letters won; mostly to aipom

#### Loss 45520 (arm key1): rank 5/6, 6 real, reward 0.00

- winner Bron: 114 pts, 1 bingos, 12 letters @ 13.2, 56 left, words SHEGETZ QINDAR XU OW
- us Malicious: 42 pts, 1 bingos, 5 letters @ 12.6, 79 left, words MAYPOLE; gap 72
- unspent 79, unplayed 3 tiles / value 6, min balance 1st half 49
- near misses 8 (O#1 11->11 Rowin'Boats, E#2 9->10 Bron, N#3 10->11 QuertyBot, W#4 17->18 aipom, D#7 12->12 aipom, W#8 15->15 Bron, R#10 10->11 QuertyBot, J#13 29->30 QuertyBot); overpays 1 (A#15 12 vs ~7.5); winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 1.00): 79 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-aipom** (strength 0.50): 3 key-letter near misses (<= 2 coins: W@18 vs 17, W@15 vs 15, J@30 vs 29) vs 1 key letters won; mostly to aipom

#### Loss 45553 (arm key1-dump): rank 5/6, 6 real, reward 0.00

- winner aipom: 132 pts, 3 bingos, 14 letters @ 14.4, 31 left, words ZELKOVA ZELKOVA BATCHED FONDU
- us Malicious: 53 pts, 1 bingos, 9 letters @ 14.3, 24 left, words ARISTAS POLICY; gap 79
- unspent 24, unplayed 1 tiles / value 1, min balance 1st half 53
- near misses 19 (O#19 11->12 aipom, U#21 11->11 SevenUp, R#23 11->11 SevenUp, F#24 24->24 LexiconWarrior, O#27 10->12 SevenUp, Y#28 21->21 SevenUp, T#29 9->10 Tow57-Auctioneer, D#31 15->15 aipom); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-LexiconWarrior** (strength 1.00): 5 key-letter near misses (<= 2 coins: F@24 vs 24, Y@21 vs 21, F@14 vs 13, W@16 vs 14, W@13 vs 13) vs 1 key letters won; mostly to LexiconWarrior

### Live cycle 2026-11-08T01:52:15.982Z: parent `default` (posterior 0.327, 61 plays)

- losses analysed: 45430, 45438, 45446, 45454, 45462, 45470, 45478, 45486, 45494, 45502, 45520, 45553 (+107 older backlog marked)
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.3 s

### Losses diagnosed 2026-11-08T01:55:46.054Z (live-only)

#### Loss 45561 (arm default): rank 3/6, 6 real, reward 0.10

- winner Lbender: 88 pts, 1 bingos, 12 letters @ 14.5, 14 left, words KYTHING AVOWER UP
- us Malicious: 75 pts, 1 bingos, 10 letters @ 15.3, 22 left, words CLAYMORE JEUX AIL; gap 13
- unspent 22, unplayed 0 tiles / value 0, min balance 1st half 35
- near misses 15 (A#1 11->11 benoit, O#3 10->11 benoit, O#6 11->12 benoit, U#7 12->12 aipom, I#8 12->12 benoit, E#9 12->12 benoit, E#11 13->13 benoit, P#18 17->17 Lbender); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-LexiconWarrior** (strength 0.50): 4 key-letter near misses (<= 2 coins: W@14 vs 12, K@17 vs 16, Z@27 vs 27, Q@6 vs 6) vs 2 key letters won; mostly to LexiconWarrior

#### Loss 45570 (arm default): rank 5/6, 6 real, reward 0.00

- winner aipom: 102 pts, 2 bingos, 13 letters @ 15.1, 6 left, words ACEQUIA OBSERVED EFT
- us Malicious: 63 pts, 2 bingos, 10 letters @ 13.3, 30 left, words HAMULUS PANTILE; gap 39
- unspent 30, unplayed 1 tiles / value 1, min balance 1st half 32
- near misses 24 (I#0 10->11 benoit, R#1 12->12 benoit, O#2 11->12 aipom, B#3 17->19 RackForge, A#4 13->13 benoit, V#6 14->16 aipom, E#7 11->11 benoit, B#9 16->16 aipom); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-aipom** (strength 0.75): 3 key-letter near misses (<= 2 coins: V@16 vs 14, Q@28 vs 28, X@22 vs 22) vs 0 key letters won; mostly to aipom
- hypothesis **underspent-hoarded-cash** (strength 0.60): 30 coins unspent at the end (>= 25)

#### Loss 45579 (arm dump): rank 5/6, 6 real, reward 0.00

- winner Astronaut: 91 pts, 2 bingos, 15 letters @ 12.1, 9 left, words DEATHTRAP BLOWIEST ARK
- us Malicious: 65 pts, 1 bingos, 9 letters @ 13.3, 45 left, words MOLTING EXODOS; gap 26
- unspent 45, unplayed 1 tiles / value 1, min balance 1st half 45
- near misses 19 (C#5 18->19 benoit, R#6 11->11 benoit, F#7 17->19 Lbender, O#8 9->9 benoit, A#10 11->11 benoit, O#12 7->9 benoit, I#17 11->11 benoit, H#24 17->17 Astronaut); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.90): 45 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Astronaut** (strength 0.50): 3 key-letter near misses (<= 2 coins: F@19 vs 17, H@17 vs 17, W@13 vs 13) vs 1 key letters won; mostly to Astronaut

### Live cycle 2026-11-08T01:55:46.054Z: parent `dump` (posterior 0.279, 8 plays)

- losses analysed: 45561, 45570, 45579
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s

### Losses diagnosed 2026-11-08T02:00:46.308Z (live-only)

#### Loss 45588 (arm harvest2): rank 4/6, 6 real, reward 0.00

- winner LexForge-Reveal-v1: 115 pts, 2 bingos, 18 letters @ 11.6, 7 left, words BUSHWAH REVIEWAL OUTLET MO
- us Malicious: 50 pts, 1 bingos, 10 letters @ 12.4, 26 left, words NOODLING SABINE; gap 65
- unspent 26, unplayed 1 tiles / value 1, min balance 1st half 90
- near misses 22 (T#9 9->10 benoit, S#14 10->12 Astronaut, N#17 8->10 Lbender, R#18 8->9 Astronaut, R#25 8->10 Astronaut, R#29 9->9 Astronaut, E#31 8->10 LexForge-Reveal-v1, W#35 15->17 LexForge-Reveal-v1); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-Lbender** (strength 1.00): 5 key-letter near misses (<= 2 coins: W@17 vs 15, F@19 vs 17, Y@23 vs 23, X@27 vs 27, V@18 vs 18) vs 0 key letters won; mostly to Lbender
- hypothesis **underspent-hoarded-cash** (strength 0.52): 26 coins unspent at the end (>= 25)

#### Loss 45597 (arm late-table): rank 4/6, 6 real, reward 0.00

- winner Como Se Dice I Want to Scrabble: 111 pts, 2 bingos, 15 letters @ 12.2, 28 left, words ACQUEST MEOWING DAVY NO
- us Malicious: 74 pts, 1 bingos, 12 letters @ 11.2, 40 left, words SPIKIER OOT EXTANT; gap 37
- unspent 40, unplayed 1 tiles / value 1, min balance 1st half 54
- near misses 34 (U#1 10->12 Como Se Dice I Want to Scrabble, U#2 12->12 benoit, A#3 12->12 benoit, N#4 11->11 benoit, A#5 12->12 benoit, S#6 10->12 benoit, L#9 9->11 benoit, Y#10 24->24 benoit); overpays 1 (T#22 12 vs ~7.3); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-LexForge-Reveal-v1** (strength 1.00): 6 key-letter near misses (<= 2 coins: Y@24 vs 24, H@20 vs 20, J@23 vs 23, W@14 vs 14, V@12 vs 12, F@19 vs 19) vs 1 key letters won; mostly to LexForge-Reveal-v1
- hypothesis **underspent-hoarded-cash** (strength 0.80): 40 coins unspent at the end (>= 25)

### Live cycle 2026-11-08T02:00:46.308Z: parent `harvest2` (posterior 0.461, 5 plays)

- losses analysed: 45588, 45597
- mode: live-only (no sim gate); capacity 1 (untested cap 2, pool cap 6, retire at >= 8 plays)
- added `cyc-2ff3da05` (keyEdge): lost-key-letters-to-X 2.00: bid +1 on key letters (ties / <=2-coin losses); params `{"earlyScale":0.7,"endWindow":20,"endKappaLo":1.6,"keyEdge":1}`; delta `{"keyEdge":1}`
- retired `["key1"]`
- skipped `[{"id":"cyc-f9cb9f75","reason":"2 untested arms already"},{"id":"cyc-26d0f2ba","reason":"2 untested arms already"},{"id":"cyc-4a08db13","reason":"2 untested arms already"},{"id":"cyc-f86e5ced","reason":"2 untested arms already"},{"id":"cyc-7b7a8968","reason":"2 untested arms already"}]`
- cycle 0.1 s

### Losses diagnosed 2026-11-08T02:03:46.485Z (live-only)

#### Loss 45616 (arm harvest): rank 2/6, 6 real, reward 0.35

- winner RackMaw-Tie45: 124 pts, 2 bingos, 14 letters @ 14.4, 23 left, words FLAXIER HORIZON TUFAS
- us Malicious: 101 pts, 2 bingos, 16 letters @ 10.3, 37 left, words QUANGOS BEDOUIN PITIER; gap 23
- unspent 37, unplayed 1 tiles / value 1, min balance 1st half 69
- near misses 27 (O#2 8->8 Pegasus v10, A#3 8->8 cosine, L#4 9->9 Pegasus v10, H#8 15->16 Pegasus v10, L#9 6->7 RackMaw-Tie45, E#10 9->9 Pegasus v10, F#14 15->15 RackMaw-Tie45, T#16 6->7 peanuts); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-RackMaw-Tie45** (strength 1.00): 5 key-letter near misses (<= 2 coins: H@16 vs 15, F@15 vs 15, Y@21 vs 21, F@16 vs 14, J@17 vs 17) vs 0 key letters won; mostly to RackMaw-Tie45
- hypothesis **underspent-hoarded-cash** (strength 0.74): 37 coins unspent at the end (>= 25)

#### Loss 45626 (arm default): rank 5/6, 6 real, reward 0.00

- winner RackForge: 103 pts, 2 bingos, 12 letters @ 15.2, 21 left, words RHUMBAS ANODIZE TAJ
- us Malicious: 68 pts, 1 bingos, 10 letters @ 12.6, 42 left, words ARCHINE SAVORY OE; gap 35
- unspent 42, unplayed 0 tiles / value 0, min balance 1st half 49
- near misses 22 (B#1 14->16 RackForge, H#2 17->17 RackForge, T#7 9->10 Karppa, N#9 7->9 Karppa, M#14 16->16 Lexicoin, O#15 8->8 Lexicoin, O#16 7->8 RackForge, I#17 7->8 RackForge); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.84): 42 coins unspent at the end (>= 25)

#### Loss 45637 (arm harvest2): rank 6/6, 6 real, reward 0.00

- winner LexForge-Base-v1: 103 pts, 2 bingos, 14 letters @ 13.3, 17 left, words WORKMAN GHASTFUL DOPE
- us Malicious: 70 pts, 1 bingos, 9 letters @ 14.9, 36 left, words AZURITE AROYNT; gap 33
- unspent 36, unplayed 1 tiles / value 1, min balance 1st half 67
- near misses 28 (S#3 9->10 Lexicoin, L#4 7->9 Pegasus v7, N#8 7->9 Lexicoin, T#9 6->8 Lexicoin, T#15 7->7 Lexicoin, E#16 6->7 Lexicoin, S#20 9->9 LexForge-Reward54-v1, V#25 13->15 Pegasus v7); overpays 1 (N#66 18 vs ~10); winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.72): 36 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Pegasus v7** (strength 0.50): 4 key-letter near misses (<= 2 coins: V@15 vs 13, H@17 vs 17, V@13 vs 11, F@22 vs 22) vs 2 key letters won; mostly to Pegasus v7

### Live cycle 2026-11-08T02:03:46.485Z: parent `harvest2` (posterior 0.393, 6 plays)

- losses analysed: 45616, 45626, 45637
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s

### Losses diagnosed 2026-11-08T02:09:16.747Z (live-only)

#### Loss 45658 (arm cyc-2ff3da05): rank 4/6, 6 real, reward 0.00

- winner aipom: 111 pts, 2 bingos, 16 letters @ 11.8, 22 left, words CAITIFFS DEPRAVED SHEND
- us Malicious: 89 pts, 1 bingos, 11 letters @ 13.3, 43 left, words BRIQUET LUXATE NOO; gap 22
- unspent 43, unplayed 0 tiles / value 0, min balance 1st half 55
- near misses 30 (O#2 7->9 Pegasus v5, I#3 8->8 LexForge-Liquid03-v1, N#4 7->7 Pegasus v5, C#6 11->13 aipom, S#8 7->7 Pegasus v8, O#9 8->10 Pegasus v8, I#11 8->8 aipom, G#15 7->9 Pegasus v5); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-aipom** (strength 1.00): 6 key-letter near misses (<= 2 coins: V@15 vs 13, Z@35 vs 35, H@17 vs 17, K@16 vs 16, W@15 vs 15, Y@24 vs 24) vs 2 key letters won; mostly to aipom
- hypothesis **underspent-hoarded-cash** (strength 0.86): 43 coins unspent at the end (>= 25)

#### Loss 45669 (arm late-table): rank 2/6, 6 real, reward 0.35

- winner LexForge-Liquid03-v1: 100 pts, 1 bingos, 11 letters @ 17.1, 12 left, words EJECTOR BONZER TAX
- us Malicious: 93 pts, 2 bingos, 14 letters @ 12.2, 22 left, words FAQUIRS LOUDENING ALE; gap 7
- unspent 22, unplayed 0 tiles / value 0, min balance 1st half 34
- near misses 17 (C#4 15->16 LexForge-Liquid03-v1, J#6 27->27 LexForge-Liquid03-v1, R#8 8->9 LexForge-Liquid03-v1, E#11 13->13 LexForge-Liquid03-v1, L#12 7->9 Pegasus v5, O#15 7->9 Pegasus v5, V#16 13->14 Pegasus v8, Y#20 21->21 aipom); overpays 1 (E#66 26 vs ~14.4); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-aipom** (strength 0.50): 3 key-letter near misses (<= 2 coins: J@27 vs 27, V@14 vs 13, Y@21 vs 21) vs 1 key letters won; mostly to aipom

### Live cycle 2026-11-08T02:09:16.747Z: parent `harvest2` (posterior 0.396, 6 plays)

- losses analysed: 45658, 45669
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s

### Losses diagnosed 2026-11-08T02:12:46.985Z (live-only)

#### Loss 45681 (arm harvest2): rank 5/6, 6 real, reward 0.00

- winner Mavvy: 104 pts, 2 bingos, 14 letters @ 11.5, 43 left, words BLINKED UNQUIET MOTOR
- us Malicious: 72 pts, 2 bingos, 12 letters @ 10.6, 45 left, words ANTISEX SOAPIER ALE; gap 32
- unspent 45, unplayed 0 tiles / value 0, min balance 1st half 85
- near misses 26 (O#4 10->10 Pegasus v6, I#12 8->10 LexForge-Reward54-v1, E#13 8->9 LexForge-Liquid03-v1, I#14 9->9 Pegasus v6, E#18 7->8 Mavvy, A#19 7->9 LexForge-Reward54-v1, R#20 6->7 Pegasus v6, A#22 9->9 LexForge-Liquid03-v1); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.90): 45 coins unspent at the end (>= 25)

#### Loss 45692 (arm late-table): rank 5/6, 6 real, reward 0.00

- winner Mavvy: 109 pts, 2 bingos, 14 letters @ 14.4, 7 left, words WHACKED FAVORITE DOES
- us Malicious: 68 pts, 2 bingos, 11 letters @ 12.3, 33 left, words RELYING DEANERY AI; gap 41
- unspent 33, unplayed 0 tiles / value 0, min balance 1st half 62
- near misses 24 (D#0 12->13 Pegasus v6, E#1 10->10 Mavvy, U#2 10->10 RackMaw-Champion-Ctl3, I#3 10->10 Mavvy, E#4 7->9 RackMaw-Champion-Ctl3, N#5 10->11 Pegasus v6, B#6 15->15 LexForge-Liquid03-v1, D#7 12->13 Mavvy); overpays 1 (A#66 17 vs ~10); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-LexForge-Liquid03-v1** (strength 1.00): 5 key-letter near misses (<= 2 coins: H@20 vs 20, F@19 vs 18, Z@42 vs 41, J@29 vs 29, K@24 vs 24) vs 1 key letters won; mostly to LexForge-Liquid03-v1
- hypothesis **underspent-hoarded-cash** (strength 0.66): 33 coins unspent at the end (>= 25)

#### Loss 45703 (arm cyc-2ff3da05): rank 5/6, 6 real, reward 0.00

- winner Pegasus v7: 90 pts, 1 bingos, 12 letters @ 12.6, 39 left, words OBJECTING MOTIFS
- us Malicious: 63 pts, 1 bingos, 11 letters @ 13.3, 17 left, words GHARIAL WAKED AE IN; gap 27
- unspent 17, unplayed 0 tiles / value 0, min balance 1st half 90
- near misses 27 (O#6 7->9 Pegasus v7, O#7 6->8 Mavvy, P#9 12->14 LexForge-Liquid03-v1, Y#10 16->17 LexForge-Liquid03-v1, R#11 7->9 Mavvy, V#12 14->14 LexForge-Liquid03-v1, D#14 9->10 RackMaw-Champion-Ctl3, M#18 12->14 Pegasus v6); overpays 1 (A#56 18 vs ~11.2); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-LexForge-Liquid03-v1** (strength 0.75): 5 key-letter near misses (<= 2 coins: Y@17 vs 16, V@14 vs 14, Y@21 vs 21, W@13 vs 13, F@14 vs 14) vs 2 key letters won; mostly to LexForge-Liquid03-v1

### Live cycle 2026-11-08T02:12:46.985Z: parent `harvest2` (posterior 0.344, 7 plays)

- losses analysed: 45681, 45692, 45703
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s

### Losses diagnosed 2026-11-08T02:16:17.090Z (live-only)

#### Loss 45725 (arm harvest): rank 5/6, 6 real, reward 0.00

- winner Pegasus-vLexForge-Base-v1: 102 pts, 2 bingos, 16 letters @ 11.1, 24 left, words KOPPIES RUFIYAA WAGER
- us Malicious: 66 pts, 2 bingos, 10 letters @ 13.4, 32 left, words THIONYLS GENTOOS; gap 36
- unspent 32, unplayed 0 tiles / value 0, min balance 1st half 37
- near misses 19 (S#3 7->9 Pegasus-vLexForge-Base-v1, V#4 13->15 LexForge-1107, P#5 12->14 Pegasus-vLexForge-Base-v1, E#12 8->10 Pegasus-vLexForge-Base-v1, W#21 14->16 Pegasus-vLexForge-Base-v1, H#24 20->20 LexForge-Shade-v1, U#25 8->10 LexForge-1107, R#26 10->10 LexForge-1107); overpays 1 (S#38 12 vs ~5); winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.64): 32 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-LexForge-1107** (strength 0.25): 3 key-letter near misses (<= 2 coins: V@15 vs 13, W@16 vs 14, H@20 vs 20) vs 2 key letters won; mostly to LexForge-1107

#### Loss 45737 (arm harvest2): rank 2.5/6, 6 real, reward 0.22

- winner Mavvy: 117 pts, 2 bingos, 14 letters @ 13.5, 28 left, words INQUIET OXIDANT OHMIC
- us Malicious: 79 pts, 1 bingos, 10 letters @ 14.9, 30 left, words FRIJOLES DYNELS; gap 38
- unspent 30, unplayed 1 tiles / value 3, min balance 1st half 90
- near misses 26 (E#1 9->9 Pegasus-vLexForge-Base-v1, I#14 9->9 Pegasus-vLexForge-Base-v1, A#15 10->11 Pegasus-vLexForge-Base-v1, T#17 7->8 Pegasus-vLexForge-Base-v1, U#19 10->10 Pegasus-vLexForge-Base-v1, V#20 12->14 Pegasus v5, T#23 7->9 Pegasus v5, N#25 6->6 Mavvy); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.60): 30 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Pegasus v5** (strength 0.50): 4 key-letter near misses (<= 2 coins: V@14 vs 12, X@25 vs 23, Z@37 vs 37, V@15 vs 13) vs 2 key letters won; mostly to Pegasus v5

### Live cycle 2026-11-08T02:16:17.090Z: parent `harvest2` (posterior 0.332, 8 plays)

- losses analysed: 45725, 45737
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s

### Evolve iteration 0 2026-11-08T02:16:39.430Z

- live-only loss cycle: exit 0
- history refetch (--recent 3000): ok
- refit dropped Odysseus's Voyage; kept previous profiles
- parent `dump` {"dumpWindow":10} (7 plays, a=1.80 b=3.69)
- hypothesis {"earlyScale":0.7,"endWindow":20,"endKappaLo":1.6,"greedMinSeats":3,"baitRatio":0.9,"baitShade":0.85} -> liveField 18.0 [10.5, 25.5]; liveFieldB 19.5 [12.0, 27.0] -> beats parent
- hypothesis {"dumpWindow":10,"tableScale":1.1} -> liveField 8.0 [0.4, 15.6]; liveFieldB 1.5 [-5.7, 8.7] -> no
- hypothesis {"dumpWindow":10,"earlyScale":0.9} -> liveField 8.0 [0.6, 15.4]; liveFieldB 5.0 [-2.8, 12.8] -> no
- hypothesis {"dumpWindow":10,"endWindow":5} -> liveField 0.5 [-1.2, 2.2]; liveFieldB 1.5 [-0.7, 3.7] -> no
- hypothesis {"dumpWindow":10,"endKappaLo":1.3} -> liveField 0.0 [0.0, 0.0]; liveFieldB 0.0 [0.0, 0.0] -> no
- hypothesis {"dumpWindow":10,"tableScale":0.9} -> liveField -3.5 [-10.5, 3.5]; liveFieldB -9.0 [-16.3, -1.7] -> no
- hypothesis {"dumpWindow":10,"earlyScale":1} -> liveField 0.0 [0.0, 0.0]; liveFieldB 0.0 [0.0, 0.0] -> no
- hypothesis {"dumpWindow":10,"incomeShare":0.45} -> liveField -1.0 [-8.5, 6.5]; liveFieldB 3.5 [-3.0, 10.0] -> no
- hypothesis {"dumpWindow":10,"reserve":10} -> liveField 0.0 [0.0, 0.0]; liveFieldB 0.0 [0.0, 0.0] -> no
- hypothesis {"dumpWindow":10,"kappaLo":0.7} -> liveField 0.0 [0.0, 0.0]; liveFieldB 0.5 [-0.5, 1.5] -> no
- hypothesis {"dumpWindow":10,"greedMinSeats":3} -> liveField 0.0 [0.0, 0.0]; liveFieldB 0.0 [0.0, 0.0] -> no
- hypothesis {"dumpWindow":10,"endWindow":0} -> liveField 0.0 [0.0, 0.0]; liveFieldB 0.0 [0.0, 0.0] -> no
- hypothesis {"dumpWindow":10,"incomeShare":0.25} -> liveField 4.0 [-3.1, 11.1]; liveFieldB 2.0 [-5.3, 9.3] -> no
- hypothesis {"dumpWindow":15} -> liveField 0.0 [0.0, 0.0]; liveFieldB 0.0 [0.0, 0.0] -> no
- hypothesis {"dumpWindow":10,"denyScale":1.15} -> liveField 0.0 [0.0, 0.0]; liveFieldB 0.0 [0.0, 0.0] -> no
- guards {"earlyScale":0.7,"endWindow":20,"endKappaLo":1.6,"greedMinSeats":3,"baitRatio":0.9,"baitShade":0.85}: lobbySims 100.0 vs 100.0; baitSpiteH2H 90.5 vs 92.5; baiterTable 28.0 vs 73.0; baiterH2H 90.0 vs 86.0 -> fail (baiterTable)
- sim 23.6 min, 200 paired seeds, 4 workers
- promoted? no (nothing beat the parent and passed the guards)
- iteration 24.4 min

### Losses diagnosed 2026-11-08T02:20:17.247Z (live-only)

#### Loss 45749 (arm hg-loose): rank 3/6, 6 real, reward 0.10

- winner Pegasus v5: 134 pts, 2 bingos, 22 letters @ 10.0, 14 left, words CONQUIAN VOLVATE HUGGED OE FEE
- us Malicious: 57 pts, 0 bingos, 8 letters @ 16.8, 23 left, words WACKES MISATE; gap 77
- unspent 23, unplayed 1 tiles / value 1, min balance 1st half 14
- near misses 11 (E#17 12->13 Lexiconda, O#40 4->5 Pegasus v5, N#42 4->6 Pegasus v5, V#54 11->11 Pegasus v5, V#55 13->13 Pegasus v5, H#59 14->14 Pegasus v5, I#60 2->4 Pegasus v5, U#62 3->4 Pegasus v5); overpays 0; winner's uncontested cheap wins 0
- hypothesis **opponent-mispriced** (strength 1.00): we paid 16.8/letter vs winner 10.0 (x1.68); 0 overpays; Pegasus v5 paid 10.0/letter vs 12.9 in the book
- hypothesis **lost-key-letters-to-Pegasus v5** (strength 0.75): 4 key-letter near misses (<= 2 coins: V@11 vs 11, V@13 vs 13, H@14 vs 14, F@25 vs 23) vs 1 key letters won; mostly to Pegasus v5

#### Loss 45774 (arm hg-loose): rank 3/6, 6 real, reward 0.10

- winner Pegasus v8: 135 pts, 2 bingos, 21 letters @ 10.9, 6 left, words ZOMBIFIES HELPING RAWIN NET IT
- us Malicious: 75 pts, 1 bingos, 13 letters @ 11.2, 30 left, words DILUENT RIOJA ACTIVE; gap 60
- unspent 30, unplayed 0 tiles / value 0, min balance 1st half 7
- near misses 21 (O#0 8->9 RackMaw-Volume85, D#14 13->13 Astronaut, W#18 19->19 RackMaw-Volume85, A#20 9->11 RackMaw-Volume85, A#21 10->11 RackMaw-Volume85, B#34 11->11 RackMaw-Volume85, Y#38 14->14 RackMaw-Volume85, G#40 8->8 RackMaw-Volume85); overpays 0; winner's uncontested cheap wins 0
- hypothesis **overspent-early** (strength 0.65): balance fell to 7 before auction 34 of 68
- hypothesis **underspent-hoarded-cash** (strength 0.60): 30 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Pegasus v8** (strength 0.50): 4 key-letter near misses (<= 2 coins: W@19 vs 19, Y@14 vs 14, F@12 vs 12, H@12 vs 12) vs 2 key letters won; mostly to Pegasus v8

### Live cycle 2026-11-08T02:20:17.247Z: parent `harvest2` (posterior 0.336, 8 plays)

- losses analysed: 45749, 45774
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s

### Losses diagnosed 2026-11-08T02:23:47.381Z (live-only)

#### Loss 45787 (arm hg-tight): rank 5/6, 6 real, reward 0.00

- winner Mavvy: 118 pts, 2 bingos, 15 letters @ 13.1, 22 left, words DEUTZIA CAIQUES BEEF
- us Malicious: 67 pts, 1 bingos, 11 letters @ 13.9, 14 left, words IMPALES ENTOMB JO; gap 51
- unspent 14, unplayed 1 tiles / value 1, min balance 1st half 11
- near misses 11 (U#0 7->9 RackMaw-Volume85, U#2 8->9 Mavvy, E#4 8->9 Astronaut, E#15 10->11 RackMaw-Volume85, A#16 9->11 Mavvy, V#19 16->17 RackMaw-Volume85, E#28 16->16 Astronaut, G#30 14->15 Astronaut); overpays 1 (I#25 14 vs ~8); winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-RackMaw-Volume85** (strength 0.50): 3 key-letter near misses (<= 2 coins: V@17 vs 16, X@23 vs 23, Y@14 vs 12) vs 1 key letters won; mostly to RackMaw-Volume85

#### Loss 45800 (arm harvest2): rank 6/6, 6 real, reward 0.00

- winner Mavvy: 105 pts, 2 bingos, 15 letters @ 11.8, 28 left, words QUICHES AMUSING DROIT
- us Malicious: 45 pts, 1 bingos, 6 letters @ 17.5, 40 left, words FLAVORS LOAN; gap 60
- unspent 40, unplayed 0 tiles / value 0, min balance 1st half 100
- near misses 28 (Y#8 18->19 Astronaut, S#13 10->12 RackMaw-Volume85, J#22 25->27 RackMaw-Spend115, H#24 19->21 Astronaut, R#26 8->10 RackMaw-Volume85, L#27 9->9 RackMaw-Volume85, I#30 7->8 Mavvy, S#32 11->11 Mavvy); overpays 1 (L#66 33 vs ~10); winner's uncontested cheap wins 0
- hypothesis **opponent-mispriced** (strength 0.81): we paid 17.5/letter vs winner 11.8 (x1.48); 1 overpays; Mavvy paid 11.8/letter vs 12.6 in the book
- hypothesis **underspent-hoarded-cash** (strength 0.80): 40 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Astronaut** (strength 0.75): 4 key-letter near misses (<= 2 coins: Y@19 vs 18, J@27 vs 25, H@21 vs 19, W@17 vs 17) vs 1 key letters won; mostly to Astronaut

#### Loss 45812 (arm hg-loose): rank 6/6, 6 real, reward 0.00

- winner RackMaw-Spend115: 102 pts, 1 bingos, 11 letters @ 16.9, 16 left, words QUIXOTE THIEF JO NU
- us Malicious: 57 pts, 2 bingos, 9 letters @ 11.3, 55 left, words ACRIDER PITEOUS; gap 45
- unspent 55, unplayed 0 tiles / value 0, min balance 1st half 67
- near misses 29 (E#2 8->10 Pegasus v8, O#6 9->9 Lexicoin, A#7 8->9 Lexicoin, E#8 8->9 Astronaut, S#9 8->10 Astronaut, K#17 31->31 Lexicoin, W#21 13->15 Astronaut, V#25 13->15 Astronaut); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 1.00): 55 coins unspent at the end (>= 25)
- hypothesis **lost-key-letters-to-Astronaut** (strength 1.00): 4 key-letter near misses (<= 2 coins: K@31 vs 31, W@15 vs 13, V@15 vs 13, W@15 vs 13) vs 0 key letters won; mostly to Astronaut

### Live cycle 2026-11-08T02:23:47.381Z: parent `dump` (posterior 0.328, 8 plays)

- losses analysed: 45787, 45800, 45812
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s

### Losses diagnosed 2026-11-08T02:27:47.522Z (live-only)

#### Loss 45825 (arm hg-tight): rank 3/6, 6 real, reward 0.10

- winner Lexicoin: 84 pts, 2 bingos, 13 letters @ 13.6, 7 left, words VELVETY ARAPAIMA
- us Malicious: 76 pts, 1 bingos, 11 letters @ 14.5, 16 left, words CARBINE ZEROES FUR; gap 8
- unspent 16, unplayed 0 tiles / value 0, min balance 1st half 100
- near misses 20 (R#5 8->10 Pegasus v8, S#11 8->9 cosine, U#12 8->9 Sepcis, I#13 8->9 Lexicoin, E#21 8->10 cosine, R#22 7->9 Lexicoin, R#25 9->9 cosine, I#26 9->9 Sepcis); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-cosine** (strength 0.25): 3 key-letter near misses (<= 2 coins: J@25 vs 23, X@22 vs 22, H@18 vs 18) vs 2 key letters won; mostly to cosine

#### Loss 45837 (arm hg-loose): rank 4/6, 6 real, reward 0.00

- winner RackMaw-Spend115: 109 pts, 1 bingos, 13 letters @ 15.2, 12 left, words ZYGOTES QUAINT VANG
- us Malicious: 69 pts, 2 bingos, 14 letters @ 10.9, 16 left, words IMPASSE OPALINE OKE AI; gap 40
- unspent 16, unplayed 0 tiles / value 0, min balance 1st half 42
- near misses 20 (R#1 7->9 cosine, S#3 8->9 RackMaw-Spend115, R#4 6->8 cosine, L#5 7->7 cosine, O#7 5->7 RackMaw-Spend115, N#9 6->8 RackMaw-Blend25, G#12 8->10 RackMaw-Blend25, I#13 4->6 cosine); overpays 1 (I#66 32 vs ~8); winner's uncontested cheap wins 0
- hypothesis: unexplained (no rule fired; random perturbation only)

#### Loss 45848 (arm harvest2): rank 5/6, 6 real, reward 0.00

- winner LexForge-CashLiquid03-v1: 139 pts, 2 bingos, 14 letters @ 15.9, 17 left, words JACQUARD TOXEMIA LOWS
- us Malicious: 57 pts, 1 bingos, 7 letters @ 13.3, 64 left, words PURVEYED ANIL; gap 82
- unspent 64, unplayed 0 tiles / value 0, min balance 1st half 100
- near misses 10 (T#20 8->10 rackpilot-live, T#27 9->10 rackpilot-live, I#40 9->9 RackMaw-Spend115, L#41 12->12 exzell, T#46 11->11 LexForge-CashLiquid03-v1, O#49 10->11 LexForge-CashLiquid03-v1, B#50 14->15 exzell, O#52 11->11 exzell); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 1.00): 64 coins unspent at the end (>= 25)

### Live cycle 2026-11-08T02:27:47.522Z: parent `dump` (posterior 0.335, 8 plays)

- losses analysed: 45825, 45837, 45848
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s

### Losses diagnosed 2026-11-08T02:30:47.597Z (live-only)

#### Loss 45859 (arm hg-tight): rank 5/6, 6 real, reward 0.00

- winner Karppa: 94 pts, 1 bingos, 12 letters @ 14.4, 21 left, words OPAQUES MOTIVE GUNK
- us Malicious: 54 pts, 2 bingos, 11 letters @ 12.0, 22 left, words TAHINIS READERS; gap 40
- unspent 22, unplayed 2 tiles / value 9, min balance 1st half 18
- near misses 16 (A#2 9->11 benoit, I#9 6->8 benoit, O#10 8->8 benoit, E#11 10->10 benoit, E#12 10->11 benoit, R#14 13->13 benoit, Z#17 50->52 cosine, T#19 10->10 benoit); overpays 0; winner's uncontested cheap wins 0
- hypothesis **words-not-cashed** (strength 0.56): unplayed rack 'AJ' (2 tiles, value 9)

#### Loss 45870 (arm dump): rank 5/6, 6 real, reward 0.00

- winner Karppa: 113 pts, 2 bingos, 13 letters @ 15.6, 10 left, words HEXEREI TACKIFY ID OE
- us Malicious: 58 pts, 1 bingos, 11 letters @ 13.0, 15 left, words CYGNETS GENII NO AH; gap 55
- unspent 15, unplayed 0 tiles / value 0, min balance 1st half 18
- near misses 17 (N#0 11->11 monkey, U#2 9->11 monkey, B#4 15->15 rackpilot-live, R#5 12->14 rackpilot-live, T#6 11->11 monkey, U#8 12->12 monkey, E#9 10->11 rackpilot-live, O#11 11->11 monkey); overpays 0; winner's uncontested cheap wins 0
- hypothesis **lost-key-letters-to-cosine** (strength 0.25): 3 key-letter near misses (<= 2 coins: Y@21 vs 19, Z@28 vs 28, J@24 vs 22) vs 2 key letters won; mostly to cosine

#### Loss 45881 (arm late-table): rank 4/6, 6 real, reward 0.00

- winner RackMaw: 133 pts, 2 bingos, 17 letters @ 11.6, 36 left, words QUARTIC PONTIFF AVOWED UT
- us Malicious: 75 pts, 2 bingos, 15 letters @ 9.7, 30 left, words BINOCLE ROYALTIES AERO; gap 58
- unspent 30, unplayed 0 tiles / value 0, min balance 1st half 22
- near misses 25 (H#0 22->22 LexForge-BidAck-v1, U#2 7->8 Pegasus v6, E#6 10->10 Pegasus v4, S#7 15->15 Pegasus v6, N#8 11->11 Pegasus v6, G#13 13->13 LexForge-BidAck-v1, U#18 7->7 RackMaw, T#21 9->9 RackMaw); overpays 0; winner's uncontested cheap wins 0
- hypothesis **underspent-hoarded-cash** (strength 0.60): 30 coins unspent at the end (>= 25)

### Live cycle 2026-11-08T02:30:47.597Z: parent `hg-loose` (posterior 0.318, 5 plays)

- losses analysed: 45859, 45870, 45881
- mode: live-only (no sim gate); capacity 0 (untested cap 2, pool cap 6, retire at >= 8 plays)
- no room for new arms: skipped adding
- cycle 0.0 s
