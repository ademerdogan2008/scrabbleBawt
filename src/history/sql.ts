// HTTP SQL API helpers: table allow-list, read-only query builders and the schema-driven decoder.
//
// Fair play (PROJECT.md / HISTORICAL.md §H11): only public BASE tables may be queried. Views are
// refused, in particular `visible_auction_top_bids` (refused: it leaks top bids of running matches
// to identities without a bot credential). Queries are built only from allow-listed table names,
// allow-listed column names and integers; no free-form SQL is ever sent.
//
// Response shape (SpacetimeDB 2.x `/v1/database/<db>/sql`):
//   [{ schema: { elements: [{ name: { some: "col" }, algebraic_type: T }, ...] },
//      rows: [[v0, v1, ...], ...], total_duration_micros, stats }]
// Encodings decoded here (RULES.md §3):
//   Option (Sum with variants some/none): [0, v] -> v,  [1, []] -> null
//   unit-only Sum (enum):                 [i, []] -> variant name (e.g. "ended", "vickrey")
//   Sum with payload:                     [i, p]  -> { tag, value }
//   Timestamp / Identity / ConnectionId / TimeDuration wrappers: [x] -> x
//     (timestamps become integer microseconds since the Unix epoch)
//   Product -> object keyed by element name; Array -> array; primitives pass through.

/** Public base tables that the history tools may read. Everything else is refused. */
export const ALLOWED_TABLES: ReadonlySet<string> = new Set([
  'bot',
  'bot_stats',
  'retired_bot_stats',
  'bot_version',
  'rating_history',
  'tournament',
  'tournament_match',
  'tournament_entry',
  'match_state',
  'match_participant',
  'auction',
  'auction_result',
  'auction_top_bid_archive',
  'word_play',
  'matchmaker_config',
  'lobby',
  'lobby_member',
]);

/** Views and private tables that must never be queried (explicit, for clearer errors). */
export const FORBIDDEN_TABLES: ReadonlySet<string> = new Set([
  'visible_auction_top_bids', // refuse: fair-play leak of running-match top bids
  'open_lobbies',
  'open_lobby_members',
  'my_rack',
  'auction_top_bid',
  'pending_bid',
  'holding',
  'bag_letter',
  'bot_credential',
]);

/** Tables whose rows are keyed by match (chunkable by a match-id range). */
export const MATCH_SCOPED_COLUMN: Readonly<Record<string, string>> = {
  match_state: 'id',
  match_participant: 'match_id',
  auction: 'match_id',
  auction_result: 'match_id',
  auction_top_bid_archive: 'match_id',
  word_play: 'match_id',
  rating_history: 'match_id',
  tournament_match: 'match_id',
};

export class ForbiddenTableError extends Error {
  constructor(table: string, reason: string) {
    super(`refusing to query '${table}': ${reason}`);
    this.name = 'ForbiddenTableError';
  }
}

/** Throws unless `table` is an allow-listed public base table. */
export function assertAllowedTable(table: string): void {
  if (FORBIDDEN_TABLES.has(table)) {
    throw new ForbiddenTableError(table, 'views and private tables are forbidden (fair play)');
  }
  if (!ALLOWED_TABLES.has(table)) {
    throw new ForbiddenTableError(table, 'not an allow-listed public base table');
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function assertInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n)) throw new Error(`${what} must be a safe integer (got ${n})`);
}

/** `SELECT * FROM <table>` for an allow-listed table. */
export function selectAll(table: string): string {
  assertAllowedTable(table);
  return `SELECT * FROM ${table}`;
}

/** `SELECT * FROM <table> WHERE <col> >= a AND <col> < b` (the API rejects ORDER BY: sort client-side). */
export function selectRange(table: string, column: string, from: number, to: number): string {
  assertAllowedTable(table);
  if (!IDENT.test(column)) throw new Error(`invalid column name '${column}'`);
  assertInt(from, 'range start');
  assertInt(to, 'range end');
  return `SELECT * FROM ${table} WHERE ${column} >= ${from} AND ${column} < ${to}`;
}

/** `SELECT COUNT(*) AS n FROM <table>`. */
export function selectCount(table: string): string {
  assertAllowedTable(table);
  return `SELECT COUNT(*) AS n FROM ${table}`;
}

// ---------------------------------------------------------------------------------------------
// Schema-driven decoder
// ---------------------------------------------------------------------------------------------

/** Minimal shape of a SATS algebraic type as delivered in the SQL response schema. */
export type AlgebraicType =
  | { Sum: { variants: Array<{ name?: { some?: string } | null; algebraic_type: AlgebraicType }> } }
  | { Product: { elements: Array<{ name?: { some?: string } | null; algebraic_type: AlgebraicType }> } }
  | { Array: AlgebraicType }
  | Record<string, unknown>;

export interface SqlStatementResult {
  schema: { elements: Array<{ name?: { some?: string } | null; algebraic_type: AlgebraicType }> };
  rows: unknown[][];
  total_duration_micros?: number;
  stats?: unknown;
}

const SPECIAL_WRAPPERS = new Set([
  '__timestamp_micros_since_unix_epoch__',
  '__identity__',
  '__connection_id__',
  '__time_duration_micros__',
]);

type Decoder = (v: unknown) => unknown;

function nameOf(n: { some?: string } | null | undefined, i: number): string {
  return (n && typeof n.some === 'string' ? n.some : undefined) ?? String(i);
}

function isUnitType(t: AlgebraicType): boolean {
  const p = (t as { Product?: { elements: unknown[] } }).Product;
  return !!p && Array.isArray(p.elements) && p.elements.length === 0;
}

/** Build a decoder for one algebraic type. */
export function makeDecoder(t: AlgebraicType): Decoder {
  const sum = (t as { Sum?: { variants: Array<{ name?: { some?: string } | null; algebraic_type: AlgebraicType }> } })
    .Sum;
  if (sum) {
    const vs = sum.variants;
    const names = vs.map((v, i) => nameOf(v.name, i));
    if (vs.length === 2 && names[0] === 'some' && names[1] === 'none') {
      const inner = makeDecoder(vs[0]!.algebraic_type);
      return (v) => {
        const a = v as [number, unknown];
        return a[0] === 0 ? inner(a[1]) : null;
      };
    }
    const decs = vs.map((v) => (isUnitType(v.algebraic_type) ? null : makeDecoder(v.algebraic_type)));
    return (v) => {
      const [i, p] = v as [number, unknown];
      const d = decs[i];
      const name = names[i] ?? String(i);
      return d ? { tag: name, value: d(p) } : name;
    };
  }
  const prod = (t as { Product?: { elements: Array<{ name?: { some?: string } | null; algebraic_type: AlgebraicType }> } })
    .Product;
  if (prod) {
    const els = prod.elements;
    if (els.length === 1 && SPECIAL_WRAPPERS.has(nameOf(els[0]!.name, 0))) {
      return (v) => (Array.isArray(v) ? v[0] : v);
    }
    const decs = els.map((e) => makeDecoder(e.algebraic_type));
    const keys = els.map((e, i) => nameOf(e.name, i));
    return (v) => {
      const a = v as unknown[];
      const o: Record<string, unknown> = {};
      for (let i = 0; i < keys.length; i++) o[keys[i]!] = decs[i]!(a[i]);
      return o;
    };
  }
  const arr = (t as { Array?: AlgebraicType }).Array;
  if (arr) {
    const d = makeDecoder(arr);
    return (v) => (v as unknown[]).map(d);
  }
  return (v) => v; // primitives (numbers, strings, bools)
}

/** Decode the first statement of an SQL API response into plain row objects. */
export function decodeSqlResponse<T = Record<string, unknown>>(json: unknown): T[] {
  if (!Array.isArray(json) || json.length === 0) throw new Error('SQL response: expected a non-empty array');
  const stmt = json[0] as SqlStatementResult;
  if (!stmt || !stmt.schema || !Array.isArray(stmt.rows)) throw new Error('SQL response: missing schema/rows');
  const dec = makeDecoder({ Product: stmt.schema } as AlgebraicType);
  return stmt.rows.map((r) => dec(r) as T);
}
