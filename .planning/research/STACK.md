# Technology Stack

**Project:** scrabbleBawt, a competitive bot for ScrabbleBot (SpacetimeDB maincloud, database `scrabblebot`)
**Researched:** 2026-11-07
**Scope:** client runtime, `spacetimedb` SDK 2.12 usage, subscriptions, reducer semantics, latency and clock design, local dev toolchain, and test and simulation tooling.
**Overall confidence:** HIGH. SDK behavior comes from reading the published `spacetimedb@2.12.0` tarball source; its shasum matches the registry. The live schema was fetched and diffed against the vendored bindings. Timing numbers come from 115k historical auctions. Each claim below is labeled where confidence is lower.

Source abbreviations:
- `sdk/...` is `spacetimedb@2.12.0/src/...`.
- `mod/...` is `clockworklabs/scrabblebot@b5ccb36/spacetimedb/src/...`.
- `starter/...` is `bot-starter/src/...`.
- `site/...` is the upstream `src/...`.
- `bind/...` is the upstream `src/module_bindings/...`.

---

## 0. Prescriptive summary

1. **Runtime.** Node 24 (24.18.0 is installed). Use TypeScript 5.9.3 for type-checking only. Depend on **`spacetimedb@2.12.0` exactly**. Do not add `ws` or `undici`, because Node 24 has a global `WebSocket`.
2. **Tooling.** Run with **tsx 4.23.15**. Test with **vitest 3.2.7**. Run parallel simulations on `node:worker_threads`. Node's native type-stripping works inside workers; this was verified locally.
3. **Bindings.** Copy the upstream generated bindings **verbatim** into `src/client/module_bindings/`. They come from upstream commit `b5ccb36` and CLI 2.12.0 @ `2f8905d`. They match the live schema column for column (checked via `GET /v1/database/scrabblebot/schema?version=9`). Add a startup schema-drift guard.
4. **Connection.** Use `withCompression('none')`, `withConfirmedReads(false)` and `withAutomaticReconnect({minDelayMs:500, maxDelayMs:4000})`. Add an outer supervisor and an in-match liveness watchdog. Persist the token; it never expires.
5. **Subscriptions.** Never call `subscribeToAllTables`. Use one global set, one "my matches" set and one per-match set (§5). Keep our own state store fed by row callbacks. SDK cache index lookups are full table scans.
6. **Bidding.** Send a provisional bid as soon as an auction row arrives. Refine it until a computed deadline. The server accepts a bid iff the **reducer start time** is `< closes_at` (`mod/index.ts:797-802`).
7. **Clock.** Estimate the offset with interval intersection: downlink receipt time minus `opens_at`/`closed_at`/`played_at`, uplink from our own `word_play.played_at`, plus RTT from reducer promises (§7).
8. **Determinism (critical).** `ctx.random` is seeded from the reducer timestamp in µs. So every participant's hidden starting rack can be recomputed from public rows. This was validated on **25,546 of 25,546** complete lobby matches and 51 of 51 tournament matches (§8; full model in RULES.md §4). Use it for simulator fidelity, and assume rivals can see our rack. **Whether to use it live is the user's call.**
9. **Hosting.** maincloud resolves to `131.153.201.171` and `125.253.87.9`, both in **Ashburn, VA**. RTT from the dev Mac is about **38–40 ms**. Run tournament play from a us-east (N. Virginia) VM for about 1–2 ms RTT and no laptop sleep.

---

## 1. Recommended stack

### Core runtime
| Technology | Version | Purpose | Why |
|---|---|---|---|
| Node.js | **24.18.0** (installed), engines `>=24.18.0 <25` | Runtime | Verified locally. Global `WebSocket` is undici 7.28.0 and sets `socket.setNoDelay(true)`, so there is no Nagle delay. `fetch`, `DecompressionStream` and `performance.timeOrigin` are present. `process.features.typescript === 'strip'`, so `.ts` files and `.ts` workers run without flags. 10 cores (`os.availableParallelism()`). |
| `spacetimedb` (npm) | **2.12.0** (exact pin) | Client SDK, typed query builder, module test harness (dev) | It is the version the bindings were generated with (`bind/index.ts:4`, `REMOTE_MODULE.versionInfo.cliVersion "2.12.0"` at `bind/index.ts:520-523`) and that the deployed module locks. 2.14.1 ships an **identical client runtime**: `db_connection_impl.ts`, `db_connection_builder.ts`, `table_cache.ts` and `ws.ts` are byte-identical per a 2.12.0-vs-2.14.1 tarball diff. 2.13.0 was not diffed separately. Upgrading gains nothing. **2.14.1 declares `engines.node ^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1`**, which our 24.18.0 fails. A `^2.12.0` range resolves to 2.14.1 today, so pin exactly. |
| TypeScript | **5.9.3** | `tsc --noEmit` type-check | All three upstream lockfiles use 5.9.3. TS 6 and 7 (7.0.2 is the native port) are not validated against these bindings. |
| tsx | **4.23.15** | Runs the bot, scripts and simulations | Resolves the bindings' **extensionless** relative imports (`bind/index.ts:37-97`). Plain `node` fails on them; see gotcha G11. The official starter uses tsx (4.22.3 locked). |

### Test, simulation, analysis
| Library | Version | Purpose | When |
|---|---|---|---|
| vitest | **3.2.7** | Unit tests and the module-fidelity project | Version locked by the module's own test suite (`spacetimedb/package-lock.json`). It works with the SDK's `spacetimedbModuleTestPlugin` (`sdk/server/test-utils/vitest.ts`). Upstream root runs the same tests under vitest 5.0.5, so 5.x is a fallback. |
| @noble/hashes | **2.4.0** (dev) | Needed only by the vendored module's `identity.ts` (blake3) | Fidelity tests that import the official module. |
| `node:worker_threads` | built-in | Parallel simulation (9 workers on this machine) and an off-thread "deep think" worker for the live bot | Always. Keep engine code free of SDK imports so workers stay light. |
| `node:perf_hooks` | built-in | `monitorEventLoopDelay` for latency SLOs; `performance.now()` monotonic clock | Live bot and latency tests. |
| @types/node | 24.19.2 | Node types | Dev. |

### Infrastructure
| Technology | Version | Purpose | Notes |
|---|---|---|---|
| `spacetime` CLI | **2.12.0** | Local server (`spacetime start`), local publish, `generate`, `logs`, `sql` | Install with the official script, then `spacetime version install 2.12.0 --use` (§10). The Homebrew tap `clockworklabs/homebrew-tap` is **archived** (GitHub API: `archived: true`, last push 2026-03-19). Do not use brew. |
| maincloud | server-side | Production | Host type `Js` (V8). Owner identity `c200dd4e…` (Tyler, `mod/game.ts:82-85`). |
| VM in us-east (N. Virginia) | — | Tournament runs | It sits next to maincloud (Ashburn). Run `caffeinate -dimsu` if you must run from the Mac. |

### Explicitly NOT used
- **`ws` / `undici` packages.** The SDK uses the global `WebSocket` first (`sdk/sdk/ws.ts:3-27`). The starter's `ws` dependency is dead weight.
- **React/Vue/Svelte subpaths and `ConnectionManager`.** These are framework glue (`sdk/sdk/connection_manager.ts`).
- **`subscribeToAllTables`.** See §5 and gotcha G1.
- **`withTokenProvider`.** Our tokens have no `exp`, so `tokenNeedsRefresh()` would return true on every reconnect (`sdk/sdk/db_connection_impl.ts:245-264`).
- **`withLightMode`.** v2 `TransactionUpdate` already carries no caller metadata (`sdk/sdk/client_api/types.ts:303-308`), so no benefit is expected. Confidence: LOW.

## 2. Alternatives considered

| Category | Recommended | Alternative | Why not |
|---|---|---|---|
| SDK version | 2.12.0 exact | 2.14.1 (latest) | Identical client runtime. Engines constraint fails on Node 24.18. Version skew vs bindings and module. |
| TS execution | tsx | Native `node file.ts` (Node 24 strip-types) | The bindings' extensionless imports throw `ERR_MODULE_NOT_FOUND` (verified). It would need a codemod on every regeneration. Keep our own code `.ts`-extension-clean so native Node remains an option for workers. |
| TS execution | tsx | `tsc` emit then `node dist` | Emitted JS keeps extensionless imports and fails the same way. The starter's `"build": "tsc"` is broken for running. |
| Bundling | none | esbuild bundle | Only needed for a single-file deploy. esbuild 0.28 is already a transitive dependency of tsx. |
| Reconnect | SDK auto-reconnect + supervisor | Manual-only rebuild | Auto-reconnect keeps handles and callbacks, batch-replays subscriptions with cache reconciliation (`db_connection_impl.ts:1146-1232`) and fails in-flight calls cleanly. Manual-only is still needed for the initial connect and terminal failures. |
| Test runner | vitest 3.2.7 | node:test | The module-fidelity harness needs the Vite plugin (`spacetime:sys` stub, `.txt` loader). |
| Compression | `none` | `gzip` (SDK default, `db_connection_builder.ts:34`) | Every gzip frame goes through an async `DecompressionStream` pipeline (`websocket_decompress_adapter.ts:17-60`, `decompress.ts`). Our payloads are tiny. |
| Hosting | us-east VM | Dev laptop | RTT 38–40 ms vs about 1–2 ms. Wi-Fi drops and sleep kill sockets silently. |

## 3. Project setup (our repo)

The layout follows ARCHITECTURE.md; `src/client/` is the only directory that imports the SDK.

```
src/client/module_bindings/   # VERBATIM copy of upstream src/module_bindings (60 files, 272 KB). Never edit.
src/client/{connection,subscriptions,adapter,clock,main}.ts
src/core|engine|state|bots|sim|history/   # pure TS, no SDK imports (worker-safe)
vendor/scrabblebot/           # read-only snapshot of upstream @ b5ccb36aa238ad16692f8d6af54da15ef9f11324 (MIT)
  spacetimedb/{src/**,wordlist.txt,package.json,tsconfig.json,vitest.config.ts}
  UPSTREAM.md                 # commit, date (2026-10-24), license, how to refresh
data/wordlist.txt             # byte-identical copy of vendor/.../wordlist.txt (172,820 words)
e2e/                          # local-server harness (§10)
scripts/                      # tsx CLIs: schema-check, latency probes, history fetch
```

**`package.json`** (exact pins; `npm install --save-exact`):
```json
{
  "name": "scrabblebawt",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24.18.0 <25" },
  "scripts": {
    "bot": "tsx src/client/main.ts",
    "bench": "tsx src/sim/cli.ts",
    "test": "vitest run --project unit",
    "test:fidelity": "vitest run --project fidelity",
    "typecheck": "tsc -p tsconfig.json",
    "schema:check": "tsx scripts/schema-check.ts",
    "latency:readonly": "tsx scripts/latency/phase0-readonly.ts"
  },
  "dependencies": { "spacetimedb": "2.12.0" },
  "devDependencies": {
    "@noble/hashes": "2.4.0",
    "@types/node": "24.19.2",
    "tsx": "4.23.15",
    "typescript": "5.9.3",
    "vitest": "3.2.7"
  }
}
```
Add `.npmrc` containing `save-exact=true` and `engine-strict=true`. Commit `package-lock.json`. Add `.nvmrc` containing `24.18.0`.

**`tsconfig.json`**:
```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],   // DOM: WebSocket/CloseEvent/DecompressionStream types used by SDK d.ts and a custom WS factory
    "module": "ESNext",
    "moduleResolution": "Bundler",               // accepts both the bindings' extensionless imports and our ".ts" imports
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,                  // no enum/namespace/param-properties → our code also runs under native Node strip-types
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts", "e2e"],
  "exclude": ["vendor"]
}
```
Do **not** use `moduleResolution: NodeNext`. It rejects the extensionless imports in the bindings.

**`vitest.config.ts`** has two projects, mirroring upstream `vitest.config.ts`:
```ts
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';
const txt = { name: 'txt', enforce: 'pre' as const, load(id: string) {
  if (id.endsWith('.txt')) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`; } };
export default defineConfig({ test: { projects: [
  { test: { name: 'unit', include: ['test/**/*.test.ts'], environment: 'node' } },
  { plugins: [spacetimedbModuleTestPlugin() as any, txt],
    test: { name: 'fidelity', include: ['test/fidelity/**/*.test.ts'], environment: 'node' } },
] } });
```
The fidelity harness runs the **real module code** in-process on SpacetimeDB's datastore compiled to WASM (8.2 MB, `dist/server/test-utils/portable-datastore-wasm`). Its per-transaction RNG comes from `TestRng`, not from the timestamp (`sdk/server/test-utils/index.ts:294`). So the harness checks **rule semantics**: validation, scoring, Vickrey price, error strings. **Production RNG parity** is checked separately with golden tests replayed against history (§8).

**Vendoring the bindings.** Copy `src/module_bindings/**` from upstream @ `b5ccb36` unchanged. Upstream tracks them in git (`.gitignore`: "Web app's bindings are tracked so the production build doesn't need spacetime CLI"). Imports are `from "spacetimedb"` plus relative paths only. Regenerate only if upstream changes, with `spacetime generate --lang typescript --out-dir src/client/module_bindings --module-path vendor/scrabblebot/spacetimedb`. This needs `npm install --prefix vendor/scrabblebot/spacetimedb` and CLI 2.12.0.

**Schema-drift guard (`scripts/schema-check.ts`; also run at bot startup).** Fetch `GET https://maincloud.spacetimedb.com/v1/database/scrabblebot/schema?version=9`. No auth is needed; pass our token so no new identity is minted. Compare every public table's ordered `(name, type)` columns and every reducer's params against the bindings. Refuse to play on mismatch. Rows are decoded positionally from one contiguous BSATN buffer (`db_connection_impl.ts:1262-1300`), so an added column corrupts decoding silently. Upstream adds tables rather than columns for exactly this reason (`DEVELOP.md:124-126`, `mod/schema.ts:592-596`). Today's check passed, scripted with `schema_diff.py`. All 30 public relations (22 tables + 8 views) have identical ordered column names. All 27 client-callable reducers have identical parameters. The live module's other 7 reducers are lifecycle or scheduled (`init`, `client_connected`, `client_disconnected`, `auction_tick`, `lobby_timeout_tick`, `nonce_expiry_tick`, `invite_expiry_tick`) and are correctly absent from client bindings.

---

## 4. SDK 2.12 facts (verified in source)

### 4.1 Connection and lifecycle
- **Builder** (`sdk/sdk/db_connection_builder.ts`):
  - `withUri` (an `https:` URI is rewritten to `wss:` at `db_connection_impl.ts:564-567`).
  - `withDatabaseName`, `withToken(token?)`.
  - `withCompression('gzip'|'brotli'|'none')`, default **gzip** (`:34`).
  - `withLightMode`, `withConfirmedReads(bool)` (`:153`). The server default applies if unset. `false` means "results sent as soon as committed in memory".
  - `withAutomaticReconnect({minDelayMs, maxDelayMs})` (`:167-173`). Floors are 500 ms and 1 s (`db_connection_impl.ts:165-221`). Backoff is ×2 with ±50% jitter (`:231-242`).
  - `withTokenProvider`, `withWSFn(factory)` (`:96`).
  - `build()` throws if URI or DB is missing, or if `cliVersion < 1.4.0` (`:334-363`, `sdk/sdk/version.ts:115-129`).
- **Token flow.** If a token is given, the SDK first POSTs `v1/identity/websocket-token` with `Authorization: Bearer <token>`. It then opens `wss://…/v1/database/<db>/subscribe?token=<short-lived>&compression=…&connection_id=…[&session_id=…]` (`sdk/sdk/ws.ts:98-138`). A bad token raises `WebSocketTokenError("Failed to verify token: 401 …")` and reaches `onConnectError`. Without a token, the server mints an identity and token in `InitialConnection`, and the SDK keeps it (`db_connection_impl.ts:1647-1649`).
- **Tokens.** Our saved anonymous JWT has `iat` and no `exp`, so it **never expires**. Treat bot tokens as secrets. There is no revoke reducer (`TODO.md`).
- **Callbacks.**
  - `onConnect(conn, identity, token)` fires once, on the first `InitialConnection` (`:1656-1661`).
  - `onAutomaticReconnect` fires before subscription replay.
  - `onConnectError(ctx, err, nextAttempt?, delayMs?)`: initial failures are **never retried** (`:800-813`).
  - `onDisconnect(ctx, err?, nextAttempt?, delayMs?)`.
  - `nextAttempt === undefined` means the SDK will not retry.
- **In-flight calls on socket loss.**
  - *With* auto-reconnect: rejected with `UnknownCallResultError` (`:772`, `:872-882`). New calls while reconnecting reject immediately with `DisconnectedError` and are not queued (`:1480-1484`).
  - *Without* auto-reconnect: `handleLoss` only emits an event (`:681-695`). **Pending reducer promises never settle.** Always wrap calls in a timeout.
- **Message ordering.** Inbound frames are processed strictly in arrival order (`:1889-1919`). Protocols `[v3, v2]` are offered (`websocket_protocols.ts:5`). Under v3, same-tick sends are coalesced into one frame by a microtask flush, order preserved (`:1426-1478`). Docs guarantee responses come back in request order (`subscription-semantics.md`, "Sequential Response Ordering").
- **Logging.** `setGlobalLogLevel('warn')` is exported. It silences `"Connecting to SpacetimeDB WS..."` (`:559`).

### 4.2 Subscriptions
- **SQL subset.** Subscriptions accept `SELECT * | t.* FROM t [JOIN t2 ON a.c = b.c] [WHERE pred]`. `pred` is `AND`/`OR` of comparisons `= < > <= >= != <>`. Literals are INTEGER, STRING, HEX, TRUE, FALSE, FLOAT. There is no arithmetic, at most 2 tables, and **both join columns must be indexed**. Projection and LIMIT are not allowed (SQL reference v2.12.0 "Subscriptions").
- **Enums are not filterable.** `status`, `auction_type` and `strategy` cannot appear in WHERE (`mod/index.ts:139-141`; no sum-type literals in the grammar). This is why `open_lobbies` and `open_lobby_members` exist.
- **Typed builder** (`sdk/lib/query.ts`):
  - `tables.<t>.where(r => r.col.eq|ne|lt|lte|gt|gte(v))`, combined with `.and()`, `.or()`, `.not()`.
  - Function forms `and/or/not` are exported from **`'spacetimedb'`**. The docs wrongly say from `./module_bindings`.
  - Literal types are string, number, bigint, boolean, Identity, Uuid, Timestamp, ConnectionId (`:678-686`).
  - Rendering (`:909-936`): `Identity` becomes `0x<hex>` and `Timestamp` becomes `'<ISO µs>'`.
  - Semijoins: `leftSemijoin`/`rightSemijoin` with a WHERE allowed on both sides (`:136-160`). A self-join throws (`:115-118`).
  - u64 columns need **bigint** literals (`r.matchId.eq(5n)`).
  - Timestamp-vs-string comparison is emitted by the builder but not documented. Confidence: LOW, and we do not need it.
- **Views** subscribe like tables ("Views can be queried and subscribed to just like normal tables using SQL", views.md).
  - `my_rack` is per-sender. It returns the caller's holdings across **all matches ever played** (`mod/index.ts:72-82`). Leftover holdings are never deleted; only `playWord` deletes, at `mod/game.ts:704`. So it grows with history. Filter it with `WHERE match_id = M`; confidence that the view accepts WHERE: MEDIUM (verify in Phase 0, §11).
  - `open_lobbies` and `open_lobby_members` are anonymous and shared.
  - `visible_auction_top_bids` returns `[]` to bot identities (`mod/index.ts:124-126`).
- **Lifecycle.**
  - `subscriptionBuilder().onApplied(ctx=>…).onError(ctx=>…).subscribe(q | q[])` returns a `SubscriptionHandle` with `isActive`, `isEnded`, `unsubscribe` and `unsubscribeThen(cb)` (`sdk/sdk/subscription_builder_impl.ts`).
  - The **`onError` callback is typed `(ctx) => void`**. Read the error from `ctx.event` (`:65-70`; `site/connection.tsx:176-179`).
  - Each `subscribe()` call is one query set. One bad query fails the whole set (`site/connection.tsx:168-170`).
  - Unsubscribe is asynchronous. The server sends the dropped rows, and the SDK fires **`onDelete` with `ctx.event.tag === 'UnsubscribeApplied'`**. Do not treat these as real deletions.
  - A `SubscriptionError` with no request id, meaning a previously applied query, makes the SDK **disconnect** (`db_connection_impl.ts:1744-1751`).
  - Calling `unsubscribe()` on a closed connection throws (`site/connection.tsx:112-120`).
  - Never mix `subscribeToAllTables` with `subscribe` (`subscription_builder_impl.ts:144-151`).
- **Overlapping queries are ref-counted per row** (`table_cache.ts:436-491`). Re-subscribing with a new bound, then unsubscribing the old one, causes no row flicker (subscriptions.md §3).

### 4.3 Cache and row callbacks
- **Updates.** For tables and views whose row type has a primary key (all the ones we use, including `my_rack`, PK `id` at `bind/my_rack_table.ts`), a server-side delete+insert of the same PK in one transaction is delivered as **one `onUpdate(ctx, old, new)`** (`table_cache.ts:308-363`). It is never delete+insert. A row leaving a query's result set gives `onDelete`. A holding whose count hits 0 is deleted, so `my_rack.onDelete` fires.
- **Callback timing.** The whole `TransactionUpdate` is applied to the cache first. Then all queued callbacks run synchronously (`db_connection_impl.ts:1561-1612`; docs "Pending Callbacks and Cache Consistency"). When `auction.onInsert(next)` fires, the result of the previous auction (balances, `my_rack`, `auction_result`, sim word) is **already in the cache**. All of it is one transaction (`mod/game.ts:541-656`).
- **Callback order.** Tables run in the order they appear in the server message, and within a table updates/inserts run before deletes. Do not depend on this; the docs say "no relative ordering guarantees". Callbacks from one message share one `ctx.event` object (`ctx.event.id`).
- **Initial rows.** On `SubscribeApplied`, `onApplied` is emitted **before** the initial rows' `onInsert` callbacks, but the cache is already full (`:1690-1697`). `auction.onInsert` therefore also covers the auction that was already open when we subscribed (event tag `'SubscribeApplied'`).
- **Event tags.** `ctx.event.tag` is one of `'Reducer'` (our own reducer's changes, with `ctx.event.value.timestamp` = server reducer timestamp), `'Transaction'` (everyone else's, including the scheduler), `'SubscribeApplied'`, `'UnsubscribeApplied'` or `'Error'` (`sdk/sdk/event.ts`, `:1780-1810`).
- **Index lookups are full scans.** `conn.db.t.idx.find()` and `.filter()` iterate all cached rows with `deepEqual` (`table_cache.ts:105-218`: "TODO: this just scans the whole table"). Keep caches small and maintain our own `Map`s from callbacks.

### 4.4 Reducer calls
- **Return value.** `conn.reducers.submitBid({auctionId, amount})` returns **`Promise<void>`** (`sdk/sdk/reducers.ts:20-30`).
  - **Resolves** when the server's `ReducerResult` is `Ok` or `OkEmpty`, i.e. the transaction committed. For `Ok`, the transaction's visible rows are applied and row callbacks run **before** the promise continuation (`db_connection_impl.ts:1780-1815`).
  - **Rejects** with `SenderError(message)`, where `message` is the exact string the module threw (`:1969-1973`). It rejects with `InternalError` for module crashes, `UnknownCallResultError` or `DisconnectedError` (above), and never on its own timeout.
- **No per-reducer callbacks in 2.12.** `conn.reducers.onSubmitBid` does not exist in code; the docs are stale. The server timestamp in `ReducerResult` (`client_api/types.ts:156-162`) is exposed only through row callbacks of our own reducer (`ctx.event.value.timestamp`). `submit_bid` writes only private rows, so **bids give no server timestamp** unless frames are tapped (§7.4).
- **Module error strings** (exact; switch on them):

| Reducer | Error strings |
|---|---|
| `submit_bid` (`mod/index.ts:780-812`) | `Bid must be non-negative` · `Your identity is not a credential for any bot` · `Unknown auction` · `Auction closed` · `Auction window expired` · `Not in this match` · `Insufficient balance` |
| `submit_word` (`:816-848`, `mod/game.ts:696`) | `Unknown match` · `Match not running` · `Not in this match` · `Word must be at least 2 letters` · `Word must be A-Z only` · `'WORD' is not in the dictionary` · `Not enough 'C': need N, have H` |
| `join_lobby` (`:852-896`) | `You're already in a running match` · `You're playing in a tournament; the lobby reopens to you when you're knocked out or it ends`. When already in the open lobby the call is a **no-op success**, which makes it a cheap liveness/RTT probe while waiting. |
| `claim_credential` (`:621-649`) | `No such nonce` · `This nonce has expired` · `Your identity is already a credential for a bot` |
| `register_for_tournament` (`mod/tournament.ts:109-117`) | `Unknown tournament` · `Tournament is not taking registrations`. Re-registering is idempotent. |

- **Ordering of consecutive calls from one connection.** Calls go out in program order on one socket. v3 coalesces same-tick calls into one frame, in order. The server answers in request order (docs, HIGH). The module executes transactions serially. So `submitWord` then `submitBid` in the same tick is **expected** to run in that order, and the bid's balance check (`mod/index.ts:807`) sees the word's reward. Confidence: MEDIUM-HIGH. The reducers doc reserves the right to run reducers concurrently, so verify locally in Phase 1 (§11). Fallback: `await` the word promise before a bid that depends on its reward. That costs one RTT.

### 4.5 Timestamps
- **Type.** `Timestamp` holds `__timestamp_micros_since_unix_epoch__: bigint`. The getter `microsSinceUnixEpoch` returns µs as bigint (`sdk/lib/timestamp.ts:20-27`).
- **Conversions.** `toMillis()` returns a bigint and `toDate()` truncates to ms (`:84-115`). For arithmetic use `Number(ts.microsSinceUnixEpoch) / 1000`, which is exact because µs since epoch is below 2^53 until year 2255.
- **Keep the raw bigint µs.** It is the RNG seed in §8; never round it.
- **Server meanings:**
  - `auction.opens_at` = the opening transaction's `ctx.timestamp`, which is the previous close or the match start.
  - `closes_at = opens_at + auction_duration_ms` (`mod/game.ts:302-303, 631-632`).
  - `auction_result.closed_at` = the close transaction's timestamp = the next `opens_at`.
  - `match_state.created_at` = `started_at` = the match-start transaction's timestamp.
  - `word_play.played_at` = the submitting reducer's timestamp.
- **Local clock.** Use `performance.timeOrigin + performance.now()`: wall-aligned at process start and monotonic.

### 4.6 Generated bindings (usable unchanged?)
**Yes, under tsx, vitest or a bundler.**
- Header: "generated using spacetimedb cli version 2.12.0 (commit 2f8905d…)" (`bind/index.ts:4`). That commit is the `v2.12.0` tag.
- They import only the `spacetimedb` root export (`:8-34`) plus 59 extensionless relative modules.
- They contain no React imports and no non-erasable TypeScript; `override` and `satisfies` both strip.
- Exports: `DbConnection`, `tables` (a query builder for tables **and views**), `reducers`, and `EventContext`/`ErrorContext`/`SubscriptionHandle` types (`:533-570`).
- **Not** runnable with plain `node` type-stripping: `node a.ts` importing `"./lib"` gives `ERR_MODULE_NOT_FOUND` (verified on 24.18.0).
- The live schema matches the bindings (§3).

---

## 5. Minimal subscription set for a bot

All per-match queries are equality filters on indexed `match_id` (indexes listed in `bind/index.ts:102-482`).

| Set | Lifetime | Queries (typed builder) | Size and traffic |
|---|---|---|---|
| **Global** | connection | `tables.botCredential` (my `botId`, rivals' `connected`); `tables.bot` (names, `isSimulated`, `strategy`); `tables.botStats` (μ, σ priors); `tables.openLobbies`; `tables.openLobbyMembers`; `tables.tournament`; `tables.matchmakerConfig` | About 148 bots; tiny. `bot_credential` updates on any bot's connect or disconnect. |
| **Mine** | re-issue after each match end with a new bound | `tables.matchParticipant.where(r => r.botId.eq(me).and(r.matchId.gt(K)))`, where K = last ended match id (persisted); `tables.tournamentEntry.where(r => r.botId.eq(me))` | 1 row per match. This **detects every new match, lobby or tournament** (tournaments call `startMatchWith` too). |
| **Per match M** | from detection until about 3 s after `Ended` (keep the logs) | `matchState.where(id = M)`, `matchParticipant.where(matchId = M)`, `auction.where(matchId = M)`, `auctionResult.where(matchId = M)`, `wordPlay.where(matchId = M)`, `myRack.where(matchId = M)` (fallback `tables.myRack`) | 1 + 6 + 68 + 68 + about 16 + ≤26 rows. About 2–4 row events per second. |
| **Post-match** (optional) | short | `tables.auctionTopBidArchive.where(r => r.matchId.eq(M))` | Rivals' winning top bids, public only after the end (`mod/game.ts:361-376`). Use for online opponent learning. |

Optional zero-RTT first auction (verify in Phase 0): a standing semijoin built as `tables.matchParticipant.where(p => p.botId.eq(me)).rightSemijoin(tables.auction, (p, a) => p.matchId.eq(a.matchId)).where(a => a.id.gt(A))`. It renders as `SELECT "auction".* FROM "match_participant" JOIN "auction" ON … WHERE (bot_id = me) AND (id > A)`, and both join columns are indexed. Without it, the first auction of a match becomes visible one subscribe round trip late (about 40–80 ms of a 1000 ms window from the Mac).

Never subscribe to whole `match_state` (25,598 rows), `auction_result` (1.74M), `word_play` (402k), `auction_top_bid_archive` (1.74M), `rating_history` or `match_participant` (153k). Upstream's site subscribes to all of `match_state` (`site/connection.tsx:59`); do not copy that.

---

## 6. Code skeletons (grounded in the 2.12 API)

These are skeletons; types follow `bind/index.ts`. Helpers `withTimeout`, `TimeoutError` and `Histogram` are ours.

```ts
// src/client/connection.ts
import { DbConnection, type ErrorContext } from './module_bindings/index.ts';
import { setGlobalLogLevel, type Identity } from 'spacetimedb';
setGlobalLogLevel('warn');

export interface Hooks {
  ready(conn: DbConnection, id: Identity, token: string, isReconnect: boolean): void; // persist token; (re)register on new conn only
  dead(err?: Error): void;                                                             // SDK will not retry → supervisor rebuilds
}
export function open(host: string, db: string, token: string | undefined, h: Hooks): DbConnection {
  return DbConnection.builder()
    .withUri(host)                                   // 'https://maincloud.spacetimedb.com' (→ wss)
    .withDatabaseName(db)                            // 'scrabblebot'
    .withToken(token)                                // undefined ⇒ anonymous identity minted by server
    .withCompression('none')
    .withConfirmedReads(false)
    .withAutomaticReconnect({ minDelayMs: 500, maxDelayMs: 4000 })
    .onConnect((c, id, tok) => h.ready(c, id, tok, false))
    .onAutomaticReconnect((c, id, tok) => h.ready(c, id, tok, true)) // subscriptions + callbacks survive; wait for onApplied
    .onConnectError((_c: ErrorContext, err: Error, next?: number) => { if (next === undefined) h.dead(err); })
    .onDisconnect((_c: ErrorContext, err?: Error, next?: number) => { if (next === undefined) h.dead(err); })
    .build();
}

// Supervisor: initial-connect failures, terminal errors, zombie sockets (Node has no browser "resume" hooks).
export class Supervisor {
  private conn?: DbConnection; private attempt = 0;
  constructor(private host: string, private db: string, private tokens: { load(): string | undefined; save(t: string): void },
              private attach: (c: DbConnection, isReconnect: boolean) => void) {}
  start() {
    this.conn = open(this.host, this.db, this.tokens.load(), {
      ready: (c, _id, tok, re) => { this.attempt = 0; this.tokens.save(tok); this.attach(c, re); },
      dead: () => this.rebuild(),
    });
  }
  /** Watchdog: call when a Running match has produced no row event for > 2500 ms (auctions close every ~1001 ms). */
  rebuild() {
    try { this.conn?.disconnect(); } catch { /* already closed */ }
    setTimeout(() => this.start(), Math.min(200 * 2 ** this.attempt++, 4000));
    // NOTE: a NEW DbConnection has none of the old subscriptions/callbacks → attach() must re-subscribe and the
    // Store must reconcile from onApplied snapshots (it is connection-agnostic).
  }
}
```

```ts
// src/client/subscriptions.ts
import { DbConnection, tables } from './module_bindings/index.ts';
export const subscribeGlobal = (c: DbConnection, ready: () => void) => c.subscriptionBuilder()
  .onApplied(() => ready())
  .onError((ctx) => console.error('global sub:', ctx.event?.message))
  .subscribe([tables.botCredential, tables.bot, tables.botStats, tables.openLobbies,
              tables.openLobbyMembers, tables.tournament, tables.matchmakerConfig]);

export const subscribeMine = (c: DbConnection, me: bigint, afterMatch: bigint) => c.subscriptionBuilder()
  .onError((ctx) => console.error('mine sub:', ctx.event?.message))
  .subscribe([tables.matchParticipant.where(r => r.botId.eq(me).and(r.matchId.gt(afterMatch))),
              tables.tournamentEntry.where(r => r.botId.eq(me))]);

export const subscribeMatch = (c: DbConnection, m: bigint, applied: () => void) => c.subscriptionBuilder()
  .onApplied(() => applied())
  .onError((ctx) => console.error(`match ${m} sub:`, ctx.event?.message))
  .subscribe([tables.matchState.where(r => r.id.eq(m)), tables.matchParticipant.where(r => r.matchId.eq(m)),
              tables.auction.where(r => r.matchId.eq(m)), tables.auctionResult.where(r => r.matchId.eq(m)),
              tables.wordPlay.where(r => r.matchId.eq(m)), tables.myRack.where(r => r.matchId.eq(m))]);
// My bot id after global onApplied:  c.db.botCredential.identity.find(identity)?.botId
```

```ts
// src/client/adapter.ts: rows → tracker events (excerpt)
const us = (t: { microsSinceUnixEpoch: bigint }) => t.microsSinceUnixEpoch;          // keep bigint µs
const ms = (t: { microsSinceUnixEpoch: bigint }) => Number(t.microsSinceUnixEpoch) / 1000;
conn.db.auction.onInsert((ctx, a) => {                      // live opens AND the already-open one from SubscribeApplied
  const t = clock.now();
  if (ctx.event.tag === 'Transaction') clock.addDownlink(ms(a.opensAt), t); // opens_at = close-tx ctx.timestamp
  store.auctionOpen(a, t);                                   // → provisional bid immediately
});
conn.db.auction.onUpdate((_c, _old, a) => store.auctionUpdated(a));      // Open→Closed is ONE onUpdate
conn.db.auctionResult.onInsert((_c, r) => store.auctionResult(r));       // same tx as the next auction's insert
conn.db.matchParticipant.onInsert((_c, p) => store.participant(p));      // new match detection (botId === me)
conn.db.matchParticipant.onUpdate((_c, _o, p) => store.participant(p));  // every seat's balance/score
conn.db.myRack.onInsert((_c, h) => store.rack(h));
conn.db.myRack.onUpdate((_c, _o, h) => store.rack(h));
conn.db.myRack.onDelete((ctx, h) => { if (ctx.event.tag !== 'UnsubscribeApplied') store.rackGone(h); });
conn.db.wordPlay.onInsert((ctx, w) => {
  if (ctx.event.tag === 'Reducer' && w.botId === store.myBotId) clock.addUplink(store.sentAtFor(w.word), ms(w.playedAt));
  else if (ctx.event.tag === 'Transaction') clock.addDownlink(ms(w.playedAt), clock.now());
  store.word(w);
});
conn.db.matchState.onInsert((_c, m) => store.match(m));     // createdAt (bigint µs) → deal replay (§8)
conn.db.matchState.onUpdate((_c, old, m) => {
  store.match(m);
  if (old.status.tag === 'Running' && m.status.tag === 'Ended' && store.isMine(m.id)) void rejoin(conn);
});
```

```ts
// src/client/actions.ts
import { SenderError, InternalError, DisconnectedError, UnknownCallResultError } from 'spacetimedb';
export type Outcome = 'ok' | 'late' | 'balance' | 'rejected' | 'unknown' | 'not-sent' | 'timeout' | 'internal';
const classify = (e: unknown): Outcome =>
  e instanceof SenderError ? (e.message === 'Auction window expired' || e.message === 'Auction closed' ? 'late'
                            : e.message === 'Insufficient balance' ? 'balance' : 'rejected')
  : e instanceof UnknownCallResultError ? 'unknown' : e instanceof DisconnectedError ? 'not-sent'
  : e instanceof TimeoutError ? 'timeout' : 'internal';

export async function bid(conn: DbConnection, auctionId: bigint, amount: number, rtt: Histogram): Promise<Outcome> {
  const t0 = performance.now();
  try { await withTimeout(conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }), 2500);
        rtt.add(performance.now() - t0); return 'ok'; }          // replaceable: later calls overwrite (mod/game.ts:828-847)
  catch (e) { return classify(e); }
}
export async function word(conn: DbConnection, matchId: bigint, w: string): Promise<Outcome> {
  try { await withTimeout(conn.reducers.submitWord({ matchId, word: w }), 2500); return 'ok'; }
  catch (e) { return classify(e); }                              // 'rejected' ⇒ rack desync → resync from my_rack
}
export async function rejoin(conn: DbConnection): Promise<void> {
  try { await withTimeout(conn.reducers.joinLobby({}), 2500); }  // no-op success if already in the open lobby
  catch (e) { if (e instanceof SenderError && e.message.startsWith("You're playing in a tournament")) store.tournamentHold = true; }
}
// Pipelined words-then-bid (verify ordering in Phase 1): fire submitWord(s) and submitBid in the same tick.
// Fallback when the bid needs the words' reward: await all word promises, then bid.
```

Credential claim. Do not copy the starter's 1000 ms `setTimeout` race (`starter/index.ts:181-201`). Instead: `await conn.reducers.claimCredential({ code })`, then wait for `botCredential.onInsert` with our identity, then save the token.

---

## 7. Latency and clock design

### 7.1 Measured facts
- **Scheduler lag.** The close transaction runs at `closes_at` plus **0.58 ms (p1), 0.76 (p5), 1.44 (p50), 2.13 (p90), 3.99 (p99), 244.6 (p99.9), 636.9 (max)**. It is **never early**. Sample: n=115,339 auctions in 1,697 matches with id ≥ 40000. Source: `auction_result.closed_at − prev closed_at − 1000 ms`. This agrees with RULES.md §0.7 (n=272).
- **Match shape.** Every recent complete match has 68 auctions, which is 98 tiles − 6 seats × 5. Each auction lasts about 1001.4 ms, so a match lasts about 68.1 s.
- **Network from the dev Mac.** TCP connect is 38–43 ms. A keep-alive HTTPS request takes 37.5 ms total. The first TLS handshake adds about 1 RTT.

### 7.2 Semantics that drive deadlines
- A bid counts iff its reducer **starts** with `ctx.timestamp < closes_at`. Otherwise it fails with `Auction window expired` (status still Open) or `Auction closed` (`mod/index.ts:794-802`).
- Server stalls (p99.9 lag 245 ms) also delay *our* reducer's start. So **always send a provisional bid immediately**; replacement is free (`mod/game.ts:828-847`).
- **The last auction ends the match inside its close transaction** (`mod/game.ts:617-629`). The final words therefore have the same deadline as the final bid. The final letter is unusable for real bots, but sims can use it (`mod/game.ts:613-615`).
- Payments never reduce score (`mod/game.ts:581-584` vs `:721-725`) and balance is worthless at the end. So a maximum bid on the final auction is a **free denial** against sims.

### 7.3 Estimator: `src/client/clock.ts`
Define θ = local − server, in ms. Causality gives hard bounds from every sample, so θ comes from interval intersection over a sliding window (120 s):
- **Upper bound (downlink).** θ ≤ `tRecv − serverTs`. Use every non-own event carrying a server timestamp: `auction.opens_at`, `auction_result.closed_at`, rivals' `word_play.played_at`, `match_state.created_at`. That gives about 2 samples per second in a match.
- **Lower bound (uplink).** θ ≥ `tSend − serverTs`. Use our own `word_play.played_at`, or `ctx.event.value.timestamp` for our reducer. Also our `lobby_member.joined_at` (via `open_lobby_members`) after `joinLobby`.
- **Estimate.** θ̂ = (lo + hi)/2. The interval width is ≤ min RTT. If there is no uplink sample yet, use θ̂ = hi − RTT_min/2.
- **RTT.** Histogram of `submitBid`/`submitWord`/`joinLobby` promise latencies (send → resolve). Also the probe `joinLobby` every 5 s while waiting in a lobby (no-op success).
- **Send deadline for the final bid refinement (local):**
  `tFinal = closes_at + θ_lo − upP99 − guard`. Here `θ_lo` is the lower bound (or `hi − RTT_min`), `upP99 ≈ RTT_p99/2` until uplink samples exist, and `guard = 25 ms`.
  Start conservative (`guard = 120 ms`, matching PITFALLS C5) and tighten after Phase 2 data.
- **Policy.** Send the provisional bid right after receipt (target < 5 ms of compute). Send refined replacements only if the amount changes. Send the last one by `tFinal`. Count late rejections; target < 0.5%.
- **Event-loop SLO.** Track `monitorEventLoopDelay` p99 < 5 ms. Anything heavier than about 2 ms goes to a worker with an anytime result.

### 7.4 Optional: frame tap for bid timestamps (low priority)
`withWSFn(factory)` lets us wrap the socket. Replicate `sdk/sdk/ws.ts:83-141`: token exchange, URL params and `binaryType='arraybuffer'`. In `onmessage`:
- Byte 0 is the compression tag (0 when `compression=None`). Strip it before calling the SDK handler.
- A first message with tag **6** is a `ReducerResult`: `u32 requestId` then `i64 µs timestamp`, little-endian (`client_api/types.ts:156-202`).
- Responses arrive in request order, so match them FIFO to our wrapped calls. Only the first message in a v3 frame is decodable without the private deserializer.
- Caveat: our factory cannot raise the SDK's private `WebSocketTokenError`, so auth failures are not classified as terminal.

Defer this until Phase-2 data shows that the word and lobby uplink samples are too sparse.

---

## 8. Determinism: timestamp-seeded RNG (cross-cutting, strategy-critical)

**Fact.** On the real host, every reducer call does `ReducerCtxImpl.resetHost(…, new Timestamp(timestamp), …)`, which clears `#random` (`sdk/server/runtime.ts:301-323, 617-661`). Then `ctx.random = makeRandom(this.timestamp)` (`:376-378`). The seed is `microsSinceUnixEpoch → pcg32 → xoroshiro128plus` (pure-rand 7.0.1; `sdk/server/rng.ts:63-132`). The seeding is unchanged in 2.14.1 (diff adds only `shuffle()`).

The module's only RNG call sites are:
- `shuffle` (`mod/game.ts:118-123`): lobby sim padding, tie-breaks, tournament round 1;
- `drawLetter` (`:752`);
- sim jitter (`:813-818`).

**My independent large-scale validation** extends RULES.md §4.4. The scripts are in the scratchpad (below). The replay uses the module's draw order: an optional 6-sim shuffle (5 calls), then 5 tiles per participant in `match_participant.id` order, then the first letter.
- **25,546 of 25,546** complete non-tournament matches replay to a hidden deal under which **every historical word is formable**: about 402k words. Each match was checked on both the first auction letter and all of its words. Every match is explained by exactly one of two variants:
  - `timeout`: 6-sim shuffle first. 8,635 matches, dominant since about id 30000.
  - `full`: 6 real bots, no shuffle. 16,911 matches, the early era.
  - Variant `none`: **0**.
- In the newest 257 matches, the first letter, the identity and order of the padded sims, and all 17,162 subsequent letters are explained.
- **51 of 51** tournament matches replay with an RNG offset from earlier tables in the same transaction. For round-1 tables, offsets step by 31 for 6-seat tables and 36 for 7-seat tables (6×5+1 and 7×5+1 draws). A live bot can brute-force offsets 0..1000 at match start. The self-check is our own 5 tiles plus the first letter, which essentially never matches by chance.
- **Sim bids.** Exact on the first auction: **187 of 187**. Later auctions need RULES.md §4.3's index-order model: the in-transaction winner is iterated first, and committed rows follow swap_remove+push order. With participant-id order I only got about 35%. The jitter multiset alone always explained the observed top bid (1,931/1,931).

**Stack consequences:**
1. `src/core/stdbRng.ts` is an exact port of `pcg32` + `xoroshiro128plus` + `unsafeUniformIntDistribution`, sketched below. It sits beside the simulator's own fast PRNG (ARCHITECTURE.md). Add golden tests from history: deals, first letters, sim bids.
2. The client must keep **bigint µs** timestamps and the participant-id order.
3. Run the self-check at every match start. If it fails, set `rngModelValid=false` and fall back to probabilistic inference.
4. Assume rivals know **our** starting rack.
5. **Open decision for the user:** use the exploit in live and tournament play, or only offline and defensively. It uses public rows only, but it defeats the game's intended hidden information. Organizers could patch it with a module change.

```ts
// Exact port (validated on history). seed = tx timestamp µs (bigint).
export function stdbTxRandom(micros: bigint) {
  const s = BigInt.asUintN(64, micros * 6364136223846793005n + 11634580027462260723n);
  const xs = Number(BigInt.asUintN(32, ((s >> 18n) ^ s) >> 27n)), rot = Number(BigInt.asUintN(32, s >> 59n));
  const seed = (xs >> rot) | (xs << (32 - rot));
  let s01 = -1, s00 = ~seed, s11 = seed | 0, s10 = 0;
  const next = () => { const out = (s00 + s10) | 0, a0 = s10 ^ s00, a1 = s11 ^ s01, o00 = s00, o01 = s01;
    s00 = (o00 << 24) ^ (o01 >>> 8) ^ a0 ^ (a0 << 16); s01 = (o01 << 24) ^ (o00 >>> 8) ^ a1 ^ ((a1 << 16) | (a0 >>> 16));
    s10 = (a1 << 5) ^ (a0 >>> 27); s11 = (a0 << 5) ^ (a1 >>> 27); return out; };
  return { int(from: number, to: number) {                       // integerInRange(from, to), inclusive
    const n = to - from + 1, max = n > 2 ? ~~(0x100000000 / n) * n : 0x100000000;
    let d = next() + 0x80000000; while (d >= max) d = next() + 0x80000000; return (d % n) + from; } };
}
// drawLetter: idx = r.int(0, bagTotal-1), walk letters A..Z with remaining > 0 (mod/game.ts:744-765).
```

---

## 9. Gotchas (stack level)

| # | Gotcha | Source | Do this |
|---|---|---|---|
| G1 | The starter and the bot guide call `subscribeToAllTables`, which pulls 1.74M `auction_result` rows, 1.74M archive rows, 402k words and all of `my_rack` history. | `starter/index.ts:217`, `bot-guide.md:105` | Use the §5 sets. |
| G2 | Cache `find`/`filter` are O(n) with `deepEqual`. | `table_cache.ts:105-218` | Keep our own Maps. |
| G3 | Without auto-reconnect, in-flight promises hang forever after a socket loss. | `db_connection_impl.ts:681-695` | Wrap every call in a timeout, and use auto-reconnect. |
| G4 | While reconnecting, calls fail instantly with `DisconnectedError`. In-flight calls fail with `UnknownCallResultError` (they may have run). | `:772`, `:1480-1484` | Re-send the bid; bids are idempotent per auction. Re-check the rack before re-sending words. |
| G5 | Initial connect failures are never retried, and Node has no resume hooks, so zombie sockets go undetected. | `:800-813`, `:911-940` | Supervisor plus a 2.5 s in-match watchdog. |
| G6 | `onError` gets `(ctx)`. The error is `ctx.event`. | `subscription_builder_impl.ts:65-70` | — |
| G7 | Unsubscribing fires `onDelete` with tag `UnsubscribeApplied`. | `:1700-1724` | Ignore those deletes in game logic. |
| G8 | Enum WHERE is impossible. | `mod/index.ts:139-141` | Filter by ids. Use the `open_lobbies` view. |
| G9 | `my_rack` spans all matches forever. | `mod/index.ts:72-82`, `mod/game.ts:704` | `WHERE match_id = M`, or filter client-side. |
| G10 | Schema drift silently corrupts positional row decoding. | `db_connection_impl.ts:1262-1300` | Startup schema guard (§3). |
| G11 | Bindings use extensionless imports, so plain `node` fails. | verified | Use tsx or vitest. Keep our own imports `.ts`-explicit. |
| G12 | Docs vs code: reducer `onX` callbacks, `ReducerEvent.status`/`callerIdentity`, `and` from bindings, "BTree index not supported", "unbid tiles return to the bag", "60 s lobby". | `reducers.ts`, `reducer_event.ts`, `bot-guide.md:55-56`, `mod/game.ts:61` | Trust the code. The lobby is 90 s. |
| G13 | Bids give no server timestamp. | `client_api/types.ts:156-162` | Uplink samples come from words and the lobby join; optionally tap frames (§7.4). |
| G14 | The gzip default adds an async decompress per frame. | `db_connection_builder.ts:34` | `withCompression('none')`. |
| G15 | `withAutomaticReconnect` floors: 500 ms minimum delay, ≥ 1 s maximum. | `:165-221` | The supervisor can rebuild faster (200 ms) when the watchdog trips. |
| G16 | All callbacks of a transaction run synchronously in one turn. | `:1604-1612` | No heavy work in callbacks. Queue it and decide in a microtask or worker. |
| G17 | Rivals can read closed auctions' top bids **live** through a second anonymous identity. The fix sits only on a side branch. They can also see `bot_credential.connected`, every balance and score, and our hidden rack (§8). | `mod/index.ts:120-137`, RULES.md §0.3 | Assume a transparent opponent model of us. Don't make our valuation trivially invertible. |
| G18 | One human identity can own at most one team (`You're already on a team`). Locally, each test bot needs its own human identity. | `mod/index.ts:356-358` | Provision with fresh anonymous SDK connections (§10). |
| G19 | `visible_auction_top_bids` is `[]` for bot identities. | `mod/index.ts:124-126` | Don't build on it from the bot connection. |
| G20 | The match ends inside the final close transaction, so words sent after `closes_at` (server) of the last auction fail with `Match not running`. | `mod/game.ts:617-629` | Use the final-words deadline = `tFinal`. |

---

## 10. Local dev toolchain (research only; nothing installed yet)

```bash
# 1) CLI on macOS arm64 (official): downloads spacetimedb-update-aarch64-apple-darwin from the latest GitHub release
#    (falls back to the S3 mirror), self-installs `spacetime` (prints the bin dir; add it to PATH if told to).
curl -sSf https://install.spacetimedb.com | sh
spacetime version install 2.12.0 --use       # pin (crates/update/src/cli/install.rs: `--use` switches after install)
spacetime version list
# 2) Local server (standalone, default http://127.0.0.1:3000; data dir ~/.local/share/spacetime/data)
spacetime start
# 3) Local test copy of the module: vendor/scrabblebot → e2e/module-local (overlay two edits):
#    mod/game.ts: SEED_ADMIN_HEX = []   (then call bootstrap_admin once: allowed iff admin table empty, mod/index.ts:290-303)
#                 LOBBY_DURATION_SECONDS = 5n   (fast cycles; production is 90n)
npm install --prefix e2e/module-local        # spacetimedb 2.12.0 + @noble/hashes (module deps)
spacetime publish -s local -p e2e/module-local scrabblebot-local --delete-data=always -y   # init seeds 6 sims + first lobby
spacetime logs -s local scrabblebot-local -f
spacetime sql -s local scrabblebot-local "SELECT * FROM match_state"
# 4) Bindings regeneration (only if upstream changed)
spacetime generate --lang typescript --out-dir src/client/module_bindings --module-path vendor/scrabblebot/spacetimedb
```

**Provisioning local bots (`e2e/provision.ts`).** Use the SDK, not the CLI. Run this only against `ws://127.0.0.1:3000`. Repeat for i = 1..N:
1. Open a fresh anonymous connection; this is "human i".
2. Call `createTeam({teamName:\`T${i}\`, botName:\`B${i}\`})`, then `mintCredentialNonce({})`.
3. Subscribe to `tables.myNonces` to read the code.
4. Open a fresh anonymous connection; this is "bot i". Call `claimCredential({code})`.
5. Persist bot i's token.

An admin script then calls `bootstrapAdmin({})` and `setMatchmakerConfig({startingRackSize:5, lobbyMaxSize:6, auctionDurationMs:1000n})`; `auctionDurationMs: 250n` is useful for stress. Six local bots that join fill the lobby and start the match immediately without sims (`mod/index.ts:885-895`). Fewer bots are padded with sims after the lobby timeout.

**Maincloud credential (user action only; this calls reducers on maincloud).**
- Website route: link the account at /account (`spacetime call scrabblebot connect_id <web identity>`), then /team, then **Generate token**.
- CLI route: `spacetime login`, then `spacetime call scrabblebot create_team …`, then `spacetime call scrabblebot mint_credential_nonce`, then read `my_nonces` via `spacetime sql`. The bot then claims with `BOT_NONCE` (`starter/index.ts:7-11`).

---

## 11. Live latency test runbook (run after `npm install`)

**Phase 0: maincloud, anonymous, read-only.** No reducer calls, so it is allowed under the current rules. Script: `scripts/latency/phase0-readonly.ts`.
1. Connect anonymously. Record build → `onConnect` and subscribe → `onApplied` for the global set.
2. Find a running match: in `open_lobbies`, wait for the lobby to resolve, then read `lobby.resolved_match_id` with `tables.lobby.where(id = L)`. Alternatively subscribe `match_state WHERE id > (recent)`. Then subscribe the per-match set.
3. For ≥ 3 matches (about 204 auctions), log per auction:
   - `tRecv − opens_at` (min, p50, p99): θ + downlink;
   - `closes_at − opens_at` (expect exactly 1000 ms);
   - `closed_at − closes_at` (expect p50 about 1.4 ms);
   - whether the auction update, result insert, next auction insert, balances and the sim word all share one `ctx.event.id` (expect yes).
4. A/B each run for one match: `compression none` vs `gzip`, and `confirmedReads false` vs unset. Compare downlink p50 and p99.
5. **Syntax acceptance** (record each `onError` message):
   - `my_rack WHERE match_id = X` (empty for anonymous, but must not error);
   - the semijoin in §5;
   - `match_participant WHERE bot_id = X AND match_id > K`;
   - an enum filter, which is expected to error (confirms G8).
6. Observe that Open→Closed arrives as `onUpdate`, and that initial rows fire `onInsert` after `onApplied`.
7. Reconnect: use a `withWSFn` wrapper exposing `kill()`, and call it mid-match. Expect `onDisconnect(next=1)`, then `onAutomaticReconnect`, then replay `onApplied`, with no duplicate inserts. Measure time to recover. Then trip the watchdog path (`disconnect()` + rebuild) and measure.
8. Event-loop delay p99 while subscribed.

**Phase 1: local server, full reducer path** (§10 setup, 6 local bots).
1. RTT histograms for `submitBid`, `submitWord` and `joinLobby` (no-op).
2. Ordering: in one tick send `submitWord(W)` then `submitBid(balance + reward(W))`. The bid must succeed in 100 of 100 trials, which confirms §4.4.
3. Cutoff probe: send at `closes_at − X` for X ∈ {300, 200, 150, 100, 75, 50, 25, 10, 0} ms (local, θ-corrected). Plot the acceptance rate per X.
4. Error strings match §4.4 verbatim.
5. Deal-replay self-check passes on every local match.
6. Kill and restart the bot mid-match. It must resume bidding within 2 auctions, and the token must be reused.

**Phase 2: maincloud with our bot credential.** Only after the user provisions a token and explicitly approves play.
1. Play K ≥ 10 lobby matches with logging.
2. Record:
   - RTT p50/p99 per reducer;
   - θ interval width;
   - uplink samples per match;
   - late-bid rate;
   - missed auctions;
   - provisional-bid send latency after `tRecv`;
   - event-loop delay;
   - reconnect count.
3. Acceptance:
   - p99 `submitBid` RTT < 150 ms from the Mac, and < 20 ms from a us-east VM;
   - late-bid rate < 0.5%;
   - zero auctions without a provisional bid;
   - θ width < 60 ms;
   - recovery < 2 s.

---

## Sources

- **SDK source.** npm `spacetimedb@2.12.0` tarball, sha1 `f67f65fb…0c21`, matching the registry; for diffs, `2.14.1` (`7b855389…050e`). Registry metadata: `https://registry.npmjs.org/spacetimedb` (dist-tags latest 2.14.1; 2.12.0 published 2026-10-13).
- **pure-rand 7.0.1 tarball.** `lib/esm/generator/XoroShiro.js`, `distribution/internals/UnsafeUniformIntDistributionInternal.js`.
- **SpacetimeDB repo @ `v2.12.0`** (= `2f8905d6…`):
  - `docs/docs/00200-core-concepts/00400-subscriptions*.md`;
  - `00600-clients/00700-typescript-reference.md`;
  - `00300-resources/00200-reference/00400-sql-reference.md`;
  - `00100-cli-reference/*.md`;
  - `00200-http-api/00300-database.md`;
  - `00200-functions/00500-views.md` and reducer docs;
  - `crates/update/spacetime-install.sh`;
  - `crates/update/src/cli/{install,use}.rs`.
- **Release assets.** GitHub API, `releases/tags/v2.12.0`, includes `spacetimedb-update-aarch64-apple-darwin`. Homebrew tap status: `api.github.com/repos/clockworklabs/homebrew-tap` (archived).
- **Upstream game.** `clockworklabs/scrabblebot@b5ccb36` (MIT): `spacetimedb/src/*`, `bot-starter/*`, `src/connection.tsx`, `src/data.ts`, `src/module_bindings/*`, `DEVELOP.md`, `docs/bot-guide.md`, `TODO.md`, and the lockfiles (spacetimedb 2.12.0, typescript 5.9.3, tsx 4.22.3, vitest 3.2.7/5.0.5, pure-rand 7.0.1, @noble/hashes 2.4.0).
- **Live, read-only.**
  - `GET https://maincloud.spacetimedb.com/v1/database/scrabblebot/schema?version=9` (diffed vs bindings: identical).
  - `GET /v1/database/scrabblebot` (host_type Js).
  - DNS + ipinfo: 131.153.201.171 and 125.253.87.9 are in Ashburn VA.
  - `curl` timing: connect 38–43 ms.
- **History.** Scratchpad `hist/*.ndjson`: 25,598 matches, 1.74M results, 402k words.
- **My validation scripts** (own code, rerunnable), all under `/private/tmp/claude-501/-Users-adem-Documents-GitHub-scrabbleBawt/f0cb5422-db12-4105-b246-d1edf5490e36/scratchpad/scripts/stack/`:
  - `schema_diff.py`
  - `sched_lag.py`
  - `rng_check.mjs`
  - `rack_check.mjs`
  - `rack_check2.mjs`
  - `tour_check.mjs`
  - `simbid_first.mjs`
- **Local verification on this machine.** Node 24.18.0 strip-types, `.ts` workers, global WebSocket/fetch/DecompressionStream, and undici 7.28.0 `setNoDelay(true)`.
- **Companion research.** RULES.md §4 (RNG and index-order model, verified), PITFALLS.md C3/C5/M9/M12, ARCHITECTURE.md (directory ownership).
