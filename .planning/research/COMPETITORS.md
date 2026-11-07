# Competitor Bot Intelligence: ScrabbleBot

**Researched:** 2026-11-07 (live data snapshot about 20:10 UTC)
**Scope:** every public ScrabbleBot bot implementation found, mapped to the live leaderboard; behavioural fingerprints of the active top bots that have no public code; re-implementable opponent specs for our simulator; ideas to adopt; weaknesses to exploit; tricks to defend against.
**Overall confidence:** HIGH for specs read from source code. MEDIUM for live fingerprints (fitted on public data; only winning bids are observable). LOW for claims about the *current* live code of bots whose repos stopped on Oct 24-25.

**Method.**
- GitHub searches: `scrabblebot`, `scrabble-bot`, `scrabble auction`, `scrabble spacetime`, `scrabble vickrey`, `scrabble bot tournament`, `scrabblebot cal hacks`, `hackutd scrabble`, `spacetimedb auction`, `lucent/bron/lettershark scrabble`. Also the fork list and the known repos.
- 33 repos (plus 3 SookraBot branches) cloned read-only to `scratchpad/ref/bots/`. Nothing was installed or executed.
- Read-only SQL against maincloud on these tables: `bot`, `bot_stats`, `bot_version`, `bot_credential`, `tournament`, `match_state`, `match_participant`, `auction_result`, `auction_top_bid_archive`, `word_play`. Three blocks of matches:
  - **NOW**: ids 42062-42661, the 600 most recent ended matches (Nov 7).
  - **ALLREAL**: ids 25950-26149 (Oct 28), 177 of them with six real bots.
  - **MIXED**: ids 29900-30099 (Oct 31), 5-6 real bots.
- Analysis scripts (our own): `scratchpad/comp_scripts/` (`fingerprint.py`, `fingerprint2.py`, `h2h.py`, `word_timing.py`, `rng_check.mjs`, `sim_bid_check*.mjs`). Data: `scratchpad/comp_data/`.

Conventions used below:
- `B` = `match_state.bag_total` while an auction is open. It counts the auctions *after* this one, so `B == 0` is the final auction.
- `T = B + 1`.
- `N` = seats.
- `totalAuctions = 98 - 5N`, which is 68 at 6 seats.
- `r` = 1-based auction index.
- `phase = (r-1)/totalAuctions`.
- `face(L)` = Scrabble letter value.

---

## 0. Key findings (read first)

1. **The live lobby field is tiny and dominated by three bots with no public code.**
   - The last 600 matches had 3 real bots in 415, 2 in 130 and 4 in 55. Sims padded the rest.
   - The regulars are **LUCENT** (18), **Bron** (114) and **maverick-bot** (62), plus **Afterword** (145).
   - Afterword is connected but scored 0 and won 0 tiles in all 323 sampled matches since about Oct 31. It is a dead seat.
   - LUCENT beats Bron 324-160 head to head. Bron beats maverick-bot 320-149.
   - None of the three has public code. Section 2 fingerprints them and section 4.9 gives data-fitted clones.

2. **K-13, the tournament #1 champion, is the top tournament threat.**
   - It is online right now (`bot_credential.connected = true` since 2026-11-04 17:41 UTC) but has played no ladder match since Oct 25.
   - This matches its documented stealth mode: `K13_NO_LADDER=1`, plus `K13_AUTO_TOURNAMENT=1`. It "registered for tournament #1 89 ms after the tournament opened".
   - Expect it in the next tournament. Its full source is public (no license), so a faithful clone is possible (section 4.8).

3. **A new tournament is forming.**
   - Seven new bots were created today between 18:51 and 20:09 UTC: Bot 161, Barracuda 162, Binter 163, Tow57-Auctioneer 164, cosine 165, SoapConsumers 166, Jaeger 167.
   - Two public repos appeared today for "HackUTD 2026 (Spacetime track)": areebhirani-beep/scrabblebot and shreyask235/ScrabbleBot. Both are stock starter copies so far.
   - Only tournament #1 exists in the `tournament` table so far.

4. **Server RNG flaw: all hidden starting racks can be computed from public data. Verified 1000/1000.**
   - `ctx.random` is `xoroshiro128+(pcg32(ctx.timestamp µs))`, re-seeded on every reducer call. Sources: SDK 2.12.0 `src/server/runtime.ts` (`get random() { return (this.#random ??= makeRandom(this.timestamp)) }`) and `src/server/rng.ts` (pcg32 uses the signed `>>`). The module itself admits the seeding flaw at `game.ts:200-204`.
   - The deal happens inside the match-start transaction (`game.ts:285-298`), and that timestamp is public as `match_state.started_at`.
   - Our own reimplementation reproduced the sim padding choice and the first auction letter in **1000 of 1000** matches (600 NOW + 200 ALLREAL + 200 MIXED). It therefore also reproduces every seat's 5 "hidden" tiles.
   - Sim jitter at auction 1 was exact in 30/30 checks.
   - For later auctions the RNG chain stays valid (40,800/40,800 next letters reproduced). The 3 sim jitters are known as a multiset (1464/1464 consistent) but not per sim, because participant-row iteration order changes.
   - K-13 has a line-for-line port of this RNG (`src/sim/rng.ts`) but says its live belief ignores it.
   - **This is an exploit of a server bug.** Using it offensively needs an explicit decision by the user (and arguably the organizers). Defensively: **assume rivals can know our starting rack.**

5. **Consensus mechanics every strong bot uses.** Treat these as table stakes.
   - Bid 0 on the final tile; its letter is unplayable (`game.ts:616-629`). In NOW, LUCENT, Bron and maverick-bot won 0 final auctions across 1,563 bot-matches.
   - Go all-in on the penultimate auction (`B == 1`) for any letter that improves the final partition. Median winning top bid over balance there: maverick 0.99, LUCENT 0.82, Bron 0.68. Code: Lala, Nijello, Lionel, SookraBot, Afterword.
   - Cash 7+ letter words when they appear. 97-100% of LUCENT and Bron mid-match words are 7+ letters.
   - Dump the exact best partition in the last auctions.
   - Act in the first ~100-400 ms of each auction. Send an anchor bid at open and refine it later (K-13, Karthik).
   - Pace a budget so coins reach about zero at the end: λ / μ shadow price (K-13, Karthik, Lala, BlackSwan).

6. **Market levels depend on the field.** Median price paid per tile:
   - NOW, with sims: A 6, E 7, N/T 5, Z 25, X 23, Q 21.
   - ALLREAL, 6 real bots: A 11, E 11, Z 40, X 32, Q 31.
   - Score levels follow: about 150-165 points with sims, 80-90 in all-real tables.
   - A strategy tuned on the lobby will mis-price a tournament. K-13 found prices of 25-40 per tile at 7+ seat tables.

7. **visible_auction_top_bids leak.**
   - Any identity *without* a bot credential can read the winning bids of every closed auction in every running match (`index.ts:120-140`).
   - Every serious bot noticed this and publicly declined to use it: K-13, Lala, LetterSharkUltra, Afterword.
   - Treat our winning bids as visible to rivals within about 1 s.

---

## 1. Summary table (all bots found)

Leaderboard numbers come from `bot_stats` as of Nov 7: OpenSkill mu, matches, average score, win%. Tier: S = top threat, A = strong, B = solid, C = weak.

| Live bot (id) | Public repo | Lang | mu / matches / avg / win% | Last active | Public code = live? | Tier | Core approach |
|---|---|---|---|---|---|---|---|
| LUCENT (18) | none found | ? | 61.75 / 4604 / 124.8 / 42% | playing now | n/a | **S** | (data) bids ~9 on 1-pt letters early, ~15-17 late; 7+ words only; dumps in last 3; penultimate ~0.8×bal |
| Bron (114) | none found | ? | 58.49 / 14610 / 136.1 / 39% | playing now | n/a | **S** | (data) thrifty phase-ramp bidder; 7+ only; dumps at final auction; ends with ~59 coins vs sims |
| K-13 (127) | aryamehr2k/k13-scrabblebot | TS | 51.05 / 136 / 98.8 / 43% | connected, ladder-stealth | yes (tuned 10-25 01:32Z) | **S** (tournament) | MC rack valuation + λ pacing + per-rival censored bid models + expected-utility bid search with denial/price-driving |
| Waupus (138) | none | ? | 53.83 / 248 / 102.0 / 53% | 10-25 | n/a | A | Tournament #1 3rd; thrifty early (60 coins at r20, per Lala's study) |
| james (23) | none | ? | 51.26 / 53 / 98.3 / 51% | 10-30 | n/a | A | thrifty early, strong late (Lala study) |
| maverick-bot (62) | none | ? | 51.20 / 7868 / 106.0 / 15% | playing now | n/a | A | (data) steepest late ramp; all-in at penultimate; also cashes 5-6 letter words |
| Lala (88) | dhruv-1100/lala-scrabblebot | TS | 51.18 / 3998 / 104.1 / 26% | 11-02 | likely (repo v2.7.5 = site version 8 = current) | A | Poisson rack-plan valuation + learned leave table; shadow price μ; cap 1.25× going price; completion floor 1.4× |
| Lionel (107) | JoaquinGiorgis/scrabblebot-gaucho | TS | 50.74 / 9045 / 98.5 / 30% | 11-01 | snapshot only (params hot-reload; an LLM advisor may rewrite policy.ts on Railway) | A | linear bid `0.969Δpot + 1.536face + 1.919 + 0.83bal/A`, ×e^0.472(spend/3)^0.215; hoards until word ≥40.6 |
| wordchoice (92) | none | ? | 48.26 / 2094 / 81.0 / 24% | 10-29 | n/a | B | strong in ALLREAL block (avg 90.0, place 2.54) |
| Karthik (74) | KarthikSubramanian07/Vickrey-Scrabblebot | Rust | 47.61 / 1854 / 87.1 / 29% | 10-27 | yes ("finished") | B | MC valuation, Balseiro-Gur λ pacing, fitted field model, anchor bid, live A/B |
| Calebot (119) | not found (calebshin22 repo is "cortado") | ? | 47.18 / 1664 / 91.4 / 31% | 10-26 | n/a | B | n/a |
| Nijello (59) | bananatruck/scrabblebot-evo, 3nvyx/nijello-scabble-bot | TS | 46.87 / 553 / 92.1 / 39% | 10-25 | gen-180 params public; live params not committed | B | 48 CMA-ES-evolved weights; endgame MC look-ahead |
| Lambi Lambiii (77) | rohan879/scrabblebot | TS | 46.08 / 768 / 90.9 / 32% | ≤10-25 | yes | B | MC planner (40 scenarios, 480 ms) bidding zero-crossing of gain curve; shading; drain/deny heads-up |
| postturing (52), Metheny (85), Chinese Dante (22), Doppio (20), TileShark (19), LetterShark (8), guesser (55) | none | ? | 43-47 mu | ≤10-26 | n/a | B | Karthik/Lala fits only (section 4.10) |
| LetterSharkUltra (120) | ManushPatel08/Scrabble_Bot_Tournament | TS | 42.81 / 280 / 88.9 / 33% | ≤10-25 | yes | B | μ-pacing agent + adversarial harness; 10th of 68 in tournament #1 |
| SookraBot (9) | StephenSook/sookrabot (branches finals-patch, round3, tournament-ready) | TS | 40.09 / 1457 / 76.2 / 15% | ≤10-25 | yes (branches) | B | `bid = κ·Δvalue`, κ paced by √(spend rate); many rule tricks (broke rivals, all-in last, duel spite) |
| BlackSwan (97) | goffycoder/blackswan-bot | TS | 38.61 / 657 / 81.9 / 21% | 10-25 | yes | C | MC valuation + "liquidity floor" 0.95× market price on every letter, 40-coin reserve |
| TaylorMason (69), Wags, VictorMateo | Phaslyr/scrabblebot | TS | 30.33 / 644 / 61.8 / 3% | 10-25 | yes | C | median-price buying; leader pressure (off in v5) |
| tosh_lupoi (112) | vkhans07/scrabble-bot | TS + C++ | 28.68 / 19 | 11-07 | yes | C | native rollout engine, opponent priors |
| cortado (109) | calebshin22/caleb-scrabblebot | TS | 23.50 / 363 / 56.4 / 4% | connected; autopilot commits daily | yes | C | UCB bandit over strategy variants, replay tuning |
| Afterword (145) | Jose-Gael-Cruz-Lopez/afterword-scrabblebot | TS | −4.71 / 6363 / 22.8 / 6% | connected | Lionel policy + exact endgame | dead | 0 tiles won in all sampled matches since about Oct 31 |
| allin-bot (151) | none | ? | −7.92 / 42 / 0.0 | 10-25 | n/a | spoiler | never plays words; buys ~8.8 tiles/match at 1.5-2× market until broke |
| Tow57-Auctioneer (164), Bot (161), Barracuda, Binter, cosine, SoapConsumers, Jaeger | areebhirani-beep/scrabblebot, shreyask235/ScrabbleBot (HackUTD day 0) | TS | new (≤7 matches) | today | stock starter so far | ? | assume starter kit (section 4.2) until they evolve |

Repos with no live bot or no bot code:
- robertguozt/ScrabbleBot: heuristic, frequency-weighted premium.
- diuekwx/scrabblebot: market.json plus a "holdRack" profile (hold until 8 tiles or auction 40).
- junsooki/scrabblebot: native C++ move evaluator.
- micahlai/scrabblebot: `TOURNAMENT_ID=auto`, replay tuning; active until 11-02.
- benjaminxie1/scrabblebot: HANDOFF.md only. sudoanmol/scrabblebot: module changes only.
- dhsdb010, benhuang3, 0xABAN, adadi-bit: empty repos.

**June-2026 event repos.** Rust `lib.rs` module era (launchpad-scrabblebot.vercel.app). Different rules: no starting racks and earliest-insert ties. Not on the current leaderboard: AlvinManojAlex/scrabblebot, TheAryanAnode/ScrabbleBotSpacetimeDb, vraj2131/scrabblebot, maanctech/scrabble-auction-bot (Python, 15 ms deterministic engine), VJDiPaola/auction-agent-evals ("TheEcho").

**Licenses.** Do not copy code from K-13, Nijello (both repos) or BlackSwan, which ship no license. Re-implement from the specs below. Karthik is MIT. The fork repos carry upstream's MIT LICENSE: Lala, gaucho, Lambi, SookraBot, LetterSharkUltra, Afterword.

---

## 2. The live field: who we will actually face

### 2.1 Composition over time (from `match_participant` scans)

| Match ids | Date (UTC) | Real bots per match | Main bots |
|---|---|---|---|
| 14000-14099 | Oct 25 | 6 (100%) | broad field: Lionel, SookraBot, LetterSharkUltra, Lala, 67, newBose, triplo... |
| 20000-20099 | ~Oct 26 | 6 | Lionel, Calebot, Bron, ericbot, hinsonloo, ace_bot, scrabby, sardine, wordchoice, guesser |
| 25950-26149 | Oct 28 | 6 (177/200) | Lionel, Bron, maverick-bot, wordchoice, scrabby, ericbot, Afterword, sardine, hinsonloo |
| 29900-30099 | Oct 31 | 2-6 | Lionel, Bron, maverick-bot, Lala, Afterword (already dead), hinsonloo |
| 34000-34099 | Nov 4 | 3-4 | Bron, maverick-bot, Afterword, LUCENT |
| 42062-42661 | Nov 7 | 3 (69%), 2 (22%), 4 (9%) | LUCENT, Bron, maverick-bot, Afterword (dead) + sims |

Match ids have gaps (blocks near 23000 and 38000 are empty). Matches start about every 90 s and run 68 s.

### 2.2 NOW fingerprints (600 matches, ids 42062-42661)

Column notes:
- `top/price` = winning bid divided by the median paid for that letter.
- `allin` = share of wins where the top bid ≥ balance.
- `pen top/bal` = winning top bid over balance at the penultimate auction.

| Bot | n | score | place | win | tiles | paid/tile | spent | end bal | mean top | top/price | allin | words | wlen | 7+ share | 1st word (round) | bal r20/r45/r56 | final won | pen top/bal |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| LUCENT | 490 | 165.5 | 1.51 | 61% | 25.6 | 9.30 | 238 | 27.5 | 14.4 | 1.87 | 6% | 4.69 | 6.39 | 75% | 17.5 | 66/50/44 | 0 | 0.82 |
| Bron | 600 | 157.8 | 1.79 | 38% | 26.4 | 7.53 | 199 | 58.9 | 12.0 | 1.57 | 3% | 4.83 | 6.32 | 73% | 13.8 | 88/71/62 | 0 | 0.68 |
| maverick-bot | 473 | 128.1 | 2.31 | 14% | 19.7 | 10.32 | 203 | 24.8 | 16.8 | 2.14 | 12% | 4.00 | 5.98 | 53% | 17.8 | 85/62/40 | 0 | 0.99 |
| Brutus-sim / Maverick-sim (Aggressive) | ~315 | 17.4 | 3.85 | 0 | 4.5 | 4.8 | 22 | 95 | 6.0 | 0.94 | 0 | 1.85 | 3.9 | 0 | 14 | ~100 | 0.67 | n/a |
| Valor/Hagrid (ValueBidder), Cheapo/Snippet (Cheapskate) | ~300 each | 1-3 | 5.2-5.4 | 0 | 0.1-0.3 | ~2 | <1 | ~101 | ~2.6 | ~0.35 | 0 | 0.1-0.2 | 4.6 | 0 | 56-65 | ~100 | 0.1-0.2 | n/a |
| Afterword | 161 | 0.0 | 4.54 | 0 | 0.0 | n/a | 0 | 100 | n/a | n/a | n/a | 0 | n/a | n/a | n/a | 100 | 0 | n/a |

Notes:
- The word counts include the final dump. Mid-match words are 7+ letters 97-99% (LUCENT), 98-100% (Bron) and 71-84% (maverick). See 2.4.
- Average score by number of real bots per match:
  - LUCENT: 209.2 with 2 real (place 1.26), 152.6 with 3 (1.57), 141.8 with 4 (1.76).
  - Bron: 177.5, 154.0, 139.7.
  - maverick-bot: 151.1, 128.1, 124.4.
- Head to head (higher score in shared matches): LUCENT > Bron 324-160 (n=490); Bron > maverick 320-149 (n=473); LUCENT > maverick 282-78 (n=363).

### 2.3 All-real fingerprints (tournament-like)

**ALLREAL**, Oct 28: 177 six-real matches and 23 five-real matches.

| Bot | n | score | place | win | tiles | paid/tile | spent | end bal | top/price | words | wlen | 1st word | bal r20/r45/r56 | pen top/bal |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Lionel | 200 | 89.8 | 2.48 | 30% | 12.4 | 14.2 | 176 | 13.7 | 1.29 | 2.87 | 5.68 | 28.7 | 73/38/24 | 0.88 |
| wordchoice | 137 | 90.0 | 2.54 | 34% | 13.2 | 13.1 | 173 | 16.8 | 1.28 | 2.84 | 6.15 | 33.5 | 50/45/36 | 0.81 |
| Bron | 199 | 82.6 | 3.19 | 20% | 12.6 | 12.7 | 160 | 22.7 | 1.23 | 2.99 | 5.66 | 28.0 | 77/45/31 | 0.89 |
| maverick-bot | 161 | 75.7 | 3.57 | 8% | 11.3 | 13.8 | 155 | 20.4 | 1.41 | 2.72 | 5.80 | 22.9 | 70/30/11 | 0.97 |
| Afterword (alive then) | 84 | 70.9 | 3.37 | 19% | 10.1 | 14.8 | 150 | 20.9 | 1.36 | 2.38 | 5.61 | 37.1 | 79/51/35 | 1.00 |
| LUCENT (v3, early) | 10 | 36.8 | 5.10 | 0% | 6.4 | 13.3 | 85 | 51.9 | 1.33 | 1.30 | 5.92 | 29.6 | 73/68/58 | 1.00 |

- Head to head: Lionel > Bron 127-71; wordchoice > Bron 80-54; wordchoice > Lionel 71-59.
- **MIXED** (Oct 31): Lionel 140.2 (place 1.96, 46% wins), Bron 131.6 (2.10, 32%), Lala 107.2 (2.31, 25%), maverick 100.5 (2.86, 10%).
- **LUCENT is unproven in all-real tables.** Its v3 has existed since 2026-10-25 07:04 UTC and made only 10 all-real appearances in the sampled blocks, all weak. Its 61.8 mu was earned mostly against sims plus Bron and maverick. Its code may have changed since without a version bump (LOW).

### 2.4 Per letter-class × phase winning bids (NOW)

Format: median winning top bid / median paid / share of those auctions won. Quarters q0..q3 cover auctions 1..T-2. Classes:
- **vow**: vowels.
- **c1**: 1-point consonants.
- **c2-4**: 2-4 point letters.
- **c5+**: K, J, X, Q, Z.

| Class | LUCENT q0 / q1 / q2 / q3 | Bron q0 / q1 / q2 / q3 | maverick q0 / q1 / q2 / q3 |
|---|---|---|---|
| vow | 9/6/.40, 9/6/.31, 9/7/.43, 15/9/.30 | 7/5/.33, 7/5/.35, 9/7/.35, 14/7/.42 | 9/6/.23, 8/6/.25, 10/7/.30, 20/10/.33 |
| c1 | 9/6/.33, 8/5/.32, 8/6/.54, 17/9/.31 | 6/4/.47, 6/4/.46, 8/6/.32, 14/7/.42 | 7/5/.25, 7/5/.26, 9/7/.30, 21/10.5/.32 |
| c2-4 | 17/11/.49, 15/11/.45, 14/10/.39, 22/14/.29 | 11/7/.39, 11/7/.42, 13/10/.39, 20/10/.44 | 14/10/.27, 13/10/.24, 17/12/.35, 28/16/.33 |
| c5+ | 33/22/.46, 35/25/.46, 35/25/.39, 32.5/21/.25 | 22/17/.30, 23.5/17/.31, 25/18.5/.30, 30/14/.50 | 33/23/.40, 28.5/20/.40, 33/24/.48, 40.5/26/.27 |

**Least-squares fits of log(winning top bid).** Wins only, auctions before the last two. These are descriptive: selection bias inflates levels, and the negative balance slopes are confounded with phase.

```
LUCENT   log b = 2.454 + 0.175·face + 0.265·phase − 0.125·bal/100 − 0.037·rack − 0.013·vowel − 0.029·nSims   sd 0.414  n 12476
Bron     log b = 1.986 + 0.169·face + 0.791·phase − 0.226·bal/100 − 0.033·rack + 0.018·vowel − 0.013·nSims   sd 0.335  n 15427
maverick log b = 2.070 + 0.163·face + 1.017·phase − 0.172·bal/100 − 0.045·rack + 0.009·vowel + 0.009·nSims   sd 0.444  n 9240
```

Word lengths by phase, as (words, mean length, 7+ share):

| Bot | q0 | q1 | q2 | q3 | last 3 auctions |
|---|---|---|---|---|---|
| LUCENT | 274, 7.20, .97 | 415, 7.25, .99 | 654, 7.26, .97 | 437, 7.07, .91 | 519, 3.6 (dump) |
| Bron | 469, 7.18, 1.00 | 510, 7.22, .99 | 523, 7.21, .98 | 478, 7.15, .99 | 918, 4.45 (dump) |
| maverick-bot | 258, 6.84, .71 | 240, 7.08, .79 | 372, 7.15, .80 | 357, 7.26, .84 | 664, 3.89 (dump) |

### 2.5 Action timing (from `word_play.played_at` minus the previous `closed_at`)

Words go out right after the auction opens. Nobody waits for the end of the window. Bids are not observable, but bots typically send words and the bid together at open.

| Bot | mid-match word offset, ms (p10 / median / p90) | final-auction dump |
|---|---|---|
| Lionel | 51-70 / 60-80 / 77-97 | median 56-78 ms |
| LUCENT | 61 / 106 / 176 | only 51 final-auction words in 490 matches: it dumps at B = 2-1 |
| Lala | 59 / 95 / 174 | 95 ms |
| Bron | 148 / 210 / 325 | 818 final-auction words: dumps at B = 0, median 117 ms |
| wordchoice | 113 / 129 / 175 | 120 ms |
| maverick-bot | 219 / 393 / 673 | 332 ms (max 803) |
| Afterword (Oct 28) | 387 / 541 / 814 | 544 ms (max 912) |

**Server timing.**
- Auction closes fire 0.65 / 1.59 / 4.7 ms (p1 / median / p99) after `closes_at`. The maximum observed lag was 637 ms.
- Karthik reported 1.8-4.3 s reducer round trips at hackathon peak, with bids sent 800 ms early rejected as "Auction closed".

---

## 3. Detailed per-bot analysis

### 3.1 K-13 (bot 127): aryamehr2k/k13-scrabblebot. Tournament #1 champion.

**Basics.**
- TypeScript, Node 22, tsx.
- Internal strategy name "palace": `src/brain/agent.ts`, `bid.ts`, `market.ts`, `value.ts`, `place.ts`, `belief.ts`, `params.ts`.
- Tuned parameters in `data/params.json`, 2026-10-25T01:32Z.
- Claimed results: champion of 68 entrants. Heads-up final 1,202-323 over three games against TileShark. About 40-50% wins on the ladder at ~90 points before the tournament.

**Letter value.** `V(rack) = E_F[P(rack + F)]`.
- F is k imagined future tiles drawn from the unseen pool. The pool is the bag plus opponents' unrevealed starting tiles; a starting tile is revealed when a bot plays more of a letter than it bought.
- P is an approximate best partition: best of the top-12 first words, then greedy.
- Letter value = `V(rack+L) − V(rack)`, using common random numbers.
- k = `clamp(futureScale·wins, 0, min(kMax, future))`, where `wins = min(future·maxWinShare, budget/price)`. The initial k is `min(kMax, future, futureScale·balance/kInitPrice)`.
- Samples last as long as the rack and age out after 6 rounds.

**Coin price λ.**
- Each round it solves for λ (points per coin) by log-space bisection over [0.02, 4].
- The constraint is `Σ_letters count_i · spend_i(floor(v_i·futureValueScale/λ)) = balance + incomeShare·baseValue·future/totalAuctions`.
- `spend_i` comes from the predicted max-competitor-bid CDF at mid-remaining phase: `phaseF = phase + (1−phase)/2`.
- The result is multiplied by lambdaScale: 1.08 at <7 seats, 0.8 at ≥7 seats (big tables clear 25-40 per tile).

**Bid.** Expected-utility maximisation over every integer bid b in [0, balance]:

```
U(b) = E[my surplus | b] + Σ_o w_o · λ · (E[o's Vickrey surplus | I bid 0] − E[... | b])
```

- The first term is truthful Vickrey `v/λ` when there are no rivals.
- The rival term adds denial (I win instead of o) plus price-driving (o pays my bid).
- The rival term may lift the bid at most `floor(maxOverbid)` = 4 coins above the selfish optimum.
- `w_o = rivalWeight(0.9) · f_o/Σf`, where f_o is the normal density of the projected score gap at 0.
- σ = `sqrt(4² + 40²·remaining)`; equity = `score + λ·balance + 2.5·rackSize`.

**FirstPrice.** Same search, paying b. The rival term is off.

**Opponent modelling.**
- One hurdle model per bot: logit P(bid = 0) plus a log-normal latent bid. Features: letter, 5 phase buckets, balance bucket, rack-size bucket.
- Fit as censored (Tobit-style) MAP: winners' bids are exact from `auction_top_bid_archive`, and Vickrey losers' bids are bounded by the price paid.
- Partial pooling toward a market model. Recency half-life 4 h. Hourly refit by an anonymous miner.
- Sims use their exact formula.
- In-match calibration: PIT of each observed price, `logScale += 0.056·(u − 0.5)`, clamped to scale [0.3, 3].

**Word policy.**
- For each of the top-8 candidate words w (length ≥ 2), compare on the same futures:
  - play: `r(w)·(1 + coinBonus·λ) + E[P(rack − w + F)]`;
  - hold: `E[P(rack + F)]`.
- Play if playing wins by `playMargin` = 2.7. Up to 3 plays per call.
- Dump the exact best partition when the last auction opens (`dumpAtBag 0`).

**Tricks.**
- Bids 0 on the final tile. If a sim is seated it bids its whole balance there instead: free denial, since coins are worthless after it.
- Values the second-to-last tile with k = 0.
- Two-stage live bidding: a quick bid at open (≤6 ms), refined until close − 250 ms (`PALACE_MARGIN_MS`).
- Clock-offset tracking. Auto tournament registration. Stealth mode (`K13_NO_LADDER=1`).
- Fair-play statement: never reads `visible_auction_top_bids`; one bot, one process.

**Self-improvement.**
- Simulator ported from server code. About 25k matches/s. Reproduces live all-sim matches within ~1 point.
- Calibrated clones of each rival: SPSA on 13 behaviour parameters, `data/clones.json`.
- Cross-entropy tuning. Paired evaluation with clustered 95% CIs.
- Full private tournament rehearsals on a local copy of the module.

**Caveat they publish.** Clones front-load spending, so the simulated field is too easy: sim place 1.1-1.3 against 2.81 live.

**Useful artefact.** `data/clones.json` holds per-bot real behaviour targets (score, tiles, price, coins left, words, word length, 7+ count) for 70 bots as of Oct 25. See the table in 4.10.

### 3.2 Lionel (bot 107): JoaquinGiorgis/scrabblebot-gaucho. Also the policy Afterword runs.

**Basics.**
- TypeScript, docs in Spanish. `bot-starter/src/core/policy.ts` plus `params/vickrey.json` (`VERSION 2026-10-25-selfarena`).
- BOT.md says "nuestro bot es Lionel". Afterword's README pins the same policy at commit f2dce03.

**Valuation.** `potential(rack)` = max over dictionary words of `reward(w) · Π_missing pc[letter]`, with:
- `pc = pBase·u/(u + aHalf')`, where u = unseen count of that letter;
- `aHalf' = aHalf / f^horizonW` and `f = A/U`;
- at most `maxMissing` = 2 missing letters, and words of length ≥ 3.

**Bid.** `alpha·Δpot + beta·face + gamma + pace·balance/A`, times `e^c0·(spend/3)^c1`. Plus:
- a market floor when behind its letter target;
- a tiny denial term;
- the exact final-partition delta for A ≤ 2;
- all-in at A = 1 when it helps.

**Word policy.** Never plays a word paying under 40.55 unless balance < 9.47. Plays when `reward + pot(rest) ≥ 0.66·pot(rack)`. Flushes at A ≤ 1.

**Self-improvement.**
- Cross-Entropy Method in the simulator, then a "replay arena": it replaces Lionel in its own real matches against the other five real bots' archived bids, with STEAL/DRAIN 0.3 calibration.
- An LLM advisor (Grok or Claude) proposes parameter and code changes, which pass the same blind test.
- Params hot-reload without a version bump. **The live code may differ from the repo.**

**Results.**
- About 35% wins live early. 9,045 matches total.
- ALLREAL: best or second-best bot. MIXED: 46% wins.
- Last played 11-01.

### 3.3 Lala (bot 88): dhruv-1100/lala-scrabblebot. Team Yuvak.

**Basics.** TypeScript. `bot-starter/src/strategy/{lala.ts, value.ts, params.ts, tables.ts}` plus JSON tables. Version string v2.7.5 = site version 8, the current version.

**Valuation.**
- Best plan over dictionary words of 2-8 letters: `P(complete)·reward − μ·ρ·Σ missing prices + leftover value`.
- `P(complete)` is a product of Poisson tails, with λ = futureDraws·unseen_k·winP/U.
- Leftover tile value comes from a learned leave table: 3 auction-left buckets × 26 letters × 3 copies.

**Bid.** `marginal/μ`.
- μ = `0.3·(need/have)^0.6`, ×0.6 in the last 12 auctions, clamped to [0.05, 1.5].
- Capped at 1.25× the going price (phase price table × in-match price scale) while T > 3.
- Floored at 1.4× the price when the letter completes a 6+ letter word worth 12+ more points.
- FirstPrice: lognormal shading.

**Word policy.**
- Play when `reward + V(rack − w) ≥ V(rack)`; ties go to play.
- Starvation rule: below 8 coins with 10+ auctions left, cash the best 7+ word.
- T = 2: all-in on any letter that improves the partition. T ≤ 1: exact partition dump, bid 0.

**Opponent modelling.** None at bid time; it uses the market price table. A rich analysis toolkit exists offline.

**Claimed results.** v2.7.4: 133 games, 19% wins, place 3.09, score 81.1.

**Most useful finding (ANALYSIS.md §13).** The leaders (Waupus, james) bid 1.10-1.19× the going price early, hold about 40 coins at round 45, and buy 4.6 tiles in the last 23 auctions. Lala's simulator was "too easy" until a field of those styles was built.

### 3.4 Nijello (bot 59): bananatruck/scrabblebot-evo (Oct 24) and 3nvyx/nijello-scabble-bot (Oct 25).

**Basics.** TypeScript on Node 24. `src/strategy.ts` with 48 CMA-ES weights. Live parameters `params/nijello-live.json` are generation 180.

**Valuation.** A learned per-letter "keep" value with vowel-balance, duplicate and Q-without-U penalties, plus best-word and 7+-word deltas, a face-value "denial" term (3.06·face), and a vowel-scarcity term.

**Bid.** `value · e^0.202 · (balance/(B+1)/3)^0.300`, with an endgame ramp and all-in at B = 1.

**Look-ahead.** In the last 12 auctions it plays the rest of the match out against fitted rival profiles, within a 450 ms budget, and replaces the bid if a candidate is clearly better. Replays: 63.4% → 69.8% wins.

**Opponent profiles.**
- Tobit regression per real bot: log bid on phase, phase², log1p(gain), log1p(gain7), log1p(balance), log(market/12), face/10, vowel.
- `3nvyx/bot/data/profiles.json` holds about 80 bots as of Oct 25 06:07Z. It includes old LUCENT, Waupus, james, K-13, Lionel and others.
- Word-play styles in `data/styles.json`.

**Release gate.** Promote only if the candidate beats the live strategy on replays of real matches by more than 1 SE. The README says 2 SE, but the code uses 1.

**Results and lessons.**
- Peak rank 4. 34-39% wins on the ladder, but 40th in tournament #1 Swiss.
- Its lesson: ladder form is not tournament form, and table size changes everything. At 10 players it won 9%.
- The 3nvyx version adds a seat-count scale and a BINGO_RULE: play any 7+ word at once unless the current letter extends it.

### 3.5 Karthik (bot 74): KarthikSubramanian07/Vickrey-Scrabblebot.

**Basics.** Rust crates: vickrey-core, vickrey-brain, vickrey-sim, vickrey-bot. MIT.

**Strategy.**
- Valuation: Monte Carlo over the letters it expects to buy.
- Exact terminal value by trie plus branch and bound (9 ms for 20 letters).
- Balseiro-Gur λ pacing against a fitted market. The rivals' max bid is lognormal(letter, phase) × heat, capped at the richest rival's balance.

**Key parameters.** min_play_len 7, cash_min_reward 45, choice_mult 1.6, income_factor 0.4 (0.8 heads-up), deny_weight 0.5 (heads-up), drain_floor 0.8 (heads-up).

**Engineering.** Instant anchor bid at auction open, which cut ghost losses from 2.4 to 0.006 per match. A dump zone when time left < 2·p90 RTT + 0.3 s.

**Self-improvement.** Refit from live data, hill-climb, live interleaved A/B with Welch t ≥ 2, research agents re-profiling rivals every 2 h.

**Results.** 49th of 68 in the tournament. 27% wins on the ladder after fixes.

**Key value for us.** The best catalogue of fitted rival families and public-bot clones: `crates/vickrey-sim/src/agents.rs`, re-specified in 4.10.

### 3.6 Lambi Lambiii (bot 77): rohan879/scrabblebot.

**Basics.** TypeScript. `bot-starter/src/{strategy.ts, planner.ts, market.ts}`. Data in `data/market-*.json` and `data/opponents-*.json`, with 42 fitted opponent profiles.

**Bid.**
- A worker planner over the remaining auctions with 40 sampled scenarios and a 480 ms budget.
- Gain curve "win at price p versus pass"; it bids where the average gain crosses 0, the optimal second-price bid.
- Shading:
  - ×0.8 on face ≤ 2 letters until the last 28 auctions;
  - ×0.85 on face ≥ 3 while more than 46 auctions remain;
  - ×0.78 in FirstPrice (fallback).
- Heads-up: denial 0.5, and a drain floor of 0.6× the typical rival bid on every letter until the last 12 auctions. Drain 0.6 also applies at 3-4 players.
- Heuristic fallback: bid ≤ min(0.6·balance unless remaining ≤ 8 or immediate ≥ 20, richest rival + 1).

**Word timing.** Play the first word of the best packing if any of these holds:
- remaining ≤ 3;
- best word is 7+ letters;
- balance < 8;
- tiles ≥ 11;
- remaining ≤ 12 and best word is 5+ letters.

**Live fit by Karthik.** Leader at 02:35Z Oct 25: mean place 1.74, 58% wins.

### 3.7 SookraBot (bot 9): StephenSook/sookrabot.

**Basics.** TypeScript. The strategy lives on branches: round3, finals-patch, tournament-ready, ... The default branch has no bot. `bot-starter/src/strategy.ts` documents every constant with its evidence.

**Bid.** `κ·Δvalue`, where Δvalue = greedy packing plus 0.35 × LEAVE_W7 leave value.
- κ = 3.8·clamp(√r, 0.5, 3), with r = (balance/auctions left)/(100/68).
- ×0.7 in the first 28 auctions when at least 2 real rivals are present.
- ×2 in the last 8 auctions. Karthik notes the ×2 was later disabled at ≤6 seats; I did not find it in the branches (LOW).

**Rules.**
- SIM_ONLY_KAPPA 20, capped at the max sim bid + 1.
- BROKE_RIVAL: when no rival can bid > 2, bid their max + 1.
- ALLIN_LAST at B = 1: bid min(balance, richest rival + 1), only when no sim is seated.

**Words.** Hold everything for the final flush, started 3,000 ms before the end (FLUSH_LEAD_MS). Liquidity word when balance < 15.

**FirstPrice.** Bid the 20% quantile of recent rival prices.

**Duels.** "Spite" price-push: ours + 0.5·(predicted − ours), capped at 2× ours.

**Self-improvement.** Cloud self-play via GitHub Actions workflows, a Python cross-check simulator, and paired seeds.

### 3.8 BlackSwan (bot 97): goffycoder/blackswan-bot.

**Basics.** TypeScript. `src/engine.ts`.

**Valuation.** MC over 150 futures: E[best finishable word | with tile] − E[best | without], ×κ (1.8, rising 1.5× over the last 12 auctions).

**Liquidity floor.** On *every* letter, bid ≥ 0.95 × market price (PRIOR_PAID scaled by this match's price index). It keeps a 40-coin reserve until 12 auctions remain. In the last 7 auctions the floor ×1.6 and the reserve is dropped.

**Words.** Mid-match it cashes only 7+ words worth ≥ 38, unless the rack has ≥ 11 tiles. Final auction: bid 0 and play the best split.

**Live A/B.** Broad buying plus MC: place 2.87-2.91, 30-31% wins (Oct 24).

### 3.9 LetterSharkUltra (bot 120): ManushPatel08/Scrabble_Bot_Tournament.

**Basics.** TypeScript. μ-pacing agent with versions v1..v7 and FINAL_PARAMS. 10th of 68 after Swiss (17 points).

**Useful pieces.**
- RULES.md: a line-by-line verified rules doc. Notes that a self-join subscription on `match_participant` never delivers later balance/score updates (S1). Notes that `subscribeToAllTables` runs out of memory.
- Adversarial harness `sim/threats.ts`, with these adversaries:
  - **shadow**: Vickrey leader tax. Bids 0.85 × the leader's estimated value.
  - **late**: hoards in the first half, then dominates.
  - **outbid**: first-price, learns the leader's prices and bids +1.
  - **jitter**: ±30% noise on bids.
  - **sniper**: no bids in the first half, then balance/left (×2 on useful letters).
  - **allin**: 3·balance/left every auction.
  - **slow**: always first in ties. Irrelevant now, since ties are random.

**Note.** The live module must be checked against the repo. Before 2026-10-22 the server ran an unpublished round-robin module (L1-L7 in RULES.md). Since 10-23 it matches `3064b36`.

### 3.10 Others in brief

- **TaylorMason, Wags, VictorMateo** (Phaslyr): TaylorMason now runs "taylor-median-v5" (median-price buying, v4 word timing, defence off). The older shared v3 policy (still used by Wags) has exploration bids of 12/9/7 on common/other/rare letters, a 55% per-auction balance cap, an 8-coin reserve, cash-out at ≤18 coins and leader pressure. Weak (mu 30).
- **cortado** (calebshin22, bot 109): UCB bandit over strategy variants in `strategy.json` (bid_aggression 1.5, market_floor 0.8, denial 0.9, hold 7+). Ported the "Cortadomacchiato" engine from the private mm-nair/ScrabbleBot. Autopilot still commits daily replay searches. Weak (mu 23.5) but online.
- **tosh_lupoi** (vkhans07): native C++ rollouts; 81 average score over 3 baseline matches.
- **Afterword**: Lionel's policy plus an exact endgame and "bid the remaining balance on the last usable auction even for an unneeded tile". Uses `TOURNAMENT_ID=auto`. Dead in the lobby since about Oct 31 (0 tiles). A tournament seat may be dead too.
- **allin-bot** (151): data only. 42 matches, 0 points. Bought 8.8 tiles/match with winning bids 16-26 on 1-pt letters early. It never plays words: a price-inflating spoiler.
- **HackUTD day-0 forks**: unmodified starter (section 4.2).

---

## 4. Re-implementable clone specs (for our simulator)

All specs assume:
- the server rules in `game.ts`;
- the view a real bot has: own rack, public balances and scores, `bag_total`, auction history, word plays;
- that the bot acts at auction open (words first, then the bid);
- that `bestPartition(rack)` is the exact max-reward set of disjoint words;
- that `best(rack, minLen)` is the max-reward single word.

### 4.1 Server sims (exact; `game.ts:771-869`)

```
strategy: id 1,6 Cheapskate; 2,4 ValueBidder; 3,5 Aggressive   (bot table rows)
bid(L) = max(min(max(base + j, 1), balance), 0),  j ~ U{-2..2} drawn per sim when the auction OPENS
  base = face−1 (Cheapskate) | face (ValueBidder) | face + (vowel ? 4 : 2) (Aggressive)
  => a sim with balance ≥1 bids ≥1 on EVERY letter: in sim-padded matches every letter sells
words: inside closeAuction, right after the sim WINS a letter: play findBestPlayable(rack, 3)
  = the longest playable word of length ≥3 (dictionary longest-first; dictionary.ts:63-100)
  => a sim can use the final letter; real bots cannot
padding: on lobby timeout the 6 sims are Fisher-Yates shuffled (lobby.ts:62-82) and the first
  (6 − realBots) are seated after the real bots
```

### 4.2 Starter kit (exact; `bot-starter/src/strategy.ts`). The HackUTD day-0 forks run this.

```
bid(L) = min(have(L)==0 ? face+2 : max(1, face), balance)     // never bids above 12
word: on every rack change (500 ms retry), play the LONGEST playable word (≥2 letters)
```

### 4.3 Lionel / gaucho (exact; `policy.ts`, `params/vickrey.json` = VERSION 2026-10-25-selfarena)

```
P = {pBase .95, aHalf .374, maxMissing 2, minLen 3, alpha .969, beta 1.536, gamma 1.919, pace .83,
     shade .552 (vickrey.json; params/firstprice.json uses .8), holdKappa .66, minPlayReward 40.551,
     flushAt 1, lowCash 9.467, floorMult .796, letterTarget 12.016, slack 1.996, horizonW 1.172,
     idleBeta .839, endN 2, allIn 1, c0 .472, c1 .215, denyW .077, capBase 1 (no cap), endBoost 0,
     floorTop 0, w2 0, baseFloor 0, paceK 0, qW 1}
view: A = bag_total (auctions after this one); round r; won = letters won so far;
      unseen[i] = BAG[i] − auctioned[i] (incl. current) − myStartRack[i]   (opponent reveals NOT removed)
      market[L][q] = median PAID per letter and 5 phase quintiles (params/market-paid.json; gaucho's
      table from Oct 24: A 11,10,10,11,12 ... Z 45,45,38,32,19)
pot(rack): U = Σunseen; f = clamp(A/U, .02, 1); aH = aHalf / f^horizonW
           pc[i] = unseen[i] > 0 ? pBase·unseen[i]/(unseen[i] + aH) : 0
           max over words w (len ≥ minLen, #missing ≤ min(maxMissing, A), need ≤ unseen):
               reward(w) · Π_{each missing tile} pc[letter]
bid(L):
  if A ≤ 0: return 0
  delta = max(0, pot(rack+L) − pot(rack)); spend = balance / max(1, A)
  if A ≤ 2:                                   # endN 2, and allIn at A == 1
      dump = bestPartition(rack+L).score − bestPartition(rack).score
      if A == 1: return dump > 0 ? balance : 0
      delta = max(0, dump)
  b = alpha·delta + (delta > 0 ? beta : beta·idleBeta)·face(L) + gamma + pace·spend
  b *= e^c0 · (max(.1, spend)/3)^c1
  total = r + A; behind = won < letterTarget·r/total − slack
  if behind and (delta > 0 or rackSize < 8): b = max(b, floorMult·market[L][min(4, floor((r−1)·5/total))] + 1)
  b = max(b, denyW · max over rivals with ≥3 public tiles of [best(rivalRack+L,2) − best(rivalRack,2)])
  if FirstPrice: b *= shade
  return floor(min(b, balance))
words:
  if A ≤ 1: play all words of bestPartition(rack)
  repeat ≤4: w = best(rack, 2); needCash = balance < lowCash
     stop if reward(w) < minPlayReward and not needCash
     stop if reward(w) + pot(rack − w) < holdKappa·pot(rack) and not needCash
     play w; balance += reward(w)
```

Worked example. Early, rack empty, balance 100, A = 66, letter E, delta ≈ 0:
- spend = 1.52;
- b = 0 + 1.536·0.839·1 + 1.919 + 0.83·1.52 ≈ 4.4;
- multiplier e^0.472·(1.52/3)^0.215 ≈ 1.39;
- result ≈ 6.

Lionel spends mostly through Δpot. Expect higher bids on letters that complete high-reward words.

### 4.4 Nijello gen 180 (exact; bananatruck `src/strategy.ts` + `params/nijello-live.json`)

```
keep = {A 8.85, B 3.12, C 4.36, D 5.39, E 9.60, F 3.85, G 1.30, H 5.93, I 7.22, J 2.19, K 7.42, L 4.62,
        M 4.54, N 5.54, O 7.78, P 4.43, Q 3.27, R 7.59, S 6.87, T 4.74, U 7.51, V 1.05, W 3.58, X 3.95,
        Y 7.02, Z 9.24}
vowelTarget .3832, vowelW 1.1091, dupW 2.5118, qNoU 11.458, scarceW 5.7008, wB .3328, wB7 0, tau .5,
denyW 3.0606, c0 .2024, c1 .3003, maxFrac 1, fpShade .7975, holdW .8834, cashW 4, cashScale 3,
playThresh 25, endN 6.4139, wFlush .9077, spendW 1.5675, endCash 10.5215, marketW 0
Q(r) = Σ keep[c]·n_c − vowelW·|vowels − vowelTarget·size| − dupW·Σ(n_c−1)² − (Q≥1 && U=0 ? qNoU : 0)
ph   = B/(B + tau)                                        # ≈1 except the last 1-2 auctions
best(r) = reward of best single word (len ≥2)
value(L) = ph·(Q(r+L) − Q(r)) + wB·(best(r+L) − best(r)) + denyW·face(L)·ph
         + (vowel(L) ? +1 : −1)·scarceW·(vowelTarget − unseenVowels/unseenTotal)·ph
  if L == 'Q' and rack U == 0 and unseen U == 0: value = min(value, 0)
  if B ≤ endN: value = max(value, wFlush·(bestPartition(r+L) − bestPartition(r)))
onAuction:
  if B == 0: play bestPartition(rack); bid 0
  words = chooseWords(minLen = (B ≤ endN and balance ≥ endCash) ? 7 : 2); balance += their rewards
  if value ≤ 0 or balance ≤ 0: bid 0
  if B == 1: bid balance
  budget = balance/(B+1)  [3nvyx: × (N<6 ? sqrt(N/6) : N/6)]
  mult = e^c0 · (budget/3)^c1;  if B ≤ endN: mult *= 1 + spendW·(endN + 1 − B)/(endN + 1)
  bid = floor(min(value·mult·(FirstPrice ? fpShade : 1), balance))
  live: in the last 12 auctions a 450 ms MC look-ahead may replace the bid
        (simulator approximation: × exp(0.25·z), as Karthik does)
chooseWords: ≤4 iterations over the top-24 words (len ≥ minLen):
  net = reward·(1 + cashW·cashScale/(cashScale + balance)) − holdW·ph·(Q(r) − Q(r − w))
      = reward·(1 + 12/(3 + balance)) − 0.883·(Q(r) − Q(r − w))
  play the argmax if net > 25
```

### 4.5 Lala v2.7.5 (exact formula; needs two data tables)

```
params: winP .9, maxMissing 2, rho .6, kappa0 3.5, kappa1 1, dupDecay .8, vowelUse 1, leaveW 1, leaveScale .7,
        minLen 2, maxLen 8, mu0 .3, muAlpha .6, muMin .05, muMax 1.5, share .2, incomeW .3, premium 1,
        lateN 12, lateMu .6, capMul 1.25, completeMul 1.4, completeMin 12, completeLen 6, starveBal 8,
        starveT 10, starveMinLen 7, playK 1, minPlayLen 2, playMargin 0, priceN0 8, shadeSigma .35, bidNoise 0
T = auctions left INCLUDING current (= B + 1); futureDraws = T − 2
prices[k] = max(1, phasePrice(r, k) · scale), scale = (Σ_{sold this match} paid/prior + 8)/(n + 8)
  phasePrice cuts r ≤ 20 / 45 / 62 / 68 (src/strategy/phase-prices.json):
   r≤20: A11 B16.9 C18 D14 E11 F20 G13 H21 I10 J31.5 K24.8 L10.1 M17 N10 O10 P17 Q33.2 R11 S12 T10 U10.9 V18.9 W19.9 X34.5 Y21.9 Z43.1
   r≤45: A10 B16 C18 D14 E11 F20 G12.1 H21 I10 J29.9 K24 L10 M17 N10 O9 P17 Q29.9 R11 S12 T10 U10 V18 W19 X32.8 Y21 Z39.9
   r≤62: A11 B16.9 C18 D14.9 E12 F20 G13 H21 I10 J25.2 K23.2 L11 M17.9 N11 O10 P17.9 Q22.7 R12 S12.9 T11 U10 V18 W19 X29 Y20.1 Z31.1
   else: A11 B14.6 C13 D12.3 E10.1 F14.8 G12.2 H15.6 I10 J19.6 K16.8 L10.2 M14.7 N10 O10 P14.1 Q17 R10.1 S12 T10 U8.4 V12.4 W14.6 X22.2 Y17.4 Z23
μ = clamp(mu0·(need/have)^muAlpha · (T ≤ 12 ? lateMu : 1), .05, 1.5)
    need = (futureDraws + 1)·share·avgUnseenPrice; have = max(1, balance + incomeW·max(0, rackValue))
V(rack) = max over plans (words 2..8 letters missing ≤ 2 letters):
    Π_missing PoissonTail(λ_k = futureDraws·unseen_k·winP/U, deficit) · reward − μ·rho·Σ missing·prices
    + leftover(rack − used)
  leftover(k, j copies) = 0.7 · max(0, Σ_{c ≤ min(j,3)} LEAVE[bucket(T)][k][c] + 0.5·(j−3)⁺·LEAVE[..][k][3])
  bucket by T: [41,99], [16,40], [3,15]. LEAVE[bucket][letter] = 1st/2nd/3rd copy:
   T 41-99: A7.2/5.6/7.9 B10.9/5.5/0 C11.9/7.0/0 D9.2/9.7/7.7 E7.3/6.1/6.3 F12.7/15.7/0 G7.4/7.1/0 H14.8/6.6/0 I6.5/5.4/4.4 J19.2/0/0 K16.0/0/0 L5.8/6.4/.5 M10.9/9.7/0 N5.9/4.3/3.0 O6.6/5.4/5.5 P10.9/9.6/0 Q20.4/0/0 R6.4/5.1/4.9 S6.4/5.8/−3.1 T5.7/5.8/6.6 U7.1/4.3/−.4 V11.6/7.4/0 W12.7/8.9/0 X22.1/0/0 Y14.6/8.4/0 Z29.4/0/0
   T 16-40: A8.3/5.6/6.8 B9.3/2.8/0 C10.7/5.2/0 D9.9/9.6/8.4 E8.7/6.7/8.0 F10.0/13.7/0 G7.2/5.6/0 H11.9/7.6/0 I7.9/5.2/2.7 J13.7/0/0 K13.0/0/0 L7.2/4.0/.2 M10.4/6.8/0 N7.4/4.4/2.4 O7.5/5.4/4.3 P9.5/5.7/0 Q11.0/0/0 R7.7/4.7/2.0 S8.3/4.9/−.8 T6.9/5.0/6.0 U7.5/3.0/.5 V8.6/6.0/0 W9.8/6.7/0 X15.4/0/0 Y12.5/4.9/0 Z19.6/0/0
   T 3-15:  A6.9/3.9/1.2 B5.6/2.2/0 C6.0/2.8/0 D6.0/5.7/1.6 E7.1/5.1/7.4 F5.9/6.1/0 G4.3/3.2/.5 H7.4/2.8/0 I6.0/3.3/3.0 J7.7/0/0 K7.7/0/0 L4.6/3.3/.4 M6.4/3.4/0 N5.1/2.3/1.9 O5.9/3.9/3.7 P5.6/4.8/0 Q4.4/0/0 R5.3/1.9/1.1 S6.0/4.0/1.0 T4.7/2.8/2.4 U5.2/2.1/−.1 V4.5/3.6/0 W6.0/2.7/0 X9.2/0/0 Y7.7/2.7/0 Z10.4/0/0
act():
  if T ≤ 1: play bestPartition; bid 0
  if T == 2: bid = (bestPartition(rack+L) > bestPartition(rack)) ? balance : 0; play words common to both partitions
  words: repeat ≤4: among words len ≥ 2: gain = reward + V(rack−w) − V(rack) (playK 1);
         play the argmax if gain ≥ 0; else if balance < 8 and futureDraws ≥ 10: cash the best 7+ word by reward + V(rest)
  marginal = max(0, V(rack+L) − V(rack)); bid = marginal/μ
  if T > 3: bid = min(bid, 1.25·prices[L])
  if best(rack+L, 6) − best(rack, 6) ≥ 12: bid = max(bid, 1.4·prices[L])
  FirstPrice: argmax_b (bid − b)·Φ((ln b − ln(1.25·price))/.35)
  bid = floor(clamp(bid, 0, balance))
```

### 4.6 SookraBot (finals-patch; core only)

```
Δ = packValue(rack+L) − packValue(rack); packValue = greedy packing total + 0.35·Σ LEAVE_W7(leftover)
LEAVE_W7 = A6.38 B6.75 C7.17 D5.79 E6.87 F7.39 G5.55 H8.61 I5.53 J8.8 K9.64 L5.41 M7.66 N5.06 O6.32 P7.11
           Q4.61 R5.2 S6.8 T4.92 U5.52 V4.82 W6.57 X10.54 Y8.93 Z11.91
if final (B == 0) or balance 0: 0
if B == 1 and no sim seated (ALLIN_LAST): Δ > 0 ? min(balance, richestRival + 1) : 0
if all rivals are sims: κ = 20, bid ≤ maxSimBid + 1
if every rival can bid ≤ 2 (broke): bid = their max + 1 on any Δ > 0
r = (balance/(B+1))/(100/68); κ = 3.8·clamp(√r, .5 (duel .75), 3)
if auction index < 28 and ≥2 real rivals: κ *= .7;  if B + 1 < 8: κ *= 2 (Karthik: off at ≤6 seats after 22:04 PDT 10-24; LOW)
bid = floor(κ·Δ·[lookahead ×.75 term, ignore for a clone])
words: hold everything; when the match ends within 3,000 ms (last 3 auctions) dump bestPartition;
       if balance < 15: cash one word (prefer len ≥5) that leaves the most valuable hoard
FirstPrice: 20% quantile of the last ≤40 rival prices (≥5 obs), else 0.4 × full bid
Vickrey duel: spite = ours + .5·(pred − ours) if pred > ours, ≤ 2×ours, tapering over the last 15
```

### 4.7 Lambi Lambiii (word policy exact; bid from Karthik's fit of its winning bids)

```
bid: class fits (winning-bid regressions, Oct 25):
  vowel:  13.7 + 2.2·progress − 2.3·bal/100 + 4.2·z
  1-pt consonant: 12.9 + 4.0·progress − 4.0·bal/100 + 2.9·z
  2-4 pt: 5.5 + 5.22·face + 2.4·progress − 0.3·bal/100 + 4.3·z
  5+ pt:  10 + 3.6·face + 2·progress + 6·z          (rarely buys: 0.42/match)
  if rack ≥ 6 tiles and the letter adds nothing to the best packing: ×0.6
  final auction: 0; clamp [0, balance]
  (the real bot: planner zero-crossing × shading 0.8 on face ≤2 until the last 28 auctions,
   0.85 on face ≥3 while >46 auctions remain)
words: play bestPacking.words[0] if remaining ≤ 3, or best word ≥7, or balance < 8,
       or tiles ≥ 11, or (remaining ≤ 12 and best ≥ 5)
heads-up: drain floor = max(bid, 0.6 × typical single-rival bid) on every letter until the last 12;
          denial +0.5 × the rival's immediate gain
```

### 4.8 K-13 "palace" (faithful simplification; constants from `params.ts` + `data/params.json`)

```
futureScale 1.07, kMax 13, kInitPrice 13, maxWinShare .5, searchTopK 12, quickSamples 8, maxSamples 96,
sampleMaxAge 6, lambdaMin .02, lambdaMax 4, lambdaScale 1.08 (<7 seats) / lambdaScaleBig .8 (≥7 seats),
incomeShare .47, futureValueScale 1.14, rivalWeight .9, denialWeight 1, driveWeight 1, maxOverbid 4.85→4,
tieShare .5, lastTileDeny true, calibRate .056 (scale ∈ [.3, 3]), generic market: bid ~ N(8 + 2.5·face, 3),
P(0) = .05; placeSigma0 40, placeSigmaMin 4, equityPerTile 2.5; playCandidates 8, playSamples 24,
coinBonus .32, playMargin 2.7, maxPlays 3, minPlayLen 2, dumpAtBag 0
per auction:
  future = B − 1 (useful auctions after this one); pool = bag + rivals' unrevealed start tiles − current letter
  counts_i = future·pool_i/|pool|; totalAuctions = 98 − 5N; phase = (r−1)/totalAuctions
  samples: F_s = k tiles drawn from pool (k fractional); P = best of the top-12 first words + greedy rest
  value(L) = mean_s[P(rack+L+F_s) − P(rack+F_s)]                # CRN
  λ: bisect log λ so that Σ_i counts_i·spend_i(floor(1.14·value_i/λ)) = balance + .47·mean_s P(rack+F_s)·future/totalAuctions
       spend_i/win_i from max-of-rivals CDF at phaseF = phase + (1−phase)/2;  λ *= (N ≥ 7 ? .8 : 1.08)
  k = clamp(1.07·min(.5·future, budget/price), 0, min(13, future)),  price = spend/wins (or 13)
  rivals: pmf_o (fitted model; sims exact), CDF G = Π CDF_o
  selfBid = argmax_b E[(value − λ·price)·1{win}]   (Vickrey: price = max(competing, 1))
  w_o = .9 · φ(z_o)/Σφ, z_o = (equity_me − equity_o)/σ, σ = sqrt(16 + 1600·future/totalAuctions),
        equity = score + λ·balance + 2.5·rackTiles
  bid = argmax_{b ≤ selfBid + 4} [mine(b) + Σ_o w_o·λ·cut_o(b)]   (cut = denial + price-driving; Vickrey only)
  B == 0: bid = (sim seated ? balance : 0); dump bestPartition (exact) during this auction
  B == 1: value with k = 0
words: candidates top-8 (len ≥2); play w if mean_s[P(rack−w+F_s)] + r(w)·(1 + .32λ) > mean_s[P(rack+F_s)] + 2.7;
       repeat on the remainder (≤3 words)
in-match calibration: after each close, u = mid-PIT of the observed price under the predicted max/second CDF;
       logScale += .056·(u − .5)
FirstPrice: same search paying b, rival term off
```

### 4.9 Data-fitted clones of the active top bots (no public code; MEDIUM-LOW)

Calibrate each clone in our simulator in a 3-real + 3-sim table until it hits the NOW targets in 2.2: tiles/match, paid/tile, spent, end balance, words/match, first-word round, balance at r20/45/56. The bid shape comes from 2.4.

```
common: B == 0 → bid 0 (never won a final auction in 1,563 bot-matches); act within the first ~100-400 ms
LUCENT:
  bid  = κ · exp(2.454 + .175·face + .265·phase − .125·bal/100 − .037·rack − .029·nSims + .414·z)
         κ ≈ 0.8 to start (winning-bid fits overstate typical bids); tune to tiles 25.6, paid 9.3, spent 238
  B == 1: bid ≈ .82·balance on a useful letter
  words: cash any 7+ letter word when held (97-99% of mid-match words are 7+); first word ≈ r17.5;
         dump bestPartition in the last 3 auctions (mostly at B = 2..1, not B = 0)
  targets (3 real + sims): score 165, place 1.51, end balance 27.5, balance r20/45/56 = 66/50/44
Bron:
  bid  = κ · exp(1.986 + .169·face + .791·phase − .226·bal/100 − .033·rack + .335·z)   # ×2.2 ramp start→end
         κ ≈ 0.8; targets tiles 26.4, paid 7.5, spent 199, end balance 59 (very thrifty with sims)
  B == 1: ≈ .68·balance;  words: 7+ only mid-match (98-100%), first word ≈ r13.8; dump at B == 0 (~117 ms in)
  all-real form (Oct 28): tiles 12.6, paid 12.7, end balance 22.7, balance r20/45/56 = 77/45/31, place 3.19
maverick-bot:
  bid  = κ · exp(2.070 + .163·face + 1.017·phase − .172·bal/100 − .045·rack + .444·z)   # ×2.8 ramp
         12% of its wins are all-in; B == 1: ≈ .99·balance (all-in)
  words: 7+ preferred (71-84%) but cashes some 5-6 letter words; first word ≈ r17.8; dump in the last 3
  slow client: word p90 673 ms after open (bids likely similar) → misses windows under server lag
```

### 4.10 Generic field components (for robust, diverse tables)

**Karthik's fitted families.** Fit on 1,568 live matches (ids 2732-4299), all-real era. `progress` ∈ [0, 1].

| Family | Bid formula | Residual sd | Word policy | Live bots |
|---|---|---|---|---|
| Ramp | −2.5 + 2.8·face + 15·progress + 11·bal/100 | 6.2 | nothing before progress 0.25; then 7+ on sight; dump in last 3 | Doppio, Nijello, Heidi, benx |
| Flat | 7 + 2.75·face + 3·progress + 4.3·bal/100 | 4.7 | 5+ words on sight | guesser, postturing, atlas, Chinese Dante |
| Hunter | 4.4 + 3.94·face + 7.1·progress + 3.2·bal/100 | 4.3 | 6+ words on sight | Metheny |

**Karthik FieldBot presets.** `bid = median_L · phase(progress) · 0.95 · aggression · (bal/100)^wealth_exp · e^(noise·z) · fit(rack)`.

| Preset | aggression | noise | wealth_exp | min_len | other |
|---|---|---|---|---|---|
| shark | 1.05 | 0.25 | 0.5 | 7 | smart dump |
| volume ("postturing") | 1.0 | 0.25 | 0.5 | 5 | premium letters ×0.55 |
| grinder | 0.95 | 0.3 | 0.4 | 5 | |
| spender | 1.35 | 0.35 | 0.8 | 6 | |
| nibbler | 0.75 | 0.3 | 0.3 | 4 | |

The field.json median per letter (all-real, Oct 25):

```
A11.7 B18.9 C19.8 D16.2 E12.6 F21.6 G14.4 H23.4 I11.7 J33.3 K26.1 L11.7 M18.9 N11.7 O10.8 P18.0 Q32.4 R12.6 S13.5 T11.7 U11.7 V19.8 W20.7 X34.2 Y22.5 Z43.2
```

- σ = 0.328.
- 17 phase multipliers: 1.124, 1.053, 1.011, 1.017, .988, .989, .980, 1.000, 1.005, 1.015, 1.000, 1.022, 1.014, 1.046, 1.094, 1.151, 1.090. Prices run hot early, dip mid-match and rise at the end.

**Other generic components.**
- **BlackSwan floor bidder.** `bid = max(MCvalue·κ, min(0.95·price_L·matchIndex, balance − reserve))`. The reserve is 40 until 12 auctions remain (0 in the last 7, where the floor ×1.6). Cash only 7+ words worth ≥ 38 mid-match. Bid 0 on the final tile.
- **allin-bot spoiler.** Never plays words. Bids about 1.5-2× the market on common letters (16-26 for 1-pt letters) until broke, about 9 tiles.
- **LetterSharkUltra adversaries.** Use as robustness opponents, not as field models: shadow (leader tax at 0.85× estimated value), late (hoard then dominate), jitter (±30%), sniper, allin (3·bal/left).

**Market price tables to seed opponent priors.**
- NOW median paid: A6 B10 C11 D8 E7 F12 G7 H13 I6 J22 K16 L6 M10 N5 O6 P10 Q21 R6 S6 T5 U7 V11 W12 X23 Y14 Z25.
- ALLREAL median paid: A11 B17 C19 D14 E11 F20 G13 H22 I10 J30 K22 L11 M18 N11 O10 P18 Q31 R11 S12 T10 U10 V18.5 W19 X32 Y21 Z40.
- K-13 `clones.json` real per-bot targets (Oct 25, all-real era), as score / tiles / price / coins left / words / 7+ words:
  - Metheny 94.7 / 13.2 / 13.7 / 14.6 / 3.0 / 1.75.
  - Lambi 92.7 / 12.4 / 14.7 / 9.7 / 3.2 / 1.34.
  - postturing 92.0 / 14.2 / 12.4 / 16.1 / 3.05 / 1.75.
  - Chinese Dante 89.3 / 11.8 / 14.3 / 20.3 / 2.8 / 1.69.
  - Lionel 86.2 / 12.6 / 13.0 / 22.2 / 2.8 / 1.51.
  - LUCENT (old) 83.6 / 12.3 / 13.0 / 24.5 / 3.0 / 1.84.
  - Bron (early) 75.2 / 11.0 / 13.8 / 23.5 / 2.7 / 1.43.

---

## 5. Best ideas to adopt (ranked by evidence × effect)

1. **Exact endgame rules.** These are near-free points and every top bot uses them.
   - Final auction: bid 0. If any sim is seated, consider bidding the whole balance to deny it (K-13), since coins are worthless after it.
   - Penultimate auction (`B == 1`): bid all coins on any letter that improves `bestPartition`, capped at richest rival + 1 (SookraBot).
   - Dump the exact best partition. Bron and Lionel dump at `B == 0`; LUCENT, SookraBot and Lambi dump in the last 3 auctions. Dump early enough to survive lag.
2. **Shadow-price pacing (λ/μ), re-solved every auction.** The goal is to spend to about 0 by the end (K-13, Karthik, Lala μ-mode 1). Use a thriftier scale at ≤6 seats and a looser one at ≥7 seats: K-13's 0.8 at ≥7 seats was worth −1.8 average place at 11 seats. "Score ≈ 0.535 × coins spent (r = 0.88)" across 1,500 live seats (Karthik). Coins converted to tiles are the game.
3. **Monte Carlo letter valuation with common random numbers** over the exact unseen pool (K-13, Karthik, BlackSwan). Pair it with an exact branch-and-bound partition solver: K-13 0.002 ms best-word, <1 ms partition; Karthik 9 ms for 20 letters.
4. **Play-vs-hold on the same futures, with a coin bonus.** K-13: `r(w)(1 + 0.32λ)`, margin 2.7. Cash a ready 7+ word immediately, since the multiplier is capped at 7, unless the current auction letter would extend it (Nijello BINGO_RULE). The data shows the top bots do exactly this: 97-100% 7+ mid-match, first word at rounds 14-18 with sims and 23-29 all-real.
5. **Per-opponent censored bid models** from `auction_top_bid_archive` (exact winners) and Vickrey `paid` (upper bound for losers). Add in-match PIT calibration (K-13) and a generic prior for unknown and HackUTD bots. Use exact formulas for sims and the starter.
6. **Two-stage bidding.** Send an anchor bid within a few ms of auction open, then replace it with the refined bid before close (K-13, Karthik). Karthik's ghost losses fell from 2.4 to 0.006 per match. Bid replacement is allowed until `closes_at` (`index.ts:797-802`); a 0 bid withdraws (`game.ts:556` filters 0).
7. **Exploit predictable bidders.**
   - Sims: bid max sim bid + 1 when only sims compete (SookraBot SIM_ONLY_KAPPA 20).
   - Starter bots: never above face + 2.
   - Broke rivals (public balances): bid max + 1 (SookraBot BROKE_RIVAL).
   - Always clamp to richest rival balance + 1 (Karthik, Lambi).
8. **Completion premium.** Bid ≥ 1.4 × the going price when the letter completes a 6+/7+ letter word worth ≥ 12 more points (Lala: −0.13 place). Top bots pay 1.19-1.42× for completing letters (Lala reverse-engineering).
9. **Placement-aware utility.** Ratings are by finishing order, so weight rivals near our score (K-13 `place.ts`). Add denial/price-driving capped at about 4 coins over the selfish bid.
10. **Heads-up final package.**
    - Drain floor: bid ≥ 0.6-0.8 × the rival's typical bid on every letter until the last 12 auctions. Lambi: 86% wins against the mirror's 51%. Karthik: +119-123 points per game.
    - Vickrey spite price-push (SookraBot, +5 margin).
    - Denial 0.5 (Lambi).
11. **Release gates on real data.** Replay arena: substitute our bot into real matches against the other bots' archived bids (gaucho, Nijello, cortado). Plus live interleaved A/B (BlackSwan, Karthik, Lala). Every team found its simulator too optimistic (Nijello 83% sim vs 47% live; gaucho 87% vs 35%; K-13 1.1-1.3 vs 2.81 place).
12. **Table-size awareness.** Prices rise with seats; Nijello fell to 9% wins at 10 players. In tournaments, read `tournament.match_size`, `auction_type` and the real seat count. Treat offline registrants as dead seats.
13. **Starting-rack reconstruction (RNG).** This exploits a server bug: decision needed (section 7). It would give the exact bag composition after the deal plus every rival's full rack. That means exact opponent valuation models, sharper denial, and exact sim bids at auction 1 and multiset-exact later.

---

## 6. Exploitable weaknesses (per bot)

| Bot | Weakness | How to exploit (Vickrey) |
|---|---|---|
| LUCENT | Pays the most per tile (9.3 paid, 1.87× median price) and often wins with top bid ≫ price (vowels 9 vs 6) | Price-push: on letters we do not need, bid just under its predicted bid (8 instead of passing) so it pays more. Its money then runs short late (balance 44 at r56 vs Bron 62). Untested in all-real tables. |
| LUCENT | Dumps in the last 3 auctions and rarely at B = 0 | It is out of the late market early. Late tiles (B = 2..1) face less LUCENT competition. |
| Bron | Very thrifty: ends with 59 unused coins vs sims, 23 in all-real. Early bids are low (1-pt letters: median top 6-7) | Win the early common letters at 7-9, ahead of Bron's 6-7, to start the 7+ engine early. Do not chase late; Bron's phase ramp ×2.2 makes late letters expensive. |
| Bron | Late ramp is predictable (log-bid phase slope 0.79) | Late price-push on letters we do not want. Bron pays our bid when we are second. |
| maverick-bot | Steepest late ramp (×2.8), 12% all-in wins, all-in at penultimate; slow client (p90 673 ms) | Let maverick overpay late (price-push). Expect it to miss windows when the server lags. At the penultimate auction it bids ~its whole balance, so bid only if we have more. |
| Lionel / Afterword | Deterministic bid formula, no noise; hoards (no word under 40.6 unless broke) | Compute its exact bid from public state (its start rack is unknown unless we use RNG reconstruction) and price-push to bid − 1, or outbid by +1. Its hoarding leaves it broke-ish late (balance 24 at r56 all-real). Afterword is a dead seat now. |
| K-13 | Truthful-plus-capped bids: never more than 4 coins over its own value/λ. λ scale tuned at 6 seats. Calibration adapts slowly (0.056 per observation). Models rivals from history, so a new bot gets the generic market prior | Be unpredictable early, since its model of us starts generic. It shades thrifty at 6 seats and may let mid-value letters go. In 7+ seat tables it spends freely (×0.8 λ), so avoid bidding wars there. Its last-tile deny only matters with sims. |
| Lala | Hard cap at 1.25× going price (except completions at 1.4×); deterministic | Any letter we value above 1.25× the price can be denied to Lala cheaply. Its cap makes it predictable for price-pushing. |
| Nijello | Deterministic except the last 12 auctions; strong face-value denial term (3.06·face) means it overpays for high-face letters it cannot use | Let Nijello buy J/Q/X/Z at inflated prices. Price-push those. |
| SookraBot | ×0.7 bid cut in the first 28 auctions; holds every word for the final flush (cash starved mid-game unless below 15); κ×2 in the last 8 | Early letters are cheap against it. Its endgame overbids are exploitable by pushing. |
| BlackSwan | Floor bids 0.95 × market on every letter with a 40-coin reserve | Predictable floor. Price-push to just under it, or outbid by 1 when we want the letter. |
| Starter / HackUTD day-0 | Bids ≤ face + 2; plays the longest word immediately (short words at low multipliers) | Win anything we want at face + 3. They are donors. |
| allin-bot type spoilers | Burn coins early, go broke by mid-game, never score | Do not follow the inflated early prices. Prices fall once they are broke. |
| Sims | Exactly predictable (±2; exact at auction 1); always bid ≥ 1; the only users of the final tile | Take letters at sim max + 1. Do not bother denying the final tile unless placement depends on a sim. |

---

## 7. Tricks and threat model (what can be done to us) and defences

| Threat | Who does or could do it | Evidence | Defence |
|---|---|---|---|
| **Starting-rack reconstruction** via timestamp-seeded RNG | Anyone; K-13 owns a verified port (`src/sim/rng.ts`) | Our verification 1000/1000 (section 0, item 4) | Assume rivals may know our 5 start tiles. Do not rely on hidden-start bluffs. Using it ourselves is an ethics/rules decision for the user. Responsible disclosure to Clockwork Labs is possible. |
| **Live top-bid snooping** (`visible_auction_top_bids` from a non-credential identity) | Anyone with a second connection | `index.ts:120-140`; flagged by K-13, Lala, LetterSharkUltra | Our winning bids leak after each close. Add ±10-15% bid noise. Avoid a deterministic function of public state, which would let rivals invert our valuation and λ. |
| **Price-pushing / leader tax** ("shadow": bid just under our estimated value) | K-13 rival term (price-driving), SookraBot duel spite, LetterSharkUltra shadow | Code | Keep bids truthful but noisy; cap overpay. Recognise that in Vickrey a push only costs us when we win, so cut the value of marginal letters when a pusher is seated. |
| **Denial** of letters that complete our words | K-13 (rival term), Lambi (heads-up 0.5), gaucho denyW 0.077, cortado | Code | Diversify targets: do not depend on one missing letter. Cash 7+ words immediately (denial cannot touch played words). |
| **Broke-rival sweeping** (buy everything at max + 1 when we are broke) | SookraBot BROKE_RIVAL_MAX_BID 2 | Code | Do not hit 0 coins with many useful auctions left. Cash a liquidity word (Lala starvation rule, SookraBot liquidity 15). |
| **Penultimate all-in collision** | Lala, Nijello, Lionel, SookraBot, Afterword, LUCENT (0.82), maverick (0.99) | Data and code | Expect the B == 1 letter to clear near the second-highest remaining balance. Never plan a must-have word on it. Our own all-in there only pays if our balance is highest or the price is low. |
| **Drain / price floors** at small tables | Lambi drain 0.6, Karthik 0.8, BlackSwan floor 0.95 | Code | In heads-up, our losing bids set their price. Bid our true value on everything (drain them back). Do not pass on letters. |
| **Early-price inflation by spoilers** (allin-bot) | allin-bot (151) | Data: 16-26 on 1-pt letters | λ pacing handles it: skip and buy later when the spoiler is broke. |
| **Ghost bids / server lag** ("Auction closed" with time to spare) | Server load: Karthik saw 1.8-4.3 s RTT at peak | Karthik README, SookraBot FLUSH_LEAD_MS 3000 | Anchor bid at open. Measure RTT and dump words earlier when slow (dump zone `2·p90 + 0.3 s`). A watchdog for stalled feeds (Lala match 3967 stalled about 70 s and scored 0). |
| **Subscription pitfalls** | n/a | LetterSharkUltra RULES S1/S2 | Subscribe `match_participant WHERE match_id = X` per match, not a self-join. Never `subscribeToAllTables`. |
| **Tournament format surprises** | Organizers | Tournament #1: 4 Swiss rounds at 6-7 seats, a bracket where the last place drops each match, then a 3-game heads-up final by total score; FirstPrice is possible; auction window 250-10,000 ms; sims may be registered (`admin_register_all_sim_bots`); offline registrants still seated | Read `match_state.auction_type`, `auction_duration_ms`, `starting_rack_size` and the seat count every match. Keep separate parameter profiles for big tables, heads-up and FirstPrice. |

---

## 8. Open questions and gaps

- **No code for LUCENT, Bron, maverick-bot, Waupus, james, wordchoice, Calebot, postturing, Metheny, Chinese Dante, Doppio or TileShark.** The clones in 4.9 are fitted on winning bids only. A proper censored (Tobit/hurdle) refit like K-13's on the last ~2,000 matches would tighten them. Recommended as a phase task for the historical-data workstream.
- **LUCENT is unknown in all-real tables.** Its v3 rating comes mostly from 2-4 real-bot tables with sims. Its strength in a tournament is unknown, and the version number may hide code changes (LOW).
- **Which veterans will enter the HackUTD tournament** is unknown. Connected now: K-13, Bron, LUCENT, maverick-bot, Afterword, atlas, cortado, Tow57-Auctioneer. K-13 and Afterword auto-register.
- **The current live params of Lionel and Nijello** may differ from the repos (hot reload, LLM advisor, uncommitted live params).
- **RNG exploit scope.**
  - Start racks are exact.
  - Per-sim jitter after auction 1 is only known up to a permutation: the participant iteration order changes after row updates. This was tested and not resolved; move-to-end is not the rule.
  - Next-letter prediction before the close is impractical: the close timestamp jitters about 1-5 ms, which is about 4,000 candidate seeds.
  - Decide whether to use any of it.
- **SookraBot's ENDGAME_SMALL_SEATS** and its newer branches (cloud-deploy, tune-ship-cloud, prediction-v2) were not read.
- **Calebot (119)** was not found on GitHub. The calebshin22 repo is bot "cortado" (109).

---

## Sources

**Official code (read-only clone of clockworklabs/scrabblebot `b5ccb36`).**
- `spacetimedb/src/game.ts`: 118-123 shuffle; 200-204 seeding-flaw note; 237-325 startMatchWith (deal 285-298); 541-656 closeAuction (556 positive-bid filter, 559-560 tie shuffle, 572 Vickrey price, 614 sim word play, 616-629 match end); 744-765 drawLetter; 771-799 sim decideBid; 801-826 simulateBids; 849-869 simulateWordPlay.
- `spacetimedb/src/lobby.ts`: 45-100 (sim padding shuffle 62-82).
- `spacetimedb/src/index.ts`: 120-140 visibleAuctionTopBids; 780-812 submitBid; 816-824 submitWord; 1134-1144 auctionTick.
- `spacetimedb/src/dictionary.ts`: 63-100 findBestPlayable.

**SDK (HIGH).**
- https://unpkg.com/spacetimedb@2.12.0/src/server/runtime.ts: `get random()`, which calls `makeRandom(this.timestamp)` and is reset per reducer call.
- https://unpkg.com/spacetimedb@2.12.0/src/server/rng.ts: pcg32 `return (xorshifted >> rot) | (xorshifted << (32 - rot));` and `xoroshiro128plus(pcg32(seedToBigInt(seed)))`.

**Competitor repos** (cloned depth 1 under `scratchpad/ref/bots/`):
- https://github.com/aryamehr2k/k13-scrabblebot
- https://github.com/JoaquinGiorgis/scrabblebot-gaucho
- https://github.com/dhruv-1100/lala-scrabblebot
- https://github.com/bananatruck/scrabblebot-evo
- https://github.com/3nvyx/nijello-scabble-bot
- https://github.com/KarthikSubramanian07/Vickrey-Scrabblebot
- https://github.com/rohan879/scrabblebot
- https://github.com/StephenSook/sookrabot (branches finals-patch, round3, tournament-ready)
- https://github.com/goffycoder/blackswan-bot
- https://github.com/ManushPatel08/Scrabble_Bot_Tournament
- https://github.com/Jose-Gael-Cruz-Lopez/afterword-scrabblebot
- https://github.com/Phaslyr/scrabblebot
- https://github.com/calebshin22/caleb-scrabblebot
- https://github.com/vkhans07/scrabble-bot
- https://github.com/robertguozt/ScrabbleBot
- https://github.com/diuekwx/scrabblebot
- https://github.com/junsooki/scrabblebot
- https://github.com/micahlai/scrabblebot
- https://github.com/benjaminxie1/scrabblebot
- https://github.com/sudoanmol/scrabblebot
- https://github.com/areebhirani-beep/scrabblebot
- https://github.com/shreyask235/ScrabbleBot
- June-era: AlvinManojAlex/scrabblebot, TheAryanAnode/ScrabbleBotSpacetimeDb, vraj2131/scrabblebot, maanctech/scrabble-auction-bot, VJDiPaola/auction-agent-evals
- Not found or private: mm-nair/ScrabbleBot (Cortadomacchiato).

**GitHub search pages.**
- https://github.com/search?q=scrabblebot&type=repositories (81 results, pages 1-4 checked; pages 3+ are unrelated pre-event repos)
- https://github.com/search?q=scrabble-bot&type=repositories (185 results, pages 1-2 checked)
- https://github.com/search?q=scrabblebot+spacetimedb&type=repositories
- https://github.com/search?q=scrabble+auction&type=repositories
- https://github.com/search?q=hackutd+scrabble&type=repositories
- https://github.com/clockworklabs/scrabblebot/forks

**Live data.** `POST https://maincloud.spacetimedb.com/v1/database/scrabblebot/sql` (anonymous, read-only). Raw results are in `scratchpad/comp_data/`.
