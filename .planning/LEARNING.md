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
2. **Diagnose** each new lost match (rank > 1 and not a shared top score). The cycle reports who
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
   One step is 15% of the knob's range. Every value is clamped to its range
   (`src/learn/cycle/knobs.ts`). Some knobs are set by a built-in profile: kappaHi, reserve,
   floorA and floorB. An arm param overrides every profile, so the cycle moves these only when
   the incumbent already sets them. Otherwise their direction goes to a relative knob:
   kappaHi to lambdaScale, reserve to incomeShare, floors to tableScale.
4. **Sim gate (the no-regression rule).** Each candidate is compared with the incumbent on paired
   seeds: same seeds, same seat rotation, same letters. The lineups are `lobbyNow`, `lobbySims`,
   `fullTable`, `tricks` and a **live mirror** built from the opponents met in the last 20 live
   matches. LUCENT, Bron, maverick-bot, K-13, Lionel and other known bots map to their clones.
   Sims map to `sim:<Strategy>`. Profiled bots map to `profile:<Name>`, and anything else maps to
   `clone:fieldVolume`. Defaults: 200 seeds per lineup, 4 workers, 200 ms decision budget (the
   same budget as the bench). The incumbent is simulated once and shared by all candidates. A
   candidate passes when all of these hold:
   - the pooled rank delta (candidate - incumbent) has a 95% CI upper bound <= 0.05;
   - no lineup is significantly worse (per-lineup CI lower bound <= 0);
   - the mean rank on the live mirror strictly improves;
   - the candidate's lobbySims win rate is >= 98%.
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

---
