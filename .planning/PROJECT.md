# scrabbleBawt

## What This Is

A competition bot for **ScrabbleBot** (clockworklabs/scrabblebot), the Scrabble-style sealed-bid letter-auction game for AI bots that runs on SpacetimeDB maincloud (`scrabblebot`). The bot bids on one letter per second, spells ENABLE-dictionary words for currency and score, and must outplay the strongest bots on the public leaderboard (LUCENT, Bron, maverick-bot, Lionel, ...) in lobby matches and tournaments while staying robust to simple tricks. The repo is the user's public GitHub submission for the challenge.

## Core Value

Win matches: maximize final placement against strong real bots (tournament tables) and sim-padded lobbies, with zero self-inflicted losses (missed bids, unplayed letters, rejected words, crashes).

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Exact-rules engine: dictionary, scoring, word finding, optimal word packing (fast enough for Monte Carlo inside a 1 s auction)
- [ ] Deterministic simulator that mirrors the server rules + sim bots exactly, with a parallel tournament/benchmark harness and statistics
- [ ] Historical-data pipeline over the live database (25.6k matches): validation tests, opponent priors, counterfactual replays
- [ ] Live SpacetimeDB client: targeted subscriptions, latency-aware anytime bidding, safe word flushing, reconnect, lobby/tournament handling, shadow mode, local-server E2E
- [ ] Strategy "Bawt": opponent bid models, MC marginal letter valuation, budget-paced Vickrey + first-price shading, word-cashing policy, endgame planner, denial, trick defenses
- [ ] Opponent zoo: server sims, starter, community-bot clones, historical clones of top bots, trick bots
- [ ] Tuning + iteration loop with paired-seed benchmarks and loss analysis until improvements plateau
- [ ] README with strategy, usage, and measured statistics; pushed public repo without secrets

### Out of Scope

- Exploiting the `visible_auction_top_bids` spectator leak via a second anonymous connection — violates the intended visibility rules; we defend against rivals doing it instead
- Modifying the official game module or the live server — we only compete through the public reducer interface
- Web UI / dashboard for the bot — headless bot; stats live in reports
- Non-TypeScript implementations — only Node 24 + Python are available; one language keeps sim and live code identical

## Context

- Game rules verified from the official module source (`clockworklabs/scrabblebot`, TypeScript module, SDK 2.12.0). Key edges: unbid tiles are consumed; the final auction's letter is unusable by real bots; bids are capped at the current balance; ties are random; all balances and scores are public; opponents' starting racks (5 tiles) are hidden until played.
- Live DB is readable anonymously over HTTP SQL: ~25.6k matches, 1.74M auction results, 1.74M archived top bids, 402k word plays — this is the "historical scrabble bot data".
- Top leaderboard bots average 125–136 points per match with ~40% win rates in mostly sim-padded lobbies; one Vickrey tournament has been played (match size 6).
- Research lives in `.planning/research/` (RULES, PITFALLS, COMPETITORS, HISTORICAL, STACK, STRATEGY, FEATURES, ARCHITECTURE, SUMMARY).

## Constraints

- **Tech stack**: TypeScript on Node 24, `spacetimedb` SDK 2.12.0, spacetime CLI 2.12.0 for local E2E — matches the official module's pinned versions.
- **Performance**: a decision must complete in ~250 ms (1 s auction minus network latency and safety margin); configurable auction length can be as short as 250 ms.
- **Security**: bot token only via env / git-ignored files; never committed or logged.
- **Fair play**: only the public reducer API and intended-visible data; no exploitation of server bugs or visibility leaks.
- **Determinism**: all strategy/sim code seeded; no `Math.random()` in decision code.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Single `Policy` interface shared by simulator and live client | What we measure is what we ship | — Pending |
| TypeScript only | Only Node available; identical code paths sim/live | — Pending |
| Strict per-directory ownership for parallel agents | Clean commits, no merge conflicts | — Pending |
| Per-phase git branches merged into main, pushed after verification | User asked for clean history + periodic pushes | — Pending |
| Defend against (not exploit) the spectator top-bid leak | Fair play; assume rivals may see our winning bids live | — Pending |
| Live token supplied by the user via git-ignored .env (present since 2026-11-07, chmod 600) | Needs user's spacetimedb.com login | — Pending |
| Do NOT exploit the timestamp-seeded server RNG (RULES.md §4: hidden deals + sim jitters computable) — treat it as a threat model only | Reading private state through an implementation weakness is not fair play; assume rivals may know our 5 hidden tiles and sims' exact bids | — Pending |
| Simulator uses independent seeded streams (bag/draws, sim jitter, tie-breaks) instead of the host RNG | Distributionally identical; gives perfectly paired letter sequences across policy variants for low-variance tuning | — Pending |
| Tournament-phase-aware objectives (Swiss: placement points; Bracket: avoid last place; Final: 3-game score sum) | RULES.md §11: objectives differ by phase | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-11-07 after initialization*
