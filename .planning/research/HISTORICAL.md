# Historical Data: ScrabbleBot (maincloud `scrabblebot`)

**Domain:** sealed-bid letter-auction word game for bots (SpacetimeDB)
**Researched:** 2026-11-07
**Data:** every public row for all 25,598 matches (25,597 complete; 1 still running at fetch time), 2026-10-23 .. 2026-11-07. Pulled read-only over the HTTP SQL API.
**Overall confidence:** HIGH for counts, prices, scores and rule checks (exact, and every row reconciles). MEDIUM for the bid models, because they are inferred from sealed bids, of which only the winning one is ever archived.

---

## TL;DR: what matters for the roadmap

1. **The lobby field right now is tiny and predictable.** In the last 4,000 matches (2026-11-03..11-07):
   - **Bron** played 3,999 of the 4,000.
   - maverick-bot played 58%, LUCENT 50%, Afterword 48% and hinsonloo 22%.
   - Simulated bots (sims) filled the rest. On average each match had 2.9 real bots and about 3 sims.
   - One match starts every **90.0 s**. That is the lobby timeout, `LOBBY_DURATION_SECONDS = 90n` (game.ts:61), not the 60 s the docs claim. Each match lasts 68.1 s, and an auction closes every 1,001.4 ms (median).
2. **LUCENT is the current lobby boss.** In the recent window:
   - LUCENT finishes above Bron 61% of the time and above maverick-bot 74%.
   - With Bron, LUCENT and maverick-bot all present (753 matches), LUCENT won 55%, Bron 32% and maverick-bot 14%. The median winning score was 162.
   - Afterword is currently inert: median score 0, and 0 auction wins in its last 3,000 matches. hinsonloo is nearly inert (median score 19).
3. **Ratings are inflated by easy, sim-heavy lobbies.** Win rates when all 6 players were real bots (bots active Oct 24..30):
   - Waupus 53%, K-13 42.5%, Nijello 38.7%, Lionel 30.5%.
   - Bron 20.6% and LUCENT 16.6%, which is chance level (1/6).
   - Head-to-head over all time, Lionel, Calebot and Karthik each finish above both Bron and LUCENT more than 50% of the time. Nijello finishes above Bron 73% of the time (n < 300).
   - **Tournament fields will look like the Oct-24/25 6-real-bot era, not like today's lobby.**
4. **What score wins:**
   - 6-real-bot match: winner median **106** (p90 130). The stronger Oct-31..Nov-2 fields needed a median of 130-155.
   - Current lobby: median 205 overall, 162 when LUCENT, Bron and maverick-bot are all present.
   - 2-player tournament final (88 auctions): K-13 scored 429 / 420 / 353.
5. **Winners score from bingos.** In 6-real matches the winner plays about 2 words of 7+ letters (median 2). Those supply **80.6%** of its points. Top bots get 71-90% of points from 7+ letter words, and 55% of LUCENT's and Bron's words are exactly 7 letters.
6. **Prices in the current lobby:**
   - Paid (median, p90): vowels about 6 (p90 9-10); 1-point consonants 4-5; D/G 6; B/C/M/P 7-8; F/H/V/W/Y 8-11; K 12; J/X/Q/Z 16-20 (p90 30-31).
   - All-real 6-bot fields pay about 2x more: overall median 12 vs 6, mean 13.2 vs 7.2.
7. **Endgame structure is exploitable:**
   - The final auction's letter is worthless to real bots. No real bot has ever played a word at or after the final close (0 such words). Sims win 100% of final auctions in the recent window.
   - The penultimate auction is where everyone dumps cash. Recent mean top bid is **50.6** against a mean price of **7.8**.
   - Bron won 79% of recent penultimate auctions. In 52.9% of those it bid its **entire balance**, which is public in `match_participant`.
8. **Ties are common.** 11.9% of real-bot wins have top bid == price >= 2, i.e., a tie broken at random. Bron caps J/X/Q/Z bids at exactly **30**, a point mass (2,172 recent wins at 30), so bidding 31 beats its cap.
9. **Sims are 100% deterministic up to jitter.** All 65,431 sim wins and 1.48M sim losses match `decideBid` exactly (game.ts:775-799). Sim strategies are public in `bot.strategy` and their balances in `match_participant.balance`. **The maximum sim bid can therefore be computed exactly** for every auction.
10. **The data is clean.** Every word reward, every dictionary lookup, every final score and balance, and every auction count reconciles with the module code, with **0 mismatches**. The historical data can serve as ground truth for our simulator and E2E tests.

---

## 0. Data acquisition and method

**Fetcher:** `/private/tmp/claude-501/-Users-adem-Documents-GitHub-scrabbleBawt/f0cb5422-db12-4105-b246-d1edf5490e36/scratchpad/hist_tools/fetch-history.mjs`. It is dependency-free Node 24 ESM.
- Modes: `--all` (optionally chunked on a primary key), `--range A:B`, `--recent N` (the N most recent ended matches) and `--ids`/`--ids-file`.
- `--chunk K` sets the number of match ids per request and `--sleep` the pause between requests.
- Output is resumable NDJSON per table, with a byte-offset checkpoint in `<table>.progress.json`.
- A schema-driven decoder unwraps the API's encodings:
  - `[0,v]`/`[1,[]]` options become value/null.
  - Unit-only sums become variant names (e.g. `"ended"`, `"vickrey"`).
  - `[micros]` timestamps become integer microseconds.

**API limits, found empirically.** No row or size cap was hit:
- 696,592 rows / 13.0 MB in one request (3.2 s).
- 340,000 rows / 16.7 MB (3.0 s).
- `ORDER BY` is rejected (`Unsupported`). `LIMIT`, `COUNT(*)`, column projection and `WHERE a >= x AND a < y` all work.
- Match ids are **not contiguous**. The autoinc sequence jumps at 4096-id blocks: gaps 4432..8192, 8372..12288, 20988..24576, 34819..36864 and 37206..40960, with max id 42,656. Chunk by id range, not by count.

**Fetch actually run:**
- Small tables in one request each: bot, bot_stats, retired_bot_stats, bot_version, tournament, tournament_match, tournament_entry, match_state, match_participant, rating_history.
- auction_result, auction_top_bid_archive and word_play over match ids 1..43000, in 2,000-id chunks with 0.7 s sleeps: 66 requests, 137 MB, about 2 minutes.
- That is **all** matches, not just the latest 4,000; it costs little and allows trend analysis.
- match_state and match_participant were re-fetched afterwards so their snapshot covers every fetched auction. A match counts as "complete" only if it has 98 − 5N auction rows and one top-bid row per auction.

**Analysis windows:**
- **ALL**: all 25,597 complete matches.
- **RECENT**: the last 4,000 complete matches (ids 32,859..42,655, 2026-11-03..11-07). This is today's lobby.
- **real6**: 16,948 matches with 6 real bots, nearly all Oct 24-30. This is the proxy for tournament conditions.
- **Tournament**: the 51 matches of tournament #1 (2026-10-25 07:06..07:50, 68 real entrants, Vickrey, match_size 6, winner K-13).
- **Per-bot tables** use each bot's current version only (from `bot_version`). Bid models use the last ≤3,000 matches of that version. Tournament rows use all versions.

**Phases:** k is the 0-based auction index and T the number of auctions in the match (68 for 6 players).
- early: k < T/3
- mid: T/3 ≤ k < 2T/3
- late: k ≥ 2T/3
- last5: k ≥ T−5, which overlaps late

**Rank:** 1 + the number of opponents with a strictly higher score, so ties share the better place. A win means score == the match maximum, as at game.ts:500.

---

## A. Match composition

All 25,598 matches are Vickrey with 1,000 ms auctions and a 5-tile starting rack. `matchmaker_config` is empty, so the game.ts:69-77 defaults apply. Auctions per match always equal 98 − 5N: 25,583 matches with 6 players and 68 auctions, 8 with 7 players and 63 auctions, and 6 tournament finals tables with 2-5 players and 73-88 auctions.

### A1. Composition by day

| day | matches | avg real bots | real-bot count hist [0,1,2,3,4,5,6,7] | distinct real bots | tournament matches |
| --- | --- | --- | --- | --- | --- |
| 2026-10-23 | 48 | 0.00 | 48,0,0,0,0,0,0,0 | 0 | 0 |
| 2026-10-24 | 5464 | 5.93 | 11,17,41,20,7,2,5366,0 | 110 | 0 |
| 2026-10-25 | 6541 | 6.00 | 0,0,3,1,1,19,6509,8 | 110 | 51 |
| 2026-10-26 | 1326 | 6.00 | 0,0,0,0,0,4,1322,0 | 23 | 0 |
| 2026-10-27 | 1241 | 5.93 | 0,0,0,0,0,88,1153,0 | 17 | 0 |
| 2026-10-28 | 1179 | 5.79 | 0,0,0,3,49,146,981,0 | 15 | 0 |
| 2026-10-29 | 1103 | 5.43 | 0,0,1,18,125,323,636,0 | 13 | 0 |
| 2026-10-30 | 1154 | 5.61 | 1,1,0,9,110,196,837,0 | 9 | 0 |
| 2026-10-31 | 974 | 3.92 | 0,0,75,273,348,213,65,0 | 7 | 0 |
| 2026-11-01 | 975 | 4.11 | 0,0,77,173,366,286,73,0 | 8 | 0 |
| 2026-11-02 | 961 | 4.03 | 0,0,22,185,505,243,6,0 | 6 | 0 |
| 2026-11-03 | 960 | 2.69 | 0,69,344,380,154,13,0,0 | 5 | 0 |
| 2026-11-04 | 958 | 3.20 | 1,18,256,296,286,101,0,0 | 5 | 0 |
| 2026-11-05 | 960 | 3.14 | 0,44,224,321,292,79,0,0 | 6 | 0 |
| 2026-11-06 | 960 | 2.03 | 0,191,558,200,11,0,0,0 | 5 | 0 |
| 2026-11-07 | 793 | 2.86 | 0,0,171,559,63,0,0,0 | 5 | 0 |

How to read this:
- Oct 24-25 was the launch/event period: 110 distinct real bots, and lobbies filled with 6 real bots, so matches started immediately and ran concurrently. That gave about 5-6.5k matches/day.
- From Oct 31 to Nov 2 a few lobbies still filled with 6 real bots (65, 73 and 6 per day). Since Nov 3 every lobby has timed out, giving 958-960 matches/day (86,400 s / 90 s = 960). Each timed-out match is padded with sims (lobby.ts:62-83).
- 144 distinct real bots have ever played. Sims won only 75 of 25,597 matches.

### A2. Current field (recent 4,000 matches)

| bot | type | matches | share |
| --- | --- | --- | --- |
| Bron | real | 3999 | 100.0% |
| maverick-bot | real | 2328 | 58.2% |
| Snippet-sim / Cheapo-sim / Maverick-sim / Valor-sim / Brutus-sim / Hagrid-sim | sim | 2103-2193 each | 52.6-54.8% each |
| LUCENT | real | 2006 | 50.1% |
| Afterword | real | 1904 | 47.6% |
| hinsonloo | real | 896 | 22.4% |
| marcellinus | real | 20 | 0.5% |
| Bot (id 161) | real | 1 | 0.0% |

The sims split into two Aggressive (Brutus, Maverick), two ValueBidder (Valor, Hagrid) and two Cheapskate (Cheapo, Snippet). They are shuffled into empty seats with no duplicate within a match (lobby.ts:68-73).

### A3. Tournament #1 structure

| phase/round | matches | table sizes |
| --- | --- | --- |
| swiss r1..r4 | 11 each | 7,7,6,6,6,6,6,6,6,6,6 (68 entrants → `tableSizes`, tournament.ts:200-208) |
| bracket r1..r4 | 1 each | 6, 5, 4, 3 (last place knocked out each match) |
| final r1..r3 | 1 each | 2 (K-13 vs TileShark; `FINAL_GAMES = 3`, tournament.ts:133) |

- Swiss points are `matchSize − place` (tournament.ts:391). A 7th place at a 7-seat table earns 0.
- Final standings: K-13 (22 Swiss points), TileShark, Waupus, SookraBot, BuySpellRepeat-bot, wordchoice.
- Bron (16 points) and LUCENT were cut after the Swiss rounds.
- The finals were blowouts: **K-13 429-89, 420-98, 353-136**. The bracket matches ran Waupus 121 > BuySpellRepeat 85 > K-13 82 ..., then K-13 132, TileShark 164 and TileShark 201 vs K-13 198.

---

## B. Scores

### B1. Winner score distribution

| subset | n | winner mean | p10 | p25 | p50 | p75 | p90 | 2nd p50 | margin p50 | margin p90 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 25597 | 136.9 | 93 | 101 | 116 | 153 | 213 | 94 | 17 | 70 |
| nReal=1 | 340 | 266.0 | 210 | 231 | 264 | 300 | 335 | 40 | 222 | 302 |
| nReal=2 | 1772 | 256.7 | 187 | 207 | 247 | 304 | 340 | 108 | 139 | 310 |
| nReal=3 | 2438 | 198.5 | 148 | 163 | 191 | 219 | 255 | 142 | 36 | 125 |
| nReal=4 | 2317 | 168.2 | 128 | 144 | 162 | 186 | 216 | 131 | 26 | 74 |
| nReal=5 | 1713 | 140.2 | 108 | 119 | 137 | 159 | 177 | 113 | 19 | 54 |
| **nReal=6** | 16948 | 108.4 | 90 | 97 | **106** | 117 | 130 | 90 | 13 | 37 |
| tournament | 51 | 133.0 | 90 | 96 | 111 | 130 | 164 | 89 | 21 | 58 |
| recent | 4000 | 219.3 | 152 | 171 | 205 | 258 | 313 | 134 | 52 | 279 |
| recent, nReal=3 | 1507 | 196.0 | 148 | 161 | 188 | 216 | 253 | 141 | 34 | 125 |

Winners of 6-real-bot matches by day had a median of 103-112 through Oct 30. As the field thinned to the strongest bots, the median rose to 130 (Oct 31), 134 (Nov 1) and 155 (Nov 2, n=6). In a 6-real match the margin over 2nd is small (median 13), so every few points matter.

### B2. Per-bot results, current version

`(watch)` marks a bot outside the top-15-by-mu that is active now or was a tournament finalist.

| bot | mu | ver | matches | active | avg | median | p90 | win% | avg rank | tournament n / avg / win% / rank |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LUCENT | 61.9 | 3 | 4615 | 10-25..11-07 | 125.0 | 130 | 201 | 42.4% | 2.29 | 4 / 77.3 / 0.0% / 3.00 |
| Bron | 58.4 | 1 | 14621 | 10-24..11-07 | 136.1 | 116 | 237 | 39.2% | 2.30 | 4 / 92.3 / 25.0% / 3.00 |
| Waupus | 53.8 | 1 | 248 | 10-25 only | 102.0 | 100 | 129 | 52.8% | 1.89 | 8 / 114.0 / 50.0% / 1.88 |
| maverick-bot | 51.2 | 3 | 7868 | 10-24..11-07 | 106.0 | 98 | 169 | 14.7% | 2.87 | 4 / 74.0 / 25.0% / 3.25 |
| Lala | 51.2 | 8 | 3998 | 10-25..11-02 | 104.1 | 102 | 141 | 26.5% | 2.39 | 4 / 83.3 / 0.0% / 3.75 |
| K-13 | 51.0 | 2 | 136 | 10-25 only | 98.8 | 91 | 121 | 43.4% | 2.26 | 11 / 193.8 / 54.5% / 1.64 |
| Lionel | 50.7 | 1 | 9045 | 10-24..11-01 | 98.5 | 94 | 132 | 30.0% | 2.47 | - |
| wordchoice | 48.3 | 1 | 2094 | 10-24..10-29 | 81.0 | 84 | 112 | 24.1% | 2.96 | 5 / 94.6 / 40.0% / 3.20 |
| Karthik | 47.6 | 1 | 1854 | 10-24..10-27 | 87.1 | 87 | 114 | 28.6% | 2.62 | 4 / 71.8 / 0.0% / 4.00 |
| Calebot | 47.2 | 2 | 1664 | 10-25..10-26 | 91.4 | 88 | 117 | 31.1% | 2.37 | 4 / 75.0 / 50.0% / 3.00 |
| Nijello | 46.9 | 3 | 553 | 10-25 only | 92.1 | 90 | 118 | 38.5% | 2.29 | 4 / 79.3 / 25.0% / 3.75 |
| Chinese Dante | 46.7 | 2 | 261 | 10-25 only | 92.3 | 90 | 120 | 33.3% | 2.39 | 4 / 85.0 / 25.0% / 3.00 |
| Lambi Lambiii | 46.1 | 1 | 768 | 10-24..10-25 | 90.9 | 89 | 115 | 31.9% | 2.38 | 4 / 80.5 / 25.0% / 3.25 |
| bro | 45.2 | 1 | 781 | 10-24..10-25 | 69.1 | 80 | 108 | 22.7% | 3.39 | 4 / 84.5 / 25.0% / 2.50 |
| here for free swag | 44.7 | 1 | 185 | 10-25..10-28 | 81.8 | 81 | 105 | 17.8% | 2.93 | 4 / 72.8 / 25.0% / 4.00 |
| Afterword (watch) | -4.7 | 1 | 6363 | 10-25..11-07 | 22.8 | 0 | 90 | 6.4% | 4.55 | 4 / 80.3 / 50.0% / 2.75 |
| hinsonloo (watch) | 8.1 | 1 | 5607 | 10-24..11-06 | 38.6 | 19 | 90 | 6.3% | 4.15 | - |
| sardine (watch) | 42.8 | 1 | 4655 | 10-24..11-01 | 75.9 | 75 | 107 | 11.9% | 3.60 | - |
| SookraBot (watch) | 40.1 | 1 | 1457 | 10-24..10-25 | 76.2 | 75 | 102 | 15.0% | 3.38 | 7 / 82.1 / 28.6% / 2.86 |
| TileShark (watch) | 35.1 | 1 | 491 | 10-24..10-25 | 73.1 | 75 | 102 | 13.8% | 3.52 | 11 / 107.2 / 27.3% / 2.36 |
| BuySpellRepeat-bot (watch) | 11.7 | 1 | 1447 | 10-25..10-29 | 50.2 | 58 | 94 | 8.3% | 4.38 | 6 / 77.8 / 16.7% / 2.50 |
| marcellinus (watch) | 39.2 | 1 | 1540 | 10-24..11-05 | 80.0 | 78 | 106 | 18.9% | 3.19 | - |

### B3. Split by number of real opponents

Each cell is n / avg score / win% / avg rank.

| bot | 0 real opp | 1 | 2 | 3 | 4 | 5 (all-real table) |
| --- | --- | --- | --- | --- | --- | --- |
| LUCENT | - | 318 / 198.8 / 75.2% / 1.33 | 1146 / 155.7 / 57.0% / 1.65 | 1223 / 139.9 / 47.9% / 1.88 | 611 / 123.4 / 42.7% / 2.16 | 1316 / 67.3 / **16.6%** / 3.53 |
| Bron | 322 / 266.5 / 100.0% / 1.00 | 1728 / 244.5 / 74.5% / 1.26 | 2417 / 177.9 / 52.0% / 1.60 | 2309 / 146.6 / 44.3% / 1.83 | 1710 / 117.1 / 33.6% / 2.25 | 6135 / 83.7 / 20.6% / 3.13 |
| Waupus | - | - | - | - | - | 242 / 101.8 / **53.3%** / 1.88 |
| maverick-bot | - | 541 / 157.3 / 28.7% / 1.77 | 1657 / 141.6 / 20.0% / 2.10 | 1316 / 126.7 / 17.1% / 2.34 | 892 / 100.3 / 9.8% / 2.97 | 3461 / 74.5 / 10.4% / 3.58 |
| Lala | - | - | 246 / 127.9 / 30.1% / 2.04 | 960 / 118.7 / 24.5% / 2.23 | 1037 / 108.3 / 29.8% / 2.27 | 1755 / 90.3 / 25.1% / 2.60 |
| K-13 | - | - | - | - | - | 127 / 90.6 / 42.5% / 2.31 |
| Lionel | - | 76 / 207.9 / 73.7% / 1.26 | 331 / 145.0 / 36.3% / 1.95 | 948 / 117.9 / 25.0% / 2.27 | 1255 / 105.4 / 27.5% / 2.36 | 6435 / 90.6 / **30.5%** / 2.56 |
| wordchoice | - | - | - | 26 / 97.6 / 15.4% / 2.81 | 62 / 99.0 / 19.4% / 2.45 | 2000 / 80.2 / 24.4% / 2.98 |
| Karthik | - | - | - | - | 52 / 99.3 / 32.7% / 2.17 | 1802 / 86.8 / 28.5% / 2.63 |
| Calebot | - | - | - | - | 22 / 104.3 / 31.8% / 2.14 | 1642 / 91.2 / 31.1% / 2.37 |
| Nijello | - | - | - | - | - | 551 / 92.2 / 38.7% / 2.28 |
| Chinese Dante | - | - | - | - | - | 260 / 92.4 / 33.5% / 2.39 |
| Lambi Lambiii | - | - | - | - | - | 768 / 90.9 / 31.9% / 2.38 |
| Afterword | - | 508 / 0.0 / 0.0% / 4.43 | 1001 / 0.8 / 0.1% / 4.42 | 1461 / 2.7 / 0.3% / 5.00 | 988 / 8.7 / 1.4% / 5.57 | 2402 / 54.7 / 16.0% / 3.94 |
| hinsonloo | - | 285 / 7.1 / 0.0% / 3.95 | 445 / 8.6 / 0.0% / 4.02 | 794 / 9.4 / 0.0% / 4.33 | 883 / 14.3 / 1.1% / 4.80 | 3200 / 59.6 / 10.8% / 3.96 |
| sardine | - | - | - | 91 / 97.1 / 14.3% / 2.78 | 593 / 84.5 / 14.7% / 3.23 | 3971 / 74.2 / 11.5% / 3.67 |

Columns with n < 10 are omitted. Full splits are in summary.json.

### B4. Head-to-head

Each cell is P(row finishes strictly above column) when both played in the same match, current versions. `*` marks n < 300.

All time:

| row \ col | Bron | LUCENT | maverick-bot | Lionel | Lala | Calebot | Karthik | Nijello | wordchoice | sardine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Bron | - | 0.44 | 0.65 | 0.45 | 0.49 | 0.35 | 0.33 | 0.27* | 0.42 | 0.61 |
| LUCENT | 0.55 | - | 0.69 | 0.35 | 0.39 | 0.28* | 0.17* | - | 0.27* | 0.52 |
| maverick-bot | 0.34 | 0.30 | - | 0.27 | 0.28 | 0.12* | 0.26 | 0.24* | 0.29 | 0.54 |
| Lionel | 0.54 | 0.64 | 0.71 | - | 0.48 | 0.44 | 0.44 | 0.40* | 0.52 | 0.71 |
| Lala | 0.49 | 0.60 | 0.70 | 0.51 | - | 0.47* | - | 0.41* | 0.52* | 0.70 |
| Calebot | 0.63 | 0.71* | 0.87* | 0.54 | 0.51* | - | 0.54* | 0.48* | 0.57* | 0.76* |
| Karthik | 0.66 | 0.82* | 0.73 | 0.54 | - | 0.42* | - | 0.36* | 0.54 | 0.74 |
| Nijello | 0.73* | - | 0.76* | 0.56* | 0.58* | 0.51* | 0.56* | - | 0.65* | 0.68* |

Recent window:

| row \ col | Bron | LUCENT | maverick-bot | Afterword | hinsonloo |
| --- | --- | --- | --- | --- | --- |
| Bron | - | 0.38 | 0.68 | 1.00 | 1.00 |
| LUCENT | 0.61 | - | 0.74 | 0.96 | 0.96 |
| maverick-bot | 0.31 | 0.25 | - | 0.99 | 0.99 |

### B5. Current-lobby matchups (recent window, top real-bot sets)

| real bots present (+ sims) | matches | wins | winner p50 | winner p90 | best sim p50 | median score per real bot |
| --- | --- | --- | --- | --- | --- | --- |
| Bron+LUCENT+maverick-bot | 753 | LUCENT 411, Bron 240, maverick 102 | 162 | 195 | 16 | LUCENT 149, Bron 136, maverick 119 |
| Afterword+Bron | 481 | Bron 481 | 294 | 351 | 38 | Bron 294, Afterword 0 |
| Afterword+Bron+maverick-bot | 445 | Bron 328, maverick 117 | 207 | 247 | 21 | Bron 201, maverick 166 |
| Afterword+Bron+LUCENT+maverick-bot | 401 | LUCENT 186, Bron 150, maverick 65 | 162 | 197 | 16 | LUCENT 144, Bron 138, maverick 120 |
| Bron+maverick-bot | 352 | Bron 250, maverick 102 | 203 | 240 | 23 | Bron 196, maverick 164 |
| Bron (alone + 5 sims) | 276 | Bron 276 | 258 | 324 | 42 | Bron 258 |
| Bron+hinsonloo | 262 | Bron 262 | 315 | 367 | 33 | Bron 315, hinsonloo 7 |
| Bron+LUCENT | 249 | LUCENT 177, Bron 72 | 214 | 256 | 21 | LUCENT 203, Bron 174 |

---

## C. Letters and prices

### C1. Per-bot buying (current version)

| bot | letters won/match | avg paid | paid p50 | avg top bid when winning | avg top−paid | tie share of wins | spend/match | score/spend | final balance mean / p50 | final-auction win% | penultimate win% (top p50 / paid p50) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LUCENT | 19.42 | 10.01 | 8 | 14.96 | 4.95 | 10.2% | 194.3 | 0.64 | 30.7 / 24 | 0.0% | 17.2% (20 / 11) |
| Bron | 21.97 | 8.32 | 7 | 13.21 | 4.89 | 10.8% | 182.8 | 0.74 | 53.4 / 38 | 0.0% | 51.9% (18 / 5) |
| Waupus | 13.05 | 13.91 | 12 | 17.97 | 4.06 | 13.6% | 181.6 | 0.56 | 20.4 / 18 | 0.0% | 19.8% (23 / 12) |
| maverick-bot | 16.34 | 11.15 | 10 | 17.38 | 6.23 | 10.8% | 182.3 | 0.58 | 23.6 / 21 | 0.0% | 16.3% (28 / 12) |
| Lala | 16.85 | 11.04 | 9 | 13.82 | 2.77 | 12.6% | 186.1 | 0.56 | 18.0 / 16 | 0.0% | 7.7% (9 / 5) |
| K-13 | 13.04 | 12.93 | 11 | 16.96 | 4.02 | 13.9% | 168.7 | 0.59 | 30.1 / 28 | 0.0% | 15.4% (18 / 12) |
| Lionel | 14.66 | 12.65 | 11 | 16.95 | 4.30 | 11.3% | 185.6 | 0.53 | 12.9 / 8 | 0.0% | 14.2% (15 / 8) |
| wordchoice | 12.40 | 12.81 | 11 | 16.77 | 3.96 | 13.2% | 158.9 | 0.51 | 22.1 / 15 | 0.0% | 30.6% (15 / 9) |
| Karthik | 12.15 | 14.02 | 12 | 17.34 | 3.31 | 12.6% | 170.4 | 0.51 | 16.7 / 13 | 0.0% | 11.7% (14 / 9) |
| Calebot | 13.07 | 13.67 | 12 | 17.37 | 3.69 | 13.1% | 178.8 | 0.51 | 12.6 / 11 | 0.0% | 11.4% (13 / 8) |
| Nijello | 13.39 | 13.30 | 11 | 16.54 | 3.23 | 17.0% | 178.0 | 0.52 | 14.1 / 13 | 0.0% | 25.5% (20 / 10) |
| Chinese Dante | 12.43 | 13.90 | 12 | 17.70 | 3.80 | 12.9% | 172.8 | 0.53 | 19.5 / 16 | 0.0% | 11.5% (16 / 10) |
| Lambi Lambiii | 12.53 | 14.37 | 12 | 18.38 | 4.02 | 11.6% | 180.0 | 0.51 | 10.9 / 9 | 0.0% | 6.3% (16 / 9) |
| bro | 11.71 | 12.36 | 11 | 15.39 | 3.03 | 15.7% | 144.8 | 0.48 | 24.3 / 9 | **68.0%** | 12.8% (13 / 9) |
| Afterword | 3.39 | 13.87 | 12 | 18.39 | 4.52 | 11.5% | 47.1 | 0.48 | 75.7 / 100 | 0.0% | 6.8% (17 / 9) |
| hinsonloo | 5.29 | 13.40 | 12 | 17.00 | 3.60 | 14.1% | 70.9 | 0.54 | 67.7 / 100 | 0.1% | 7.2% (11 / 7) |
| sardine | 10.02 | 13.83 | 12 | 18.11 | 4.29 | 11.1% | 138.5 | 0.55 | 37.4 / 35 | 0.0% | 8.9% (13 / 7) |
| SookraBot | 11.69 | 13.81 | 12 | 21.39 | 7.57 | 9.2% | 161.5 | 0.47 | 14.7 / 8 | 0.8% | 9.0% (17 / 10) |
| TileShark | 9.94 | 14.68 | 12 | 20.12 | 5.44 | 7.4% | 145.9 | 0.50 | 27.2 / 21 | 0.0% | 8.6% (23 / 14) |
| BuySpellRepeat-bot | 7.06 | 14.46 | 12 | 20.76 | 6.30 | - | - | - | 48.1 / 31 | **63.4%** | 7.8% (10 / 6) |

How to read the money columns:
- Spend per match = 100 + score − final balance. This is the economy: every reward is recycled into the bidding budget.
- Score/spend is best for Bron (0.74). Most strong bots convert at 0.51-0.64.

### C2. Per-bot buying by phase

Each cell is wins/match / share of the phase's auctions won / avg paid / avg top bid.

| bot | early (k<T/3) | mid | late (k≥2T/3) | last 5 |
| --- | --- | --- | --- | --- |
| LUCENT | 6.59 / 28.6% / 9.82 / 14.07 | 7.28 / 31.6% / 9.01 / 12.72 | 5.55 / 25.2% / 11.54 / 18.95 | 0.86 / 17.3% / 11.28 / 21.15 |
| Bron | 6.36 / 27.7% / 7.66 / 10.43 | 7.10 / 30.9% / 8.48 / 11.30 | 8.50 / 38.6% / 8.69 / 16.89 | 2.02 / 40.3% / 7.51 / 23.40 |
| Waupus | 3.79 / 16.5% / 13.26 / 15.64 | 4.35 / 18.9% / 14.06 / 17.27 | 4.92 / 22.3% / 14.27 / 20.39 | 1.12 / 22.4% / 14.21 / 23.97 |
| maverick-bot | 5.07 / 22.1% / 10.83 / 14.46 | 5.58 / 24.3% / 10.35 / 14.01 | 5.69 / 25.9% / 12.23 / 23.29 | 0.39 / 7.9% / 12.48 / 25.70 |
| Lala | 8.57 / 37.2% / 11.69 / 14.72 | 5.69 / 24.7% / 10.46 / 12.76 | 2.59 / 11.8% / 10.19 / 13.15 | 0.31 / 6.3% / 7.57 / 13.29 |
| K-13 | 3.38 / 14.6% / 11.44 / 14.69 | 4.74 / 20.5% / 13.49 / 16.86 | 4.93 / 22.2% / 13.42 / 18.61 | 1.05 / 21.0% / 14.24 / 22.09 |
| Lionel | 4.40 / 19.2% / 13.06 / 16.67 | 5.26 / 22.9% / 13.38 / 17.39 | 5.00 / 22.7% / 11.53 / 16.74 | 0.99 / 19.7% / 9.74 / 17.89 |
| wordchoice | 4.61 / 20.0% / 13.14 / 17.06 | 3.22 / 14.0% / 12.73 / 15.51 | 4.58 / 20.8% / 12.53 / 17.38 | 1.11 / 22.2% / 10.40 / 16.86 |
| Karthik | 3.90 / 17.0% / 14.03 / 16.73 | 4.64 / 20.2% / 14.53 / 17.70 | 3.61 / 16.4% / 13.37 / 17.53 | 0.65 / 13.1% / 11.96 / 17.71 |
| Calebot | 5.36 / 23.3% / 15.73 / 19.90 | 4.41 / 19.2% / 12.90 / 15.76 | 3.31 / 15.0% / 11.38 / 15.40 | 0.72 / 14.4% / 10.60 / 16.48 |
| Nijello | 3.80 / 16.5% / 13.86 / 16.06 | 4.31 / 18.8% / 13.82 / 16.25 | 5.27 / 24.0% / 12.47 / 17.11 | 0.86 / 17.2% / 11.16 / 18.41 |

### C3. Market price per letter

The columns are the price paid and the archived top bid, over auctions that had a winner.

**Recent window (current lobby, 272,000 auctions):**

| letter | value | n | paid p10 | p25 | p50 | p75 | p90 | paid mean | top p50 | top p90 | top mean |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 1 | 24997 | 3 | 4 | 6 | 7 | 9 | 6.19 | 8 | 19 | 10.78 |
| E | 1 | 33408 | 3 | 4 | 6 | 7 | 10 | 6.24 | 8 | 20 | 11.12 |
| I | 1 | 24454 | 3 | 4 | 6 | 7 | 9 | 5.86 | 7 | 18 | 10.41 |
| O | 1 | 22214 | 3 | 4 | 6 | 7 | 9 | 5.79 | 7 | 17 | 10.07 |
| U | 1 | 11148 | 3 | 4 | 6 | 7 | 9 | 6.06 | 9 | 21 | 11.75 |
| S | 1 | 11239 | 2 | 3 | 5 | 7 | 10 | 5.67 | 8 | 20 | 10.60 |
| T | 1 | 16878 | 2 | 3 | 4 | 6 | 8 | 4.87 | 6 | 16 | 9.05 |
| R | 1 | 16624 | 2 | 3 | 5 | 6 | 9 | 5.21 | 7 | 18 | 9.81 |
| N | 1 | 16543 | 2 | 3 | 5 | 6 | 9 | 5.07 | 7 | 17 | 9.43 |
| L | 1 | 11420 | 2 | 3 | 5 | 6 | 9 | 5.21 | 7 | 18 | 9.56 |
| D | 2 | 11322 | 3 | 4 | 6 | 9 | 12 | 7.22 | 10 | 21 | 12.72 |
| G | 2 | 8157 | 3 | 4 | 6 | 9 | 11 | 6.72 | 9 | 19 | 11.76 |
| B | 3 | 5496 | 4 | 6 | 8 | 11 | 15 | 8.91 | 13 | 24 | 14.95 |
| C | 3 | 5422 | 4 | 6 | 8 | 12 | 16 | 9.32 | 14 | 26 | 15.92 |
| M | 3 | 5552 | 4 | 6 | 8 | 12 | 15 | 9.11 | 13 | 26 | 15.36 |
| P | 3 | 5595 | 4 | 5 | 7 | 11 | 15 | 8.82 | 12 | 25 | 14.72 |
| F | 4 | 5457 | 5 | 7 | 10 | 14 | 18 | 10.71 | 16 | 28 | 18.14 |
| H | 4 | 5305 | 6 | 7 | 10 | 15 | 19 | 11.44 | 17 | 30 | 19.58 |
| V | 4 | 5635 | 5 | 6 | 8 | 12 | 16 | 9.69 | 14 | 25 | 16.28 |
| W | 4 | 5797 | 5 | 7 | 9 | 13 | 17 | 10.50 | 16 | 28 | 17.65 |
| Y | 4 | 5637 | 5 | 7 | 11 | 15 | 19 | 11.68 | 18 | 30 | 19.97 |
| K | 5 | 2739 | 6 | 8 | 12 | 17 | 22 | 13.08 | 21 | 30 | 22.57 |
| J | 8 | 2803 | 9 | 11 | 17 | 24 | 30 | 17.86 | 30 | 42 | 29.39 |
| X | 8 | 2832 | 9 | 11 | 18 | 25 | 30 | 18.48 | 30 | 42 | 29.50 |
| Q | 10 | 2736 | 11 | 12 | 16 | 24 | 30 | 18.63 | 30 | 44 | 29.82 |
| Z | 10 | 2590 | 11 | 13 | 20 | 29 | 31 | 21.03 | 30 | 47 | 33.43 |
| ALL | - | 272000 | 3 | 4 | 6 | 8 | 13 | 7.20 | 9 | 25 | 12.62 |

**All 25,597 matches** (dominated by the 6-real era; median paid in brackets):
- Vowels: 9-10, p90 13-14.
- S: 11. Other 1-point consonants: 9-10.
- D 13, G 12. B/C/M/P 15-16. F 18, H 19, V 16, W 17, Y 19. K 21.
- J 26, X 28, Q 25, Z 32 (p90 49).
- ALL: median 10, p90 19, mean 11.52.
- The full table is in `summary.json → letterPrices.all.overall`.

### C4. Price by phase and by number of real bots (all letters pooled)

| window | group | n | paid p25/p50/p75/p90 | top p50/p90 | paid mean | no-bid |
| --- | --- | --- | --- | --- | --- | --- |
| all | early | 588544 | 8/10/14/20 | 13/26 | 11.79 | 0.0% |
| all | mid | 588363 | 8/10/14/19 | 13/24 | 11.55 | 0.1% |
| all | late | 552104 | 7/10/14/19 | 15/30 | 11.20 | 2.0% |
| all | last5 | 117283 | 4/8/13/17 | 16/34 | 9.08 | 8.4% |
| all | real bots=1 | 23120 | 3/5/6/7 | 7/19 | 4.83 | 0.0% |
| all | real bots=2 | 120553 | 4/5/7/11 | 8/24 | 6.13 | 0.0% |
| all | real bots=3 | 165798 | 5/7/10/14 | 10/25 | 7.91 | 0.0% |
| all | real bots=4 | 157565 | 6/8/11/16 | 11/24 | 9.07 | 0.0% |
| all | real bots=5 | 116489 | 7/9/13/18 | 13/24 | 10.54 | 0.0% |
| all | real bots=6 | 1140836 | 10/12/15/21 | 15/28 | 13.21 | 1.0% |
| recent | early | 92000 | 4/5/7/11 | 7/17 | 6.41 | 0.0% |
| recent | mid | 92000 | 4/6/7/11 | 8/17 | 6.62 | 0.0% |
| recent | late | 88000 | 5/7/11/16 | 15/32 | 8.64 | 0.0% |
| recent | last5 | 20000 | 3/6/9/15 | 18/40 | 7.09 | 0.0% |

### C5. Price by auction index

T = 68. Selected rows; the full curve is in `summary.json → priceByAuctionIndex68`.

| k | all: mean paid | all: mean top | all: no-bid | all-real matches: mean paid / no-bid | recent: mean paid | recent: mean top | recent: real-winner share |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 12.56 | 17.40 | 0.1% | 14.49 / 0.1% | 6.98 | 12.22 | 91.8% |
| 10 | 11.54 | 14.84 | 0.0% | 13.53 / 0.1% | 6.06 | 8.82 | 76.8% |
| 20 | 11.46 | 14.57 | 0.0% | 13.44 / 0.1% | 5.91 | 8.56 | 73.5% |
| 30 | 11.48 | 14.76 | 0.1% | 13.39 / 0.1% | 6.23 | 9.20 | 78.7% |
| 40 | 11.53 | 14.94 | 0.1% | 13.24 / 0.1% | 7.02 | 10.26 | 85.7% |
| 50 | 11.71 | 16.16 | 0.1% | 13.06 / 0.1% | 8.48 | 13.77 | 91.5% |
| 55 | 11.91 | 17.90 | 0.1% | 12.95 / 0.1% | 9.68 | 18.88 | 95.1% |
| 60 | 11.59 | 18.80 | 0.1% | 12.64 / 0.1% | 9.65 | 20.76 | 97.4% |
| 64 | 10.55 | 19.63 | 0.1% | 11.66 / 0.2% | 8.67 | 22.51 | 97.8% |
| 65 | 9.75 | 19.31 | 0.1% | 10.80 / 0.2% | 7.93 | 22.65 | 97.2% |
| **66 (penultimate)** | 9.34 | 24.92 | 0.2% | 10.46 / 0.4% | 7.80 | **50.60** | 95.6% |
| **67 (final)** | 2.09 | 7.64 | **41.2%** | 1.81 / **62.3%** | 2.76 | 4.62 | **0.0%** |

### C6. Key bots by letter

Each cell is avg paid / median top bid when winning / share of that letter's auctions won.

| letter | LUCENT | Bron | maverick-bot | Lionel | Lala | Waupus | K-13 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | 8.11 / 11 / 26.6% | 7.32 / 10 / 31.4% | 9.16 / 12 / 24.5% | 9.75 / 13 / 19.7% | 8.58 / 11 / 25.7% | 10.51 / 12 / 19.9% | 9.32 / 12 / 18.0% |
| E | 8.29 / 11 / 27.7% | 7.49 / 10 / 30.7% | 9.36 / 13 / 24.2% | 9.97 / 13 / 20.8% | 9.06 / 11 / 27.1% | 11.17 / 13 / 18.1% | 10.22 / 12 / 18.1% |
| S | 8.37 / 12 / 27.1% | 7.18 / 10 / 32.7% | 9.58 / 13 / 27.0% | 10.33 / 13 / 18.8% | 9.84 / 13 / 25.0% | 11.69 / 13 / 17.0% | 11.81 / 14 / 18.7% |
| T | 7.19 / 9 / 28.3% | 6.37 / 9 / 32.4% | 8.21 / 11 / 22.3% | 9.40 / 12 / 20.2% | 8.02 / 10 / 26.0% | 9.88 / 12 / 17.4% | 9.14 / 11 / 16.1% |
| D | 10.68 / 15 / 35.8% | 8.50 / 12 / 31.7% | 11.58 / 16 / 23.4% | 13.03 / 17 / 20.8% | 12.29 / 15 / 30.8% | 13.94 / 16 / 19.5% | 14.44 / 16 / 18.0% |
| B | 12.52 / 16 / 29.3% | 9.98 / 14 / 35.2% | 13.91 / 19 / 23.5% | 15.00 / 19 / 21.1% | 14.57 / 18 / 24.9% | 15.94 / 19 / 15.5% | 15.27 / 18 / 24.3% |
| H | 16.13 / 21 / 28.1% | 12.14 / 18 / 35.3% | 17.52 / 23 / 24.0% | 18.69 / 24 / 19.1% | 19.42 / 24 / 27.9% | 19.92 / 24 / 18.1% | 20.81 / 24 / 23.9% |
| K | 18.63 / 23 / 19.2% | 13.49 / 21 / 38.3% | 19.77 / 26 / 24.8% | 21.12 / 27 / 22.3% | 21.95 / 26 / 21.6% | 22.40 / 28 / 27.1% | 24.42 / 28 / 19.0% |
| J | 25.43 / 34 / 30.3% | 16.42 / 27 / 33.3% | 25.46 / 34 / 26.3% | 27.22 / 35 / 33.1% | 27.63 / 33 / 12.5% | 29.25 / 38 / 33.7% | 26.00 / 32 / 28.7% |
| X | 25.59 / 35 / 30.9% | 17.08 / 28 / 32.4% | 26.18 / 35 / 23.5% | 28.99 / 37 / 31.4% | 30.91 / 37 / 19.4% | 30.60 / 38 / 33.3% | 31.44 / 37 / 30.0% |
| Q | 25.38 / 36 / 26.4% | 16.54 / 26 / 27.3% | 24.49 / 35 / 35.6% | 27.01 / 39 / 44.4% | 26.82 / 33 / 10.5% | 29.82 / 44 / 46.2% | 26.03 / 42 / 32.6% |
| Z | 28.50 / 38 / 29.1% | 18.27 / 30 / 28.1% | 27.39 / 37 / 23.6% | 36.28 / 49 / 41.1% | 38.52 / 48 / 17.4% | 36.13 / 46 / 36.1% | 37.00 / 46 / 33.0% |

All 26 letters for all 23 profiled bots are in `summary.json → bots[i].letters.byLetter`.

### C7. Auctions nobody bid on, and unspent balance

**No-bid auctions:**
- 11,635 of 1,740,646 (0.67%) overall, and 0 of 272,000 in the recent window (sims always bid).
- They concentrate in the final auction: 41.2% of final auctions overall, and 62.3% in all-real matches. Excluding the final auction, the no-bid rate is 1,078 of 1,715,049 (0.06%).
- No letter is avoided systematically. The per-letter rate is 0.6-0.8% everywhere (Z 0.8%).
- In all-real matches, 6,405 final auctions were won by a real bot and 10,557 got no bid.
- **Letters are not returned to the bag when nobody bids.** The data confirms the code: every match has exactly 98−5N auctions even with no-bid auctions present, and the bag draw happens regardless (game.ts:617-629).

**Unspent balance at match end:**

| window | final place | final balance p10/p25/p50/p75/p90 | mean |
| --- | --- | --- | --- |
| all | 1 | 5/10/19/38/79 | 33.5 |
| all | 2 | 5/10/17/35/58 | 25.3 |
| all | 6 | 8/19/52/100/104 | 58.2 |
| recent | 1 | 17/29/64/139/178 | 84.5 |
| recent | 2 | 14/24/46/73/87 | 49.3 |
| recent | 4-6 | p50 = 100 (sims and inert bots that never won anything) | ~100 |

- Leftover balance is worthless.
- Recent winners waste a median of 64, mostly Bron (mean 53 across all its matches).
- In 6-real matches the winner leaves a median of 19 unspent.

**Letters bought but never played** (real bots, Σ max(0, won − played) / won):
- All matches: Q 23.3%, U 11.8%, V 11.2%, Z 10.4%, J 8.5%, K 7.0%, ... down to A 2.4%.
- Recent: Q 16.1%, V 7.5%, U 5.8%, J 4.4%, ... down to A 0.6%.
- **Q is the trap.** It is bought at a median of 25 (all) or 16 (recent), and one in four or five is never used.

---

## D. Words

### D1. Per-bot word play (current version)

| bot | words/match | avg len | len dist % 2/3/4/5/6/7/8+ | avg reward/word | pts share 7+ | 7+ words/match | share of words in last 5 auctions | latency after last close p50 (ms) | tiles played/match | unplayed at end mean / p50 / p90 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LUCENT | 3.77 | 6.16 | 11/5/4/5/5/55/16 | 33.18 | 89.9% | 2.65 | 29.6% | 94 | 23.3 | 1.07 / 0 / 4 |
| Bron | 4.23 | 6.16 | 8/6/5/6/6/56/13 | 32.21 | 85.7% | 2.90 | 36.1% | 136 | 26.1 | 0.89 / 1 / 2 |
| Waupus | 3.01 | 5.90 | 10/7/6/9/9/50/10 | 33.85 | 82.6% | 1.80 | 42.3% | 104 | 17.8 | 0.23 / 0 / 1 |
| maverick-bot | 3.45 | 5.92 | 10/6/6/7/17/37/16 | 30.71 | 70.9% | 1.84 | 38.5% | 282 | 20.6 | 0.79 / 0 / 2 |
| Lala | 3.47 | 5.96 | 10/5/8/7/11/43/16 | 29.96 | 82.7% | 2.04 | 36.4% | 124 | 21.0 | 0.87 / 1 / 2 |
| K-13 | 2.88 | 6.01 | 8/7/6/7/12/45/15 | 34.29 | 80.0% | 1.72 | 43.9% | 143 | 17.4 | 0.65 / 0 / 2 |
| Lionel | 3.23 | 5.62 | 12/11/10/8/9/28/22 | 30.51 | 77.3% | 1.61 | 24.5% | 66 | 18.5 | 1.20 / 1 / 3 |
| wordchoice | 2.73 | 5.78 | 8/10/12/10/10/25/25 | 29.63 | 76.3% | 1.36 | 32.0% | 142 | 16.3 | 1.09 / 1 / 3 |
| Karthik | 2.92 | 5.69 | 10/8/9/11/13/37/12 | 29.83 | 74.2% | 1.42 | 30.8% | 166 | 16.7 | 0.48 / 0 / 1 |
| Calebot | 3.11 | 5.69 | 9/11/9/8/9/50/5 | 29.42 | 80.7% | 1.73 | 28.2% | **44** | 17.7 | 0.39 / 0 / 1 |
| Nijello | 3.19 | 5.44 | 12/8/13/12/16/29/11 | 28.90 | 63.4% | 1.29 | 38.1% | 113 | 17.4 | 0.94 / 1 / 2 |
| Chinese Dante | 2.89 | 5.89 | 11/7/6/7/8/51/11 | 32.00 | 84.5% | 1.77 | 38.0% | 205 | 17.0 | 0.39 / 0 / 1 |
| Lambi Lambiii | 3.16 | 5.39 | 17/9/7/8/12/41/7 | 28.80 | 75.2% | 1.50 | 18.2% | 214 | 17.1 | 0.48 / 0 / 1 |
| bro | 2.88 | 5.04 | 16/15/12/8/9/33/7 | 23.96 | 71.7% | 1.13 | 10.2% | 207 | 14.6 | 2.15 / 2 / 4 |
| Afterword | 0.74 | 5.70 | 11/10/10/9/10/29/22 | 30.71 | 77.0% | 0.38 | 28.5% | 238 | 4.3 | 4.10 / 5 / 5 |
| hinsonloo | 1.71 | 5.01 | 14/15/18/12/7/20/15 | 22.65 | 67.4% | 0.59 | 25.9% | 467 | 8.7 | 1.57 / 1 / 5 |
| sardine | 2.39 | 5.98 | 10/5/5/9/13/48/10 | 31.76 | 76.7% | 1.40 | 44.1% | 143 | 14.3 | 0.71 / 0 / 2 |
| TileShark | 2.57 | 5.52 | 18/6/6/10/10/39/12 | 28.48 | 78.6% | 1.31 | 15.6% | 231 | 14.2 | 0.71 / 0 / 2 |

"Unplayed at end" = 5 starting tiles + letters won − tiles played. Top bots finish with about 0.2-1.2 tiles stuck.

### D2. When words are played

Each cell is the % of a bot's words played in each tenth of the match, measured by auctions closed at play time / T.

| bot | 0-10% | 10-20 | 20-30 | 30-40 | 40-50 | 50-60 | 60-70 | 70-80 | 80-90 | 90-100% | last word: auctions left p10/p50/p90 | last word: ms before final close p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LUCENT | 2 | 6 | 6 | 7 | 10 | 9 | 13 | 11 | 8 | 30 | 1/3/7 | 2915 |
| Bron | 3 | 6 | 7 | 8 | 6 | 6 | 7 | 9 | 11 | 38 | 1/1/2 | 912 |
| Waupus | 0 | 2 | 4 | 7 | 6 | 7 | 9 | 10 | 11 | 44 | 1/1/1 | 906 |
| maverick-bot | 1 | 7 | 10 | 8 | 4 | 5 | 9 | 10 | 9 | 39 | 1/3/3 | 2771 |
| Lala | 1 | 8 | 8 | 8 | 9 | 9 | 8 | 11 | 3 | 37 | 1/1/2 | 903 |
| K-13 | 1 | 2 | 3 | 6 | 4 | 9 | 11 | 10 | 10 | 45 | 1/1/1 | 865 |
| Lionel | 1 | 5 | 6 | 7 | 6 | 8 | 10 | 12 | 17 | 27 | 2/4/16 | 3940 |
| Calebot | 3 | 12 | 9 | 7 | 5 | 7 | 8 | 7 | 13 | 29 | 1/1/7 | 958 |
| Nijello | 0 | 2 | 3 | 6 | 6 | 8 | 10 | 12 | 13 | 41 | 1/1/6 | 904 |
| Chinese Dante | 0 | 2 | 5 | 10 | 10 | 11 | 10 | 10 | 5 | 39 | 1/1/1 | 844 |
| sardine | 0 | 0 | 3 | 13 | 11 | 8 | 7 | 8 | 6 | 45 | 1/1/14 | 893 |
| SookraBot | 2 | 1 | 1 | 1 | 2 | 6 | 9 | 14 | 29 | 34 | 2/5/13 | 4947 |

The best bots hoard. They play 30-45% of their words in the final tenth, and Waupus, K-13, Chinese Dante and Bron make their last play right after the **penultimate** close, during the final auction window, about 850-960 ms before the end. That play uses the penultimate letter. Our bot must be able to submit its final word inside that roughly 1 s window.

### D3. What 6-real-bot winners look like

16,948 matches.

| | n | avg score | words/match | 7+ words/match | letters won | spend | share of points from 7+ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| winners | 17374 | 108.1 | 3.29 | 1.83 | 14.8 | 189.6 | 80.6% |
| others | 84314 | 66.6 | 2.58 | 1.25 | 10.5 | 139.6 | 74.0% |

Number of 7+ words per winner: 0 → 167, 1 → 3,865, **2 → 12,124**, 3 → 1,145, 4+ → 73. So in practice, winning a full table means two bingos, plus filler words.

---

## E. Bid models and apparent strategies

### E1. Simple model: archived top bid when the bot WON

`top = b0 + b1·value + b2·vowel + b3·phase(0..1) + b4·last5 + b5·balance/100 + b6·nRealOpp + b7·heldSame + b8·heldTotal`, fit on wins only. Features:
- `heldSame`: copies of this letter the bot already holds, reconstructed as won − played + revealed start tiles.
- `heldTotal`: the known rack size, reconstructed the same way.
- `nRealOpp` is reported as n/a when one value covers more than 95% of a bot's wins. In that case it is collinear with the intercept.

The fit uses each bot's last ≤3,000 current-version matches. It is selection-biased upward: it shows what the bot bid when it was the highest bidder.

| bot | wins used | intercept | value | vowel | phase | last5 | balance/100 | nRealOpp | heldSame | heldTotal | R² | RMSE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LUCENT | 72024 | 7.10 | 3.08 | 0.66 | 6.33 | 4.01 | 0.28 | 0.06 | -1.95 | -0.32 | 0.46 | 6.70 |
| Bron | 94143 | -2.74 | 2.21 | 1.29 | 8.05 | 16.67 | 4.69 | 0.17 | -1.43 | 0.05 | 0.32 | 11.07 |
| Waupus | 3237 | 4.88 | 3.42 | 0.02 | 5.86 | 6.24 | 2.94 | n/a | -1.81 | 0.08 | 0.71 | 5.34 |
| maverick-bot | 65851 | 2.89 | 2.99 | 0.84 | 22.78 | 1.66 | -0.52 | -0.09 | -1.84 | -0.73 | 0.43 | 10.07 |
| Lala | 53534 | 2.30 | 3.40 | -0.23 | 2.40 | 0.39 | 5.57 | 0.47 | -0.87 | 0.05 | 0.79 | 2.93 |
| K-13 | 1774 | 0.68 | 3.02 | -0.56 | 9.23 | 5.38 | 7.66 | -0.01 | -1.31 | 0.02 | 0.65 | 5.31 |
| Lionel | 52994 | -3.66 | 3.21 | 0.42 | 8.40 | 2.52 | 10.50 | 0.42 | -1.64 | 0.28 | 0.69 | 4.85 |
| wordchoice | 25976 | 0.61 | 2.78 | 0.07 | 4.01 | 1.77 | 7.94 | 0.63 | -2.23 | 0.31 | 0.46 | 5.56 |
| Karthik | 22526 | 2.42 | 3.30 | 0.17 | 7.27 | -0.33 | 6.07 | n/a | -2.02 | 0.29 | 0.66 | 4.74 |
| Calebot | 21756 | 3.43 | 3.30 | 0.20 | 2.33 | 1.93 | 6.31 | n/a | -1.99 | 0.77 | 0.59 | 5.16 |
| Nijello | 7402 | 0.90 | 3.04 | 0.15 | 7.72 | 2.13 | 8.23 | n/a | -1.46 | 0.08 | 0.68 | 4.62 |
| hinsonloo | 967 | 8.05 | 2.93 | -1.93 | 7.89 | 0.64 | -0.47 | 0.39 | -1.54 | 0.08 | 0.65 | 4.55 |
| sardine | 30807 | -12.28 | 3.89 | 0.35 | 14.29 | -4.27 | 9.98 | 1.31 | -2.14 | 0.53 | 0.64 | 5.78 |

Patterns common to all bots:
- Each face point adds about **3 to the bid** (the coefficient ranges 2.2-3.9).
- Every bot bids **less for duplicates** (heldSame −0.9 to −2.6 per copy).
- Most bots bid more as the match progresses and when they are richer.
- The number of real opponents barely matters (|b6| ≤ 0.63 for the top-15 bots).

### E2. Full bid distribution (reverse Kaplan-Meier)

**Method.** This model uses losses as well as wins:
- When a bot wins, its bid = the archived top bid (exact).
- When it loses, its bid ≤ the winner's top bid. That bound is the maximum of the other bids, so it is independent of this bot's bid, which makes this standard left-censoring.
- When nobody bids, bid ≤ 0.
- The estimator was validated on synthetic data: the recovered P(bid ≥ x) was within 0.01 of the truth.

**Caveat.** Mass below about 3-5 is not identified. Competitors' maximum bid rarely falls that low, so `pNoBid` and the low quantiles are biased toward 0. Use the upper tail. The previous Tobit attempt was rejected: σ was 35-45 and the fit failed to converge for 4 bots.

Each cell is the q75/q90 bid, then P(bid ≥ 10).

| bot | vowels | LNSTR | DG | BCMP | FHVWYK | JXQZ | early | mid | late | last5 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LUCENT | 8/13, 20% | 8/13, 19% | 13/17, 49% | 15/19, 56% | 19/23, 59% | 34/40, 64% | 10/17, 25% | 9/15, 25% | 13/21, 38% | 9/21, 24% |
| Bron | 8/12, 18% | 7/11, 14% | 10/14, 26% | 13/19, 52% | 17/24, 76% | 30/30, 92% | 8/11, 15% | 8/12, 16% | 14/21, 48% | **27/34, 62%** |
| Waupus | 10/13, 33% | 11/13, 37% | 14/17, 53% | 17/20, 56% | 21/25, 58% | 40+/40+, 76% | 11/13, 40% | 11/14, 38% | 13/19, 42% | 14/24, 29% |
| maverick-bot | 8/14, 18% | 7/13, 16% | 9/16, 25% | 13/21, 41% | 17/26, 55% | 33/40, 73% | 7/11, 13% | 7/12, 15% | **20/35, 54%** | 0/16, 14% |
| Lala | 10/12, 28% | 10/12, 27% | 14/16, 51% | 17/20, 49% | 20/24, 44% | 21/37, 30% | 12/18, 45% | 10/13, 35% | 9/12, 21% | 0/5, 5% |
| K-13 | 10/12, 30% | 11/13, 38% | 13/16, 56% | 18/20, 68% | 22/26, 63% | 37/40, 85% | 10/12, 32% | 11/15, 38% | 12/18, 45% | 13/22, 33% |
| Lionel | 10/13, 26% | 10/13, 26% | 13/16, 44% | 16/20, 53% | 19/24, 57% | 37/40, 66% | 11/15, 32% | 11/16, 34% | 11/16, 33% | 7/14, 20% |
| Calebot | 11/13, 33% | 11/13, 32% | 15/17, 48% | 19/22, 53% | 22/28, 52% | 18/36, 40% | 12/21, 44% | 12/15, 43% | 10/14, 30% | 4/15, 18% |
| Nijello | 10/12, 37% | 10/12, 37% | 14/16, 61% | 18/20, 65% | 23/25, 66% | 35/40, 63% | 11/14, 45% | 11/14, 43% | 12/18, 48% | 7/17, 22% |
| Afterword | 0 (no win in last 3,000 matches) | | | | | | | | | |
| hinsonloo | 0/0, <1% everywhere | | | | | | | | | |

Per-letter × phase curves (P(bid ≥ x) for x = 1..40, 135 groups per bot) are in `summary.json → bots[i].bidModel.bidDistributionKM`. They are ready to use as opponent clones in the simulator.

### E3. Apparent strategies

**Active in today's lobby:**
- **LUCENT** (v3; strongest in today's lobby):
  - Buying: a mid-volume value buyer, winning 19.4 letters/match at 10.0 average paid.
  - Bidding: ≈ 7 + 3.1·value + 6.3·phase + 4·last5. It ignores its own balance (+0.3 per 100).
  - Words: the most bingo-focused bot, with 2.65 words of 7+ letters per match and 89.9% of points from 7+.
  - Endgame: conservative. It plays its last word about 3 auctions before the end and never bids on the final letter.
  - Weakness: it dominates sims (75% wins with 1 real opponent) but is **chance-level at a 6-real table (16.6%)**.
- **Bron** (v1; 14.6k matches; present in every lobby match):
  - Buying: the cheapest volume buyer, winning 22 letters/match at 8.3 average paid. It bids small amounts on nearly every letter (q90 11-12 early and mid).
  - Hard cap: J/X/Q/Z bids stop at exactly 30.
  - Late game: it escalates sharply (last5 +16.7). On the **penultimate letter it bids its whole balance** 52.9% of the time and wins 79% of those auctions (median top 30, max 326).
  - Endgame: it never bids on the final letter and plays its last word right after the penultimate close.
  - Waste: it ends with 53 balance unspent on average, but has the best score/spend (0.74).
  - Plays 4.2 words/match, 56% of them exactly 7 letters.
- **maverick-bot** (v3):
  - Buying: phase-driven. It is cheap early (q90 11) and very aggressive in the late third (q75 20 / q90 35, bid +22.8 across the match).
  - Endgame: it then mostly stops in the last 5 (wins 7.9% of them) and plays its last word about 3 auctions early.
  - Slow: 282 ms word latency.
  - Weakest of the active three: Bron and LUCENT finish above it 68% and 74% of the time.
- **Afterword**: inert now. It had no winning bid in its last 3,000 matches, ends with a median balance of 100 and a median score of 0, and played zero words in 71.7% of its matches. It scored 54.7 at 6-real tables in late October. It is a free last place.
- **hinsonloo**: almost inert. P(bid ≥ 10) is under 1%, its median score is 19, and it has never beaten Bron or LUCENT recently.

**Strong in full-table (tournament-like) conditions:**
- **Lionel** (inactive since Nov 1):
  - The best high-volume full-table bot: 30.5% wins over 6,435 6-real matches.
  - Its bids scale with balance (+10.5 per 100), and it spends down to a median final balance of 8.
  - Fast (66 ms latency). It plays more short words and the most 8+ words (22%).
- **Lala** (v8): front-loaded. It wins 37% of early auctions but only 6% of the last 5, and skips high-value letters entirely (KM median 0 for F/V/W/Y/K/J/X/Q/Z). Its bids are very deterministic: R² 0.79, RMSE 2.9.
- **Waupus** (Oct 25 only):
  - The strongest full-table bot: 53% wins, and 3rd in the tournament.
  - It buys fewer letters (13.1/match) at high prices (13.9 average), and its bids are highly consistent (R² 0.71).
  - Its endgame is tight: last word about 906 ms before the end, 0.23 tiles unplayed.
- **K-13** (tournament champion):
  - Bids are balance- and phase-sensitive (+7.7 per 100, +9.2 across the match).
  - It values letters generously (P(bid ≥ 10) for J/X/Q/Z is 85%).
  - It crushed the 2-player finals by about 4:1.
- **Calebot**: fastest word reactions (44 ms after a close). It spends heavily early (15.7 average paid early vs 11.4 late).
- **Nijello**: 38.7% wins at full tables. It has the highest tie share (17%), consistent with round-number bids.

**Quirky bots:**
- **bro**: bids on almost everything (P(no bid) about 0.08) and wins 68% of final auctions, which wastes the letter. It leaves 2.15 tiles unplayed.
- **BuySpellRepeat-bot**: bids a **constant 2** on nearly every letter (KM median 2 for all 26), sometimes bids high early, and wins 63% of final auctions at a price of 1.

---

## F. Sim-bot verification

The rule being checked is `decideBid` (game.ts:775-799), applied when each auction opens by `simulateBids` (game.ts:801-825):
- base = value−1 (Cheapskate), value (ValueBidder), or value+4 for vowels / value+2 for consonants (Aggressive).
- bid = max(min(max(base+jitter, 1), balance), 0), with integer jitter in −2..2 (`SIM_BID_JITTER = 2n`, game.ts:771).
- After winning, a sim plays `findBestPlayable(rack, 3)` inside `closeAuction` (game.ts:613-615, 864).

| check | count | violations |
| --- | --- | --- |
| sim wins: archived top bid within decideBid range given strategy, letter, reconstructed balance | 65,431 | **0** |
| sim losses (balance ≥ 1): smallest possible sim bid ≤ price paid (= second-highest bid) | 1,484,765 | **0** |
| auctions with a solvent sim but no winner | - | **0** |
| sim words played at the close timestamp of an auction that sim just won | 26,624 | **0** |
| sim words shorter than 3 letters | 26,624 | **0** |
| sim wins followed by more than 1 word | 65,431 | **0** |
| sim wins followed by exactly one word | 65,431 | 26,624 (40.7%) |
| sim words using the FINAL auction's letter (impossible for real bots) | - | 4,901 |

Winning top-bid offsets from base, where balance was not binding:
- Aggressive: −2:1,760, −1:4,446, 0:8,459, +1:14,997, +2:27,761.
- ValueBidder: −2:34 ... +2:3,454.
- Cheapskate: −2:25 ... +2:1,288.

Winners skew to +2, as expected when several sims compete.

**Implication.** A sim's price ceiling is known in advance:
- A vowel against an Aggressive sim costs at most 7, and a consonant at most value+4.
- ValueBidder never bids above value+2, and Cheapskate never above value+1.
- Recently, real winners paid a median of 5-7 for vowels, depending on the sim count (5 sims → 5; 1 sim → 7).

---

## G. Validation

These are the E2E data checks. They passed with 0 mismatches.

| check | checked | mismatches |
| --- | --- | --- |
| word_play total_reward == floor(Σ values × mult) and bonus == total − base (letters.ts:75-81, game.ts:713-719) | 402,308 | 0 |
| word_play base_score == Σ letter values (letters.ts:1-39) | 402,308 | 0 |
| played word ∈ wordlist.txt (172,820 ENABLE words, uppercase) | 402,308 | 0 |
| word length ≥ 2 | 402,308 | 0 |
| participant final score == Σ its word rewards | 153,572 | 0 |
| participant final balance == 100 − Σ paid on wins + Σ rewards | 153,572 | 0 |
| auctions per match == 98 − 5 × participants | 25,597 | 0 |
| a letter auctioned more often than its bag count | 25,597 | 0 |
| top_bid < paid | 1,740,646 | 0 |
| winner with top_bid < 1, or no winner with paid/top ≠ 0 | 1,740,646 | 0 |
| winner whose balance < price (the game.ts:579 branch that silently withholds the letter) | 1,740,646 | 0 |
| bot played more than 5 tiles it never won (starting-rack overdraw) | 153,572 | 0 |
| real-bot word at or after the final auction's close | 402,308 | 0 |

Three consequences:
1. A replay simulator built from letters.ts and game.ts reproduces history exactly.
2. Each bot's known letters (won − played) are exact.
3. Start tiles become known exactly when they are played.

---

## H. Surprising or exploitable findings

1. **The final auction is dead money for real bots; skip it.** The letter can never be used: the match ends in the same transaction (game.ts:617-627), and there are 0 real-bot words at or after the final close. Sims take it every time recently, and use it in a word 4,901 times overall. Paying for it has no effect except that it does not hurt, because leftover balance is worthless.
2. **The penultimate letter is where everyone dumps cash.** Recent mean top bid is 50.6 against a mean price of 7.8.
   - Bron bids its entire public balance there 52.9% of the time.
   - Under Vickrey, whoever bids the most pays the runner-up's bid, so wanting that letter means outbidding Bron's balance.
   - Pushing Bron's price there is pointless, since its leftover money is worthless anyway.
   - A word that needs the penultimate letter must be submitted within about 1 s of that close.
3. **Late-game top bids double while prices stay flat.** Recent mean top bid goes from about 9 mid-game to 19-23 in the last 10 auctions, while the mean price goes from 6 to 8-10. Desperate bidders face little competition, so late bargains exist for whoever bids second-highest well. Overbidding late is cheap if we really need the letter.
4. **Ties are frequent and random** (game.ts:557-560). 11.9% of real-bot wins (25.3% of sim wins) had top == price ≥ 2.
   - Multiples of 5 are only slightly over-represented: Bron 22.8% and bro 29.4% of winning bids, against a 20% baseline.
   - So most ties come from bids clustering on a few small integers. The one clear focal point is Bron's hard cap of 30 on J/X/Q/Z.
   - **Bid one above the main rival's modal bid** for that letter and phase (from the KM curves), e.g. 31 for J/X/Q/Z against Bron.
5. **Real field strength is overstated by ratings.**
   - LUCENT and Bron win 16.6% and 20.6% at full real tables.
   - Waupus, K-13, Nijello and Lionel won 30-53% there.
   - Tune for full-table tournaments separately from sim-padded lobbies. A full table pays about 2x higher prices: median 12 vs 6.
6. **Sims fill about half of every current lobby (on average 3.1 of 6 seats; range 1-5), and their bids are exactly computable.** Strategy is in the public `bot` row; balance and score are in the public `match_participant`. Model their maximum bid exactly rather than statistically.
7. **Inert opponents.** Afterword is in 48% of matches and hinsonloo in 22%. Both always finish at the bottom, and our bot loses nothing by ignoring them.
8. **Racks are partially public.** For every opponent, won − played gives the known part of its rack, exactly (the validation shows 0 overdraws). Only its 5 hidden start tiles are unknown, and those are revealed when played. Rack-aware denial and valuation of opponents are therefore feasible.
9. **Q is overbought.** 23.3% of won Qs go unplayed, at a median price of 25 (16 recently), and V, U and Z are wasted 10-12% of the time. Price Q only when a QU word is reachable.
10. **Money is left on the table.** Recent winners end with a median of 64 unspent (Bron's mean is 53). A bot that plans to spend down to near 0 by the penultimate auction converts more balance into score.
11. **Spectator leak** (index.ts:120-140). `visible_auction_top_bids` returns `auction_top_bid` rows for **running** matches to any identity without a bot credential. Those rows are inserted at close (game.ts:602-607), so a second anonymous connection sees every closed auction's **winning bid** live. That exposes each opponent's exact valuation mid-match, and exposes ours to anyone watching. It does not expose the current auction's pending bids, because `pending_bid` is private. Assume competitors may read our past top bids. Don't let our bid amounts encode exploitable state.
12. **The economy is circular.** Spend per match is about 170-195 for top bots, nearly double the starting 100, because rewards refill the balance (game.ts:721-725). Early word plays fund later bids.
    - Lionel (median final balance 8) and Waupus play words steadily.
    - LUCENT and Bron hoard, playing 30-38% of their words in the last 10%, and still win in sim-heavy lobbies.
    - The trade-off between playing early to fund bids and holding for bingos is a key strategy lever worth simulating.

---

## Implications for our bot (opinionated)

1. **Phase 1: simulator and tests.** Build the simulator and E2E harness on this data first.
   - The module rules reproduce history with 0 mismatches, so they are safe to clone.
   - Use the sim rule exactly, and seed opponent clones from `summary.json` (KM curves plus word-length and timing profiles). Bron, LUCENT and maverick-bot are needed for lobby realism; Waupus, K-13, Lionel and Nijello for tournament realism.
2. **Bidding.**
   - Value each letter by its marginal effect on our probability of making about 2 bingos. Each face point is worth about 3 currency.
   - Subtract value for duplicates.
   - Never bid on the final auction.
   - Treat the penultimate auction as a balance dump. Respect Bron's public balance there.
   - Break ties by bidding +1 above the rival's modal bid. Bid 31 for J/X/Q/Z when we need them, which beats Bron's 30 cap.
3. **Word timing.** Hoard for 7+ letter words, but submit the final word right after the penultimate close. Target under 150 ms latency: top bots react in 44-140 ms and auctions close every 1,001 ms.
4. **Two operating modes.**
   - Lobby, where 3-4 sims are present: prices are low, so buy volume.
   - Full real table (tournament): about 2x prices. The winner needs about 106-130 points (130-155 against the strongest fields), and the margin over 2nd is only about 13.
5. **Regression targets for our E2E stats.**
   - Beat LUCENT head-to-head more than 50% in lobby-like simulations.
   - Reach above 35% wins at simulated full tables against clones of Waupus, K-13 and Lionel. Waupus achieved 53%.

---

## Gaps and open questions

- **Bid timing is not observable.** `pending_bid` is private, so how late rivals bid, and how often they replace bids, cannot be measured. Sniping risk has to be handled by design, not by data.
- **Low-bid behaviour is unidentified.** KM gives no reliable P(no bid) for strong bots. It needs live probing, which is out of scope here because no reducers may be called.
- **Tournament format may change.** Only one tournament exists (Vickrey, size 6). `auction_type` can be FirstPrice, but no FirstPrice match has ever been played, so there are no FirstPrice priors.
- **Bots may change without a version bump.** Bron's single "version" spans 14.6k matches. A drift check (early vs late Bron) was not done.
- **Using the spectator leak is a policy question** (ethics and rules) for the user. It is documented here, not recommended.

---

## Files (scratchpad; untracked)

All paths are under `/private/tmp/claude-501/-Users-adem-Documents-GitHub-scrabbleBawt/f0cb5422-db12-4105-b246-d1edf5490e36/scratchpad/`.

**Data (`hist/`):**

| file | size |
| --- | --- |
| auction_result.ndjson (1,740,657 rows) | 192.1 MB |
| auction_top_bid_archive.ndjson (1,740,646 rows) | 90.8 MB |
| word_play.ndjson (402,317 rows) | 52.9 MB |
| rating_history.ndjson (153,566 rows) | 20.7 MB |
| match_participant.ndjson (153,578 rows) | 10.2 MB |
| match_state.ndjson (25,598 rows) | 6.4 MB |
| **summary.json (opponent and price priors)** | **2.76 MB** |
| bot.ndjson (148) | 16.5 KB |
| bot_stats.ndjson (149) | 26.8 KB |
| retired_bot_stats.ndjson (96) | 19.0 KB |
| bot_version.ndjson (111) | 7.1 KB |
| tournament.ndjson (1) | 0.2 KB |
| tournament_match.ndjson (51) | 3.6 KB |
| tournament_entry.ndjson (68) | 8.4 KB |

**Analysis outputs (`hist_out/`):**
- results.json (2.73 MB, every computed table)
- extra.json (41 KB: ties, head-to-head, field combos, ROI)
- tables.md (46 KB)

**Scripts (`hist_tools/`):**
- fetch-history.mjs: the fetcher.
- load.mjs: the loader and the reward/bag constants.
- analyze.mjs: sections A-H.
- analyze_extra.mjs
- km.mjs: the reverse-KM estimator.
- gen_tables.mjs: renders the tables and merges extras into summary.json.
- Probes and tests: cadence.mjs, probe_bron.mjs, probe_tour.mjs, probe_unused.mjs, test_km.mjs.
- tobit.mjs: kept for reference only; it was rejected.

**To reproduce:**
```bash
T=/private/tmp/claude-501/-Users-adem-Documents-GitHub-scrabbleBawt/f0cb5422-db12-4105-b246-d1edf5490e36/scratchpad
node $T/hist_tools/fetch-history.mjs --token-file $T/ident.json --out $T/hist --tables bot,bot_stats,retired_bot_stats,bot_version,tournament,tournament_match,tournament_entry,match_state,match_participant --all --fresh
node $T/hist_tools/fetch-history.mjs --token-file $T/ident.json --out $T/hist --tables auction_result,auction_top_bid_archive,word_play --range 1:43000 --chunk 2000 --sleep 700
node --max-old-space-size=8192 $T/hist_tools/analyze.mjs $T/hist $T/ref/official/spacetimedb/wordlist.txt $T/hist_out
node --max-old-space-size=8192 $T/hist_tools/analyze_extra.mjs $T/hist $T/hist_out
node $T/hist_tools/gen_tables.mjs $T/hist_out $T/hist
```

## Sources

- Live DB `maincloud.spacetimedb.com/v1/database/scrabblebot/sql`, read-only SELECTs, fetched 2026-11-07 13:48-13:58 local time. HIGH confidence.
- Official module source (github.com/clockworklabs/scrabblebot), as cited inline: `spacetimedb/src/game.ts`, `letters.ts`, `dictionary.ts`, `lobby.ts`, `index.ts`, `tournament.ts` and `spacetimedb/wordlist.txt`. HIGH confidence.
