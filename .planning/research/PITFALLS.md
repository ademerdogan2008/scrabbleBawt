# Domain Pitfalls: ScrabbleBot (sealed-bid letter auction on SpacetimeDB)

**Domain:** a competitive bot for a Vickrey/first-price letter-auction word game on SpacetimeDB maincloud.
**Researched:** 2026-11-07
**Companion file:** `RULES.md`. Every rule cited here is specified and cited there, with `file:line` references into `clockworklabs/scrabblebot@b5ccb36`.
**Phase keys** follow `.planning/ROADMAP.md`:
- 01-01 core/rng/types
- 01-02 word engine
- 01-03 MatchTracker
- 02-01 simulator
- 02-02 history
- 02-03 live client
- 03-01 Bawt strategy
- 03-02 opponent zoo and trick bots
- 04 evaluate/tune
- 05 E2E and release

**Confidence:** HIGH unless marked. Every rule-level claim is code-read or verified against live history.

---

## Critical pitfalls (cause rewrites, forfeits, or a systematically weaker bot)

### C1. Treating "hidden" information as hidden, in both directions
**What goes wrong:** We assume our 5 starting tiles, rivals' starting tiles and the bag composition are private, so we model rivals with uncertainty they don't have and assume they lack knowledge they have.

**Why it happens:**
- The docs say racks "stay hidden" (`docs/bot-guide.md:29-32`).
- In fact `ctx.random` is seeded from the transaction timestamp in µs, which is public.
- `started_at`, `opens_at` and `closed_at` all appear in public tables.
- Anyone can recompute every deal, every letter draw (after the fact), every tie-break and every sim's jitter (RULES.md §4; verified bit-exact).

**Consequences:**
- A rival that reconstructs our rack can deny-bid the exact letter we need for a 7-letter word (3× multiplier) and price-push the letters we value.
- If *we* don't reconstruct deals, our opponent models and unseen-pool estimates are needlessly noisy. We also give up exact knowledge of what every sim bids on every auction.

**Prevention:**
- Implement the exact RNG (01-01) and deal reconstruction in `MatchTracker` (01-03).
- In opponent modelling, assume **every rival knows our full rack** (03-01).
- Whether to *use* the deal and sim-bid inference offensively is an explicit user decision (see "Policy" below). Defensively, assume rivals can.

**Known exposure:** COMPETITORS.md reports that rival K-13 ships a line-for-line port of this RNG (`src/sim/rng.ts`). At least one rival can do this today.

**Detection:**
- A self-check at match start: predicted first letter vs `auction.letter`. If it fails, set `rngModelValid=false` (02-03/03-01).
- Rivals' wins on letters that complete our known words at abnormally high rates suggest deal-aware denial (04 analytics).

### C2. Simulator infidelity, which means tuning for a different game
**What goes wrong:** We tune against a simulator that disagrees with the server on small rules, so strategy gains do not transfer.

**Why it happens:** There are many non-obvious rules:
- Unbid letters are **consumed**, not returned (the docs are wrong).
- The final letter is unusable by real bots, but **sims** play it inside the close.
- Sims bid only at auction open, never re-bid, and their bids are capped by balance.
- A sim plays exactly one longest ≥3-letter word (lexicographically first) and **only right after winning**.
- Ties: shuffle, then a stable sort.
- Vickrey sole-bidder price is 1.
- Number of auctions = `98 − P×rack`.
- The jitter-to-sim assignment follows index iteration order: rows updated in the transaction come first, then committed rows with swap_remove plus push (RULES.md §4.3).

**Consequences:** Benchmarks lie. The bot overfits to fake sims, and win% against real lobbies collapses.

**Prevention:**
- Build 02-01 straight from RULES.md §4–§9.
- Add a **parity test suite** (02-02) that replays historical all-sim matches (1, 28962, 33893 and the other 58) and requires 68/68 exact auctions, the same sim words, and the same final balances and scores.
- For mixed matches, require the deal and letter sequence to reproduce and every sim-bid hypothesis to be consistent.

**Detection:** Any parity diff. Simulated sim scores per strategy that drift from the historical averages.

### C3. Subscription firehose (`subscribeToAllTables`)
**What goes wrong:** The starter and the bot guide subscribe to everything (`bot-starter/src/index.ts:217`, `docs/bot-guide.md:105`).
- Live, that is roughly `auction` 1.74M + `auction_result` 1.74M + `auction_top_bid_archive` 1.74M + `word_play` 402k + `lobby_member` 262k + `match_participant` 154k + `rating_history` + … ≈ 6M rows.
- Every delta from every concurrent match then streams in.

**Consequences:**
- Startup takes minutes, and memory runs to hundreds of MB.
- Event-loop stalls delay bids past `closes_at`.
- The first auction of a match can be missed entirely.

**Prevention** (02-03):
- Use targeted subscriptions:
  - `match_participant WHERE bot_id = ME` to discover our matches;
  - per match: `match_state WHERE id = M`, `match_participant WHERE match_id = M`, `auction WHERE match_id = M`, `auction_result WHERE match_id = M`, `word_play WHERE match_id = M`;
  - `my_rack`;
  - the anonymous views `open_lobbies` and `open_lobby_members`.
- Unsubscribe from ended matches.
- Verify whether range filters (`auction WHERE id > X`) or semijoins are accepted. The SDK builder exposes `gt/gte/leftSemijoin`; server support is MEDIUM confidence.

**Detection:** Time from connect to `onApplied` above about 2 s. Resident memory above about 200 MB. Event-loop lag above 50 ms.

### C4. The end-of-match word race (flush before the final close)
**What goes wrong:** We hold letters for a bigger word and the match ends first.

**Why it happens:**
- The match ends **inside the same transaction** that closes the final auction (`game.ts:617-629`).
- Any later `submit_word` fails with `"Match not running"`.
- The final auction lasts only about 1000 ms.
- The final letter itself can never be played by a real bot.

**Consequences:** All held letters score 0. This is the single largest avoidable loss.

**Prevention:**
- Treat `bag_total == 0 && status == Running` as **final auction open**. Immediately submit the **maximum-weight packing** of the whole rack (01-02 packer), from the largest reward down.
- Give the final packing a precomputed fast path: refresh the plan every time the rack changes.
- Do not bid on the final letter for value. The exception: denying a **sim** that could use it to overtake us in placement, since balance is worthless at the end anyway.
- The top rivals' last words land 35–125 ms after the final auction opens (matches 31393, 41799 and 42656). Budget at most 300 ms end to end (03-01 + 02-03).

**Detection:** A rack left after `Ended` with nonzero value. Any `"Match not running"` error.

### C5. Latency and clock skew against `closes_at`: bids rejected or late
**What goes wrong:** Bids arrive after the deadline. They are rejected with `"Auction window expired"` (server time ≥ `closes_at`, before the scheduler runs) or `"Auction closed"` (after the close).

**Why it happens:**
- The window is about 1001.5 ms in server time, starting from the close transaction timestamp of the previous auction.
- We learn of the auction one network hop later, and the bid needs another hop.
- The server assigns the transaction timestamp. Our local clock is irrelevant and may be skewed.
- Server load can queue transactions; closes have run up to 116 ms late.

**Consequences:** Silent lost auctions. They are worst exactly when we want a letter most, i.e. when we deliberate longest.

**Prevention** (02-03 "anytime bids"):
- Submit a provisional bid within about 100–200 ms of seeing the auction. Replacement is free until the deadline.
- Only refine later, with a hard cutoff of `closes_at − (est. one-way latency + margin ≥ 150 ms)` in server time.
- Estimate the offset continuously: `localRecv − opens_at` gives one-way delay plus skew. Use the reducer promise's RTT.
- Never run CPU-heavy work on the event loop during the window. Use a worker for MC valuation.
- A bid of `0` withdraws, if we change our mind.

**Detection:**
- Any `"Auction window expired"` or `"Auction closed"` error. Alert if the rate is above 0.
- Bid-ack RTT p99 above 400 ms.
- Our `submitted_at`-equivalent landing within 50 ms of `closes_at`.

### C6. Token leakage in a public repo
**What goes wrong:**
- Qualification requires a **public** GitHub repo.
- A committed `.token-*`, `.env` or logged JWT lets anyone act as our bot: bid our whole balance on junk, play bad words, or join lobbies on our behalf.
- There is **no revoke-credential reducer** (`TODO.md:22-26`). Minting a new credential does not invalidate the old one. The only kill switch is dissolving the team, which deletes the bot and ends the persona.

**Prevention:**
- 01-01: `.gitignore` covers `.token-*`, `.env*` and `*.jwt`.
- Read the token only from an env var or a file outside the repo.
- Never log tokens.
- Add a pre-commit or CI secret scan for JWT patterns (`eyJ[A-Za-z0-9_-]+\.`).
- 05-02: audit `git log -p` before the first push.

**Detection:** The secret scan, or GitHub push protection. Bids or words we did not send, visible in `word_play` and `auction_result` under our bot id while we were offline (`bot_credential.connected`).

### C7. Dictionary mismatch
**What goes wrong:** Words that are valid in TWL06, SOWPODS or Collins are rejected, wasting a reducer round trip and possibly the end-of-match window.

**Why:**
- The server uses **exactly** `spacetimedb/wordlist.txt` (ENABLE, 172,820 words).
- It **lacks QI, ZA, ZO, JA and KI**. It has XU, XI, JO, KA, OX, AX and EX.
- Input is ASCII-uppercased only, with **no trim**.

**Prevention:**
- 01-02: vendor the identical file. Assert its SHA-256 and its count of 172,820.
- Uppercase locally. Never send whitespace.
- Add a unit test with known-rejected words.

**Detection:** Any `"... is not in the dictionary"` or `"Word must be A-Z only"` error.

### C8. The live top-bid leak: assume rivals see our winning bids during the match
**What goes wrong:** `visible_auction_top_bids` hides rows only from identities that hold a bot credential. Any rival can open a second, **anonymous** connection and read the top bid of every closed auction in every running match. This was confirmed live on 2026-11-07: 37 rows for running match 42660. The fix (PR #16) sits on an unmerged side branch. Our true valuations (our winning bids) therefore leak live. Under first-price, `paid` leaks them directly.

**Consequences:** Rivals can fit our bidding function within a match and then:
- price-push (see M1);
- avoid fighting us for letters we overvalue;
- learn our end-game behaviour.

**Prevention** (03-01):
- Treat our winning bids as public.
- Add calibrated randomisation to bids.
- Don't reveal a stable letter→bid map.
- Where competition is known, e.g. exact sim bids through the RNG model, prefer `min(valuation, predicted max competitor + small margin)` over the full valuation. This leaks less, and under Vickrey it costs nothing when the prediction is right. Weigh the risk from unknown real bidders.
- **Do not ship a snooper ourselves** without an explicit policy decision. It exploits an acknowledged bug.
- 03-02: add a "snooper" trick bot that uses the leak, to measure how much it hurts us.

**Detection:** Rivals' runner-up bids (`paid` on our wins) concentrate at our bid − 1 after the first few auctions of a match, or track our past winning bids by letter class.

### C9. Optimising the wrong objective for the context
**What goes wrong:** One scoring objective is used everywhere. The real objectives differ:
- **Lobby** (rating): OpenSkill Plackett-Luce on **placement only**. Margin is irrelevant, ties share the place, and sims count as opponents.
- **Swiss:** points = `matchSize − #strictly better`, so placement again.
- **Bracket:** **only last place is eliminated**. Tie-breaks: lower score, then lower tournament total, then the higher bot id goes out.
- **Final:** the champion has the **highest total score over 3 two-player games** (88 auctions each). This is not best-of-3, despite README:126-128.
- **Everywhere:** leftover balance is worth 0.

**Prevention:**
- 03-01: a `mode` parameter (lobby / swiss / bracket / final) that sets risk appetite. Bracket means minimise P(last). Final means maximise expected score across games, so carry risk across games.
- Read `tournament_match.phase` for our match.
- 04: benchmarks per mode, including a 2-player 88-auction format.

**Detection:** Our bracket eliminations happen with a high average score but a high variance.

### C10. Mispricing money over time (hoarding or burning balance)
**What goes wrong:**
- Bidding as if balance had terminal value: we end matches with 100+ unspent.
- Or burning it early and being priced out of late letters.

**Why:** Balance only buys letters, and words refill it (reward goes to both balance and score). Its marginal value falls toward 0 as auctions run out. Rivals know this too, which produces end-game spikes (see M4).

**Prevention** (03-01):
- Value money as the expected score it can still buy over the remaining `bag_total + 1` auctions, given the unseen pool and the competition.
- Pace spending. Spend down to about 0 by the end.
- Cash words early when the balance is needed for a key bid. `submit_bid` checks the **current** balance, so a word played first raises the limit.

**Detection:** The distribution of end balances. Late-auction win rate vs. price paid.

---

## Moderate pitfalls, including the "simple tricks" opponents use

### M1. Price-pushing: rivals bid just under our known valuation
**What:** Under Vickrey we pay the second-highest bid. A rival who knows, or estimates, our bid v (from the leak, from history or from deal reconstruction) bids v−1. We still win, but pay v−1 instead of the true second price. Repeated, this drains our budget. The risk to the rival is that it occasionally wins letters at our price.

**Warning signs:** On our wins, `paid/our_bid` rises well above the baseline measured in sims-only matches. `paid == our_bid − 1` (or a tie) appears often for one rival's lobbies.

**Prevention:**
- Randomise bids.
- When exact sim bids are known (RNG model), keep our winning bid close to the competition.
- Lower our valuation on letter classes where pushes keep repeating. They are effectively more expensive.
- Track push statistics per rival (03-01).
- 03-02: a price-pusher trick bot.

**Phase:** 03-01, 03-02, 04.

### M2. All-in bidders and bidding wars
**What:** A bot bids its whole balance on letters it wants. Under Vickrey it pays the runner-up's bid, which is ours. Pitfalls:
- escalating against it, which wastes our runner-up position;
- misreading its huge archived top bids as real valuations;
- not noticing it is broke afterwards.

**Prevention:**
- Bid our own value.
- Being runner-up to an all-in bidder makes *them* pay, which is good.
- Model each rival's **balance cap**. It is public, and no bid can exceed the current balance.
- 03-02: an all-in trick bot.

**Phase:** 03-01, 03-02.

### M3. Bottom-feeders bidding 1
**What:** Bots bid the reserve (1) on everything and collect letters nobody else bids on. In lobbies with sims this rarely works, because every sim bids at least 1 on every letter while its balance is at least 1. In all-real lobbies, and in 2-player finals, it does work.

**Prevention:**
- Bid at least 1–2 on any letter with positive marginal value to us, or positive value to a close rival.
- Keep track of unsold letters: they are consumed, which shrinks the pool.
- 03-02: a bottom-feeder trick bot.

**Phase:** 03-01, 03-02.

### M4. End-game money dumps
**What:** In the last auctions, rivals with large balances bid very high, because money is worthless at the end. In matches 41797–41799, Bron's top bids in rounds 60–67 reached 27–73, but he paid only 2–9 because only sims competed. Bron never took the final (round 68) letter. Against other real dumpers, the second price spikes.

**Prevention:**
- Forecast late price spikes.
- Secure key letters earlier, or plan words that don't depend on late letters.
- Spend our own remainder late as well.
- 04: measure late `paid` per rival.

**Phase:** 03-01, 04.

### M5. Denial ("hate") bidding by deal-aware rivals
**What:** A rival who knows our exact rack (C1) outbids us only on the letters that complete our long words.

**Prevention:**
- Prefer word plans with several completion letters.
- Cash a shorter word when the denial risk times the remaining value exceeds the gain from holding.
- Use rivals' public balances to estimate their denial capacity.

**Detection:** Our completion letters are lost to real bots at prices far above their own needs.

**Phase:** 03-01, 03-02 (denial trick bot).

### M6. First-price winner's curse
**What:** Tournaments can be `FirstPrice` (`index.ts:911-946`), where the winner pays its own bid. A truthful Vickrey policy overpays every time. The lobby is always Vickrey (`lobby.ts:30`).

**Prevention:**
- Branch on `match_state.auction_type` for every match.
- Shade bids toward `max(predicted competitor bids) + 1`. Against sims, use the exact predicted bids when the RNG model is valid.
- 04: a first-price benchmark table.

**Phase:** 03-01, 04.

### M7. Ties
**What:** Ties are broken randomly: shuffle, then a stable sort (`game.ts:556-560`). The tie-break is not predictable in advance, because it depends on the close timestamp. Sims tie very often: 16–21 top-ties per all-sim match.

**Prevention:** Avoid bidding exactly at the predicted sim maximum. Bid `simMax + 1` when we want the letter, or stay below it when we don't.

**Phase:** 03-01.

### M8. Bids rejected for balance, and number-type bugs
**What:**
- `"Insufficient balance"` when `amount > current balance` (`index.ts:807-809`).
- `"Bid must be non-negative"`.
- `i64` and `u64` values arrive as JS `bigint`. Mixing them with `number` throws or truncates.

**Prevention:**
- Take the balance from the server row. It arrives in the same transaction as the next auction.
- Clamp every bid to the balance.
- Use `bigint` end to end in the client adapter (02-03, 01-01 types).

**Detection:** Any `"Insufficient balance"` error. A TypeError in bid paths.

**Phase:** 01-01, 02-03.

### M9. Reconnecting mid-match
**What:** After a disconnect the cache is gone. **We cannot read our own pending bid**, because `pending_bid` is private and no view exposes it. Words in flight may or may not have landed.

**Prevention** (02-03):
- On reconnect:
  - resubscribe;
  - rebuild the rack from `my_rack` (filtered by `match_id`) and the word history from `word_play`;
  - **resubmit** the bid for the current open auction. Replacement makes this idempotent.
  - re-plan words from the server rack.
- Keep the token and the identity stable. The same token gives the same identity and the same bot.

**Detection:** A gap in `bot_credential.connected`. Auctions in that window without our bid.

### M10. Several matches, tournament holds and lobby errors
**What:**
- `join_lobby` fails with `"You're already in a running match"` or `"You're playing in a tournament; ..."`.
- Tournament matches start **without** the lobby: Swiss rounds start inside the close transaction of the previous round's last match, and finals are started by an admin.
- A registered bot that is offline is still seated and loses every auction.

**Prevention:**
- Detect new matches by our `match_participant` insert, not by the lobby.
- Handle the join errors gracefully and retry after the match ends.
- Stay connected through tournaments. Register from the bot process with `register_for_tournament`.
- Run one match loop per `match_id`.

**Phase:** 02-03.

### M11. Variable match size, auction length, rack size and auction type
**What:** Admin config allows:
- rack size 0–20;
- lobby size 2–12;
- auction length 250–10000 ms;
- tournament tables between `matchSize` and `2·matchSize − 1` (tournament 1 had 7-player tables);
- bracket matches of 5, 4 and 3 players;
- 2-player finals (88 auctions).

Hardcoding 6, 5, 1000 or 68 breaks valuation, pacing and deadlines. A 250 ms auction makes latency critical.

**Prevention:**
- Read P, rack size, duration and type from the match rows.
- Parametrise the simulator over all of them.
- 04: a variable-configuration benchmark table.

**Phase:** 02-01, 03-01, 04.

### M12. Subscription filter limits
**What:**
- Clients cannot filter subscriptions on the status enum (comment at `index.ts:139-141`). For example, `match_state WHERE status = Running` is not possible.
- If we subscribe to `auction WHERE match_id = M` only after learning M, the first auction (1 s) is already open. That is fine, because the initial rows include it, but it costs one subscribe round trip.

**Prevention:**
- Discover matches through `match_participant WHERE bot_id = ME`.
- Pre-warm the per-match subscriptions immediately.
- Bid on the open auction from the subscription's initial rows, not only from `onInsert`.
- Use the `open_lobbies` and `open_lobby_members` views for lobby state.

**Phase:** 02-03.

### M13. `my_rack` returns tiles from every past match
**What:** `holding` rows are never deleted at match end, so `my_rack` returns leftovers from every match we have ever played.

**Prevention:** Always filter by the current `match_id`.

**Phase:** 02-03, 01-03.

### M14. Word double-spend and races with rack updates
**What:**
- Two in-flight `submit_word` calls that share letters: the second fails with `"Not enough 'X'"`.
- A word that uses a letter we have not yet been credited with fails the same way.

**Prevention:**
- Keep a local "reserved" multiset for in-flight words.
- Release it on the promise result.
- Plan only from server-confirmed rack rows.
- Send at most one packing batch at a time, in order on the same connection.

**Phase:** 02-03.

### M15. Two processes acting as the same bot
**What:** A dev instance and a prod instance, or two credentials, run at once. The bids overwrite each other (last writer wins), the words conflict, and lobby joins interleave.

**Prevention:**
- One live process per bot.
- A lock file or heartbeat check against `bot_credential.connected` for our bot's other credentials.
- Never point local tests at maincloud with the prod token.

**Phase:** 02-03, 05.

### M16. Information leaks from our own behaviour
**What:**
- Words reveal letters: this matters only against rivals that do not reconstruct the RNG deal.
- Word timing reveals strategy, e.g. holding for 7-letter words.
- `bot_credential.connected` and `lobby_member.joined_at` reveal when we play.
- The count of positive bids per auction can be inferred by anyone running the RNG model, so rivals see *whether* we bid on each letter.

**Prevention:**
- Don't play words purely for signalling.
- Vary timing within the safe budget.
- Accept that presence is public.

**Phase:** 03-01.

### M17. Lobby sniping and matchmaking games
**What:**
- `open_lobby_members` shows who is waiting. Rivals can join only lobbies they like, which farms rating against weak bots or sims and dodges us.
- The 6th real joiner triggers an instant start. Otherwise the lobby resolves at its 90 s timeout, padded with sims, and the sim mix is random.
- Today the top three bots cycle through 3-real + 3-sim lobbies.

**Prevention:**
- Join promptly after each match. One match per 90 s cycle is the maximum.
- Optionally, if policy allows, evaluate the lobby before joining. There is no way to leave a lobby once joined.

**Phase:** 02-03, 05.

### M18. Variance in sim padding
**What:** Which sims pad a lobby, and their strategy mix (2 each of Cheapskate, ValueBidder and Aggressive in the pool), changes the competition for every letter. Aggressive sims bid 3–7 on vowels.

**Prevention:**
- Value letters against the *actual* sims present: their strategies are public in `bot.strategy`, and their exact bids are known when the RNG model is valid.
- Parametrise the simulator to draw padding exactly as the server does.

**Phase:** 02-01, 03-01.

### M19. Fragile exploits: the organizers patch mid-event
**What:**
- PR #16 (closing the leak) could be deployed.
- An SDK upgrade could change RNG seeding.
- Admins could spawn extra sims, which changes the shuffle call count S.
- A datastore change could alter iteration order.
- Any of these silently corrupts inference.

**Prevention:**
- Self-check every match: the first letter, and that the letter is reproducible at every close.
- Gate every RNG-dependent feature behind `rngModelValid`, with probabilistic fallbacks that are always implemented and benchmarked.
- 04: run benchmarks with the RNG model disabled as well.

**Phase:** 01-03, 03-01, 04.

### M20. Rating contamination and versions
**What:**
- Testing a half-built bot on maincloud with the real persona drags down the displayed OpenSkill rating. A new bot starts at ±246 and is provisional until ±175, which takes about 20–30 matches.
- Each human can be on only one team, so a second test persona needs another human identity.
- `start_new_bot_version` resets the rating, and the old version stays listed.

**Prevention:**
- Validate locally first (02-01 sim, 05 local server).
- Use shadow mode, which only reads.
- Start a new version right before the final submission if the test history hurt the rating.

**Phase:** 05.

### M21. CPU stalls in word search or MC valuation
**What:** A blocking anagram search or rollout on the event loop delays bids past the deadline. The starter's comment warns about this (`bot-starter/src/strategy.ts:39-42`).

**Prevention:**
- Precompute anagram classes (01-02: p99 < 5 ms target).
- Run MC in a worker with anytime results.
- Set a 250 ms decision budget (03-01 success criterion).

**Phase:** 01-02, 03-01.

---

## Minor pitfalls

| # | Pitfall | Prevention | Phase |
|---|---|---|---|
| m1 | Sum-type and Option encodings over HTTP/SQL (`[idx, payload]`, `[0,v]` = some, `[1,[]]` = none). Timestamps are `[micros]`. | One typed decoder layer | 02-02 |
| m2 | Assuming exact 1000 ms rounds. Closes run about 1.5 ms late, so the schedule drifts by about +100 ms per match. | Use `opens_at` and `closes_at` from rows | 02-01, 02-03 |
| m3 | `submit_word` does not trim, and uppercases only `a-z`. A one-character multibyte input passes the length check, then fails A-Z. | Normalise locally | 01-02 |
| m4 | Forgetting that real bots may play **2-letter** words (96 in ENABLE) while sims play only ≥3 | Include 2-letter words in the packer and the final flush | 01-02 |
| m5 | Treating a `0` bid as a bid. It **withdraws** our previous bid. | Use it deliberately to cancel | 02-03 |
| m6 | Deleted bots in history: 9 participant bot ids are no longer in `bot` | Loaders must tolerate missing bot rows | 02-02 |
| m7 | Zombie match: a tournament table with `P×rack ≥ 98` (20 or more players at rack 5) leaves a `Running` match with no auction. Its bots can never `join_lobby` again. | Detect and alert. Report to organizers. | 02-03 |
| m8 | The HTTP SQL API rejects `ORDER BY`. `LIMIT` works. | Sort client-side | 02-02 |
| m9 | The seed quirk: `pcg32` with `>>` gives seed `-1` for 3.13% of timestamps. It has no practical value; don't chase it. | — | — |
| m10 | The docs are wrong in about 16 places: 60 s lobby, letters returned to the bag, `top_bid` column, "your balance" only, and others (RULES.md §13) | Trust RULES.md and the code | all |
| m11 | `lobby` and `lobby_member` keep every historical row | Use the `open_lobbies` views | 02-03 |
| m12 | The balance check at close (`game.ts:579`) cannot fail in practice. If it ever did, `auction_result` would name a winner who got no tile. | Note in the simulator; no handling needed | 02-01 |
| m13 | The sim rack becomes predictable: a sim plays only after a win and always plays its best ≥3-letter word, so it keeps unplayable leftovers | Use in opponent models | 01-03 |
| m14 | Scheduled jobs carry only `matchId`. A stale tick is a no-op. Clients cannot call ticks. | — | 02-01 |

---

## Catalog of opponent tricks (for 03-02 trick bots and 04 benchmarks)

| Trick | Effect on us | Warning sign | Counter |
|---|---|---|---|
| Price-pusher (bids `our_v − 1`) | We pay near our maximum on every win | `paid/our_bid` close to 1 on our wins | Randomise; bid close to the known competition; per-rival push memory |
| All-in bidder | It takes letters at our price | Huge top bids in the archive; its balance drops sharply | Stay truthful; let it overpay; track its balance cap |
| Bottom-feeder (1 on everything) | It gets free letters in all-real tables and finals | Many wins at `paid = 1` | Bid 1–2 on letters with any marginal value |
| End-game money dumper | Late letters become expensive | Late `paid` rises sharply | Secure completions early; spend our remainder too |
| Denial bidder (deal-aware) | Our 7-letter completions are taken | Losses on exactly our completion letters | Plans with several outs; cash earlier |
| Top-bid snooper (leak) | Our valuation function becomes public | Pushes that track our past winning bids | See C8 |
| RNG exploiter | Exact sim bids and our rack are known to it | Its wins at `simMax + 1`; no lost ties to sims | Assume it; match it if policy allows |
| Lobby sniper | It dodges us and farms sims | It joins only lobbies without us | Accept; maximise our own cycle rate |
| Last-moment bidder | Nothing, since bids are sealed | — | Bid early anyway (C5) |
| Reducer spammer (griefing load) | Closes and our acks are delayed | Close delay above 10 ms; RTT spikes | Larger deadline margin; early bids |

**Note on Bron (MEDIUM):** the evidence does not show Bron exploiting the RNG. Bron lost 10 of 38 exact ties to sims when runner-up (RULES.md §12.3). Re-test in 02-02 profiles.

---

## Policy decision required (raise to the user before 03-01)

Two exploit-class capabilities exist:
- **(a)** Reading live top bids through an anonymous second connection. This is an acknowledged bug. PR #16's own description says "anyone could create a fresh anonymous identity and read opponents' bids".
- **(b)** Reconstructing hidden deals and exact sim bids from the timestamp-seeded RNG. This uses only public data.

Recommendation:
- **Never ship (a).** Treat it as a threat model only.
- Ship (b) **only with explicit approval**. Otherwise implement it solely in `MatchTracker` for defensive modelling and benchmarking.
- Either way, the bot must remain strong with both disabled.

---

## Phase-specific warnings

| Phase / plan | Likely pitfall | Mitigation |
|---|---|---|
| 01-01 core/rng/types | An RNG off by one call: the lobby shuffle (S−1 calls), the `integerInRange(0,0)` call, rejection sampling, BigInt handling. The simulator's own seeded PRNG (ARCHITECTURE.md: xoshiro128**) is fine for synthetic matches, but historical parity replays need the **server** RNG (RULES.md §4.1). | Ship both. Add golden tests from the RULES.md §4.4 matches (deal strings, first letters). |
| 01-01 | Secrets committed | `.gitignore` plus a secret-scan hook from day 1 |
| 01-02 word engine | Dictionary drift, missing 2-letter words, a slow packer at the end | SHA-pin the wordlist; benchmarks; final-flush fast path |
| 01-03 MatchTracker | Wrong iteration-order bookkeeping, which corrupts sim-bid inference | Implement §4.3 exactly. Real-bot word transactions update the order. Self-check every close. |
| 02-01 simulator | Sim behaviour errors (bid timing, word timing, consumption, final letter) | Bit-exact all-sim replay parity tests (61 historical all-sim matches) |
| 02-02 history | Data volume (≈6M rows), encodings, deleted bots, ORDER BY unsupported | Chunked `WHERE match_id BETWEEN`; polite sequential fetches |
| 02-03 live client | Firehose subscription, latency, reconnect, enum filters, double-spent words, two processes | Targeted subscriptions; anytime bids; idempotent resubmit; reservation set |
| 03-01 strategy | Wrong objective per mode, money mispriced over time, first-price curse, leak exposure | Mode-aware objective; money valuation; shading; randomisation |
| 03-02 zoo | A trick zoo that leaves out deal-aware and snooper opponents | Trick bots built *with* RNG and leak knowledge |
| 04 evaluate | Overfitting to sims; benchmarks only with the RNG model on | Lineups by type; ablations with the RNG model off; paired seeds |
| 05 E2E and release | Harness RNG is not host-equivalent; no scheduler in the harness | Use a local `spacetime start` server for E2E; historical replays for parity; audit secrets before the push |

---

## Sources

- Official module code: `spacetimedb/src/{game,index,lobby,tournament,dictionary,letters,ratings,text,schema}.ts`, tests, `docs/bot-guide.md`, README, DEVELOP, TODO (`clockworklabs/scrabblebot@b5ccb36`).
- SDK 2.12.0: `server/rng.ts`, `server/runtime.ts:376-377`, `server/test-utils/index.ts:275-303`. pure-rand 7.0.1.
- GitHub PRs #16 (docs-for-bots branch), #23, #24, #25.
- Live read-only SQL on maincloud `scrabblebot` (2026-11-07): `visible_auction_top_bids`, `open_lobbies`, `open_lobby_members`, `matchmaker_config`, and match data for 1, 16863–16873, 28962, 31393, 33893, 41797–41799, 42656.
- Verification scripts and data in `scratchpad/rules-scripts/` and `scratchpad/rules-data/`.
