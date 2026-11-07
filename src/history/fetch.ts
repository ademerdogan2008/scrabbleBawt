// Resumable read-only downloader for the public ScrabbleBot tables (maincloud HTTP SQL API).
// TypeScript port of the research fetcher (scratchpad hist_tools/fetch-history.mjs); no deps.
//
// Security / fair play:
//   - The anonymous identity token is kept in a token file (default .cache/history-ident.json,
//     git-ignored, written with mode 0600). It is NEVER printed or logged; only its length is.
//   - Only allow-listed public base tables are queried (src/history/sql.ts); views are refused.
//   - Requests are sequential with a sleep between them; matches are chunked by id range
//     (match ids are NOT contiguous: the autoinc sequence jumps at 4096-id blocks).
//   - No reducer is ever called; the only endpoints used are POST /v1/identity and
//     POST /v1/database/<db>/sql.
import fs from 'node:fs';
import path from 'node:path';
import {
  MATCH_SCOPED_COLUMN,
  assertAllowedTable,
  decodeSqlResponse,
  selectAll,
  selectRange,
} from './sql.js';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export type Logger = (msg: string) => void;

export interface ClientOptions {
  host?: string; // default https://maincloud.spacetimedb.com
  db?: string; // default scrabblebot
  tokenFile?: string; // default .cache/history-ident.json
  fetchImpl?: FetchLike; // default global fetch
  log?: Logger; // default stderr
  retries?: number; // default 6
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number; // per request, default 180 s
}

export const DEFAULT_HOST = 'https://maincloud.spacetimedb.com';
export const DEFAULT_DB = 'scrabblebot';
export const DEFAULT_TOKEN_FILE = '.cache/history-ident.json';

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Thin HTTP SQL client. Holds the token privately and never exposes it in messages. */
export class HistoryClient {
  readonly host: string;
  readonly db: string;
  readonly tokenFile: string;
  requests = 0;
  bytes = 0;
  private token: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly log: Logger;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions = {}) {
    this.host = (opts.host ?? DEFAULT_HOST).replace(/\/+$/, '');
    this.db = opts.db ?? DEFAULT_DB;
    this.tokenFile = opts.tokenFile ?? DEFAULT_TOKEN_FILE;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.log = opts.log ?? ((m) => process.stderr.write(m + '\n'));
    this.retries = opts.retries ?? 6;
    this.sleep = opts.sleep ?? realSleep;
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  /** Mint a fresh anonymous identity and persist it (mode 0600). Logs the token length only. */
  async mintIdentity(): Promise<string> {
    const res = await this.fetchImpl(`${this.host}/v1/identity`, { method: 'POST' });
    if (!res.ok) throw new Error(`identity mint failed: HTTP ${res.status}`);
    const j = JSON.parse(await res.text()) as { token?: unknown };
    if (typeof j.token !== 'string' || j.token.length === 0) throw new Error('identity mint: no token in response');
    this.token = j.token;
    fs.mkdirSync(path.dirname(path.resolve(this.tokenFile)), { recursive: true });
    fs.writeFileSync(this.tokenFile, JSON.stringify({ token: j.token }), { mode: 0o600 });
    fs.chmodSync(this.tokenFile, 0o600);
    this.log(`[auth] minted anonymous identity (token length ${j.token.length}) -> ${this.tokenFile}`);
    return j.token;
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    if (fs.existsSync(this.tokenFile)) {
      const j = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')) as { token?: unknown };
      if (typeof j.token === 'string' && j.token.length > 0) {
        this.token = j.token;
        this.log(`[auth] using token file ${this.tokenFile} (token length ${j.token.length})`);
        return j.token;
      }
    }
    return this.mintIdentity();
  }

  /** Run one read-only statement and return the decoded rows. */
  async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[]; bytes: number; ms: number }> {
    if (!/^SELECT /.test(sql)) throw new Error('only SELECT statements are allowed');
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const token = await this.getToken();
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        let res;
        let text: string;
        try {
          res = await this.fetchImpl(`${this.host}/v1/database/${this.db}/sql`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
            body: sql,
            signal: ctrl.signal,
          });
          text = await res.text();
        } finally {
          clearTimeout(timer);
        }
        this.requests++;
        this.bytes += text.length;
        if (res.status === 401 || res.status === 403) {
          this.log(`[auth] HTTP ${res.status}; minting a fresh anonymous identity`);
          this.token = undefined;
          await this.mintIdentity();
          continue;
        }
        if (!res.ok) {
          // Redact BEFORE truncating, so a cut can never leave a partial token behind.
          const msg = `HTTP ${res.status}: ${redact(text, token).slice(0, 300)}`;
          // 4xx other than 429 is a bad query: do not retry.
          if (res.status >= 400 && res.status < 500 && res.status !== 429) throw new FatalQueryError(msg);
          throw new Error(msg);
        }
        const rows = decodeSqlResponse<T>(JSON.parse(text));
        return { rows, bytes: text.length, ms: Date.now() - t0 };
      } catch (e) {
        if (e instanceof FatalQueryError) throw e;
        lastErr = e;
        if (attempt === this.retries) break;
        const backoff = Math.min(60_000, 2000 * 2 ** attempt);
        this.log(`[retry ${attempt + 1}/${this.retries}] ${redact(errMsg(e), token)}; sleeping ${backoff} ms`);
        await this.sleep(backoff);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

class FatalQueryError extends Error {}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Remove the token and any bearer credential from a message (defense in depth). */
function redact(s: string, token: string): string {
  const out = token ? s.split(token).join('<redacted>') : s;
  return out.replace(/Bearer\s+\S+/g, 'Bearer <redacted>');
}

// ---------------------------------------------------------------------------------------------
// Resumable NDJSON writer
// ---------------------------------------------------------------------------------------------

interface Progress {
  done: string[];
  bytes: number;
}

/**
 * Appender for <out>/<table>.ndjson with a checkpoint in <out>/<table>.progress.json:
 * `done` lists finished chunk keys and `bytes` the file size after the last finished chunk.
 * On reopen, any partial tail written after the last checkpoint is truncated away.
 */
export class TableWriter {
  readonly file: string;
  readonly progressFile: string;
  private readonly done: Set<string>;
  private readonly fd: number;
  private readonly prog: Progress;

  constructor(outDir: string, table: string, fresh = false) {
    fs.mkdirSync(outDir, { recursive: true });
    this.file = path.join(outDir, `${table}.ndjson`);
    this.progressFile = path.join(outDir, `${table}.progress.json`);
    let prog: Progress = { done: [], bytes: 0 };
    if (!fresh && fs.existsSync(this.progressFile)) {
      prog = JSON.parse(fs.readFileSync(this.progressFile, 'utf8')) as Progress;
    }
    if (fresh || !fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, '');
      prog = { done: [], bytes: 0 };
    } else {
      fs.truncateSync(this.file, Math.min(prog.bytes, fs.statSync(this.file).size));
    }
    this.prog = prog;
    this.done = new Set(prog.done);
    this.fd = fs.openSync(this.file, 'a');
  }

  has(key: string): boolean {
    return this.done.has(key);
  }

  /** Append rows (optionally filtered) and checkpoint `key`. Returns the number written. */
  writeChunk(key: string, rows: readonly unknown[], keep?: (row: Record<string, unknown>) => boolean): number {
    let s = '';
    let n = 0;
    for (const r of rows) {
      if (keep && !keep(r as Record<string, unknown>)) continue;
      s += JSON.stringify(r) + '\n';
      n++;
    }
    if (s) fs.writeSync(this.fd, s);
    this.done.add(key);
    this.prog.done = [...this.done];
    this.prog.bytes = fs.fstatSync(this.fd).size;
    fs.writeFileSync(this.progressFile, JSON.stringify(this.prog));
    return n;
  }

  close(): void {
    fs.closeSync(this.fd);
  }
}

// ---------------------------------------------------------------------------------------------
// Fetch orchestration
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  outDir: string;
  tables: string[];
  /** Whole-table fetch (one request). */
  all?: boolean;
  /** Match-id range [from, to). */
  range?: [number, number];
  /** The N highest-id ended matches (resolved from match_state). */
  recent?: number;
  /** Match ids per request (default 2000). */
  chunk?: number;
  /** Pause between requests in ms (default 700). */
  sleepMs?: number;
  /** Truncate existing output and progress first. */
  fresh?: boolean;
}

export interface FetchSummary {
  tables: Record<string, { rows: number; chunks: number; skippedChunks: number; file: string }>;
  requests: number;
  bytes: number;
}

/** Split [a, b) into chunks of at most k ids. */
export function chunkRange(a: number, b: number, k: number): Array<[number, number]> {
  if (!(k > 0)) throw new Error('chunk must be > 0');
  const out: Array<[number, number]> = [];
  for (let x = a; x < b; x += k) out.push([x, Math.min(b, x + k)]);
  return out;
}

function readLocalMatchStates(outDir: string): Array<{ id: number; status: string }> | undefined {
  const f = path.join(outDir, 'match_state.ndjson');
  if (!fs.existsSync(f) || fs.statSync(f).size === 0) return undefined;
  return fs
    .readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: number; status: string });
}

/** Download the requested tables into NDJSON files, resuming from progress checkpoints. */
export async function fetchHistory(client: HistoryClient, plan: FetchPlan, log: Logger): Promise<FetchSummary> {
  if (plan.tables.length === 0) throw new Error('no tables requested');
  for (const t of plan.tables) assertAllowedTable(t); // refuse views before any network call
  const modes = [plan.all, plan.range, plan.recent].filter((x) => x !== undefined && x !== false).length;
  if (modes !== 1) throw new Error('choose exactly one of --all, --range A:B, --recent N');
  const chunk = plan.chunk ?? 2000;
  const sleepMs = plan.sleepMs ?? 700;
  const pause = async () => {
    if (sleepMs > 0) await realSleep(sleepMs);
  };

  let chunks: Array<[number, number]> | undefined;
  let keepIds: Set<number> | undefined;
  if (plan.range) {
    const [a, b] = plan.range;
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b <= a) throw new Error(`bad range ${a}:${b}`);
    chunks = chunkRange(a, b, chunk);
  } else if (plan.recent !== undefined) {
    let states = plan.fresh ? undefined : readLocalMatchStates(plan.outDir);
    if (!states) {
      states = (await client.query<{ id: number; status: string }>(selectAll('match_state'))).rows;
      await pause();
    }
    const ended = states
      .filter((r) => String(r.status).toLowerCase() === 'ended')
      .map((r) => r.id)
      .sort((x, y) => y - x)
      .slice(0, plan.recent);
    if (ended.length === 0) throw new Error('--recent: no ended matches found');
    keepIds = new Set(ended);
    const lo = Math.min(...ended);
    const hi = Math.max(...ended) + 1;
    chunks = chunkRange(lo, hi, chunk);
    log(`[recent] ${ended.length} ended matches, ids ${lo}..${hi - 1}`);
  }

  const summary: FetchSummary = { tables: {}, requests: 0, bytes: 0 };
  for (const table of plan.tables) {
    const w = new TableWriter(plan.outDir, table, !!plan.fresh);
    const st = { rows: 0, chunks: 0, skippedChunks: 0, file: w.file };
    try {
      if (plan.all) {
        if (w.has('all')) st.skippedChunks++;
        else {
          const r = await client.query(selectAll(table));
          st.rows += w.writeChunk('all', r.rows);
          st.chunks++;
          log(`[${table}] all rows=${r.rows.length} bytes=${r.bytes} ms=${r.ms}`);
          await pause();
        }
      } else {
        const col = MATCH_SCOPED_COLUMN[table];
        if (!col) throw new Error(`table '${table}' is not match-scoped; use --all`);
        const keep = keepIds ? (row: Record<string, unknown>) => keepIds!.has(row[col] as number) : undefined;
        for (const [a, b] of chunks!) {
          const key = `${col}:${a}-${b}`;
          if (w.has(key)) {
            st.skippedChunks++;
            continue;
          }
          const r = await client.query(selectRange(table, col, a, b));
          const n = w.writeChunk(key, r.rows, keep);
          st.rows += n;
          st.chunks++;
          log(`[${table}] ${key} rows=${r.rows.length} kept=${n} bytes=${r.bytes} ms=${r.ms}`);
          await pause();
        }
      }
    } finally {
      w.close();
    }
    summary.tables[table] = st;
    log(`[${table}] done: +${st.rows} rows (${st.chunks} chunks fetched, ${st.skippedChunks} resumed) -> ${w.file}`);
  }
  summary.requests = client.requests;
  summary.bytes = client.bytes;
  return summary;
}
