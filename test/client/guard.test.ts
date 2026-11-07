import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BINDING_REDUCERS,
  callReducer,
  GAME_REDUCERS,
  isBlocked,
  MaincloudGuardError,
  reducerAccessor,
} from '../../src/client/guard.js';

const CLIENT_DIR = join(__dirname, '..', '..', 'src', 'client');

function fakeConn() {
  const calls: Array<[string, unknown]> = [];
  const reducers = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (args: unknown) => {
          calls.push([prop, args]);
          return Promise.resolve();
        };
      },
    },
  );
  return { conn: { reducers }, calls };
}

/** Reducer names declared in the vendored bindings (`__reducerSchema("name", ...)`). */
function bindingReducerNames(): string[] {
  const src = readFileSync(join(CLIENT_DIR, 'module_bindings', 'index.ts'), 'utf8');
  return [...src.matchAll(/__reducerSchema\("([a-z0-9_]+)"/g)].map((m) => m[1]!).sort();
}

function clientSources(dir = CLIENT_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'module_bindings') continue;
      out.push(...clientSources(p));
    } else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const MAINCLOUD_HOSTS = [
  'https://maincloud.spacetimedb.com',
  'wss://maincloud.spacetimedb.com',
  'https://other.spacetimedb.com',
  'https://spacetimedb.com',
];

describe('maincloud guard', () => {
  it('BINDING_REDUCERS is exactly the bindings reducer list', () => {
    expect([...BINDING_REDUCERS].sort()).toEqual(bindingReducerNames());
    expect(bindingReducerNames().length).toBe(27);
  });

  it('every game reducer named by the plan is covered', () => {
    for (const r of [
      'join_lobby',
      'leave_lobby',
      'submit_bid',
      'submit_word',
      'register_for_tournament',
      'unregister_from_tournament',
      'claim_credential',
      'create_team',
      'mint_credential_nonce',
    ]) {
      expect(GAME_REDUCERS).toContain(r);
    }
    for (const r of BINDING_REDUCERS) expect(GAME_REDUCERS).toContain(r);
  });

  it.each(MAINCLOUD_HOSTS)('blocks every reducer on %s without ALLOW_MAINCLOUD_PLAY and never touches conn', (host) => {
    for (const name of [...GAME_REDUCERS, 'some_future_reducer']) {
      const { conn, calls } = fakeConn();
      const get = vi.fn();
      const spyConn = { get reducers() { get(); return conn.reducers; } };
      expect(() => callReducer(spyConn, name, {}, { host }, { env: {} })).toThrow(MaincloudGuardError);
      expect(() => callReducer(spyConn, name, {}, { host }, { env: { ALLOW_MAINCLOUD_PLAY: 'true' } })).toThrow(
        MaincloudGuardError,
      );
      expect(get).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    }
  });

  it('blocks when the target is flagged maincloud even if the host string looks local', () => {
    const { conn } = fakeConn();
    expect(() =>
      callReducer(conn, 'submit_bid', {}, { host: 'http://127.0.0.1:3000', isMaincloud: true }, { env: {} }),
    ).toThrow(MaincloudGuardError);
  });

  it('defaults to process.env when no env is passed', () => {
    const { conn } = fakeConn();
    const prev = process.env.ALLOW_MAINCLOUD_PLAY;
    delete process.env.ALLOW_MAINCLOUD_PLAY;
    try {
      expect(() => callReducer(conn, 'submit_bid', {}, { host: MAINCLOUD_HOSTS[0]! })).toThrow(MaincloudGuardError);
    } finally {
      if (prev !== undefined) process.env.ALLOW_MAINCLOUD_PLAY = prev;
    }
  });

  it.each(['http://127.0.0.1:3000', 'ws://localhost:3000', 'http://[::1]:3000'])('passes through on %s', async (host) => {
    const { conn, calls } = fakeConn();
    await callReducer(conn, 'submit_bid', { auctionId: 5n, amount: 3n }, { host }, { env: {} });
    await callReducer(conn, 'join_lobby', {}, { host }, { env: {} });
    expect(calls).toEqual([
      ['submitBid', { auctionId: 5n, amount: 3n }],
      ['joinLobby', {}],
    ]);
  });

  it('ALLOW_MAINCLOUD_PLAY=1 passes through on maincloud', async () => {
    const { conn, calls } = fakeConn();
    await callReducer(conn, 'submit_word', { matchId: 1n, word: 'CAT' }, { host: MAINCLOUD_HOSTS[0]! }, {
      env: { ALLOW_MAINCLOUD_PLAY: '1' },
    });
    expect(calls).toEqual([['submitWord', { matchId: 1n, word: 'CAT' }]]);
    expect(isBlocked('submit_word', { host: MAINCLOUD_HOSTS[0]! }, { env: { ALLOW_MAINCLOUD_PLAY: '1' } })).toBe(false);
  });

  it('unknown reducer accessor throws on loopback', () => {
    expect(() => callReducer({ reducers: {} }, 'nope', {}, { host: 'http://127.0.0.1:3000' }, { env: {} })).toThrow(
      /unknown reducer/,
    );
  });

  it('reducerAccessor maps snake_case to the SDK camelCase accessors', () => {
    expect(reducerAccessor('submit_bid')).toBe('submitBid');
    expect(reducerAccessor('backfill_top_bid_archive')).toBe('backfillTopBidArchive');
    expect(reducerAccessor('join_lobby')).toBe('joinLobby');
  });

  it('no client source outside guard.ts calls conn.reducers.* directly', () => {
    const offenders: string[] = [];
    for (const file of clientSources()) {
      if (file.endsWith(`${'/'}guard.ts`)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (/\.reducers\b/.test(l)) offenders.push(`${relative(CLIENT_DIR, file)}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
    expect(clientSources().length).toBeGreaterThan(3);
  });
});
