---
phase: 02-infrastructure-simulator-history-live-client
verified: 2026-11-07T15:58:00Z
status: human_needed
score: 11/14 must-haves verified (3 uncertain, 0 failed)
overrides_applied: 0
gaps: []
human_verification:
  - test: "Re-run full-dataset validation: NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/history-validate.ts --data data/history (after scripts/history-fetch.ts --all)"
    expected: "TOTAL mismatches: 0 over about 25.6k complete matches (summary: 402,308 words, 153,572 seats, 1.74M auctions)"
    why_human: "data/history/ is git-ignored and not on disk. A re-fetch hits maincloud HTTP SQL, which this verification was told not to touch."
  - test: "Shadow mode on maincloud: npx tsx scripts/client-shadow.ts --full-only (anonymous)"
    expected: "At least 1 full live match observed with 0 reducer calls. Latency stats printed. The JSONL log replays with all diagnostics 0 and replay == live."
    why_human: "Live maincloud spectating is out of scope for this verifier. No run logs survive (runs/ is git-ignored and gone)."
  - test: "Local E2E: bash e2e/setup-local.sh && npx tsx e2e/provision.ts --bots 6 && npx tsx e2e/run-local.ts --matches 3 && npx tsx e2e/run-local.ts --matches 1 --kill-one; then setup-local.sh --stop"
    expected: "E2E OK on both runs: 0 timing errors, 0 rejected calls, all diagnostics 0, client scores == server, pooled anchor p99 <= 30 ms, killed client resumes and finishes"
    why_human: "The verifier was told not to run the local server. No summary.json artifacts survive."
---

# Phase 2: Infrastructure (Simulator, History, Live Client) Verification Report

**Phase Goal:** Everything needed to measure and to play: a rules-exact parallel simulator with baselines and stats, the historical dataset with validation and priors, and a working live client with shadow mode and a local-server E2E harness.
**Verified:** 2026-11-07, at commit dafa4e9 in a scratch worktree (now removed)
**Status:** human_needed
**Re-verification:** No (initial verification)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | SC1: `npm run bench` plays ≥1000 six-player matches in <5 min with paired seeds and prints win%/rank/score/CI/OpenSkill | ✓ VERIFIED | Lineup `starter,greedy,hoarder,random,sim:Aggressive,sim:ValueBidder`, 1000 matches, 8 workers: `wallMs=2582`, real 2.95 s. The table has Wilson CI, rank, score, margin and OpenSkill columns. `--compare greedy,starter --template "*,sim:..."` printed the paired delta table with 95% CIs and a sign test (+299/−1). A test asserts workers 0/1/4 give byte-identical results. |
| 2a | SC2 (sample): validation reproduces every word reward and participant score with 0 mismatches | ✓ VERIFIED | `scripts/history-validate.ts --data data/history-sample`: 297 matches (296 complete, 1 excluded), 23 checks, TOTAL 0, exit 0. Independent corruption test: one `total_reward` +1 in a copy gave word.reward=1, score.sum=1, balance.identity=1, TOTAL 10 (the check bites). |
| 2b | SC2 (full fetched dataset): 0 mismatches | ? UNCERTAIN | Full dump is not on disk and re-fetching touches maincloud. Supporting evidence: `data/profiles.json` `generatedFrom` records matches 25598, complete 25597, id range 1–42655, consistent with a full-dump run. |
| 2c | SC2: `data/profiles.json` exists for the top bots | ✓ VERIFIED | schemaVersion, 93 bots including Bron, LUCENT, Waupus, K-13, Lionel, Nijello and maverick-bot. Each has bidCurves, regression, caps, penultimate, words, timing and results. Market priors are included. A profile test rebuilds deterministically from the sample. |
| 3a | SC3: shadow mode spectates a live maincloud match end-to-end and reports latency | ? UNCERTAIN | The code is real: `src/client/shadow.ts` (847 lines). GhostObserver has no reducer host and never imports callReducer. `shadowQueries` = perMatchQueries + bot, checked with assertQueriesAllowed. Fake-server tests pass, including a full match and mid-match joins after 17/40/77 closes, with 0 diagnostics and replay == live. The live run was not re-executed. |
| 3b | SC3: the local-server harness completes a full match with our client bot, including kill-and-resume (CLI-07) | ? UNCERTAIN | The harness is real. `e2e/setup-local.sh` pins CLI 2.12.0 (binary present), module b5ccb36, an isolated `--config-path`, `--no-config`, and loopback 127.0.0.1:3100. `e2e/run-local.ts` (446 lines) has requireLoopback, asserts ALLOW_MAINCLOUD_PLAY is absent from the child env, does a SIGKILL plus same-token restart, and gates on timing errors, diagnostics, server scores and pooled p99. Not executed here. |
| 4 | SIM-01: simulator implements the server rules exactly | ✓ VERIFIED | `closeAuction`: filters bids >0, module shuffle, stable sort, Vickrey `second ?? min(1,top)`, FirstPrice top, balance check. `drawLetter` uses alphabetical-index draws. A sim word is played only after a sim win. match.test covers unbid letters consumed, the final letter unusable by policies, exact simBid and malformed-bid rejection (18 tests pass). |
| 5 | SIM-04: parity with the official module logic | ✓ VERIFIED | hostParity.test: 65 tests pass. 61 all-sim matches are bit-exact through the same `runMatchCore` (hostReplay imports it and does not loop on its own). hostReplay inputs are only startedAt, roster and closedAt; outcomes are not leaked. Independent cross-check: fixture matches 1/13/25/37/49 vs the committed `data/history-sample` auction_result and match_participant gave 68/68 auctions with 0 mismatches and equal finals for all 5. |
| 6 | SIM-03: stats include Wilson CIs, OpenSkill PL, JSON and markdown output | ✓ VERIFIED | Bench printed the markdown table. `--json` wrote the file. stats.test (7) passes. The analytic sim-distribution test passes for all 26 letters (chi² p 0.078–0.974). |
| 7 | HIST-04: counterfactual replay runs any Policy in a historical seat | ✓ VERIFIED | `history-replay --policy mimic --target Bron --tie-mode historical` on the sample: 155/155 exact score matches, 0 rejections, 0 diagnostics. `--policy greedy` (from the registry) gave win 0.6% vs 39.4% original, with Wilson CIs. replay.test (9) passes. |
| 8 | HIST-01: resumable chunked fetch to NDJSON | ✓ VERIFIED (offline) | fetch.test (11) uses a mocked fetch: resume after HTTP 400 plus a garbage tail, the view is refused with 0 network calls, and the token never appears in logs. Not exercised against the network here. |
| 9 | Maincloud guard / CLI-01 token safety: npm start refuses non-loopback hosts before connecting | ✓ VERIFIED | Ran `npx tsx src/client/main.ts` with `STDB_HOST=wss://nohost.invalid` and an empty ENV_FILE. Output "read-only: refusing to play", exit 3. client.jsonl does not contain the token. Guard is default-deny (`isGameReducer` plus an empty safe set). No `.reducers.` access outside guard.ts or the bindings. |
| 10 | CLI-02: targeted subscriptions only, never the leak view | ✓ VERIFIED | grep finds no subscribeToAllTables in src, scripts or e2e. `visible_auction_top_bids` appears only on FORBIDDEN or refuse lines. subscriptions.test (6) includes a source scan. |
| 11 | CLI-01/03/04/05: lifecycle, anytime bids before the deadline, final flush and retry, resume | ✓ VERIFIED (fake server) | session.test covers join, rejoin after Ended, MAX_MATCHES, NO_LADDER, TOURNAMENT_ID auto/id, boot resume and reconnect rebuild. adapter.test covers anchor plus refine, no submit after deadlineFor, late-delivery deadline, final-auction words-first plus re-plan plus packer flush, and the Insufficient-balance retry. resume.test covers rebuild deep-equal and the 0-bid resubmit. All pass. |
| 12 | ZOO-01: exact starter replica plus greedy variants | ✓ VERIFIED | `src/bots/baselines/starter.ts` uses the bid `min(have==0 ? value+2 : max(1,value), balance)` on every auction. It attempts a word only after the deal or its own win, via `findBestPlayable(rack,2)`. greedy, hoarder and random are registered. baselines.test passes. |

**Score:** 11/14 verified, 3 uncertain (2b, 3a, 3b), 0 failed.

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| src/sim/{match,tournament,stats,cli,worker,rngStreams,hostRng,hostReplay}.ts | ✓ VERIFIED | Substantive (79–577 lines each). Used by bench, tests and history replay. |
| src/bots/registry.ts, src/bots/baselines/* | ✓ VERIFIED | Used by bench, history-replay and main.ts. The bawt, clones and tricks entries are empty maps on purpose; Phase 3 fills them. |
| src/history/{fetch,sql,load,validate,km,profiles,replay,mimic,stats}.ts, scripts/history-*.ts | ✓ VERIFIED | Wired to the CLIs and tests. |
| data/history-sample/*.ndjson.gz (9), data/profiles.json | ✓ VERIFIED | Sample validates. 93 profiles. |
| src/client/{config,guard,connection,clock,log,subscriptions,adapter,words,session,main,shadow}.ts | ✓ VERIFIED | `npm start` reaches runSession through main.ts. The shadow CLI and whoami scripts exist. |
| e2e/{setup-local.sh,provision.ts,run-local.ts,lib.ts,README.md,patches/seed-admin.patch} | ✓ EXISTS / substantive | Not executed (see human items). |
| test/fixtures/allsim/matches.json | ✓ VERIFIED | Matches the committed sample (cross-check above). |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| hostReplay | runMatchCore | direct import; the only match loop | WIRED |
| bench CLI | tournament worker pool, stats | `npm run bench` uses src/sim/cli.ts | WIRED (ran) |
| history-replay | bots/registry | dynamic import, greedy resolved | WIRED (ran) |
| main.ts | registry, then runSession, then guard.callReducer | SessionCore.call uses callReducer | WIRED (refusal ran) |
| shadow GhostObserver | reducers | none by design | correctly NOT wired |
| run-local | npm start children | explicit env plus requireLoopback | WIRED (static) |

### Data-Flow Trace (Level 4)

| Artifact | Source | Real data | Status |
|----------|--------|-----------|--------|
| bench table | runMatch results aggregated in seed order | yes (1000 simulated matches) | ✓ FLOWING |
| validate report | loadMatches(data/history-sample) | yes (297 matches; reacts to injected corruption) | ✓ FLOWING |
| replay report | loadMatches plus a registry policy | yes | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Test suite | `npx vitest run` | 27 files, 322 tests, all pass (11.9 s) | ✓ PASS |
| Typecheck | `npx tsc --noEmit` | exit 0 | ✓ PASS |
| Bench, 1000 six-player matches | `npm run bench -- --lineup ... --matches 1000 --workers 8 --seed 7` | wallMs=2582 | ✓ PASS |
| Paired compare | `npm run bench -- --compare greedy,starter --template "*,sim:Aggressive,..."` | delta table with CIs; sign test p=2.96e-88 | ✓ PASS |
| Host parity | `npx vitest run test/sim/hostParity.test.ts` | 65/65 | ✓ PASS |
| Sample validation | `npx tsx scripts/history-validate.ts --data data/history-sample` | TOTAL mismatches 0, exit 0 | ✓ PASS |
| Validation catches corruption | reward +1 in a copied sample | TOTAL 10 mismatches | ✓ PASS |
| Replay mimic | `history-replay --policy mimic --target Bron --tie-mode historical` | 155/155 exact | ✓ PASS |
| Read-only refusal | main.ts with a non-loopback host | "read-only: refusing to play", exit 3, token not logged | ✓ PASS |
| Live shadow / local E2E | not run (constraint) | n/a | ? SKIP |

### Probe Execution

None declared. No `scripts/*/tests/probe-*.sh` exist. SKIPPED.

### Requirements Coverage

| Req | Plan | Status | Evidence |
|-----|------|--------|----------|
| SIM-01 | 02-01 | ✓ SATISFIED | Truth 4 |
| SIM-02 | 02-01 | ✓ SATISFIED | Truth 1 (worker_threads, paired seeds, 2.6 s per 1000) |
| SIM-03 | 02-01 | ✓ SATISFIED | Truth 6 |
| SIM-04 | 02-01 | ✓ SATISFIED | Truth 5 |
| HIST-01 | 02-02 | ✓ SATISFIED (offline tests) | Truth 8 |
| HIST-02 | 02-02 | ✓ SATISFIED on the sample; full dump ? NEEDS HUMAN | Truths 2a, 2b |
| HIST-03 | 02-02 | ✓ SATISFIED | Truth 2c |
| HIST-04 | 02-02 | ✓ SATISFIED | Truth 9 |
| CLI-01 | 02-03/04 | ✓ SATISFIED (unit); live ? NEEDS HUMAN | Truths 9, 11 |
| CLI-02 | 02-03 | ✓ SATISFIED | Truth 10 |
| CLI-03 | 02-03 | ✓ SATISFIED (fake server) | Truth 11 |
| CLI-04 | 02-03 | ✓ SATISFIED (fake server) | Truth 11 |
| CLI-05 | 02-03/04 | ✓ SATISFIED (fake server); live kill-resume ? NEEDS HUMAN | Truths 11, 3b |
| CLI-06 | 02-04 | ? NEEDS HUMAN (code and fake tests verified) | Truth 3a |
| CLI-07 | 02-04 | ? NEEDS HUMAN (harness present) | Truth 3b |
| ZOO-01 | 02-01 | ✓ SATISFIED | Truth 12 |

No orphaned requirements. All 16 IDs are claimed by the plans' `requirements:` frontmatter.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| e2e/setup-local.sh | 28 | `OFFICIAL_SRC` defaults to a session scratchpad path (`/private/tmp/claude-501/.../scratchpad/ref/official`) | ⚠️ Warning | Not portable. It falls back to `git clone https://github.com/clockworklabs/scrabblebot.git` at b5ccb36, so nothing breaks, but an ephemeral agent path is baked into the repo. |
| src/sim/cli.ts | — | `--template` has no named presets ("lobby" errors: "needs exactly one '*'") | ℹ️ Info | The 02-01 summary's wording "lobby template" implies a preset. The literal `*,sim:...` template works. |
| src/bots/baselines/hoarder.ts | — | decide max 390 ms in the bench (packExact on large racks); overruns the 15 ms anchor budget in E2E | ℹ️ Info | Already noted for 03-02. Baseline only. |
| src/client/clock.ts | — | at 250 ms auctions, the snapshot-delivered first auction is always skipped | ℹ️ Info | Already noted for Phase 5. |

No TBD, FIXME, XXX, TODO or HACK markers in the phase files. No JWT-shaped strings or real `BOT_TOKEN=` values are committed. `.gitignore` covers `.env`, `.token-*`, `.cache/`, `runs/` and `data/history/`.

### Human Verification Required

#### 1. Full-dataset historical validation
**Test:** Fetch the full dump (`npx tsx scripts/history-fetch.ts --all`), then run `NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/history-validate.ts --data data/history`.
**Expected:** TOTAL mismatches 0. Exactly 1 match excluded as incomplete.
**Why human:** The full dump is not on disk, and fetching it touches maincloud.

#### 2. Shadow mode on maincloud
**Test:** Run `npx tsx scripts/client-shadow.ts --full-only`.
**Expected:** At least 1 full match observed anonymously. Latency p50/p90/p99 printed. 0 reducer calls. Replay diagnostics 0/0/0/0 and replay == live.
**Why human:** Live external service. No surviving run logs.

#### 3. Local official-module E2E, including kill-and-resume
**Test:** Run `bash e2e/setup-local.sh && npx tsx e2e/provision.ts --bots 6 && npx tsx e2e/run-local.ts --matches 3 && npx tsx e2e/run-local.ts --matches 1 --kill-one`, then `bash e2e/setup-local.sh --stop`.
**Expected:** "E2E OK" on both runs. 0 timing errors and 0 rejections. Client scores equal the server's. Pooled anchor p99 ≤ 30 ms. The killed client logs "resumed from snapshot" and finishes.
**Why human:** This verifier was told not to start the local server.

### Gaps Summary

No blocker gaps. Everything that can be checked offline passes and was re-checked independently:
- the simulator rules and timing;
- host-RNG parity, with fixtures cross-checked against the committed history sample;
- paired comparison and stats;
- sample validation, including a corruption check showing it catches errors;
- profiles and the counterfactual replay;
- the client guard, refusal path, subscriptions, deadlines, flush and resume against the fake server.

Three claims rest only on the executor's measured runs: the full-dataset validation, live maincloud shadow, and local official-module E2E. Their run artifacts were not kept (`runs/` and `data/history/` are git-ignored and absent). They need a human re-run, or explicit acceptance, before the phase counts as passed. There is one portability warning: a hardcoded scratchpad path in `e2e/setup-local.sh`, which has a working clone fallback.

---
_Verified: 2026-11-07T15:58:00Z_
_Verifier: Claude (gsd-verifier)_
