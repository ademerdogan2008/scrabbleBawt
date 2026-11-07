# Strategy Research: Championship ScrabbleBot Bot

**Researched:** 2026-11-07
**Mode:** quantitative strategy analysis. Every number below comes from an experiment we ran, from the live DB, or from the official code (cited `file:line`).
**Overall confidence:** MEDIUM-HIGH.
- Rules and the dictionary/packing math are HIGH. They are exact computations on the real code and wordlist.
- Live-field statistics are HIGH for the measured window and MEDIUM as forecasts.
- Simulated policy comparisons are MEDIUM. The rules are faithful, but the opponents are our own archetypes, and the results depend on the field (section 9).

Experiment code and raw outputs live in `scratchpad/strategy_lab/`. Full path: `/private/tmp/claude-501/-Users-adem-Documents-GitHub-scrabbleBawt/f0cb5422-db12-4105-b246-d1edf5490e36/scratchpad/strategy_lab/`. It contains `scripts/` (our code), `results/` (outputs) and `dl_sql/` (live-DB pulls: matches 41000-42655, 1,656 matches, 112,631 auctions, 24,379 words). Sibling docs cover rules (RULES.md), rival bots and their clone specs (COMPETITORS.md), history (HISTORICAL.md), pitfalls (PITFALLS.md), stack (STACK.md) and architecture (ARCHITECTURE.md). This file is the "how to win" synthesis.

---

## 0. TL;DR: the decisions that matter, ranked by measured impact

| # | Decision | Measured effect (simulator unless noted) | Confidence |
|---|----------|-------------------------------------------|------------|
| 1 | **Bid on value, and scale bids by how much money we have (pacing factor κ ≥ 1 when rich).** Bids must exceed the letter's raw score value whenever money is plentiful, because leftover balance is worth 0 (`game.ts:721-725`; score ranks, balance doesn't). | Removing pacing (κ = 1): about 55 pts vs about 130 in 3-bot fields, and about 30 vs about 90 in 6-bot fields (league 3, `P6F`). Too timid (l0 0.8): -13 pts. | HIGH |
| 2 | **Value letters with the real end-game marginal packing value, not face value.** A 1-point letter is worth about 5-7 pts at the end, Z about 21-29, Q about 2.5 (small rack) to 22 (20 letters) (section 4.2). The live leader's winning bids follow this curve: Bron ≈ 2.48·face + 4.64. | A static bidder on this curve (2.5·face + 3 or 4) placed 1st in every 2-bot, 2-bot + 4-sim and 3-bot league (8-11 strategies each). Planners whose valuations were biased low lost (section 9). | HIGH (values), MEDIUM (policy) |
| 3 | **Cash 7+ letter words immediately. Never cash 4-6 letter words early except for liquidity.** | Cashing 6-letter words immediately: -34 vs sims, -19 in 3-bot fields. Holding 7-letter words for 8+: -11. | HIGH |
| 4 | **Final flush.** When the last auction opens (`bag_total == 0`), submit the optimal packing of the whole rack. The final auction's letter is useless to us (`game.ts:617-628`). | No flush: -25 pts vs sims, -26 in 3-bot fields. | HIGH |
| 5 | **Rack-specific valuation quality** (unbiased Monte Carlo, exact packer). | Better MC (S16/H16): +5 to +9 (3-bot), +6 (6-bot), +40 (heads-up). Worse MC (S4/H8): -14. A greedy-packer MC is biased low by 0.5-3.7 pts per letter (section 7.3), and that bias caused an underbidding spiral (section 9.3). | HIGH |
| 6 | **Against sims, buy nearly everything.** The price to beat all sims averages 5.38 coins (section 3.2). | A bot alone with 5 sims scores 357-368, vs the live Bron's 270 average in such matches. Our default pacing reached only 296. | HIGH |
| 7 | **Denial only when it is cheap and the game is heads-up (finals).** Never in 6-bot fields. | Heads-up vs a low bidder: +95 to +118 pts, 83-85% wins. Heads-up vs disciplined bidders, denial-heavy variants lose (league 1 `P4`, 26% win rate). 6-bot fields: -3 pts. 3-bot fields: about +9 (deny 0.5). | MEDIUM |
| 8 | **Money discipline in heads-up.** With no sims, a broke bot hands every remaining letter to its rival at price 1 (`game.ts:572`). | Static bidder PUSH3 won 90-96% of heads-up games (leagues 2-3). PUSH won 50-89%. Denial-heavy over-spenders won 12-26% (league 1). | MEDIUM |
| 9 | **Anytime bidding.** Submit a table bid at once (≤1 ms), then refine and resubmit. Bids are replaceable until `closes_at` (`index.ts:797-801`, `game.ts:828-847`). | Avoids missed auctions. Rivals react in 50-290 ms (live). | HIGH |
| 10 | **Defend against tricks by bidding truthfully** (value × κ). Truthful bidding caps the damage any pusher can do. All-in bidders self-destruct: the all-in archetype scored 32 vs 130-160 for others. | Section 10. | MEDIUM-HIGH |

**Recommended core policy ("HYB-κ"), described in full in section 11:**

`bid = clamp(⌊max(V̂ · κ, floor)⌋, 0, balance)`

- `V̂` = a blend of the rack-adjusted end-game marginal table and an unbiased MC estimate. MC dominates when the remaining horizon is short.
- `κ` = budget pacing from a clearing-price model.
- `floor` = 2.5·face + 3 to 4, but only for letters that are useful to our rack.

This hybrid was the most robust across 2-bot, 2-bot + 4-sim, 3-bot + 3-sim and 6-bot leagues. It placed 1st-4th in 10 of 11 league results; the exception was 6th of 8 in league 1's 6-bot field. Its sibling COMBO placed 2nd-6th. Pure static bidders were best in small lobbies but collapsed in 6-bot fields (last of 8, and 11th of 11).

---

## 1. Rules that shape strategy (verified in code)

| Fact | Code | Strategic consequence |
|------|------|-----------------------|
| Start balance 100. Auction 1000 ms. Reserve 1. Lobby 6. Lobby timeout **90 s** (docs say 60). Rack 5. | `game.ts:48-65`; `matchmaker_config` table empty live → defaults (`game.ts:69-77`) | 98 − 5N auctions: N=6 → 68, N=2 → 88, a 7-seat tournament table → 63. |
| Ties: shuffle, then stable sort, so the tie-break is random | `game.ts:555-560` | 12.7% of live auctions have top bid == paid (live). A +1 nudge wins ties outright. |
| Vickrey: pay the 2nd bid, or min(1, bid) if alone. FirstPrice: pay own bid. | `game.ts:565-574` | Truthful bidding is the baseline. FirstPrice needs shading (section 3.6). |
| Bids of 0 are ignored. A bid must be ≤ current balance. Bids are replaceable until `closes_at`. | `game.ts:556`, `index.ts:807-809`, `index.ts:797-801` | A bid of 0 cancels. Use anytime refinement. |
| **Unbid letters are consumed** (docs claim they return to the bag) | `drawLetter` `game.ts:744-765`; nothing re-adds | Every tile that leaves the bag is gone. Bag accounting = 98 − all auctioned − all dealt. |
| Reward = ⌊Σface × mult⌋, with mult 1/1/1.5/2/2.5/3 for lengths ≤3/4/5/6/7+. The reward goes to **both** balance and score. | `letters.ts:75-81`, `game.ts:713-725` | Money is only instrumental. Leftover balance is worth 0 at the end. |
| The match ends inside the transaction that closes the last auction | `game.ts:617-628` | The last letter is worthless to real bots. Sims can use it, because they play inside `closeAuction` (`game.ts:613-615`). |
| `submit_word` needs status Running | `index.ts:823-825` | The final flush must land before the last auction closes. |
| Sims bid at auction open: `max(min(max(base+j,1),balance),0)` with j uniform on −2..2. Cheapskate base = face−1, ValueBidder = face, Aggressive = face+2 (consonant) or face+4 (vowel). | `game.ts:771-825` | Exact price-to-beat tables (section 3.2). |
| A sim plays one word, the longest of 3+ letters (ties lexicographic), right after each auction it wins | `game.ts:849-869`, `dictionary.ts:63-106` | Sims score about 2-25 pts. They never threaten rank. They are price floors and absorbers. |
| `visible_auction_top_bids` shows top bids of **closed** auctions in **running** matches to any identity without a bot credential | `index.ts:114-137`, inserted at `game.ts:600-607` | Rivals can learn our winning bids live with a second connection. Assume our bid curve leaks. |
| The RNG is seeded from the transaction timestamp | `game.ts:201-205` comment. RULES.md §4 and STACK.md §8 verified a replay of all 25,546 matches. | Hidden deals and sim jitters can be reconstructed from public rows. User decision needed (section 10.8). |
| Ranking uses OpenSkill Plackett-Luce on final score. Ties share a place. | `game.ts:458-521`, `ratings.ts:50-87` | Roughly linear in place (section 6). |
| Tournaments: Swiss points = matchSize − place. Bracket knocks out last place. Final = 3 games, summed score. The auction type comes from the tournament. | `tournament.ts:380-395`, `304-337`, `133`, `341-372`, `182`, `266` | Three different objectives (section 6.3). |

---

## 2. The live field (window: last 1,656 matches, up to 2026-11-07 19:48 UTC)

- **Composition** (real bots per match): 3 real 743 (45%), 2 real 701 (42%), 1 real 138 (8%), 4 real 74. Bron is in **all 1,656**. maverick-bot is in 912, LUCENT 690, Afterword 597 (scores 0, a dead bot), hinsonloo 209. **If we join, almost every match is us + Bron + 0-2 others + sims.**
- **Scores in the window:**
  - Bron 214 avg (final balance 103, so money is wasted).
  - LUCENT 157 (balance 31).
  - maverick-bot 138 (balance 25).
  - Sims: Aggressive about 18-25, ValueBidder 3-6, Cheapskate 1-4.
- **Winning score by number of real bots:** 1 → 270, 2 → 267, 3 → 190, 4 → 176.
- **Head-to-head:** LUCENT beats Bron 62% (429/690) and maverick 75%. maverick beats Bron 29%. Bron's high average comes from sim-padded games. LUCENT is the strongest per game.
- **Bid curves** (median winning top bid fit on face value; archive data):
  - Bron ≈ **2.48·face + 4.64** (vowel IQR 6-12).
  - LUCENT ≈ **3.21·face + 6.30** (7-14).
  - maverick ≈ **2.95·face + 6.73** (8-17).
- **All-in-ish wins** (top bid ≥ 0.9·balance and ≥ 20): Bron 1.5% of its wins, LUCENT 4.5%, maverick 9.7%. Bron's top bids reach 313.
- **Words:** Bron plays 5.9 words/match, LUCENT 4.4, maverick 4.2.
  - Bron gets 70.5% of its reward from 7-letter words and 17.3% from 8-letter words. maverick gets 20% from 6-letter words, which is suboptimal (section 5).
  - 24% of Bron's words land in the final window, 2% of LUCENT's.
- **Reaction latency in the final window** (word `played_at` minus the 67th close): Bron p50 115 ms (p90 123), LUCENT 53 ms, maverick 288 ms (p90 479, max 803).
- **Auction spacing:** p50 1001.4 ms, p99 1003.9 ms, max 1637 ms. The schedule is very regular.
- **Prices rise late in competitive games.** With 3 real bots, mean paid for vowels goes 5.7 → 5.3 → 6.7 → 9.0 by quarter. 1-point consonants go 4.8 → 8.6. JQXZ stay flat at about 22.
- **Bron leaves letters to sims early.** In 1-real matches the real bot wins 47% of auctions in quarter 1 and 75% in quarter 4. That is the 270-point ceiling we beat in section 3.3.
- **Money per 3-real match:** paid 558, word rewards 413, leftover 454 (mostly the sims' unspent 100s).
- **RNG check:** auctioned-letter frequencies pooled over all rounds are uniform (χ² 33.9, 25 df). Round-1 letters are skewed (χ² 89.5; X 2.07×, P 1.69× expected). This is consistent with timestamp seeding.

---

## 3. Economics

### 3.1 Supply and money

- Auctions = 98 − 5N. The last one is useless to real bots, so there are **67 usable auctions in 6-seat games** and 87 heads-up.
- Mean face value per tile = 187/98 = 1.908, and 3× = 5.72. Total face of the bag = 187.
- Money supply = 100N + Σ word rewards (live 3-real games: about 1,013 coins in total).
- Real bots spend about 210-230 coins per match. Bron's spend is 100 + 214 − 103 = 211. LUCENT 226, maverick 213. That converts to about 0.7-1.0 score per coin.

### 3.2 Exact sim bids and the price to beat them (`results/e8_sim_prices.txt`)

Uncapped sim bids per letter, each value with probability 20% unless shown:

- **Cheapskate**, 1-point letter: 1 (80%), 2 (20%).
- **ValueBidder**, 1-point letter: 1 (60%), 2, 3.
- **Aggressive**, vowel: 3-7. 1-point consonant: 1-5. D/G: 2-6. 3-point letter: 3-7. 4-point letter: 4-8. K: 5-9. J/X: 8-12. Q/Z: 10-14.

The sure-win bid against any sim lineup is the Aggressive maximum + 1:

| Letters | Sure-win bid |
|---------|--------------|
| Vowels | 8 |
| L N R S T | 6 |
| D G | 7 |
| B C M P | 8 |
| F H V W Y | 9 |
| K | 10 |
| J X | 13 |
| Q Z | 15 |

**Vickrey price to beat 5 sims** (E[max sim bid], averaged over the 6 possible 5-sim lineups):

| Letters | E[max sim bid] |
|---------|----------------|
| Vowels | 5.53 |
| L N R S T | 3.68 |
| D G | 4.68 |
| B C M P | 5.68 |
| F H V W Y | 6.68 |
| K | 7.68 |
| J X | 10.68 |
| Q Z | 12.68 |

- Averaged over the bag, that is **5.38 coins per auction**. Buying all 67 usable letters costs about 361 coins.
- Win probability at a given bid, for E (5 sims): bid 5 → 34%, bid 6 → 56%, bid 7 → 84%, bid 8 → 100%.
- With 3 sims, E[max] drops by 0.6-1.0 (for example, vowels 4.55, 1-point consonants 3.06), because P(no Aggressive sim) = 20%.

### 3.3 The value of money (λ) and budget pacing

Let `V` = the expected score gain from a letter, and `λ` = the marginal score per coin of balance. The truthful Vickrey bid is `b = V/λ = V·κ`, where κ = 1/λ.

- λ is endogenous. Coins buy letters, letters become words, and words return coins (3× face for 7+ words). At the end of the match λ → 0.
- When money is abundant relative to letter prices, λ < 1, so we bid **above** raw score value. The data agree: every top live bot's winning bids are about 2.5-3.2× face.
- Measured vs 5 sims (100 matches each). The pacing rule `λ = clamp(l0·need/balance, lo, hi)`, with `need = remaining·share·p̄`:

| Pacing | Score | Letters won | Final balance |
|--------|-------|-------------|---------------|
| l0 0.8 | 271 | 44 | 134 |
| default l0 0.5 | 296 | 49 | 135 |
| l0 0.3 | 320 | 54 | 130 |
| l0 0.2 | 334 | 57 | 126 |
| l0 0.1 | 345 | 61 | 118 |
| l0 0.05 | **357** | 62 | 121 |
| l0 0.1 + S16 MC | 357.5 | | |
| hybrid floor + l0 0.1 | **368** | 65 | |

  Against sims, essentially **λ → its floor: buy everything with positive value.** Money never binds after the first ~15 auctions.
- **In competitive fields, aggressive pacing hurts** (3-bot fields, X vs 2 default planners, paired, control ≈ −1.3 ± 3):
  - l0 0.2/lo 0.06: −16.5
  - an "expected income" term that lowers λ: −16
  - income term + deny 0.5: −37
  - l0 0.8 (timid): −14.5
- **Conclusion:** λ must be set by the *field's price level*, not by a constant. The right tool is a clearing-price model (section 8):
  1. For a grid of λ, predict the spend over the remaining auctions: Σ_t E[p_t·1{p_t < V_t/λ}].
  2. Pick the smallest λ whose predicted spend ≤ balance + expected income − reserve.
  - Against sims, spend at any λ is bounded by cheap sim prices, so λ falls to its floor.
  - Against strong bots, spend explodes as λ falls, so λ stays near 0.5-1.
  - This is the standard dual-pacing rule for budget-constrained repeated second-price auctions (Balseiro & Gur style), adapted to endogenous income.

### 3.4 When truthful (value × κ) bidding is and is not optimal here

1. **Optimal for:**
   - single-letter private value with a quasi-linear budget (b = V/λ), and
   - any lineup made only of sims and other value bidders.
   A loser never pays (`game.ts:577-590`), so overbidding your *own* value is the only way to lose money.
2. **Not optimal, or incomplete, because of:**
   - **Complementarities.** A letter's value depends on future wins (the exposure problem). Fix: an MC expectation over futures, not a myopic value.
   - **Externalities / denial.** In rank play, a rival's gain is our loss, so effective value = V_me + w·V_rival. Useful heads-up (w ≈ 1) and only when the price is below the combined value (section 6).
   - **Price-setting.** As runner-up we set the winner's price. Raising a losing bid drains a rival's money, but only matters if that rival is cash-constrained. Bron ends with 103 unspent, so draining him is useless. LUCENT and maverick end with 25-31, so draining them is mildly useful.
   - **Information leakage.** When we are 2nd, `paid` publishes our bid. The spectator view publishes our winning bids. Truthful bids reveal rack needs, so add ±1 jitter on low-stakes letters.
   - **Integer ties** (12.7% of auctions). Bid +1 above a likely integer tie when value permits.

### 3.5 Measured economic shape (simulator, 3 real + 3 sims)

- Strong bots win about 20-26 letters each, spend 190-230 and end with 15-45 coins.
- Scores are 120-150.
- Final rack sizes (letters ever held) are about 25-31. **The n≈20-30 rows of the marginal table (section 4) are the right reference for most of a match.**

### 3.6 First-price (tournaments may use it)

Exact optimal shading vs sims (`results/e11_firstprice.txt`):

- **Never bid above the sure-win bid.** For a high-value letter, bid exactly sure-win: E 8, T 6, D 7, B 8, H 9, K 10, X 13, Z 15.
- Below that, shade. For E vs 5 sims: V=6 → bid 5, V=8 → 6, V=10 → 7, V≥15 → 8.
- First-price surplus vs sims is about half of Vickrey surplus at the same value (E, V=10: 2.5 vs 4.5). If the user approves RNG reconstruction (section 10.8), we know each sim's bid exactly and can bid max+1, which recovers the full Vickrey surplus.
- Against other planners, shading 0.5-1.0× made no significant difference (3-bot, 150 matches each: −2.4/+0.5/+2.4/+0.1 ± 2.5).
- Against real bots, use the revealed winning bids (FirstPrice `paid` = the winner's bid) to fit each rival's bid distribution, then maximize (V − b)·P(win | b).

---

## 4. Letter valuation with the real dictionary (exact)

**Dictionary.** 172,820 words (ENABLE), **156,473 anagram classes**. Classes by length: 2:73, 3:711, 4:2,674, 5:6,303, 6:11,958, 7:19,424, 8:25,434, 9:23,396. Loading takes 215 ms. All words with the same letters score the same, so packing works on anagram classes.

### 4.1 Optimal packing value vs rack size

Random racks drawn from the 98-tile bag; branch-and-bound exact.

| Rack size | 5 | 8 | 10 | 12 | 15 | 16 | 20 | 25 | 30 | 35 |
|-----------|---|---|----|----|----|----|----|----|----|----|
| **Optimal** total reward | 10.2 | 27.5 | 40.8 | 53.4 | 72.6 | 81.7 | 103.6-107.8 | 141.8 | 172.9 | 202.2 |
| Points per letter | 2.0 | 3.4 | 4.1 | 4.5 | 4.8 | 5.1 | 5.2-5.4 | 5.7 | 5.8 | 5.8 |
| Greedy by reward | | | 39.9 | | 64.3 | | 91.8 | 126.2 | 149.6 | 180.5 |
| Greedy longest-word (sim/starter style) | 9.2 | 26.3 | 34.4 | 46.5 | 53.1 | | 80.7 | | | |

- Value is **superlinear up to about 20 letters and then linear at about 5.7-5.8 per letter**. That is about 3× the mean face value: nearly every tile ends up in a 7+ word.
- Greedy-by-reward loses 2-13%. Longest-first greedy loses about 26%.

### 4.2 Marginal value of each letter: V(R+L) − V(R) (`results/e4_summary.txt`)

Common random racks: 400 per size for n ≤ 12, 160 for n = 16 and 20.

| L | face | n=5 | n=8 | n=12 | n=16 | n=20 | ratio to face @20 | used in 7+ @12 / @20 |
|---|------|-----|-----|------|------|------|-------------------|----------------------|
| A | 1 | 5.0 | 5.7 | 6.0 | 4.1 | 6.2 | 6.2 | .44 / .67 |
| E | 1 | 5.1 | 5.6 | 6.2 | 4.3 | 6.0 | 6.0 | .50 / .73 |
| I | 1 | 4.2 | 4.5 | 5.5 | 4.2 | 5.8 | 5.8 | .50 / .76 |
| O | 1 | 4.3 | 4.8 | 5.6 | 3.9 | 5.7 | 5.7 | .44 / .76 |
| U | 1 | 3.8 | 4.3 | 6.0 | 4.6 | 6.6 | 6.6 | .38 / .69 |
| L N R S T | 1 | 3.8-5.3 | 4.5-6.3 | 5.0-6.9 | 3.3-4.9 | 5.6-6.6 | 5.6-6.6 | .38-.53 / .60-.77 |
| D | 2 | 5.3 | 6.6 | 7.2 | 6.2 | 8.5 | 4.2 | .52 / .78 |
| G | 2 | 4.1 | 5.2 | 6.2 | 5.6 | 7.9 | 3.9 | .47 / .77 |
| B C M P | 3 | 5.5-6.1 | 7.3-8.1 | 8.2-9.7 | 8.0-9.4 | 10.8-11.5 | 3.6-3.8 | .50-.72 / .77-.93 |
| F H W Y | 4 | 5.6-7.2 | 6.4-9.5 | 8.6-11.7 | 8.8-11.2 | 12.6-13.9 | 3.2-3.5 | .43-.55 / .89-.95 |
| V | 4 | 4.5 | 6.2 | 7.7 | 8.3 | 11.6 | 2.9 | .45 / .83 |
| K | 5 | 7.5 | 9.6 | 12.4 | 12.5 | 16.4 | 3.3 | .53 / .89 |
| J | 8 | 7.2 | 10.3 | 14.4 | 17.7 | 22.4 | 2.8 | .38 / .88 |
| X | 8 | 8.5 | 11.9 | 16.2 | 19.1 | 23.2 | 2.9 | .48 / .92 |
| Q | 10 | **2.5** | 6.0 | 11.3 | 15.0 | 21.8 | 2.2 | **.29 / .65** (any word .63/.88) |
| Z | 10 | 10.5 | 16.3 | 21.3 | 24.2 | 29.1 | 2.9 | .48 / .97 |

How to read the table:
- The dip at n=16 for 1-point letters is real, not noise. A 16-letter rack is usually 7+7+2, and one more letter rarely completes a third word. At 12 (7+5) and 20 (7+7+6) the next letter often crosses a length threshold. **Marginal value depends on distance to the next word-length threshold (6→7 above all), not just the letter.**
- The n=20 column is almost exactly `2.5·face + 4` (A 6.2 vs 6.5, B 10.8 vs 11.5, H 13.9 vs 14, X 23.2 vs 24, Z 29.1 vs 29). It is also Bron's live bid curve (2.48·face + 4.64).
- **Q** is the only bad letter. It is worth 2.5 in a 5-letter rack and is used in a 7+ word only 29% of the time at n=12. Value it by expected final rack size, and by U ownership.
- **J, X, Z, K** are easy. At n=20 they land in 7+ words 88-97% of the time, so they are worth 2.8-3.3× face.

### 4.3 Vowel balance (marginal value by vowels already in the rack)

| Rack | Vowels already held → value of a new vowel | Vowels already held → value of a new consonant | Balance point |
|------|-----------------------------------------|---------------------------------------------|---------------|
| n=12 | 2 → 12.7, 3 → 8.7, 4 → 7.3, 5 → 5.4, 6 → 4.1, 7 → 3.0, 8 → 1.1 | 2 → 4.5, 3 → 6.9, 4 → 8.6, 5 → 10.1, 7 → 11.6 | 3.5-4 vowels (about 30%) |
| n=20 | 5 → 10.1, 6 → 7.6, 8 → 6.4, 10 → 5.1, 12 → 3.1 | 5 → 8.0, 6 → 10.0, 8 → 13.1 | about 5.5 vowels (about 28%) |

The bag is 43% vowels (42/98). Random holdings are therefore vowel-heavy, so **consonants are usually worth more than vowels**, and the 3rd+ vowel collapses in value.

### 4.4 Duplicates (marginal value by copies already held, n=12)

| Letter | 0 held | 1 held | 2 held | 3 held |
|--------|--------|--------|--------|--------|
| E | 11.5 | 6.3 | 4.4 | 2.6 |
| I | 9.3 | 4.9 | 3.1 | 1.3 |
| U | 8.0 | 3.1 | 1.6 | |
| S | 8.1 | 5.5 | 4.1 | |
| D | 8.4 | 5.5 | 4.9 | |

- Vowel duplicates decay by about 45% per copy, consonant duplicates by 15-35%.
- At n=20 the decay is gentler (E with 1 → 2 → 3 held: 7.9 → 5.9 → 5.8).
- Multipliers used by our rack adjustment: vowels [1, .7, .5, .3, .2], consonants [1, .85, .7, .5, .35].

---

## 5. Word-cashing policy

1. **Play 7+ words as soon as they exist.** 3× is the maximum multiplier, so waiting cannot raise those letters' value. The only cost is losing a different arrangement.
   - Holding 7-letter words to build 8+: −11 pts (vs sims).
   - Live, Bron and LUCENT get 87-91% of their reward from 7+ words.
   - Pick the 7+ word with the best `reward + leave value`. Greedy by highest reward is fine for v1.
2. **Do not cash 4-6 letter words for score.** At the end they are worth the same, and early they block 3× conversions.
   - Cash-6-immediately: −34 (vs sims), −19 (3-bot).
   - maverick-bot does this live (699 six-letter words in 912 matches) and ranks 3rd.
3. **Cash 5-6 words only for liquidity:** balance < about 20 and a high-value auction is likely soon. Measured +4 ± 3 in 3-bot fields (not significant), −1 in 6-bot fields. Keep it as a tunable, default ON at threshold 20.
4. **Final flush.** It triggers when the auction with `bag_total == 0` opens: that is the last auction, and the rack is final.
   - Solve the exact packing. B&B ≤ 9 ms up to 15 letters, median 14 ms (max 390 ms) at 20 letters.
   - Submit all words back-to-back in the first ~100 ms of the 1000 ms window.
   - Precompute the flush packing during the second-to-last auction. Use a time-capped B&B with a greedy incumbent.
   - Measured value: +25 to +27 pts.
   - Bron flushes at p50 115 ms and maverick at 288 ms, so this is safe.
5. **Bid 0 on the last letter.** It is useless to us. Leftover money is worthless anyway, so a denial bid against a sim is harmless but pointless unless that sim ranks near us (it never does).

---

## 6. Rank-aware play

### 6.1 OpenSkill PL payoff by place

Ported from `ratings.ts:50-87`; `results/e_openskill.txt`.

| Bot | Field | Δμ by place 1 / 2 / 3 / 4 / 5 / 6 |
|-----|-------|-----------------------------------|
| Established (μ=62, σ=1) | Bron, LUCENT, maverick + 2 sims | +0.065 / +0.020 / −0.049 / −0.141 / −0.237 / −0.333 |
| New (μ=25, σ=8.33) | same | +5.1 / +4.9 / +4.3 / +2.4 / −2.0 / −7.2 |
| Established | 5 sims | 1st = **+0.009**, 2nd = −0.082 |

- The steps are roughly linear, a little larger at the bottom. So the objective ≈ **maximize expected placement = Σ_rivals P(our score > rival score)**, with mild risk-aversion.
- Beating sims is worth nothing extra; losing to one is costly.
- With one rival that matters, a +1 for us and a −1 for that rival are worth the same. With k equally close rivals, denying one is worth about 1/k of an own gain.

### 6.2 Denial results (simulator, paired)

| Field | Deny weight | Effect |
|-------|-------------|--------|
| Heads-up (88 auctions, no sims), vs default planner | 0.5 | **+94.8 ± 6.3** (83% wins) |
| Heads-up, vs default planner | 1.0 | **+117.8 ± 7.2** (85% wins) |
| 3 real + 3 sims | 0.5 | about +9 vs control |
| 3 real + 3 sims | 1.0 | about +3 |
| 6 real | 0.5 | −2.7 |
| Heads-up league vs disciplined bidders (league 1) | deny 1.0 schedule | **26% win rate**, vs 48% for the same bot without denial |

Why denial fails against disciplined bidders: with no sims to absorb letters, overspending makes the bot go broke, and a broke bot concedes every remaining letter at price 1. **Rule: deny only when `price_pred < V_me + w·V_rival` AND the pacing budget allows. w = 1 heads-up, 0.3-0.5 with 2 rivals, 0 with 4+.**

### 6.3 Tournament modes (different objectives, `tournament.ts`)

- **Swiss:** points = 6 − place, linear (`:380-395`). Same as lobby play: maximize expected place. Total score breaks ties, so maximize score when the place is locked.
- **Bracket:** only last place is eliminated (`:304-337`). Minimize P(last): play risk-averse, keep a cash reserve, and never go broke. Ties for last go to the lower tournament total score.
- **Final:** 3 games heads-up, summed score (`:133`, `:341-372`). This is zero-sum over 264 auctions. Use heads-up mode: full denial when cheap, strict money discipline, and maximize score difference.
- The auction type may be FirstPrice (`tournament.auction_type`), so switch to the shading module (section 3.6).

---

## 7. Algorithms and measured JS performance

Node 24 on a 10-core Mac; `results/e1_dict_enum.txt`, `e2*_*.txt`, `e12_mc_H12.txt`.

### 7.1 Sub-anagram enumeration (all dictionary classes that fit a rack)

| Rack | Classes that fit | Linear scan + 26-bit mask | Trie, alphabetical | **Trie, rare letters first** |
|------|------------------|---------------------------|--------------------|------------------------------|
| 5 | 10 | 296 µs | 5 µs | **4 µs** |
| 10 | 139 | 191 µs | 23 µs | **16 µs** |
| 15 | 728 | 238 µs | 85 µs | **63 µs** |
| 20 | 2,538 | 384 µs | 266 µs | **179 µs** |
| 25 | 6,227 | 570 µs | 590 µs | **395 µs** |
| 30 | 12,564 | 836 µs | 1,076 µs | **776 µs** |
| 35 | 22,655 | 1,266 µs | 1,775 µs | 1,384 µs |

Trie sizes: rare-first 564k nodes (build 79 ms), alphabetical 403k nodes (74 ms). **Use the rare-first trie.** Linear scan only wins at 35+ letters.

### 7.2 Optimal packing

- **Exact memoized DP** (pivot on the highest-value letter: drop it, or use a word containing it): n=12 3 ms, n=15 27 ms, n=18 248 ms, n=20 349 ms (max 1.1 s), n=25 up to 9.5 s. Too slow beyond about 15 letters.
- **Branch and bound** (same pivot; candidate lists inherited from the parent; bound = acc + Σ r_k·face_k·maxMult_k, where maxMult_k is the best length multiplier among still-fitting words containing k; greedy incumbent). Exact on all tests, and identical to the DP on 150 racks.

| Rack | 10 | 15 | 20 | 25 | 30 | 35 |
|------|----|----|----|----|----|----|
| Median | <1 ms | 1 ms | 14 ms | 112 ms | 262 ms | 642 ms |
| Mean | <1 ms | 3 ms | 35 ms | 384 ms | 521 ms | 1,285 ms |
| Max | <1 ms | 9 ms | 390 ms | 4.8 s | 4.5 s | 11.5 s |

  In-game racks are usually ≤15 because we cash 7+ words, so exact packing is affordable. Always run with a node or time cap plus the greedy incumbent. Run it in a worker thread.

### 7.3 Monte Carlo marginal value: V̂(L) = E_F[Pack(R+L+F) − Pack(R+F)]

Setup: F = future winnings, CRN across L, 40 future auctions, 35% win share, horizon H = 12.

| Live rack | ms per pack, greedy | ms per pack, B&B | RMSE at S=16, greedy | RMSE at S=16, B&B | Bias at S=16, greedy | Bias at S=16, B&B |
|-----------|---------------------|------------------|----------------------|-------------------|----------------------|-------------------|
| 0 | 0.033 | 0.65 | 2.56 | 1.39 | **−1.92** | 0.00 |
| 4 | 0.096 | 6.7 | 2.10 | 1.44 | −0.45 | −0.06 |
| 8 | 0.196 | 31.1 | 4.73 | 1.12 | **−3.70** | +0.17 |
| 12 | 0.429 | 112.5 (partly measured under CPU load) | 2.56 | 0.89 | −1.38 | −0.13 |

B&B RMSE at S=32: 0.75-0.93.

- **The greedy packer is 20-260× faster but biased low by up to 34%** (rack 8: true value 10.95). B&B cost grows steeply with rack + future size: about 112 ms per pack at roughly 20-24 letters. Live MC therefore needs a horizon cap (H ≤ 8-12), memoization across samples, and worker threads. In the simulator that bias drove an underbidding spiral (section 9.3).
- **Recommendation:**
  - MC with the exact/B&B packer, S = 16-32, CRN, in a worker thread with a time cap (about 200 ms).
  - Use the calibrated table (section 4.2, interpolated by projected total letters held, rack-adjusted) when the horizon is long.
  - Use MC fully when the remaining future is short (expected future wins ≤ about 6). That is where rack specifics dominate and the packer is fast.
  - **Estimate the win probability for future letters from the price model, never from our own past win share.** Using own share feeds back: lose → value ↓ → bid ↓ → lose.

### 7.4 Anytime bidding timeline (per 1000 ms auction)

| Time after `auction.onInsert` | Action |
|-------------------------------|--------|
| t0 + ~1 ms | Submit the table bid (`V_table·κ`, floor rule) |
| ≤ t0 + 50 ms | Process the previous `auction_result`: update opponent models, κ, bag accounting |
| ≤ t0 + 250 ms | MC refinement, then resubmit only if \|Δbid\| ≥ 1 |
| ≤ t0 + 600 ms | Optional second refinement (more samples, denial term) |
| Hard stop: closes_at − (RTT_p95 + 100 ms) | No more resubmits. The server rejects bids at/after `closes_at` (`index.ts:797-801`). |

The final-auction flush has priority over everything (section 5.4).

---

## 8. Opponent modeling

- **Sims: exact.** The strategy is public (`bot.strategy`), the balance is public (`match_participant`), and the jitter support is known, so we have the full bid distribution (section 3.2). With RNG reconstruction (section 10.8) we would know the exact bid.
- **Real bots: censored observations.**
  - Vickrey publishes only `paid` = the 2nd-highest bid. The winner's bid is ≥ paid. Every other bidder's bid is ≤ paid. Exactly one of them, unknown, is = paid unless it was a reserve sale.
  - FirstPrice publishes the winner's bid exactly.
  - After a match, `auction_top_bid_archive` gives every winner's exact top bid. Over time this is a large offline dataset per rival (Bron plays every match).
- **Model per rival j and letter class c:** log-bid ~ Normal(a_j·log-value-feature + b_j, σ_j). Priors come from the history fits (section 2):
  - Bron 2.48f + 4.64
  - LUCENT 3.21f + 6.30
  - maverick 2.95f + 6.73
  - Update online with interval-censored likelihoods: winner [paid, ∞), losers [0, paid]. Use a particle or grid posterior per (j, c). That is cheap: about 5 parameters × 3 rivals.
  - Add a phase covariate. Prices rise about 60% in the last quarter of 3-bot games.
- **What the model is for:**
  1. κ pacing: the predicted spend curve (section 3.3).
  2. FirstPrice shading: maximize (V − b)·P(max_j b_j < b).
  3. Denial pricing: the predicted price vs V_me + w·V_rival.
  4. Trick detection (section 10).
  5. Rank estimation: rival latent rack value = known won letters (public) minus letters they played, plus 5 hidden tiles, valued at 3 × face × efficiency.

---

## 9. Simulator leagues: what wins depends on the field

**Simulator** (`scripts/sim.mjs`): official rules exactly, namely deal order, draw-by-index over A..Z, sim bids at open with balance caps, random tie-break, sim word play inside close, and match end inside the last close.

**Calibration:**
- Our planner field produces winning top bids close to the live ones (vowels 10-14, JQXZ 29-53, cf. LUCENT).
- Scores in 3-bot games are 125-145.
- The starter bot scores 27 vs 5 sims.

**Strategies:**

| Name | Description |
|------|-------------|
| `PUSH` | Static 2.5·face + 4, cash 7+, final flush |
| `PUSH3` | Same, + 3 |
| `T37` | Static 3·face + 7 with ±3 noise and duplicate halving |
| `P2` | MC planner (greedy packer, H 12) + pacing |
| `COMBO` | P2 + S16/H16 + deny 0.5 + liquidity cash + wider κ |
| `HYB` | COMBO + a static floor (2.5f + 4) on rack-useful letters |
| `P4` | Table/MC blend by horizon coverage + deny schedule |
| `PRLP` | Prior + late MC + pacing |
| `P6` | Interpolated table by projected rack size + exact late MC + κ |

Leagues are random lineups, scored by average place among real bots (0 = first).

| Strategy | Heads-up (L1 / L2 / L3) | 2 real + 4 sims (L4, 1,200 games) | 3 real + 3 sims (L1 / L2 / L3, 800-880 each) | 6 real (L1 / L2 / L3, 200-220 each) |
|----------|-------------------------|-----------------------------------|----------------------------------------------|-------------------------------------|
| PUSH | 0.11 / 0.21 / 0.50 | 0.45 | **0.82 (1st/8) / 0.34 (1st/11) / 0.69 (1st/11)** | **4.86 (last) / 1.38 / 2.80** |
| PUSH3 | - / 0.10 / 0.04 | **0.36 (1st/8)** | - / 0.62 / 1.26 | - / 2.84 / 4.81 |
| COMBO | 0.18 / 0.54 / 0.39 | 0.43 | 0.96 / 0.71 / 0.72 | 1.93 / 0.96 / 1.72 |
| **HYB** | 0.29 / 0.32 / 0.49 | **0.42** | **0.93 / 0.52 / 0.79** | 2.21 / 1.26 / **1.68 (1st/11)** |
| P6 family | - / - / 0.37-0.72 | 0.48-0.63 | - / - / 0.94-1.16 | - / - / 1.76-1.94 |
| no pacing (P6F) | | | 1.91 (55 pts) | 4.52 (30 pts) |

### 9.1 Findings

1. **Static price-setters win small lobbies and lose big ones.**
   - A static bid near the end-game marginal curve (2.5·face + 3 or 4, Bron's live curve) acts as a price floor. Rivals pay it when they want the letter, and the static bidder collects the rest cheaply.
   - Heads-up, PUSH3 won 90-96%.
   - In 6-bot fields where others bid higher, it starves: 18-30 pts, last place.
   - This is rock-paper-scissors. Static bid *levels* are exploitable in both directions.
2. **Rack-aware valuation plus pacing plus a floor (HYB) is the most robust.** It was never last, and placed 1st-4th in 10 of 11 league results (6th of 8 once). COMBO was 2nd-6th. HYB is our recommended core.
3. **Valuation bias is fatal.** MC with greedy packing and a truncated horizon under-values letters. Feeding own win share into the future-win probability compounds it: `PRL` family 53 pts in 3-bot fields vs 111 for a pure table.
4. **Bids must be multiplied by κ > 1 when rich.** The table value alone is too timid (no-pacing variants collapse).
5. **Denial is context-specific** (section 6.2).

### 9.2 Recommendation for the build

Keep the simulator and league as a permanent E2E harness, with the population expanded. Include:
- clones of the live bots: Bron-like PUSH 2.48/4.64 with rack awareness, LUCENT-like 3.21/6.30, and the exact clone specs of Lionel, Nijello, the starter and the sims in COMPETITORS.md §4;
- our own variants.

Tune κ bounds, floor level and denial weights against **the expected live mix**: 42% two-real, 45% three-real, always Bron. Do not tune against a single opponent.

### 9.3 Caveats

- The opponents are our archetypes, not the real LUCENT or Bron. Absolute numbers will shift live.
- League averages depend on the population (PUSH moved from last to 5th in 6-bot fields between L1 and L2).
- Heads-up cells have 39-154 games per strategy, so their SE is about ±0.05-0.08 in place.

---

## 10. Exploits and defenses

| Trick | What happens (evidence) | Defense / counter |
|-------|-------------------------|-------------------|
| **All-in bidders** (live: maverick 9.7%, LUCENT 4.5%, Bron 1.5% of wins) | An all-in archetype scored **32** vs 162-165 for the planners in the same games (`E_allIn`). They burn their money and then starve. | Bid truthfully: they pay our bid. Price-pushing them is safe only up to **our own value × κ**. A loser never pays, and a rival's public balance caps its bid (`index.ts:807-809`). Never bid above our value just to "make them pay". If they did not go all-in, we win at their bid, which is ≤ ours ≤ our value, so the downside is bounded at zero surplus. |
| **Price-pushers / static high bidders targeting us** (they can read our winning bids from `visible_auction_top_bids`) | A static 2.5f + 4 pusher beat naive planners (140 vs 126, `E_pusher`). A 3f + 7 table bot beat them too (134 vs 121). | Accurate values. Never buy above value × κ. Let pushers win letters we value less: they pay our bid, which drains them. Jitter bids ±1 on low-stakes letters to blur our curve. The pacing model sees their price level and adjusts κ, rather than chasing. |
| **Bottom-feeders bidding 1** | They only win ties against Cheapskates. A bottom-feeder lineup lifted our planner to 190 (`E_bottom`). | Bid ≥ 2 on anything useful; we then pay 1. No special handling. |
| **Hoarders / end-game dumpers** (Bron flushes 24% of its words in the final window) | Their visible score understates their position until the flush. | Rank estimates must add the rival's latent rack value (8.5). Do not "protect a lead" that is not real. |
| **Snooping our bids** via the spectator view (`index.ts:114-137`) | Rivals learn our top bids during the match. | Assume it happens (see PITFALLS C8). Truthful bidding means leaked bids cannot extract more than our value. Use jitter. **Do not** use a second anonymous identity ourselves without the user's approval: the code comment says the view is meant for spectators, not bots. |
| **Denial ("hate") bidding by rivals** | It raises our prices on letters we need. | κ pacing absorbs it. Keep a reserve for 7-word completions. A completion is worth up to 3× face of 7 letters (≈ 30-60 pts) versus a single-letter price. |
| **Integer ties** (12.7% of auctions) | A coin flip. | A +1 nudge when V·κ ≥ predicted tie price + 1. |
| **RNG reconstruction** (seed = transaction timestamp; RULES §4, STACK §8: 25,546/25,546 historical matches replay) | Anyone can derive all hidden starting racks, the exact bag composition and the exact sim bids. | **Defensive by default:** assume rivals know our deal. **Offensive use needs a user decision:** perfect sim-bid knowledge doubles FirstPrice surplus vs sims (section 3.6) and makes the unseen pool exact (better MC). It uses public rows only, but it defeats intended hidden information, and the organizers may patch it. Build it behind a flag, default OFF for live play. |
| **Last-letter bidding** | Pointless for real bots. | Bid 0. |

---

## 11. Recommended policy, formulas and tunable parameters

**Per auction (letter L, our rack R, balance B, f = remaining useful auctions = bag_total − 1):**

```
if bag_total == 0:  flush(exact packing of R); bid 0; return               # §5
share_hat   = price-model P(win) at our typical bid level (not own history)
n_proj      = 5 + won_so_far + f·share_hat                                  # letters held over match
V_table     = interp_n(MARG[L], n_proj) · dupFactor(R,L) · vowelFactor(R,L) · qFactor(R,L)   # §4.2-4.4
V_mc        = E_F[Pack*(R+L+F) − Pack*(R+F)], F ~ Bernoulli(share_hat) over sampled future letters,
              CRN, exact/B&B Pack*, S=16-32, ≤200 ms                        # §7.3
cover       = min(1, H / (f·share_hat))                                     # H ≈ 6-12
V̂           = cover·V_mc + (1−cover)·V_table
V̂          += w_deny(#real) · V̂_rival(L)  if predicted price < V̂ + V̂_rival  # §6.2 (w: 2→1.0, 3→0.4, ≥4→0)
κ           = argmin κ s.t. Σ_future E[p·1{p < V·κ}] ≤ B + E[income] − reserve, κ ∈ [κ_lo, κ_hi]   # §3.3
floor       = useful(R,L) ? ⌊fa·face(L) + fb⌋ : 0                           # HYB floor
bid         = clamp(⌊max(V̂·κ, floor)⌋ + tieNudge, 0, B)
FirstPrice: bid = argmax_b (V̂·κ − b)·P(max_opp < b), never above the sims' sure-win bid when only sims compete (§3.6)
Words:      after every rack change play all 7+ words (best reward+leave); if B < poorBelow and a
            valuable letter is likely soon, cash the best 5-6 word.
```

| Parameter | Start value | Range to tune | Effect seen |
|-----------|-------------|---------------|-------------|
| κ_lo / κ_hi | 0.6 / 2.5 (sims only: κ_hi → 10+) | 0.5-1 / 1.5-∞ | Too low collapses. Unbounded in competitive fields loses 16-37. |
| reserve | 15 coins (heads-up: 25) | 0-40 | Heads-up bankruptcy concedes everything. |
| floor fa / fb | 2.5 / 3.5 | 2.0-3.0 / 2-5 | Price-setter strength in 2-3-bot lobbies. |
| useful(): vowel cap, dup cap | 40% of rack+1, 2 copies | 30-45%, 1-3 | Avoids paying floor prices for dead letters. |
| MC horizon H, samples S | 12, 16-32 | 6-20, 8-64 | S16H16 vs S4H8 = +20 pts. |
| cashMinLen | 7 | 7-8 | 6 loses 19-34, 8 loses 11. |
| poorBelow (liquidity cash 5-6) | 20 | 0-30 | ±4 (not significant). |
| deny weights by #real | 2: 1.0, 3: 0.4, 4: 0.2, 6: 0 | 0-1 | Heads-up +95 to +118 vs weak, harmful vs disciplined bidders when unpaced. |
| tieNudge | +1 when V·κ ≥ tie + 1 | 0/1 | 12.7% ties. |
| bid jitter | ±1 on letters with V < 6 | 0-2 | Anti-snooping. |
| flush trigger | `bag_total == 0` auction opens. Precompute on the previous auction. | | +25 pts. |
| refine deadline | closes_at − (RTT_p95 + 100 ms) | | Avoids rejects. |

---

## 12. Prioritized plan and expected impact

| Priority | Item | Expected impact | Cost |
|----------|------|-----------------|------|
| P0 | Correct plumbing: always bid, flush on `bag_total == 0`, cash 7+, bid 0 on the last letter | +25 (flush) +19-34 (no early short cashing) vs naive. The starter scores 27 vs sims. | Low |
| P0 | Marginal table (section 4.2) with rack factors, × κ pacing, + floor | Gets us to the field leaders' level (Bron-like curve), robust across fields | Low |
| P1 | Unbiased MC (B&B packer, worker thread, CRN), late-game emphasis | +5 to +20 in competitive games, +40 heads-up | Medium |
| P1 | Clearing-price model per rival (censored Bayesian) → κ pacing and denial pricing | Prevents the −16 to −37 overspend failures. Enables heads-up denial. | Medium |
| P1 | Simulator league harness with live-bot clones (E2E regression) | Guards against field-specific overfitting (section 9) | Medium |
| P2 | Tournament modes: Swiss = lobby, bracket = survival, final = heads-up, FirstPrice shading | Tournament wins | Medium |
| P2 | Anti-snooping jitter, tie nudges, latent-rack rank estimates | Small but cheap | Low |
| P3 (user decision) | RNG reconstruction for exact sims, bag and deals | FirstPrice vs sims about 2× surplus. Better MC. | Medium. Ethics/patch risk. |

**Phases that need deeper research:** κ pacing against the real Bron and LUCENT (live A/B over 50+ matches); heads-up final dynamics against LUCENT-like bidders; FirstPrice against real bots (no live FirstPrice data exists yet: all 12,283 recent matches were Vickrey).
