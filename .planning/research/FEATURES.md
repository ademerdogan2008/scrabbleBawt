# Feature Landscape: Championship ScrabbleBot Bot

**Domain:** autonomous bidding and word-forming bot for the ScrabbleBot sealed-bid letter-auction game (SpacetimeDB maincloud `scrabblebot`)
**Researched:** 2026-11-07
**Basis:** STRATEGY.md (quantitative experiments), official code (`file:line` cited there), and the live DB (last 1,656 matches).

**Impact** is measured in points per match against comparable bots in our rule-faithful simulator unless marked *live*. For scale, a strong 3-bot game is won with about 150-190 points (live winning score 190).

---

## Table Stakes

Without these, the bot loses to the server's own sims or forfeits value. Live baseline: the starter kit scores about 27 against 5 sims.

| Feature | Why expected | Complexity | Expected impact / evidence |
|---------|--------------|------------|----------------------------|
| **Reliable connection and lifecycle:** token, reconnect, minimal subscriptions, join the lobby after each match, refusal handling while held for a tournament | A bot that misses auctions "loses every auction it doesn't bid in" (docs). One running match per bot (`index.ts:858-861`). | Med | Precondition for everything |
| **Bid on every auction within the 1 s window**, ≤ balance, integer i64; resubmit allowed | `submit_bid` rejects amounts above balance and anything at/after `closes_at` (`index.ts:797-809`). Auctions are spaced 1001.4 ms p50 (*live*). | Low | Missing auctions hands letters to rivals at price ≈ 1 |
| **Exact local dictionary** (ENABLE, 172,820 words) + **rare-first anagram trie** | `submit_word` validates against the bundled list (`dictionary.ts:29-52`). The trie finds all fitting words in 4-63 µs for racks of 5-15. | Low | Precondition |
| **Cash every 7+ letter word immediately** | 3× is the maximum multiplier (`letters.ts:75-81`). Reward funds bids (`game.ts:721-725`). | Low | Holding 7s for 8+: −11. Top live bots get 87-91% of reward from 7+ words (*live*). |
| **Final flush** when the `bag_total == 0` auction opens: exact packing of the whole rack, all words submitted in the first ~100 ms | The match ends inside the last close (`game.ts:617-628`). `submit_word` needs Running (`index.ts:823-825`). | Low-Med | **+25 to +27 pts**. Rivals flush at 53-288 ms (*live*). |
| **Bid 0 on the final letter** | It can never be played by a real bot | Low | Avoids waste (money is worthless at the end, so this is housekeeping) |
| **End-game marginal value table** per letter (not face value), with duplicate, vowel-balance and Q/U factors | A 1-point letter is worth about 5-7 pts at the end and Z about 21-29. 3rd vowels collapse to 1-3. Q is worth 2.5 in small racks (STRATEGY §4). | Low (precomputed) | The core of being competitive. A static bid on this curve (2.5·face + 3 or 4) placed 1st in every 2- and 3-bot league (8-11 strategies), and near last in 6-bot fields. |
| **Money pacing (κ ≥ 1 when rich)** | Leftover balance is worthless. Bids must exceed raw score value when cash is plentiful. | Low-Med | Without it: 55 vs about 130 pts (3-bot), 30 vs about 90 (6-bot) |
| **Bag accounting** (unseen pool = 98 − our deal − all auctioned − rivals' revealed unwon letters) | Unbid letters are consumed (`game.ts:744-765`), contrary to the docs | Low | Correct MC sampling and table projection |
| **Telemetry:** per-auction log of bid, value, κ, price, winner, timings; per-match summary | Needed for E2E tests, live A/B and learning from mistakes | Low | Enables every later tuning step |

## Differentiators

These separate a champion from the field. LUCENT, Bron and maverick already have rough versions of several.

| Feature | Value proposition | Complexity | Expected impact / evidence |
|---------|-------------------|------------|----------------------------|
| **Unbiased MC marginal valuation** (B&B exact packer, CRN, S=16-32, worker thread, ≤200 ms), weighted toward the late game | Rack-specific: completes words, avoids dead letters. A greedy-packer MC is biased low by up to 34% and causes an underbidding spiral. | Med-High | +5 to +20 (3-6 bots), +40 heads-up. Bad MC (S4/H8): −14. |
| **Price-setting floor on useful letters** (2.5·face + 3 to 4) | Makes rivals pay a market price for what they take. This is Bron's live curve. | Low | The hybrid "HYB" placed 1st-4th in 10 of 11 league results (6th of 8 once). Static-only bidders swung from 1st to last depending on the field. |
| **Clearing-price model per rival** (Bayesian, interval-censored: winner ≥ paid, losers ≤ paid; priors from `auction_top_bid_archive`) | Drives κ pacing, denial pricing, FirstPrice shading and trick detection. Priors: Bron 2.48f + 4.64, LUCENT 3.21f + 6.30, maverick 2.95f + 6.73 (*live*). | Med | Prevents the −16 to −37 overspend failures seen with fixed aggressive pacing |
| **Budget-pacing κ by price model**: the smallest κ whose projected spend fits balance + income − reserve | Against sims: buy everything (357-368 pts vs Bron's 270 *live*). Against strong bots: discipline. | Med | +60-90 in sim-heavy lobbies. Avoids bankruptcy heads-up. |
| **Exact sim modeling** (public strategy + balance + jitter support → price-to-beat tables; sure-win bids) | Sims are 3-5 of 6 seats in 87% of live matches | Low | Exact Vickrey/FirstPrice decisions against sims |
| **Rank-aware denial schedule** (w = 1.0 heads-up, 0.4 with 2 rivals, 0 with 4+), only when the predicted price < V_me + w·V_rival | OpenSkill PL is roughly linear in place. Finals are zero-sum. | Med | Heads-up +95 to +118 vs weak bidders. Harmful if unpaced vs disciplined ones. 6-bot: −3. |
| **Tournament modes** (Swiss = lobby objective, bracket = avoid last + reserve, final = heads-up 3-game sum) | Objectives differ (`tournament.ts:304-395`) | Med | Converts lobby skill into tournament wins |
| **FirstPrice module** (sure-win cap vs sims; shading vs rivals from revealed winning bids) | Tournaments may run FirstPrice (`tournament.ts:182,266`) | Med | Never pay above the sure-win bid against sims (vowel 8, Z 15) |
| **Anytime bidding** (table bid at ~1 ms, MC refine, resubmit before closes_at − RTT_p95 − 100 ms) | Bids are replaceable (`game.ts:828-847`) | Low-Med | No missed or late bids under load |
| **Liquidity cashing** (5-6 letter word only when balance < ~20 and a valuable letter is likely soon) | Avoids being priced out at key moments | Low | +4 ± 3 (3-bot). Tunable. |
| **Latent-rack rank estimation for rivals** (won letters − played letters + 5 hidden × 3·face·efficiency) | Hoarders and end-flushers (Bron flushes 24% of words late) hide their true score | Low-Med | Correct denial targeting and risk mode |
| **Tie nudge (+1) and ±1 bid jitter** | 12.7% of live auctions are top-bid ties. The spectator view leaks our winning bids. | Low | Small, cheap |
| **Simulator + league E2E harness** (rule-exact, sims exact, clones of live bots from COMPETITORS.md, our variants; parallel runs) | The best static level flips with the field (rock-paper-scissors in STRATEGY §9) | Med | Prevents overfitting. Required by the user (E2E stats). |
| **Historical replay tests** (archive bids/prices per letter and phase; our bid curve vs observed clearing prices) | Calibrates the price model and the expected win share before going live | Med | Quantifies the expected live win share |

## Anti-Features

Explicitly do **not** build these.

| Anti-feature | Why avoid (evidence) | What to do instead |
|--------------|----------------------|--------------------|
| **Starter/sim word policy: play the longest word immediately** (2-6 letters) | It forfeits the 3× multiplier. The starter scores 27 vs sims. Cash-6: −19 to −34. | Cash 7+ only. Flush at the end. |
| **Greedy-packer, short-horizon MC as the main valuation** | Biased low (−0.5 to −3.7 per letter). The underbidding spiral scored 53 vs 111. | B&B packer. Table prior when the horizon is long. |
| **Using our own past win share as P(win future letters)** | Self-reinforcing loss spiral | Price-model win probabilities |
| **Static bid levels as the whole strategy** | Best in 2-3-bot lobbies, last in 6-bot fields (18-30 pts) | Floor + value × κ |
| **Unconditional denial / hate bidding** | 6-bot: −3. Heads-up vs disciplined bidders: 26% wins (bankruptcy). | The price-gated denial schedule |
| **All-in bidding** | The all-in archetype scored 32 vs 162-165 | Value × κ with a reserve |
| **Fixed aggressive pacing / "money is free" in competitive fields** | −16 to −37 | Price-model κ |
| **Bidding on the final letter, or holding words past the last auction's open** | No value. Unflushed words are lost (−25). | Bid 0. Flush at `bag_total == 0`. |
| **Heavy synchronous compute in the event loop** (exact packing of 25+ letter racks: up to 4.8-11.5 s) | Missed bids and a missed flush | Worker threads, node/time caps, greedy incumbent |
| **Snooping `visible_auction_top_bids` with a second anonymous identity** (`index.ts:114-137`) | It defeats the view's intent ("bots can't see it", `game.ts:600-601`). Rules/ethics risk. | Do not use without explicit user approval. Defend by assuming rivals do it. |
| **Live RNG exploitation by default** (timestamp-seeded RNG: hidden deals and sim bids are reconstructible, RULES §4) | Defeats intended hidden information. Organizers can patch it. | Behind a flag, default OFF live. Offline/defensive use is fine. Needs a user decision. |
| **`subscribeToAllTables`** | Firehose of 1.7M-row tables (PITFALLS C3) | Minimal, filtered subscriptions (STACK §5) |

## Feature Dependencies

```
Connection/lifecycle -> Always-bid -> Anytime bidding
Dictionary + rare-first trie -> Cash 7+ -> Final flush (B&B exact packer)
Dictionary + trie -> End-game marginal table (offline) -> Static floor
Bag accounting -> MC valuation (needs B&B packer + worker threads)
Telemetry -> Clearing-price model (needs archive priors) -> kappa pacing -> Denial schedule -> Tournament modes
Clearing-price model -> FirstPrice module
Rule-exact simulator (needs sims exact) -> League harness (needs live-bot clones) -> parameter tuning of all of the above
(Optional, user decision) RNG reconstruction -> exact sim bids + exact bag -> sharper MC and FirstPrice
```

## MVP Recommendation (first version to ship live)

1. Plumbing table stakes: connection, always bid, telemetry.
2. Cash 7+ and final flush with exact packing. Bid 0 on the last letter.
3. End-game marginal table × rack factors × simple κ pacing, plus the 2.5·face + 3.5 floor on useful letters (the "HYB-lite").
4. Exact sim price tables for the sims-only parts of the κ logic.
5. Rule-exact simulator + league harness, so every later change is measured.

Defer:
- **Unbiased MC:** after the harness exists, because its value is measured there.
- **Price model and denial:** they need telemetry, and archive priors from a few dozen live matches.
- **FirstPrice and tournament modes:** only needed when a tournament is announced. Check `tournament.auction_type`.
- **RNG features:** pending a user decision.

## Sources

- Official module source (local clone): `spacetimedb/src/game.ts`, `index.ts`, `letters.ts`, `dictionary.ts`, `lobby.ts`, `tournament.ts`, `ratings.ts`; `docs/bot-guide.md`; `TODO.md`. HIGH.
- Live DB `scrabblebot` via the HTTP SQL API, read-only: matches 41000-42655 (auction_result, auction_top_bid_archive, word_play), match_participant ≥ 23600, bot, bot_stats. HIGH for the measured window.
- Our experiments: `/private/tmp/claude-501/-Users-adem-Documents-GitHub-scrabbleBawt/f0cb5422-db12-4105-b246-d1edf5490e36/scratchpad/strategy_lab/`. These include `results/e1_dict_enum.txt`, `e2b_bb_probe.txt`, `e4_summary.txt`, `e8_sim_prices.txt`, `e11_firstprice.txt`, `e12_mc_H12.txt`, `e_openskill.txt`, `batch1-3/`, `league*/summary.txt`. HIGH (exact computations), MEDIUM (simulated policy comparisons).
- Sibling research: RULES.md (RNG verification), COMPETITORS.md (bot clone specs), PITFALLS.md, STACK.md.
