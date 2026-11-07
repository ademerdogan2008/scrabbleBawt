// Fetch tool: schema-driven decoder over recorded API responses, resumable chunked download with a
// mocked fetch (no network), view refusal and token hygiene.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryClient, TableWriter, chunkRange, fetchHistory, type FetchLike } from '../../src/history/fetch.js';
import {
  ForbiddenTableError,
  assertAllowedTable,
  decodeSqlResponse,
  makeDecoder,
  selectAll,
  selectRange,
  type AlgebraicType,
} from '../../src/history/sql.js';

const API = path.join(__dirname, 'fixtures', 'api');
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(API, `${name}.json`), 'utf8'));

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-fetch-'));
}

describe('decoder over recorded API fixtures', () => {
  it('decodes match_state: enums, Option none/some, [µs] timestamps', () => {
    const rows = decodeSqlResponse<Record<string, unknown>>(fixture('match_state'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      id: 1,
      status: 'ended',
      current_round: 68,
      current_auction_id: null,
      bag_total: 0,
      auction_type: 'vickrey',
      created_at: 1792795759064790,
      started_at: 1792795759064790,
      ended_at: 1792795827154126,
      auction_duration_ms: 1000,
      starting_rack_size: 5,
    });
  });

  it('decodes auction_result winner Option: [0,v] -> v and [1,[]] -> null', () => {
    const rows = decodeSqlResponse<{ winner_bot_id: number | null; closed_at: number; letter: string }>(
      fixture('auction_result'),
    );
    expect(rows.length).toBe(68);
    const none = rows.filter((r) => r.winner_bot_id === null);
    expect(none.length).toBeGreaterThan(0);
    expect(rows.find((r) => r.winner_bot_id === 9)).toBeDefined();
    for (const r of rows) {
      expect(typeof r.closed_at).toBe('number');
      expect(Number.isSafeInteger(r.closed_at)).toBe(true);
      expect(r.letter).toMatch(/^[A-Z]$/);
    }
  });

  it('decodes word_play, participants, top bids and tournament phases', () => {
    const words = decodeSqlResponse<{ word: string; played_at: number; total_reward: number }>(fixture('word_play'));
    const achy = words.find((w) => w.word === 'ACHY')!;
    expect(achy.played_at).toBe(1792795760065667);
    expect(achy.total_reward).toBe(18);
    const parts = decodeSqlResponse<{ match_id: number }>(fixture('match_participant'));
    expect(parts).toHaveLength(6);
    const tops = decodeSqlResponse<{ top_bid: number }>(fixture('auction_top_bid_archive'));
    expect(tops.every((t) => Number.isInteger(t.top_bid))).toBe(true);
    const tm = decodeSqlResponse<{ phase: string }>(fixture('tournament_match'));
    expect(tm.length).toBeGreaterThan(0);
    expect(tm.every((t) => t.phase === 'swiss')).toBe(true);
  });

  it('decodes payload sums, arrays and unit sums synthetically', () => {
    const t: AlgebraicType = {
      Product: {
        elements: [
          { name: { some: 'opt' }, algebraic_type: { Sum: { variants: [{ name: { some: 'some' }, algebraic_type: { U32: [] } }, { name: { some: 'none' }, algebraic_type: { Product: { elements: [] } } }] } } },
          { name: { some: 'e' }, algebraic_type: { Sum: { variants: [{ name: { some: 'a' }, algebraic_type: { Product: { elements: [] } } }, { name: { some: 'b' }, algebraic_type: { U8: [] } }] } } },
          { name: { some: 'xs' }, algebraic_type: { Array: { U8: [] } } },
          { name: { some: 'ts' }, algebraic_type: { Product: { elements: [{ name: { some: '__timestamp_micros_since_unix_epoch__' }, algebraic_type: { I64: [] } }] } } },
        ],
      },
    };
    const dec = makeDecoder(t);
    expect(dec([[0, 7], [0, []], [1, 2, 3], [123]])).toEqual({ opt: 7, e: 'a', xs: [1, 2, 3], ts: 123 });
    expect(dec([[1, []], [1, 9], [], [5]])).toEqual({ opt: null, e: { tag: 'b', value: 9 }, xs: [], ts: 5 });
  });
});

describe('allow-list (fair play)', () => {
  it('refuses views, private tables and unknown tables', () => {
    expect(() => assertAllowedTable('visible_auction_top_bids')).toThrow(ForbiddenTableError);
    expect(() => selectAll('visible_auction_top_bids')).toThrow(/forbidden/);
    expect(() => selectRange('open_lobbies', 'id', 0, 1)).toThrow(ForbiddenTableError);
    expect(() => selectAll('pending_bid')).toThrow(ForbiddenTableError);
    expect(() => selectAll('bot; DROP TABLE bot')).toThrow(ForbiddenTableError);
    expect(() => selectRange('word_play', 'match_id; --', 0, 1)).toThrow(/invalid column/);
    expect(() => selectRange('word_play', 'match_id', 0.5, 1)).toThrow(/integer/);
    expect(selectRange('word_play', 'match_id', 1, 3)).toBe('SELECT * FROM word_play WHERE match_id >= 1 AND match_id < 3');
  });

  it('fetchHistory refuses a view before any network call', async () => {
    let calls = 0;
    const f: FetchLike = async () => {
      calls++;
      throw new Error('network must not be used');
    };
    const dir = tmpDir();
    const client = new HistoryClient({ fetchImpl: f, tokenFile: path.join(dir, 'tok.json'), log: () => {} });
    await expect(
      fetchHistory(client, { outDir: dir, tables: ['visible_auction_top_bids'], all: true, sleepMs: 0 }, () => {}),
    ).rejects.toThrow(ForbiddenTableError);
    await expect(
      fetchHistory(client, { outDir: dir, tables: ['word_play', 'visible_auction_top_bids'], range: [1, 3], sleepMs: 0 }, () => {}),
    ).rejects.toThrow(ForbiddenTableError);
    expect(calls).toBe(0);
  });
});

/** Mock SQL server answering `SELECT * FROM match_state WHERE id >= a AND id < b` from the fixture schema. */
function mockServer(token: string, opts: { failAtRequest?: number; unauthorizedFirst?: boolean; echoErrorOnce?: boolean } = {}) {
  const fx = fixture('match_state') as Array<{ schema: unknown; rows: unknown[][] }>;
  const schema = fx[0]!.schema;
  const template = fx[0]!.rows[0]!;
  const state = { sqlRequests: 0, mints: 0, queries: [] as string[] };
  let unauthorized = !!opts.unauthorizedFirst;
  let echo = !!opts.echoErrorOnce;
  const f: FetchLike = async (url, init) => {
    if (url.endsWith('/v1/identity')) {
      state.mints++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ identity: 'abc', token }) };
    }
    state.sqlRequests++;
    const auth = init?.headers?.Authorization ?? '';
    if (unauthorized) {
      unauthorized = false;
      return { ok: false, status: 401, text: async () => 'unauthorized' };
    }
    if (echo) {
      echo = false;
      return { ok: false, status: 503, text: async () => `upstream error for header ${auth}` };
    }
    if (opts.failAtRequest !== undefined && state.sqlRequests === opts.failAtRequest) {
      return { ok: false, status: 400, text: async () => 'bad query' };
    }
    const q = String(init?.body);
    state.queries.push(q);
    const m = /WHERE id >= (\d+) AND id < (\d+)/.exec(q)!;
    const rows: unknown[][] = [];
    for (let id = Number(m[1]); id < Number(m[2]); id++) {
      const r = [...template];
      r[0] = id;
      rows.push(r);
    }
    return { ok: true, status: 200, text: async () => JSON.stringify([{ schema, rows, total_duration_micros: 1 }]) };
  };
  return { f, state };
}

describe('resumable chunked fetch (mocked fetch, no network)', () => {
  it('chunks id ranges', () => {
    expect(chunkRange(1, 8, 3)).toEqual([
      [1, 4],
      [4, 7],
      [7, 8],
    ]);
  });

  it('resumes from the progress file after a failure and drops a partial tail', async () => {
    const dir = tmpDir();
    const tokenFile = path.join(dir, 'ident.json');
    const token = 'tok-' + 'Z'.repeat(40);
    const plan = { outDir: dir, tables: ['match_state'], range: [1, 8] as [number, number], chunk: 3, sleepMs: 0 };

    const s1 = mockServer(token, { failAtRequest: 2 });
    const c1 = new HistoryClient({ fetchImpl: s1.f, tokenFile, log: () => {}, sleep: async () => {} });
    await expect(fetchHistory(c1, plan, () => {})).rejects.toThrow(/HTTP 400/);
    const prog = JSON.parse(fs.readFileSync(path.join(dir, 'match_state.progress.json'), 'utf8'));
    expect(prog.done).toEqual(['id:1-4']);
    // Simulate a crash mid-write: garbage after the last checkpoint.
    fs.appendFileSync(path.join(dir, 'match_state.ndjson'), '{"id":99,"partial');

    const s2 = mockServer(token);
    const c2 = new HistoryClient({ fetchImpl: s2.f, tokenFile, log: () => {}, sleep: async () => {} });
    const sum = await fetchHistory(c2, plan, () => {});
    expect(s2.state.sqlRequests).toBe(2); // chunk 1 resumed, chunks 2 and 3 fetched
    expect(s2.state.mints).toBe(0); // token reused from the token file
    expect(sum.tables.match_state!.skippedChunks).toBe(1);
    const ids = fs
      .readFileSync(path.join(dir, 'match_state.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { id: number }).id);
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // A third run is a no-op.
    const s3 = mockServer(token);
    const c3 = new HistoryClient({ fetchImpl: s3.f, tokenFile, log: () => {}, sleep: async () => {} });
    await fetchHistory(c3, plan, () => {});
    expect(s3.state.sqlRequests).toBe(0);
  });

  it('TableWriter keeps rows filtered by keep()', () => {
    const dir = tmpDir();
    const w = new TableWriter(dir, 't');
    expect(w.writeChunk('k', [{ a: 1 }, { a: 2 }], (r) => r.a === 2)).toBe(1);
    w.close();
    expect(fs.readFileSync(path.join(dir, 't.ndjson'), 'utf8')).toBe('{"a":2}\n');
  });
});

describe('token hygiene', () => {
  it('never logs the token (mint, 401 re-mint, echoed error) and stores it with mode 0600', async () => {
    const dir = tmpDir();
    const tokenFile = path.join(dir, 'sub', 'ident.json');
    const token = 'SECRET.' + 'q'.repeat(300) + '.END';
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const s = mockServer(token, { unauthorizedFirst: true, echoErrorOnce: true });
    const client = new HistoryClient({ fetchImpl: s.f, tokenFile, log, sleep: async () => {} });
    await fetchHistory(client, { outDir: dir, tables: ['match_state'], range: [1, 3], sleepMs: 0 }, log);
    expect(s.state.mints).toBe(2); // initial mint + re-mint after 401
    expect(logs.length).toBeGreaterThan(3);
    const all = logs.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain('q'.repeat(20));
    expect(all).toContain(`token length ${token.length}`);
    expect(all).toContain('<redacted>'); // the echoed Authorization header was scrubbed
    const st = fs.statSync(tokenFile);
    expect(st.mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token).toBe(token);
  });

  it('only SELECT statements are sent', async () => {
    const s = mockServer('t');
    const client = new HistoryClient({ fetchImpl: s.f, tokenFile: path.join(tmpDir(), 'i.json'), log: () => {} });
    await expect(client.query('CALL submit_bid(1, 2)')).rejects.toThrow(/only SELECT/);
    expect(s.state.sqlRequests).toBe(0);
  });
});
