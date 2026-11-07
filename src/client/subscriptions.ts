// Targeted subscription queries (PITFALLS C3/M12). The client never subscribes to every table: each
// query is a single table filtered by our identity / bot id / match id, or a small table or view.
// Every query list is checked against FORBIDDEN rules when it is built (fair play: the live top-bid
// leak view is never read; no unfiltered history table).
//
// SQL rendering matches the SDK typed builder (`toSql(tables.auction.where(r => r.matchId.eq(5n)))`
// renders `SELECT * FROM "auction" WHERE "auction"."match_id" = 5`; Identity renders as 0x<hex>).

/** Tables/views this client must never subscribe to. */ // FORBIDDEN
export const FORBIDDEN_TABLES: readonly string[] = ['visible_auction_top_bids']; // FORBIDDEN (live top-bid leak)

/** Large append-only tables: only ever subscribed with a WHERE filter. */
export const HISTORY_TABLES: readonly string[] = [
  'auction',
  'auction_result',
  'auction_top_bid_archive',
  'word_play',
  'match_participant',
  'match_state',
  'lobby',
  'lobby_member',
  'rating_history',
  'tournament_entry',
  'tournament_match',
  'bot_version',
  'retired_bot_stats',
];

export class ForbiddenQueryError extends Error {
  constructor(query: string, reason: string) {
    super(`forbidden subscription query (${reason}): ${query}`);
    this.name = 'ForbiddenQueryError';
  }
}

const FROM_RE = /\b(?:FROM|JOIN)\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;

/** Tables referenced by a query (FROM / JOIN targets), lower-cased and unquoted. */
export function queryTables(query: string): string[] {
  return [...query.matchAll(FROM_RE)].map((m) => m[1]!.toLowerCase());
}

/** Throws ForbiddenQueryError for any forbidden query; returns the list unchanged otherwise. */
export function assertQueriesAllowed(queries: readonly string[]): string[] {
  for (const q of queries) {
    const lower = q.toLowerCase();
    for (const t of FORBIDDEN_TABLES) {
      if (lower.includes(t)) throw new ForbiddenQueryError(q, `references ${t}`);
    }
    if (lower.includes('visibleauctiontopbids')) throw new ForbiddenQueryError(q, 'references the top-bid leak view');
    const tables = queryTables(q);
    if (tables.length === 0) throw new ForbiddenQueryError(q, 'no table');
    const hasWhere = /\bWHERE\b/i.test(q);
    for (const t of tables) {
      if (HISTORY_TABLES.includes(t) && !hasWhere) throw new ForbiddenQueryError(q, `unfiltered history table ${t}`);
    }
  }
  return [...queries];
}

const all = (table: string): string => `SELECT * FROM "${table}"`;
const eq = (table: string, column: string, literal: string | number): string =>
  `SELECT * FROM "${table}" WHERE "${table}"."${column}" = ${literal}`;

function u64(n: number | bigint): string {
  const v = typeof n === 'bigint' ? n : BigInt(n);
  if (v < 0n) throw new Error(`subscriptions: negative id ${v}`);
  return v.toString();
}

/** Identity hex (64 hex chars, optional 0x) -> SQL literal 0x<hex>. */
export function identityLiteral(hex: string): string {
  const h = hex.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('subscriptions: identity must be 32 bytes of hex');
  return `0x${h}`;
}

/**
 * Boot stage 1 (before our bot id is known): own credential row, bot roster (small), lobby views,
 * my_rack (own holdings view), tournaments (small).
 */
export function identityQueries(identityHex: string): string[] {
  return assertQueriesAllowed([
    eq('bot_credential', 'identity', identityLiteral(identityHex)),
    all('bot'),
    all('open_lobbies'),
    all('open_lobby_members'),
    all('my_rack'),
    all('tournament'),
  ]);
}

/** Boot stage 2 (after resolving our bot id): our match seats (detects new matches) and entries. */
export function myBotQueries(botId: number | bigint): string[] {
  return assertQueriesAllowed([
    eq('match_participant', 'bot_id', u64(botId)),
    eq('tournament_entry', 'bot_id', u64(botId)),
  ]);
}

/** All boot queries (stage 1 + stage 2 when the bot id is known). */
export function bootQueries(identityHex: string, botId?: number | bigint): string[] {
  return assertQueriesAllowed([...identityQueries(identityHex), ...(botId === undefined ? [] : myBotQueries(botId))]);
}

/** Per-match queries for match M (also used by the 02-04 ghost observer). */
export function perMatchQueries(matchId: number | bigint): string[] {
  const m = u64(matchId);
  return assertQueriesAllowed([
    eq('match_state', 'id', m),
    eq('match_participant', 'match_id', m),
    eq('auction', 'match_id', m),
    eq('auction_result', 'match_id', m),
    eq('word_play', 'match_id', m),
    eq('tournament_match', 'match_id', m),
  ]);
}

/**
 * Range-predicate probe (RULES §16 open question): does the server accept `match_id > X`?
 * 02-04 runs it once against a recent bound and records the outcome; nothing depends on it.
 */
export function rangeProbeQueries(afterMatchId: number | bigint): string[] {
  const m = u64(afterMatchId);
  return assertQueriesAllowed([`SELECT * FROM "auction" WHERE "auction"."match_id" > ${m}`]);
}

export interface SubscriptionHandleLike {
  unsubscribe(): void;
  isEnded?(): boolean;
}

/** The part of DbConnection the subscribe helper needs (fakeable). */
export interface SubscribableConn {
  subscriptionBuilder(): {
    onApplied(cb: (ctx: unknown) => void): unknown;
    onError(cb: (ctx: unknown) => void): unknown;
    subscribe(q: string[]): SubscriptionHandleLike;
  };
}

export interface SubscribeCallbacks {
  onApplied?: () => void;
  onError?: (message: string) => void;
}

/** Subscribe to a checked query list (one query set). Returns the handle. */
export function subscribeQueries(
  conn: SubscribableConn,
  queries: readonly string[],
  cb: SubscribeCallbacks = {},
): SubscriptionHandleLike {
  const checked = assertQueriesAllowed(queries);
  const b = conn.subscriptionBuilder() as {
    onApplied(cb: (ctx: unknown) => void): typeof b;
    onError(cb: (ctx: unknown) => void): typeof b;
    subscribe(q: string[]): SubscriptionHandleLike;
  };
  return b
    .onApplied(() => cb.onApplied?.())
    .onError((ctx: unknown) => {
      const ev = (ctx as { event?: unknown } | undefined)?.event;
      const msg = ev instanceof Error ? ev.message : String((ev as { message?: string } | undefined)?.message ?? ev);
      cb.onError?.(msg);
    })
    .subscribe(checked);
}

/** Unsubscribe, ignoring errors from an already-closed connection. */
export function safeUnsubscribe(h: SubscriptionHandleLike | undefined): void {
  if (!h) return;
  try {
    if (h.isEnded?.()) return;
    h.unsubscribe();
  } catch {
    /* connection closed */
  }
}
