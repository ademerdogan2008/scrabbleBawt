# scrabbleBawt

A competition bot for [ScrabbleBot](https://github.com/clockworklabs/scrabblebot), Clockwork Labs'
letter-auction word game on SpacetimeDB (maincloud database `scrabblebot`).

Every second one letter goes up for a sealed-bid auction (Vickrey by default). Bots spend coins to
win letters and cash words for `floor(sum(letter values) x length multiplier)`, where the
multiplier is 1 / 1.5 / 2 / 2.5 / 3 for words of up to 3 / 4 / 5 / 6 / 7+ letters. The reward is
added to both balance and score. The highest score at the end wins.

**Bawt** is a Monte-Carlo, budget-paced, opponent-modelling bidder. One TypeScript `Policy` runs
unchanged in a rules-exact simulator and in the live SpacetimeDB client.

## Demo

```bash
npm ci

# 1. Benchmark in the simulator (about 1-3 min): Bawt vs sims, starter bots and 15 opponent tables
npm run demo:bench

# 2. One full match on the OFFICIAL game module, on a local SpacetimeDB 2.12 server (loopback only).
#    Bawt vs clones of LUCENT, Bron and maverick (today's live lobby), plus 2 sims. About 2.5 min.
npm run demo:local

# 3. Shadow a LIVE maincloud match: Bawt decides every auction, submits nothing (anonymous).
npm run demo:shadow

# 4. Live play on maincloud (needs BOT_TOKEN in .env; the guard blocks game reducers otherwise)
ALLOW_MAINCLOUD_PLAY=1 npm start
```

`demo:local` needs the pinned spacetime CLI 2.12.0. See `e2e/README.md`.

## Results (2026-11-07, Bawt v1)

### Simulator (200 matches per row, paired seeds, 95% Wilson CI)

| table | Bawt win % | avg rank | Bawt score | best opponent (win % / score) |
|---|---|---|---|---|
| 5 server sims (lobby) | 100.0 [98.1, 100] | 1.00 | 383 | 0.0 / 0 |
| 5 starter bots | 100.0 [98.1, 100] | 1.00 | 374 | 0.0 / 11 |
| heads-up vs starter (88 auctions) | 100.0 [98.1, 100] | 1.00 | 500 | 0.0 / 11 |
| tricks: all-in spoiler, shadow price-pusher, bottom-feeder | 96.0 [92.3, 98.0] | 1.04 | 192 | 3.5 / 93 |
| tricks: late hoarder, jitter, sniper, end-game dumper | 84.0 [78.3, 88.4] | 1.16 | 183 | 16.0 / 118 |
| heads-up vs spite bidder (88 auctions) | 92.5 [88.0, 95.4] | 1.07 | 368 | 7.5 / 124 |
| heads-up vs K-13 clone (88 auctions) | 72.5 [65.9, 78.2] | 1.27 | 261 | 28.0 / 222 |
| lobby: LUCENT + Bron + maverick clones + 2 sims | 72.0 [65.4, 77.8] | 1.36 | 128 | 14.0 / 87 |
| FieldBot families | 64.5 [57.6, 70.8] | 1.58 | 81 | 13.0 / 56 |
| tricks: spite, hoarder, random + LUCENT clone | 56.0 [49.1, 62.7] | 1.71 | 119 | 21.0 / 95 |
| profile-driven clones (LUCENT, Bron, K-13, Lionel, Lala) | 31.0 [25.0, 37.7] | 2.65 | 80 | 19.5 / 71 |
| community clones (lambi, blackswan, ...) | 17.5 [12.9, 23.4] | 2.71 | 73 | 73.0 / 104 |
| **6 real: K-13, Lionel, Nijello, Lala, Waupus clones** | **8.0 [5.0, 12.6]** | **4.01** | 70 | 34.0 / 88 |
| same table, first-price auctions | 3.5 [1.7, 7.0] | 4.59 | 59 | 46.0 / 101 |

**Known weakness:** Bawt v1 is strong in sim-padded lobbies, against trick bots and heads-up, but
below chance (16.7%) at 6-bot tables of strong real-bot clones. The live maincloud lobby is now
mostly real bots, so this is where the continual-learning loop (below) focuses.

### Official module, local server (1 match)

| bot | policy | score |
|---|---|---|
| e2e1 | **bawt** | **111 (#1)** |
| e2e2 | clone:lucent | 90 |
| e2e4 | clone:maverick | 88 |
| e2e3 | clone:bron | 72 |
| 2 sims | server sims | 0 |

The run had 0 rejected bids or words and 0 timing errors. The client's score equals the server's.

### Live maincloud shadow (match 42901, read-only)

Bawt made 133 decisions on live traffic, 0 of them past the deadline, with 0 policy errors.
Decision time was p50 1.2 ms and p99 28 ms. The replayed state equals the live state, with all
diagnostics 0.

## How Bawt plays

For each auction (letter L, rack R, balance B):

1. **Valuation.** A Monte-Carlo estimate `V_mc = E[Pack(R+L+F) - Pack(R+F)]` over sampled futures
   F. It uses an exact word packer (best set of disjoint words) and common random numbers. `V_mc`
   is blended with a precomputed marginal-value table that covers the rest of the match.
2. **Pacing.** A multiplier κ in [0.6, 2.5] sets spend against a model of the field's clearing
   prices. That model is exact for server sims (their strategy, ±2 jitter and balance cap) and
   learned online for real bots, starting from priors fitted on 25,598 historical matches.
3. **Bidding.** `bid = clamp(floor(max(V·κ, floor)) + denial ± jitter + tie nudge, 0, B)`.
   Against a rank-relevant real rival in Vickrey auctions, Bawt drives the price up (K-13 style).
   In first-price auctions it shades the bid: `argmax_b (v - b)·P(win | b)`.
4. **Words.** Bawt cashes 7+ letter words immediately (3x multiplier). It cashes 5-6 letter words
   only when it needs liquidity. Every remaining word is flushed before the match ends.
5. **Endgame.** Bawt goes all-in on the last useful auction and bids 0 on the final letter, which
   can never be played.
6. **Defenses.** Bawt is tested against all-in spoilers, price-pushers, bottom-feeders, late
   hoarders, end-game dumpers, snipers, spite bidders and a simulator-only RNG-exploiting denier.

Bawt plays fair. It never reads `visible_auction_top_bids` and it does not exploit the server's
timestamp-seeded RNG.

## Layout

| path | contents |
|---|---|
| `src/core` | exact rules: letters, scoring, racks, seeded RNG, sim-bot formulas, shared types |
| `src/engine` | dictionary (module wordlist), anagram trie, exact + fast word packers |
| `src/state` | `MatchTracker`: balances, racks, hidden tiles, unseen pool from public events |
| `src/sim` | rules-exact match simulator, parallel tournament runner, stats (Wilson CI, OpenSkill) |
| `src/history` | historical data fetch, validation (0 mismatches over 25.6k matches), profiles, replay |
| `src/client` | live SpacetimeDB client: guarded reducers, clock sync, anytime bids, reconnect, shadow |
| `src/bots` | `bawt/` (the bot), baselines, community and top-bot clones, trick bots, named lineups |
| `e2e` | local official-module harness |

## Tests

```bash
npx tsc --noEmit && npx vitest run      # 384 tests
```
