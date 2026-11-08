// State-file lock and record cap: the live client and the learn-cycle watcher both
// read-modify-write .cache/learn/state.json; neither may lose the other's update, and records
// dropped by the cap must never be backfilled (re-learned) again.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { backfill, type MatchSummary } from '../../src/learn/cycle/ingest.js';
import {
  emptyState,
  isKnownMatch,
  loadStateStrict,
  normalizeState,
  trimMatches,
  updateState,
  withStateLock,
  type MatchRecord,
} from '../../src/learn/store.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'learn-lock-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const rec = (matchId: number): MatchRecord => ({
  matchId,
  armId: 'default',
  endedAt: '2026-11-07T00:00:00.000Z',
  players: 2,
  realPlayers: 2,
  rank: 2,
  score: 1,
  bestOtherScore: 2,
  won: false,
  reward: 0,
  opponents: ['x'],
});

describe('state lock', () => {
  it('runs fn under <path>.lock and releases it', () => {
    const p = join(tmp(), 'state.json');
    const seen = withStateLock(p, () => existsSync(`${p}.lock`));
    expect(seen).toBe(true);
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('releases the lock when fn throws', () => {
    const p = join(tmp(), 'state.json');
    expect(() =>
      withStateLock(p, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('takes over a lock left by a dead process at once', () => {
    const p = join(tmp(), 'state.json');
    writeFileSync(`${p}.lock`, '999999');
    const t0 = Date.now();
    updateState(p, (s) => s.matches.push(rec(1)), { timeoutMs: 5000 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(loadStateStrict(p).matches.map((m) => m.matchId)).toEqual([1]);
    expect(existsSync(`${p}.lock`)).toBe(false);
  });

  it('waits for a live holder, then takes over after timeoutMs (never wedges)', () => {
    const p = join(tmp(), 'state.json');
    writeFileSync(`${p}.lock`, String(process.ppid));
    const t0 = Date.now();
    updateState(p, (s) => s.matches.push(rec(2)), { timeoutMs: 80 });
    const dt = Date.now() - t0;
    expect(dt).toBeGreaterThanOrEqual(70);
    expect(dt).toBeLessThan(2000);
    expect(loadStateStrict(p).matches.map((m) => m.matchId)).toEqual([2]);
  });

  it('two processes incrementing concurrently lose no update', async () => {
    const d = tmp();
    const p = join(d, 'state.json');
    const n = 150;
    const store = resolve(__dirname, '../../src/learn/store.ts');
    const child = join(d, 'child.mts');
    writeFileSync(
      child,
      `import { updateState } from ${JSON.stringify(store)};\n` +
        `for (let i = 0; i < ${n}; i++) updateState(${JSON.stringify(p)}, (s) => { s.matches.push({ matchId: 100000 + i, armId: 'default', endedAt: 'x', players: 2, realPlayers: 2, rank: 1, score: 1, bestOtherScore: 0, won: true, reward: 1, opponents: [] }); });\n`,
    );
    const tsx = resolve(__dirname, '../../node_modules/.bin/tsx');
    const proc = spawn(tsx, [child], { stdio: 'ignore' });
    let code: number | null | undefined;
    const exited = new Promise<void>((res) =>
      proc.on('exit', (c) => {
        code = c;
        res();
      }),
    );
    // interleave with the child: our own increments for as long as it runs
    let mine = 0;
    while (code === undefined) {
      updateState(p, (s) => s.matches.push(rec(mine)));
      mine++;
      await new Promise((r) => setImmediate(r));
    }
    await exited;
    expect(code).toBe(0);
    const ids = loadStateStrict(p).matches.map((m) => m.matchId);
    expect(ids).toHaveLength(mine + n);
  }, 30_000);
});

describe('record cap', () => {
  it('trimMatches remembers the highest dropped id and normalizeState keeps it', () => {
    const s = emptyState();
    for (let i = 1; i <= 10; i++) s.matches.push(rec(i));
    trimMatches(s, 4);
    expect(s.matches.map((m) => m.matchId)).toEqual([7, 8, 9, 10]);
    expect(s.trimmedThrough).toBe(6);
    expect(isKnownMatch(s, 3)).toBe(true);
    expect(isKnownMatch(s, 8)).toBe(true);
    expect(isKnownMatch(s, 11)).toBe(false);
    expect(normalizeState(JSON.parse(JSON.stringify(s)))!.trimmedThrough).toBe(6);
  });

  it('backfill never re-learns a trimmed match', () => {
    const s = emptyState();
    s.trimmedThrough = 50;
    const sum = (matchId: number) => ({ matchId, decisions: 3, config: { players: [] }, others: [], me: { score: 1 }, armId: 'default', endedAt: 'x', rank: 1, won: true, reward: 1 }) as unknown as MatchSummary;
    const out = backfill(s, [sum(40), sum(60)], new Map([[40, 0], [60, 0]]), 1e12, 1);
    expect(out).toEqual([60]);
    expect(s.arms[0]!.plays).toBe(0); // 0-player summaries: no bandit update, but recorded once
    expect(s.matches.map((m) => m.matchId)).toEqual([60]);
  });
});
