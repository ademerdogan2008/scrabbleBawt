# ScrabbleBot: Exact Server Rules Specification

**Researched:** 2026-11-07
**Scope:** Everything the `scrabblebot` SpacetimeDB module does that affects a bot. A simulator built from this file should reproduce the live server **bit-exactly, RNG included**. The RNG is not a "modulo" caveat here: it is a pure function of public timestamps (section 4).
**Sources:**
- Official repo `clockworklabs/scrabblebot`, branch `main` at `b5ccb36` ("Team invite codes (#24)", 2026-10-24). Cloned read-only at `scratchpad/ref/official`.
- SpacetimeDB TypeScript SDK **2.12.0**: `crates/bindings-typescript/src/server/rng.ts`, `runtime.ts`, `test-utils/*`. These are pinned by `spacetimedb/package-lock.json` (spacetimedb 2.12.0, pure-rand 7.0.1).
- pure-rand **7.0.1**: `lib/esm/generator/XoroShiro.js` and `lib/esm/distribution/internals/UnsafeUniformIntDistributionInternal.js`.
- Live database `scrabblebot` on maincloud, read with anonymous read-only SQL on 2026-11-07.

**Citation convention:** a bare `file.ts:N` means `spacetimedb/src/file.ts` in the official repo. `sdk/` means the SDK at tag v2.12.0. `pure-rand/` means pure-rand 7.0.1.

**Confidence labels:**
- **VERIFIED**: reproduced bit-exactly against live match history.
- **CODE**: read directly from the source. HIGH confidence.
- **MEDIUM / LOW**: marked as such where they apply.

---

## 0. The facts that matter most

1. **The server RNG is a deterministic function of the transaction timestamp in µs. Every timestamp is public.** Anyone can compute every participant's hidden 5-tile starting rack at match start. They can also compute every sim's bid jitter as soon as an auction opens. After each close, they can compute the tie-break and the letter draw. **VERIFIED:**
   - Three all-sim matches (1, 28962, 33893) replay bit-exactly. That is 68/68 auctions each: winner, `paid`, top bid and all 16–21 top-ties. All 22–24 sim words match, and so do the final balances and scores.
   - Four matches with real bots (31393, 41799, 42656, plus match 1) reproduce the deal and all 68 letters. The deal causes 0 rack-consistency violations against every real-bot word.
   - All 11 tournament round-2 tables (matches 16863–16873, one shared transaction) reproduce their first letters.
2. **Index iteration order follows an exact, verified model** (section 4.3). In-transaction rows come first. Committed rows follow in a per-key vector order that uses swap_remove plus push. This model decides which sim gets which jitter, and the order of the bid list before the tie-break shuffle.
3. **The deployed module is `main` at `b5ccb36`.** Evidence: the `open_lobbies` view exists live, and it was introduced in that commit. The **live top-bid leak is open**: on 2026-11-07, an anonymous (non-bot) identity read 37 `visible_auction_top_bids` rows for running match 42660. The fix (PR #16, admin-only allowlist) was merged only into the side branch `docs-for-bots`, not into `main`.
4. **Lobby length is 90 s** (`game.ts:61`); the docs say 60. Today the top bots (Bron 114, LUCENT 18, maverick-bot 62) keep rejoining, and their lobbies time out as 3 real bots plus 3 sims. Live lobby 37565 had exactly those three members.
5. **Unbid letters are consumed** (`game.ts:541-656` has no return path). The **final auction's letter is useless to real bots**, because the match ends inside the same transaction. Sims *can* use it (`game.ts:613-629`). In match 31393 (6 real bots), nobody bid on the final letter.
6. **All 25,598 historical matches are Vickrey, 1000 ms, rack size 5.** `matchmaker_config` is empty live, so the defaults in `game.ts:69-77` apply.
7. **Every close runs 0.3–3.3 ms after `closes_at`** (p50 1.5 ms, p90 2.1 ms, p99 3.3 ms, max seen 116 ms, n=272). The next auction opens at the close transaction's timestamp, so each auction lasts about 1001.5 ms. A 68-auction match lasts about 68.1–68.2 s.

---

## 1. Versions, deployment, pending changes

| Item | Value | Evidence |
|---|---|---|
| Module source | `main` @ `b5ccb36` (2026-10-24 23:48 -0700) | `git log` |
| Deployed version | `b5ccb36` (or later and unpushed). The leak is still present. | `open_lobbies` and `open_lobby_members` views answer SQL. They were introduced in b5ccb36 (`git log -S openLobbies`). `visible_auction_top_bids` returns live rows to an anonymous identity. |
| SDK (bundled into module) | spacetimedb 2.12.0, pure-rand 7.0.1 | `spacetimedb/package-lock.json`. The RNG behaviour matches 2.12.0 exactly (section 4). |
| Wordlist | ENABLE, 172,820 words, uppercase, LF, sorted in C order, unique | `spacetimedb/wordlist.txt`. 96 two-letter, 972 three-letter, max length 28. |
| PR #16 "Show live winning bids to admins only" | Merged on 2026-10-24 into **`docs-for-bots`** (commit 48f6b6f), **not into main** | GitHub PR page, compare `main...docs-for-bots` |
| PR #23 (web: per-page subscriptions) | Merged. Web only. | GitHub |
| PR #25 (ideas list, open) | Ideas only: tournament UX, "variables to change the meta every hackathon", "better performance", "local network". No rule changes yet. | `docs/ideas.md` on branch `docs/ideas` |

**Risk:** the organizers can deploy #16 at any time, or change the meta "every hackathon". The bot must read every parameter from the match row and must detect when the RNG model breaks (section 15).

---

## 2. Constants and configurable parameters

| Name | Value | Where | Configurable? |
|---|---|---|---|
| `STARTING_BALANCE` | 100 | `game.ts:48` | No |
| `AUCTION_DURATION_MS` | 1000 | `game.ts:49` | Yes, `matchmaker_config.auction_duration_ms` in **250–10000** (`index.ts:754-756`). Copied to `match_state.auction_duration_ms` at match start (`game.ts:250-263`). |
| `AUCTION_RESERVE` | 1 | `game.ts:50` | No. Vickrey sole-bidder price = `min(1, top)` = 1. |
| `LOBBY_MAX_SIZE` | 6 | `game.ts:60` | Yes, `lobby_max_size` in **2–12** (`index.ts:751-753`). Copied to `lobby.max_size` at lobby creation (`lobby.ts:29`). |
| `LOBBY_DURATION_SECONDS` | **90** | `game.ts:61` | No |
| `STARTING_RACK_SIZE` | 5 | `game.ts:65` | Yes, `starting_rack_size` in **0–20** (`index.ts:748-750`). Copied to `match_state.starting_rack_size`. |
| Config constraint | `lobbyMaxSize * startingRackSize < 98` | `index.ts:759-763` | |
| `SIM_BID_JITTER` | 2, uniform integer in [-2, 2] | `game.ts:771`, `game.ts:813-818` | No |
| `BAG_SIZE` | 98 (standard distribution, no blanks, face value 187) | `letters.ts:42-70`, `tests/pure.test.ts:46-54` | No |
| Lobby auction type | **Vickrey, hardcoded** | `lobby.ts:30` | No (only tournaments choose) |
| Tournament auction type | `Vickrey` or `FirstPrice`, set at creation | `index.ts:911-946` | Admin |
| `FINAL_GAMES` | 3 | `tournament.ts:133` | No |
| Rating init | mu 25, sigma 25/3, Elo 1000 | `game.ts:402-412` | No |

**Auctions per match** = `98 - P * startingRackSize`, where P is the number of participants. P=6 gives 68, P=7 gives 63, P=5 gives 73, P=4 gives 78, P=3 gives 83, P=2 gives 88. All of these appear in the historical data (`current_round` values).

**Bag** (`letters.ts:43-70`):
A9 B2 C2 D4 E12 F2 G3 H2 I9 J1 K1 L4 M2 N6 O8 P2 Q1 R6 S4 T6 U4 V2 W2 X1 Y2 Z1.

**Letter values** (`letters.ts:1-39`):
- 1: A E I O U L N S T R
- 2: D G
- 3: B C M P
- 4: F H V W Y
- 5: K
- 8: J X
- 10: Q Z
- Anything else scores 0.

---

## 3. Tables, views and what each identity can see

`public: true` tables can be subscribed to and read over SQL by **any** identity. Private tables are readable only inside the module.

| Table / view | Vis | Key columns | Written when |
|---|---|---|---|
| `bot` | public | id, name, team_id, is_simulated, strategy | `createTeam`, `ensureSimBot` / `spawnSimulatedBot`. Deleted when a team dissolves (9 deleted bot ids still appear in `match_participant`). |
| `bot_credential` | public | identity → bot_id, connected, last_seen | `claimCredential`. `clientConnected` / `clientDisconnected` toggle `connected` (`index.ts:231-251`). **This shows everyone when each bot is online.** |
| `lobby` | public | id, status, opens_at, closes_at, max_size, auction_type, resolved_match_id | Every lobby ever made stays in the table (~37.6k rows) |
| `lobby_member` | public | lobby_id, bot_id, joined_at | Rows of resolved lobbies stay (~262k) |
| `open_lobbies`, `open_lobby_members` | anon views | Only the `Open` lobby and its members | `index.ts:142-158` |
| `match_state` | public | id, status, current_round, current_auction_id, bag_total, auction_type, created_at, started_at, ended_at, auction_duration_ms, starting_rack_size | Start, each close, end |
| `match_participant` | public | id (autoInc, **in roster order**), match_id, bot_id, **balance, score of every participant** | Start; winner at each close; each word play |
| `bag_letter` | private | match_id, letter, remaining | |
| `holding` | private; own rows via the `my_rack` view | match_id, bot_id, letter, count | Deal, wins, word plays. **Never deleted at match end**, so `my_rack` returns tiles from every past match (`index.ts:72-82`). |
| `auction` | public | id, match_id, letter, opens_at, closes_at, status | Insert at open; status set to Closed at close (~1.74M rows) |
| `pending_bid` | private | auction_id, bidder_bot_id, amount, submitted_at | `submit_bid`, sims at open. Deleted at close. **A bot cannot read even its own pending bid.** |
| `auction_result` | public | auction_id, match_id, letter, winner_bot_id (Option), paid, closed_at | At close |
| `auction_top_bid` | private | auction_id, match_id, top_bid, visible(=true, unused) | At close. Moved to the archive at match end (`game.ts:361-373`). |
| `visible_auction_top_bids` | view | Top bids of **closed** auctions in **Running** matches | Returns `[]` to identities that hold a bot credential, and **everything to everyone else** (`index.ts:120-137`). **LIVE LEAK.** |
| `auction_top_bid_archive` | public | auction_id, match_id, top_bid | At match end, one row per auction |
| `word_play` | public | match_id, bot_id, word, base_score, bonus, total_reward, played_at | Each word (~402k rows) |
| `auction_schedule`, `lobby_timeout_schedule` | private | Scheduled one-shot jobs | |
| `matchmaker_config` | public | id=0 row, if an admin saved one | **Empty live** |
| `bot_stats`, `rating_history`, `retired_bot_stats`, `bot_version` | public | Ratings (section 10) | Match end |
| `tournament`, `tournament_entry`, `tournament_match` | public | Section 11 | |

**Sum-type encodings over SQL/HTTP:** `[variantIndex, payload]`.
- `MatchStatus` is Lobby 0, Running 1, Ended 2.
- `AuctionStatus` is Open 0, Closed 1.
- `AuctionType` is FirstPrice 0, Vickrey 1.
- `Option` is `[0, v]` (some) or `[1, []]` (none).
- Timestamps are `[micros]`.

The HTTP SQL endpoint accepts `WHERE` and `LIMIT`. It rejects `ORDER BY` ("Unsupported").

---

## 4. Determinism model (RNG and iteration order)

### 4.1 RNG algorithm (VERIFIED)

`ctx.random` is created lazily, once per reducer transaction, as `makeRandom(ctx.timestamp)` (`sdk/runtime.ts:376-377`). Its seed is `timestamp.microsSinceUnixEpoch` (`sdk/rng.ts:120-131`). The stream is:

```js
// Exact re-implementation. Our own code; behaviour identical to SDK 2.12.0 + pure-rand 7.0.1.
function pcg32(state /* BigInt micros */) {                        // sdk/rng.ts:63-72
  state = BigInt.asUintN(64, state * 6364136223846793005n + 11634580027462260723n);
  const xorshifted = Number(BigInt.asUintN(32, ((state >> 18n) ^ state) >> 27n));
  const rot = Number(BigInt.asUintN(32, state >> 59n));
  return (xorshifted >> rot) | (xorshifted << (32 - rot));          // JS int32 ops: '>>' sign-extends (quirk)
}
// pure-rand xoroshiro128plus(seed) = new XoroShiro128Plus(s01=-1, s00=~seed, s11=seed|0, s10=0)
function unsafeNext(s) {                                            // pure-rand/generator/XoroShiro.js:16-27
  const out = (s.s00 + s.s10) | 0, a0 = s.s10 ^ s.s00, a1 = s.s11 ^ s.s01, s00 = s.s00, s01 = s.s01;
  s.s00 = (s00 << 24) ^ (s01 >>> 8) ^ a0 ^ (a0 << 16);
  s.s01 = (s01 << 24) ^ (s00 >>> 8) ^ a1 ^ ((a1 << 16) | (a0 >>> 16));
  s.s10 = (a1 << 5) ^ (a0 >>> 27);
  s.s11 = (a0 << 5) ^ (a1 >>> 27);
  return out;
}
function integerInRange(s, min, max) {                              // sdk/rng.ts:107; pure-rand UnsafeUniformIntDistribution(Internal)
  const n = max - min + 1;                                          // range size
  const maxAllowed = n > 2 ? Math.floor(0x100000000 / n) * n : 0x100000000;
  let d = unsafeNext(s) + 0x80000000;                               // rejection sampling: usually exactly 1 call
  while (d >= maxAllowed) d = unsafeNext(s) + 0x80000000;
  return (d % n) + min;
}
```

Notes:
- Every `integerInRange` call consumes at least one `unsafeNext()`. This includes `integerInRange(0, 0)`, which is the draw when one tile is left.
- For the module's ranges (at most 98), rejection happens with probability about 2e-8. Implement the rejection loop anyway.
- A reference implementation lives in `scratchpad/rules-scripts/stdbrng.mjs`.
- **Seed quirk:** `>>` sign-extends. Over 1M consecutive micros, 74% of seeds are negative, seed `-1` occurs 3.13% of the time, `-2` 1.56%, and `-3`/`-4` 0.78% each. This is the "many timestamps map to the same few seeds" issue noted at `game.ts:202-205`. It gives very little prediction power and needs no special handling.
- **The module's own `shuffle`** (`game.ts:118-123`) is: `for i = len-1 down to 1: j = integerInRange(0, i); swap(items[i], items[j])`. That is `len-1` calls. It is *not* the SDK's `random.shuffle`.

### 4.2 RNG consumption per transaction, in exact order (VERIFIED)

The seed is always that transaction's `ctx.timestamp`. All of these timestamps are published.

**A. Lobby timeout** (`lobbyTimeoutTick`, `index.ts:898-905`). Seed = `match_state.started_at` = `created_at` = the first `auction.opens_at`.
1. `shuffle(availableSims)`: S−1 calls. S = the number of `is_simulated` bots in `bot` that are not in the roster, in `bot.iter()` table-scan order (`lobby.ts:68-72`). Live, S = 6 (bot ids 1–6, in id order), so this is **5 calls**. It happens even when `need` is 0.
2. Deal: for each participant **in roster order** (equal to `match_participant.id` ascending), `rackSize` calls of `drawLetter` (`game.ts:288-296`).
3. First letter: one `drawLetter` (`game.ts:298`).
4. `simulateBids`: one `integerInRange(-2, 2)` for each **sim** participant, in `mpByMatch.filter` order. In the start transaction that is insertion order, which equals roster order. Real bots consume nothing (`game.ts:801-825`).

**B. Lobby filled by `maxSize` real bots** (`joinLobby`, `index.ts:885-895`). Seed = that `join_lobby` transaction's timestamp = `started_at`. No shuffle. Steps 2–4 only.

**C. Auction close** (`auctionTick`, `index.ts:1134-1144`). Seed = `auction_result.closed_at` = the next `auction.opens_at` (= `ended_at` on the final close).
1. `shuffle(sorted)` over the n bids with `amount > 0`: `max(n-1, 0)` calls (`game.ts:555-560`).
2. Sim word play uses no RNG.
3. `drawLetter`: one call if `bagTotal > 0`. If the bag is empty, there is no call and the match ends (`game.ts:749-751`).
4. `simulateBids` for the new auction: one call per sim, in **in-transaction** iteration order (section 4.3).
5. If the match ended and it is a tournament match, the next Swiss round may start **in this same transaction, continuing the same stream**. Round 1 begins with `shuffle(entries)`. Then for each table in order: deal, first letter, sim jitters (`tournament.ts:149-195`, `tournament.ts:437-441`). `startRoundOneWhenFree` (`index.ts:1141`, `tournament.ts:89-107`) can do the same.

**D. `start_tournament`** (admin). If no entrant is busy: `shuffle(entries)` (E−1 calls), then table 1 (deal, first letter, jitters), table 2, and so on, all in one stream. VERIFIED on round 2, which has no shuffle: 11/11 first letters.

**E. `start_next_finals_match`** (admin). Deal, first letter, jitters. No shuffle.

**`drawLetter`** (`game.ts:744-765`):

```
if bagTotal == 0: return none                           // no RNG call
idx = integerInRange(0, bagTotal - 1)
for (letter, remaining) in bag rows with remaining > 0, sorted by letter ascending (A..Z):
    if idx < remaining: remaining -= 1; bagTotal -= 1; return letter
    idx -= remaining
```

### 4.3 Index iteration order (VERIFIED on all-sim matches; consistent on mixed matches)

The model below is required to reproduce which sim receives which jitter, and the input order of bids to the tie-break shuffle.

For `table.index.filter(key)` inside a reducer transaction:
1. **Rows inserted in this transaction come first, in insertion order.** An updated row counts as newly inserted.
2. **Then the committed rows for that key** that were not deleted in this transaction, in the key's *committed order*.
3. The committed order per key behaves like a vector. At commit:
   - each deleted row is removed by **swap_remove**: the key's last element moves into the hole;
   - each inserted row is **pushed to the end**.
   - An `update` is a delete plus an insert.

Applied to the module:
- **`matchParticipant.mpByMatch.filter(matchId)`.** The start order is the roster (insertion) order. In a close transaction, the winner's row was just updated (paid, and possibly a sim word), so **the previous winner is iterated first**. The other rows follow in committed order. After the commit, apply `swapRemovePush(committed, winner)`. Every real-bot `submit_word` transaction (a `word_play` whose `played_at` matches no `closed_at`) also commits `swapRemovePush(committed, bot)`.
  - Tested over 67 close transactions of match 1: this model gives **0 failures**. Alternatives give 34–64 failures: identity order; updated row moved to the end or front; updated row kept in place.
- **`pendingBid.bidByAuction.filter(auctionId)` at close** is the committed order. Sims' bids are pushed when the auction opens (in-transaction sim order; zero bids are skipped). Each real bot's bid is pushed when its transaction commits. A replacement does swap_remove of the old row, then pushes the new one. This decides the pre-shuffle order, so with the close RNG it decides tie-breaks. VERIFIED: all 55 top-ties in the three all-sim replays resolve correctly.

**This supersedes the "sim jitters known only as a multiset" limitation in COMPETITORS.md.** With this model, each jitter maps to a specific sim exactly.

**Caveat (MEDIUM):** this is an empirical model of SpacetimeDB's datastore internals as deployed in Nov 2026. A server upgrade can change it. Self-check it at runtime (section 15).

### 4.4 Verification record

| Check | Matches | Result |
|---|---|---|
| Sim padding order = `shuffle([1..6])` at started_at | 1, 41799, 42656 | exact |
| Deal + first letter + all later letters (n inferred per close) | 1, 31393 (6 real), 41799 (1 real), 42656 (3 real), 41797, 41798 | 68/68 letters each; 0 rack-consistency violations against every word |
| Full bit-exact replay, incl. ties, sim words, final balance/score | 1, 28962, 33893 (all-sim) | 68/68, 68/68, 68/68 |
| Sim-bid model consistent with (winner, paid, top) when real bots are present | 41797, 41798, 41799, 42656 | 68/68 each. The null models fail 12–57 of these checks on the sim-heavy matches. |
| Tournament: one RNG stream across tables | 16863–16873 | 11/11 first letters |

Scripts: `scratchpad/rules-scripts/{stdbrng,tiecheck,dealcheck,simbids,sql}.mjs`. Data: `scratchpad/rules-data/`.

---

## 5. Lobby

**`openLobbyOrCreate`** (`lobby.ts:19-40`): return the first `Open` lobby. Otherwise insert one with `closesAt = now + 90 s`, `maxSize = config.lobbyMaxSize`, and `auctionType = Vickrey`, then schedule `lobbyTimeoutTick` at `closesAt`.

**`join_lobby()`** (`index.ts:852-896`). Checks and steps in order:
1. No credential: error `"Your identity is not a credential for any bot"`.
2. `botInRunningMatch`: error `"You're already in a running match"`.
3. `heldForTournament`: error `"You're playing in a tournament; the lobby reopens to you when you're knocked out or it ends"`.
4. Call `openLobbyOrCreate`.
5. Already a member: silent no-op (idempotent).
6. Insert the `lobby_member` row.
7. If the count of **real** members is at least `lobby.maxSize`, call `resolveLobby(lobby, padWithSims=false)`. The match starts in this transaction.

There is **no leave-lobby reducer**.

**`resolveLobby(id, pad)`** (`lobby.ts:45-107`):

```
if lobby missing or status != Open: return                          // stale timeout = no-op
roster = lobby members (index order) minus deleted bots minus heldForTournament bots
if pad:
    avail = [b.id for b in bot.iter() if b.isSimulated and b.id not in roster]
    shuffle(avail)                                                  // RNG (section 4.2 A)
    need = max(maxSize - len(roster), 0)
    for sim in avail[:need]: insert lobby_member; roster.push(sim)  // sims are APPENDED after real bots
if len(roster) < 2: lobby := Cancelled; openLobbyOrCreate(); return
r = startMatchWith(lobby.auctionType, roster)
lobby := Resolved(resolvedMatchId) or Cancelled on error
openLobbyOrCreate()                                                 // the next lobby opens at THIS timestamp
```

**Practical cycle:**
- Lobby L opens when match M starts, at time t0.
- M ends at about t0+68.1 s. Its bots rejoin L.
- L times out at t0+90 s. It is padded with sims and becomes match M′.
- So one match per 90 s per bot. The idle gap is about 22 s.
- A lobby resolves early only when `maxSize` real bots are in it.
- Sims are reusable across concurrent matches. They are never "busy" (`lobby.ts:63-66`).

---

## 6. Match start: `startMatchWith(auctionType, participants)` (`game.ts:237-328`)

```
if participants empty: err "Need at least one participant"
if any bot id unknown: err "Unknown bot in roster: <id>"               // checked BEFORE any write
bagTotal = 98; cfg = matchmakerConfig[0] ?? defaults
insert match_state {status Running, currentRound 1, bagTotal, auctionType,
                    createdAt = startedAt = now, auctionDurationMs, startingRackSize}
for botId in participants: insert match_participant {balance 100, score 0}   // ids ascending = roster order
insert 26 bag_letter rows
for botId in participants: repeat startingRackSize: l = drawLetter(); if none: break; addToRack(botId, l)
first = drawLetter(); if none: return err "Bag empty"      // NOTE: the rows above are NOT rolled back (zombie match)
insert auction {letter first, opensAt now, closesAt now + auctionDurationMs, Open}
match.currentAuctionId = auction.id
schedule auctionTick at closesAt (one-shot)
simulateBids(auction)
```

The zombie case needs `P * rack >= 98`. It cannot happen from a lobby (the config check prevents it). It can happen at a tournament table of 20 or more players with rack 5. That would leave a `Running` match with no auction, and its bots could never `join_lobby` again. This is an edge case only.

---

## 7. Auctions: timing, bidding, closing

### 7.1 Lifecycle and timing (CODE + VERIFIED timing)
- Exactly one auction is `Open` per match at a time.
- `closes_at = opens_at + match.auction_duration_ms`.
- The close is a one-shot scheduled `auction_tick(job{matchId})` at `closes_at` (`game.ts:316-320`, `game.ts:648-652`).
- The job carries only `matchId`. `closeAuction` closes **the match's current auction** and does **not** check the clock (`game.ts:541-553`).
- A tick for a finished or unknown match is a no-op.
- Clients cannot call `auction_tick`: `requireScheduler` rejects them with `"Only the scheduler may call this"` (`game.ts:159-163`).
- **Measured:** the close runs 0.3–3.3 ms after `closes_at` (p50 1.5 ms; one outlier of 116 ms). The next auction's `opens_at` is the close transaction's timestamp, so the schedule drifts by about +1.5 ms per auction.
- `current_round` starts at 1 and increments each time a new auction opens. Its final value equals the number of auctions.
- `bag_total` is the number of tiles left in the bag *after* the current auction's letter was drawn.
- **`bag_total == 0` while `Running` means the current auction is the final one.**

### 7.2 `submit_bid(auction_id: u64, amount: i64)` (`index.ts:780-812`)

Errors, checked in this order:
1. `amount < 0`: `"Bid must be non-negative"`
2. No credential: `"Your identity is not a credential for any bot"`
3. No auction row: `"Unknown auction"`
4. `status != Open`: `"Auction closed"` (the close already ran)
5. `ctx.timestamp >= closes_at`: `"Auction window expired"` (past the deadline, but the scheduler has not run yet)
6. Not a participant of `auction.match_id`: `"Not in this match"`
7. `balance < amount`: `"Insufficient balance"`. This uses the **current** balance, including word rewards credited earlier.

On success, `replaceBid` deletes this bot's earlier bid on this auction and inserts the new one (`game.ts:828-847`).
- Any number of replacements is allowed before the deadline.
- **`amount = 0` is accepted.** It replaces the earlier bid and is then filtered out at close, so a 0 bid **withdraws** a bid.
- The deadline uses the server's transaction timestamp. Your local clock is irrelevant. Network and queue delay count against you.

### 7.3 `closeAuction(matchId)` (`game.ts:541-656`)

```
m = match; if m missing or not Running or no currentAuctionId or auction missing: return false
bids   = pendingBid.bidByAuction.filter(auctionId)          // committed order (4.3)
sorted = [b for b in bids if b.amount > 0]
shuffle(sorted)                                              // RNG: len-1 calls
stable-sort sorted by amount DESC                            // ties keep their shuffled order
winner = sorted[0]?.bot; topBid = sorted[0]?.amount ?? 0; paid = 0
if winner: paid = FirstPrice ? top : (sorted[1] ? sorted[1].amount : min(1, top))
if winner and participant(winner).balance >= paid:           // always true in practice: balance only falls at closes
    participant.balance -= paid; addToRack(winner, letter); if winner is sim: simWinner = winner
# If the balance check failed (unreachable in normal play), auction_result would still name the winner
# and the paid amount, but no money moves and no tile is given. The letter is lost.
insert auction_result {auctionId, matchId, letter, winnerBotId: winner (Option), paid, closedAt: now}
insert auction_top_bid {topBid, visible: true}               // private; leaked via the view (section 3)
auction.status = Closed; delete all bids of this auction (incl. 0-amount ones)
if simWinner: simulateWordPlay(simWinner)                    // BEFORE the next draw, so sims can use the final letter
next = drawLetter()
if none: match := Ended {currentAuctionId: none, endedAt: now}; onMatchEnded(); return true
insert auction {next, opensAt now, closesAt now + match.auctionDurationMs}
match.currentRound += 1; match.currentAuctionId = new; schedule tick at closesAt
simulateBids(newAuction); return false
```

- **No positive bids:** `winner_bot_id = none`, `paid = 0`, and the **letter is consumed**.
- **Vickrey `paid`** equals the second-highest positive bid, or 1 when the winner was the only positive bidder. So `paid = 1` is ambiguous.
- **FirstPrice `paid`** equals the winner's own bid.

---

## 8. Simulated bots

**Roster:**

| id | Name | Strategy |
|---|---|---|
| 1 | Cheapo-sim | Cheapskate |
| 2 | Valor-sim | ValueBidder |
| 3 | Brutus-sim | Aggressive |
| 4 | Hagrid-sim | ValueBidder |
| 5 | Maverick-sim | Aggressive |
| 6 | Snippet-sim | Cheapskate |

They are seeded by `init` (`index.ts:215-225`). Admins can add more with `spawn_simulated_bot`, which would change S in section 4.2 A. Sims have fabricated credentials with `connected = true`, and they never call reducers.

**`decideBid(strategy, letter, balance, jitter)`** (`game.ts:775-799`):

```
v = letterValue(letter); vowel = letter in "AEIOU"            // Y is NOT a vowel
base = Cheapskate: v-1 | ValueBidder: v | Aggressive: v + (vowel ? 4 : 2) | Human: return 0
amount = max(min(max(base + jitter, 1), balance), 0)          // never below 1 unless broke; capped by balance
```

`jitter = integerInRange(-2, 2)`. `simulateBids` (`game.ts:801-825`):
- runs right after each auction opens, in the same transaction;
- calls `replaceBid` once per sim with `amount > 0`;
- runs only at open. Sims never re-bid.

**Pre-cap bid ranges** (each value equally likely before clamping at 1):

| Letter class (v) | Cheapskate | ValueBidder | Aggressive |
|---|---|---|---|
| Vowel AEIOU (1) | {1,1,1,1,2} | {1,1,1,2,3} | 3..7 |
| L N S T R (1) | {1,1,1,1,2} | {1,1,1,2,3} | {1,2,3,4,5} |
| D G (2) | {1,1,1,2,3} | {1,1,2,3,4} | 2..6 |
| B C M P (3) | {1,1,2,3,4} | 1..5 | 3..7 |
| F H V W Y (4) | 1..5 | 2..6 | 4..8 |
| K (5) | 2..6 | 3..7 | 5..9 |
| J X (8) | 5..9 | 6..10 | 8..12 |
| Q Z (10) | 7..11 | 8..12 | 10..14 |

**`simulateWordPlay(sim)`** (`game.ts:849-869`):
- It runs only in the close transaction where that sim **won** (and was able to pay).
- `word = findBestPlayable(wholeRack, minLen=3)`. If a word is found, `playWord` runs.
- At most **one word per win**. A sim never plays its starting tiles until it wins something, and it never plays 2-letter words.

**`findBestPlayable`** (`dictionary.ts:63-106`):
- Scan the dictionary sorted by **length descending, then lexicographic ascending** (`dictionary.ts:22-27`).
- Stop when the words get shorter than `minLen`. Skip words longer than the rack.
- Return the **first** word the rack can spell. That is the longest playable word; among equal lengths, the alphabetically first.
- VERIFIED: every sim word in the 3 replays matches.

---

## 9. Words: `submit_word(match_id: u64, word: string)` (`index.ts:816-848`, `game.ts:670-742`)

Errors, checked in this order:
1. `"Unknown match"`
2. `"Match not running"`. This includes every attempt after the final close.
3. `"Your identity is not a credential for any bot"`
4. `"Not in this match"`
5. `wordUpper = asciiUppercase(word)`. Only `a-z` is uppercased, and there is **no trim** (`text.ts:12-14`).
6. UTF-8 byte length below 2: `"Word must be at least 2 letters"`
7. Not `/^[A-Z]*$/`: `"Word must be A-Z only"`. Spaces and accented letters fail here.
8. Not in ENABLE (binary search over the raw sorted list, `dictionary.ts:29-52`): `"'<WORD>' is not in the dictionary"`
9. Rack short of a letter: `"Not enough 'X': need n, have m"`. Nothing is consumed on failure.

**Effect:**
- The letters are deducted.
- `base = sum(letterValue)` and `total = floor(base * num / den)`, using BigInt division on a positive base.
- `bonus = total - base`.
- `balance += total` and `score += total`.
- A `word_play` row is inserted with `played_at = now`.
- There is no limit on how often words can be played, and no requirement to use the newest letter.

| Length | Multiplier | Example (from `tests/words.test.ts:56-61`) |
|---|---|---|
| 2–3 | 1× | CAT: 5 → 5 |
| 4 | 1.5× (floor) | AXES: 11 → 16; QUIZ: 22 → 33 |
| 5 | 2× | QUAKE: 18 → 36 |
| 6 | 2.5× (floor) | ZEBRAS: 17 → 42 |
| 7+ | 3× | JUKEBOX: 27 → 81 |

**Dictionary details:**
- Two-letter words are legal for real bots. ENABLE has 96 of them.
- ENABLE **lacks QI, ZA, ZO, JA and KI**. It has XU, XI, JO, KA, OX, AX and EX.
- Score is what ranks a match. Balance only funds bids, and **leftover balance at the end is worth nothing**.

---

## 10. Match end, ratings and stats

The match ends inside the closing transaction of the final auction:
1. The status becomes `Ended`.
2. `onMatchEnded` moves every `auction_top_bid` row of the match into the public `auction_top_bid_archive` (`game.ts:361-373`).
3. `updateEloAtMatchEnd` runs (`game.ts:458-521`).
4. Then `auctionTick` calls `onTournamentMatchEnded` and `startRoundOneWhenFree` (`index.ts:1139-1141`).

**Rating** (only if the match has at least 2 participants):
- Sort the participants by score, descending.
- `place` = the index of the first participant with an equal score, i.e. the number with a strictly higher score. **Ties share the better place** (`game.ts:482`).
- OpenSkill Plackett-Luce rates the whole match as one observation (`ratings.ts:50-87`):

```
BETA^2 = (25/6)^2; KAPPA = 1e-4
c = sqrt(sum(sigma_i^2 + BETA^2)); s_i = exp(mu_i / c)
field_q = sum(s_i over i with place_i >= place_q); tied_q = #players sharing q's place
for i: omega = sum over q with place_q <= place_i of (i==q ? 1 - s_i/field_q : -s_i/field_q) / tied_q
       delta = sum over same q of (s_i/field_q)(1 - s_i/field_q) / tied_q
       mu_i'    = mu_i + omega * sigma_i^2 / c
       sigma_i' = sigma_i * sqrt(max(1 - (sigma_i/c) * delta * sigma_i^2 / c^2, KAPPA))
```

- Elo with K=32 is also kept, computed pairwise against the other participants' **pre-match** ratings (`ratings.ts:21-33`).
- `wins += 1` for everyone tied for the top score (`game.ts:500`).
- `matchesPlayed += 1`, `totalScore += score`, `lastPlayed = now`.
- One `rating_history` row per participant.
- Sims are rated like everyone else.
- Each match counts for the bot version that was current at match creation (`game.ts:390-398`). `start_new_bot_version` resets the rating (`index.ts:556-580`).

**Leaderboard display** (`src/rating.ts`):
- `display = round(1500 + 29.4809 * (mu - 25))` and `± = round(29.4809 * sigma)`.
- A bot is provisional while ± > 175, i.e. sigma > 5.936. A new bot starts at ±246.
- Example: mu 61.8 displays as about 2585.

---

## 11. Tournaments (`tournament.ts`, `index.ts:911-1106`)

**Create** (admin): `swiss_rounds_total >= 1`, `top_cut >= 2`, `match_size >= 2`, and `auction_type` either Vickrey or FirstPrice. Only one active tournament may exist at a time.

**Registration:** only by the bot's own credential (`register_for_tournament` and `unregister_from_tournament` while the status is `Registration`). An admin can enter **every** sim with `register_sim_bots` (`index.ts:983-994`).

**Start** (admin, `index.ts:1019-1063`):
- Drop entries whose bot was deleted. Require at least `match_size` entries.
- Set the status to `Swiss`. Remove entrants from the open lobby.
- If any real entrant is in a running match, **round 1 waits** (`currentRound` stays 0). It starts in the close transaction of the last such match (`startRoundOneWhenFree`).
- From the start until a bot is knocked out or the tournament ends, `join_lobby` refuses entrants and lobbies skip them. Sims are exempt (`tournament.ts:41-53`).

**Swiss round r** (`tournament.ts:149-208`):
- Non-eliminated entries are ordered by `shuffle` (r = 1) or by standing (points desc, total score desc, bot id asc).
- They are sliced into `tableSizes(n, matchSize)`: `tables = max(floor(n/size), 1)`, `base = floor(n/tables)`, and the first `n % tables` tables get one extra seat.
- So **tables can hold between `matchSize` and `2*matchSize - 1` players**. Example: 68 entrants at size 6 gives tables [7, 7, 6×9], as seen in tournament 1.
- All tables start in **one transaction**, sharing one RNG stream.
- Points awarded = `max(matchSize - #bots with strictly higher score, 0)`. Ties share the better place. At an oversized table, places beyond `matchSize` earn 0.
- `total_score += score` for every tournament match.

**Cut:** after the last Swiss round, keep the top `top_cut` by standing and eliminate the rest. The status becomes `Bracket` if more than 2 are kept, otherwise `Final` (`tournament.ts:285-299`).

**Bracket** (each match started by an admin):
- One match seats **all** alive entrants.
- **Last place is eliminated.** Tie-break: lower match score, then lower `total_score`, then **higher** bot id goes out.
- `final_finish_position` = the number alive before the match.
- At 2 alive, the status becomes `Final` (`tournament.ts:304-337`).

**Final:** 3 two-player games (88 auctions each with rack 5). The champion has the **highest total score over the 3 games**, not the most game wins. Tie-break: tournament `total_score`, then lower bot id (`tournament.ts:341-372`).

**Force end:** in-progress matches play out but no longer count.

**History:** tournament 1 (2026-10-25) had Vickrey, size 6, 4 Swiss rounds, top cut 6, 68 entrants, and no sims. Its bracket went 6 → 5 → 4 → 3 → final. The winner was bot 127.

**Objectives differ by phase:**
- Lobby: placement, for the PL rating.
- Swiss: placement points.
- Bracket: **only avoid last place**.
- Final: **3-game score sum**.

---

## 12. Information model

### 12.1 What becomes visible, and when (subscription deltas)

| Moment | New public data |
|---|---|
| Lobby join | `lobby_member` row (bot_id, joined_at) for **everyone**. `bot_credential.connected` is always visible. |
| Match start transaction | `match_state` (parameters, `started_at`); all `match_participant` rows (roster order = id order); the first `auction`; own `my_rack` (5 tiles); `lobby.resolved_match_id`; the new lobby |
| During an auction | **Nothing** about the current bids. They sit in the private `pending_bid`. |
| Close transaction | `auction.status` Closed; `auction_result` (winner, paid, closed_at); the winner's balance drop; the sim winner's `word_play` and balance/score; the next `auction` (letter, opens_at, closes_at); `match_state` round, `bag_total`, current auction; own `my_rack` if you won. **Leak:** `visible_auction_top_bids` gains the closed auction's top bid, readable by any non-bot identity, e.g. a second anonymous connection. |
| Word transaction | `word_play` row (word, reward, `played_at`); that participant's balance and score |
| Final close | `match_state` Ended, `ended_at`; every top bid of the match in `auction_top_bid_archive`; `bot_stats`; `rating_history` |

### 12.2 What can be derived (exactly, by anyone)

1. **Every participant's starting rack**, from the deal (4.2 A/B, 4.4) at match start. This needs `started_at`, the roster order (`match_participant.id`), `starting_rack_size`, and the lobby type (timeout means a 5-call shuffle first). Our own rack is **not** private from a capable rival.
2. **Every participant's rack at all times** = deal + letters won (`auction_result`) − letters played (`word_play`).
3. **The exact bag composition** = DEFAULT_BAG − all deals − all auctioned letters. It is exact once the deals are known; `bag_total` is the count. Without the RNG, the 5×(P−1) unseen dealt tiles are only a distribution.
4. **Every sim's exact bid on the current auction**, at the moment it opens (seed = `auction.opens_at`). This needs:
   - n = the number of positive bids at the previous close. Each candidate n either reproduces the observed letter or it does not. In sampled mixed matches, 22–29 of 67 closes (33–43%) leave 2 or more candidates. Narrow them using the known sim bid count, your own bid, and `paid`.
   - the iteration order (4.3), maintained from public events;
   - the sims' public balances.
5. **An upper bound on any opponent's bid** = their current public balance. `submit_bid` rejects anything higher. Their balance rises only through their own word transactions.
6. **The count of positive bidders in every closed auction** (the candidate-n set). This shows how many rival real bots bid on each letter, but not how much.
7. **Bid amounts:**
   - Vickrey `paid` = the second-highest bid, from an unnamed bidder.
   - FirstPrice `paid` = the winner's bid.
   - After the match, the archive gives every winner's top bid.
   - Live, the leak gives the top bids of closed auctions.
8. **Classic inference without the RNG:** letters a rival played but never won must come from its deal. Once all of a rival's tiles are played, its deal is fully known.
9. **What cannot be predicted:** future letters. The next close timestamp carries roughly ±1.5 ms of µs-level jitter, and each µs gives a different seed. The resulting letter distribution is effectively the bag distribution. Also unpredictable: future tie-breaks, and rivals' real bids on the open auction.

### 12.3 Do the top rivals exploit the RNG? (MEDIUM)

There is no clear evidence. In Bron's 3 solo matches against 5 sims (41797–41799), Bron's winning bid minus the computed sim maximum was 0/1/2/3/4 in 9/19/9/7/1 of his first 45 wins. When Bron was runner-up to a sim, Bron **lost 10 of 38 exact ties**. An exact predictor would avoid ties. The pattern fits bidding just above the sims' typical range, not exact prediction. Re-test this in the opponent-modelling work with more matches.

---

## 13. Docs versus code (the code wins)

| # | Docs say | Code / live does | Cite |
|---|---|---|---|
| 1 | Lobby is "rolling 60-second" | **90 s** | `docs/bot-guide.md:10,102`; README:31; DEVELOP:70 vs `game.ts:61`; live lobby 37565 |
| 2 | "Tiles with no bid are returned to the bag" | **Consumed** | bot-guide:55-56; README:52-53 vs `game.ts:541-656`, commit 3802a4d (#3) |
| 3 | `auction_result` has `top_bid` | It does not. Top bids are private, then leaked by a view, then archived at match end. | bot-guide:26; DEVELOP:99; TODO:7-18 vs `schema.ts:449-456,467-508` |
| 4 | `match_participant` holds "your" balance and score | **Every** participant's balance and score are public | bot-guide:23-24 vs `schema.ts:329-344` |
| 5 | `auction` holds "open auctions across matches you're in" | Every auction ever (~1.74M rows) | bot-guide:25 |
| 6 | `lobby` holds the currently open lobby | Every lobby ever. Use the `open_lobbies` views. | bot-guide:22 vs `index.ts:139-158` |
| 7 | Opponents' racks and the bag "stay hidden" | Fully derivable, including the hidden deal through the RNG | bot-guide:29-32 vs section 4 |
| 8 | No mention of starting racks | Each bot is dealt 5 hidden tiles | bot-guide:3-11 vs `game.ts:285-296` |
| 9 | Lobby "padded out to 6" | Padded to `lobby.max_size` (configurable 2–12) | README:36-37 vs `lobby.ts:29,73` |
| 10 | "best-of-3 finals" | Champion by **total score** over 3 games | README:126-128 vs `tournament.ts:341-372` (`docs/ideas.md` admits this) |
| 11 | Admin "can't start the tournament" while a bot is mid-match | The start succeeds. Round 1 is deferred. | bot-guide:184-186 vs `index.ts:1046-1057` |
| 12 | `auction_tick` "self-rescheduling ... every 1s" | A one-shot job per auction at that auction's `closes_at`, using the per-match duration | DEVELOP:107-110 vs `game.ts:631-652` |
| 13 | Live top bids are "spectator-only" and hidden from bots | Hidden only from identities **with** a bot credential. A fresh anonymous identity sees them (confirmed live). | `index.ts:114-137`; `schema.ts:460-466` |
| 14 | "Bidders see only their own bid as acknowledged" | A bot cannot read even its own pending bid. Only the reducer's success or error comes back. | DEVELOP:205-209 |
| 15 | New bots "start at 1500" | That is a display transform of mu = 25 | bot-guide:57-62 vs `src/rating.ts` |
| 16 | The example uses `subscribeToAllTables()` | It works, but pulls about 6M history rows | bot-guide:105 |

---

## 14. Running the official module in-process for parity tests

This section is analysis only. Nothing here was run.

**Mechanism** (`spacetimedb/src/tests/harness.ts`, SDK `server/test-utils`):
- `createModuleTestHarness(schemaDefault, moduleExports)`, where `moduleExports = import * as from index.ts`.
- It needs Vitest with `spacetimedbModuleTestPlugin()`, which inlines the SDK and stubs `spacetime:sys`, plus a `.txt` loader for the wordlist (`spacetimedb/vitest.config.ts:7-25`).
- The datastore is SpacetimeDB's **portable datastore compiled to WASM** (`test-utils/default_wasm_runtime.ts`). It is real datastore code, so index-order semantics should match the host. This is plausible but **unverified**.
- **Transactions:** `test.withReducerTx(auth, ctx => reducer(ctx, args))`. Use `TestAuth.internal()` for scheduler and admin-less module calls; it acts as `moduleIdentity`, so `requireScheduler` passes. Use `TestAuth.fromJwtPayload(JSON.stringify({iss, sub}), new ConnectionId(n))` for clients (`harness.ts:76-105`).
- **Bots:**
  - Either use the full team flow: `createTeam`, then `mintCredentialNonce`, then `claimCredential` (`harness.ts:130-142`).
  - Or write rows directly through `test.db.bot.insert` and `test.db.botCredential.insert({identity: identityFromClaims(iss, sub), ...})`.
  - Sims are available after `init`.
- **Start a match:** `internal(test, tx => startMatchWith(tx, {tag:'Vickrey'}, ids))` (`harness.ts:174-184`). Or `joinLobby` plus `lobbyTimeoutTick(tx, {job: {scheduledId: 0n, scheduledAt: ScheduleAt.time(..), lobbyId}})`.
- **Inject bids and words:** `call(test, name, tx => submitBid(tx, {auctionId, amount}))` and `submitWord(...)`. The window check uses `test.clock.now()`.
- **Close auctions:** nothing fires automatically. Call `test.clock.advance(...)`, then `internal(test, tx => auctionTick(tx, {job: {scheduledId: 0n, scheduledAt: ScheduleAt.time(x), matchId}}))` (`harness.ts:248-285`, `runToEnd`).
- **Inspection:** `test.db.*` exposes private tables (`holding`, `pendingBid`, `bagLetter`, `auctionTopBid`). Views are called as functions: `myRack(test.viewContext(auth))`, `openLobbies(test.anonymousViewContext())`.

**Limits:**
- **The RNG is not host-equivalent.** The harness seeds each transaction from its own stream: `makeRandomFromSeed(test.rng[nextSeed]())` (`test-utils/index.ts:294`). Runs are deterministic for a given `rngSeed` or `test.rng.setSeed(x)`, but they do not use the timestamp.
  - To get host parity, pass the reducer a `Proxy` of `ctx` whose `random.integerInRange` is our timestamp-seeded RNG. The module only uses `ctx.random.integerInRange`. Then set `test.clock` to the historical timestamps.
- No scheduler, no real `senderAuth` (DEVELOP:352-354), and no network, latency or concurrency.
- The clock is frozen unless advanced. Every transaction at the same µs shares a seed in host mode.
- Global page and slot state from other concurrent matches is absent. The per-key order model (4.3) does not depend on it; this is verified on later all-sim matches.
- Running it requires installing the official module's dependencies and executing third-party code. That is a Phase 5 decision; it was forbidden during research.

**Recommendation:** use **historical replays against the live server** as the parity oracle (section 4.4). They are stronger than the harness because they are the real host. Use the harness only for a local E2E of the client against the real reducers. Phase 5 also needs a local `spacetime start` server, which uses the real scheduler.

---

## 15. Simulator implementation checklist (to reproduce the server exactly)

1. The bag, values and multipliers are exactly as in section 2. Reward = `floor(base*num/den)`, and it is added to both balance and score.
2. Roster order:
   - Lobby: real bots in lobby-member order, then the sims in shuffled order.
   - Tournament: shuffled entries (round 1) or standings order, sliced into tables.
   - Deal per participant in roster order, then the first letter.
3. RNG exactly as in 4.1. Consumption order exactly as in 4.2. The lobby shuffle happens over **all** available sims (S−1 calls), even when fewer are needed.
4. Sims bid only at open (jitter order per 4.3), only when `amount > 0`, and are capped by balance. A sim plays one longest ≥3-letter word, the lexicographically first, **only right after winning**, inside the close and before the next draw.
5. Close: filter amounts above 0, shuffle (using the committed bid order per 4.3), stable-sort descending, Vickrey/FirstPrice price, reserve 1. The letter is consumed if there is no bid. Next draw, then end when the bag is empty. Real bots cannot use the final letter.
6. `submit_bid` and `submit_word` validation and error strings exactly as in 7.2 and 9. Bids must arrive before `closes_at` in server time. Model bid latency, and the 0.3–3.3 ms close delay (default 1.5 ms).
7. Read P, rack size, auction duration and auction type from the match. Never hardcode 6, 5 or 1000.
8. Ratings: PL with shared places (section 10). Tournament scoring per section 11.
9. **Runtime self-check:**
   - At every match start, compute the first letter and compare it with `auction.letter`.
   - At every close, check that some candidate n reproduces the new letter.
   - If either check fails, set `rngModelValid = false` and fall back to probabilistic inference. The cause could be an SDK upgrade, an admin who spawned extra sims (which changes S), or a datastore change.

---

## 16. Open questions

- **Policy (needs a user or organizer decision):**
  - Reading `visible_auction_top_bids` through a second anonymous identity exploits an acknowledged bug (PR #16's own description).
  - Predicting the RNG uses only public data, but it exploits an implementation weakness.
  - Recommendation: treat both as a **threat model** (assume rivals do it). Do not ship the leak-snooping. Decide explicitly whether to ship RNG-based deal and sim-bid inference.
- Do 2.12 server subscriptions accept range predicates (`auction WHERE id > X`) and semijoins? The SDK query builder exposes `gt/gte/lt/lte/and/or/not/leftSemijoin/rightSemijoin` (`sdk/lib/query.ts`). Verify against maincloud in Phase 2 (CLI-02).
- Is the reducer timestamp taken when the call is received or when it starts executing? Under load this decides whether queued bids miss the window. Measure in shadow mode.
- Does maincloud rate-limit reducer calls or connections? Unknown.
- The swap_remove model for `pending_bid` with real-bot **replacements** is inferred from the same datastore behaviour. It is only directly verified for sim-only bid sets.
- What will the next event's tournament configuration be (match size, FirstPrice or not, rack size, auction length)? Unknown. Admins can change all of these.
