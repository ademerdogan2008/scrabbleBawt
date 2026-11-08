// Live-only loss cycle (src/learn/cycle/live.ts): rate limit, untested-arm cap, dedupe, retire
// rule, live-only gate eligibility, and one end-to-end cycle on a synthetic loss.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { paramsInBounds } from '../../src/learn/arms.js';
import { activeArms, isEligible } from '../../src/learn/bandit.js';
import { runCycle, type CycleOptions } from '../../src/learn/cycle/cycle.js';
import {
  addLiveArms,
  liveCandidates,
  liveCapacity,
  liveOnlyGate,
  markerPath,
  paramsEqual,
  rateLimitOk,
  readMarker,
  retireVictim,
  untestedArms,
} from '../../src/learn/cycle/live.js';
import { emptyState, loadStateStrict, saveState, type Arm, type LearnState, type MatchRecord } from '../../src/learn/store.js';
import type { Diagnosis } from '../../src/learn/cycle/diagnose.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'learn-live-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function arm(id: string, plays: number, alpha = 1, beta = 1, params: Record<string, unknown> = { tableScale: 0.7 + [...id].reduce((t, ch) => t + ch.charCodeAt(0), 0) / 2000 }): Arm {
  return { id, params, origin: 'cycle', createdAt: 'x', alpha, beta, plays, gate: liveOnlyGate() };
}

function rec(matchId: number, won = false): MatchRecord {
  return { matchId, armId: 'default', endedAt: 'x', players: 3, realPlayers: 2, rank: won ? 1 : 2, score: won ? 50 : 10, bestOtherScore: won ? 10 : 50, won, reward: won ? 1 : 0.35, opponents: ['Rival'] };
}

function stateWith(...arms: Arm[]): LearnState {
  const s = emptyState();
  s.arms[0]!.plays = 40;
  s.arms.push(...arms);
  return s;
}

describe('live-only gate stub', () => {
  it('makes a cycle arm live-eligible and active', () => {
    const s = stateWith(arm('a', 0));
    expect(isEligible(s.arms[1]!)).toBe(true);
    expect(activeArms(s).map((a) => a.id)).toContain('a');
    const { gate: _g, ...noGate } = s.arms[1]!;
    expect(isEligible(noGate)).toBe(false);
    expect(liveOnlyGate()).toMatchObject({ lineups: ['live-only'], matches: 1 });
  });
});

describe('rate limit', () => {
  it('runs the first time, then only after 3 new finished matches', () => {
    const s = emptyState();
    expect(rateLimitOk(s, undefined)).toBe(false); // nothing played yet
    s.matches.push(rec(10));
    expect(rateLimitOk(s, undefined)).toBe(true);
    const marker = { lastMatchId: 10 };
    s.matches.push(rec(11), rec(12));
    expect(rateLimitOk(s, marker)).toBe(false);
    s.matches.push(rec(13, true));
    expect(rateLimitOk(s, marker)).toBe(true);
  });
});

describe('pool rules', () => {
  it('never holds more than 2 untested arms', () => {
    const s = stateWith(arm('t1', 2));
    expect(liveCapacity(s)).toBe(1);
    const ch = addLiveArms(s, [arm('n1', 0), arm('n2', 0)]);
    expect(ch.added).toEqual(['n1']);
    expect(ch.skipped[0]!.reason).toMatch(/untested/);
    expect(untestedArms(s).map((a) => a.id).sort()).toEqual(['n1', 't1']);
    expect(liveCapacity(s)).toBe(0);
  });

  it('adds at most 2 per cycle', () => {
    const s = stateWith();
    const ch = addLiveArms(s, [arm('n1', 0), arm('n22', 0), arm('n333', 0)]);
    expect(ch.added).toEqual(['n1', 'n22']);
  });

  it('dedupes against existing arms (retired included) within 1e-9, and against each other', () => {
    const s = stateWith(arm('old', 9, 1, 1, { keyEdge: 1 }), { ...arm('gone', 9, 1, 1, { keyEdge: 2 }), retired: true });
    expect(paramsEqual({ keyEdge: 1 }, { keyEdge: 1 + 1e-12 })).toBe(true);
    expect(paramsEqual({ keyEdge: 1 }, { keyEdge: 1.001 })).toBe(false);
    expect(paramsEqual({ keyEdge: 1 }, { keyEdge: 1, endWindow: 0 })).toBe(false);
    const ch = addLiveArms(s, [arm('x1', 0, 1, 1, { keyEdge: 1 + 1e-12 }), arm('x2', 0, 1, 1, { keyEdge: 2 }), arm('x3', 0, 1, 1, { keyEdge: 3 }), arm('x4', 0, 1, 1, { keyEdge: 3 })]);
    expect(ch.added).toEqual(['x3']);
    expect(ch.skipped.map((x) => x.reason)).toEqual(['duplicate of old', 'duplicate of gone (retired)', 'duplicate of x3']);
  });

  it('when full, retires the lowest posterior mean among arms with >= 8 plays (never default)', () => {
    const s = stateWith(arm('a', 8, 3, 7), arm('bb', 20, 2, 9), arm('ccc', 7, 1, 20), arm('dddd', 9, 6, 4), arm('eeeee', 30, 5, 5));
    s.arms[0]!.alpha = 1;
    s.arms[0]!.beta = 50; // default is the worst, but must survive
    expect(retireVictim(s)!.id).toBe('bb'); // ccc is worse but has < 8 plays
    const ch = addLiveArms(s, [arm('n1', 0)]);
    expect(ch).toMatchObject({ added: ['n1'], retired: ['bb'] });
    expect(s.arms.filter((a) => !a.retired)).toHaveLength(6);
    expect(s.arms[0]!.retired).toBeFalsy();
  });

  it('skips adding when the pool is full and no arm qualifies for retirement', () => {
    const s = stateWith(arm('a', 7), arm('bb', 6), arm('ccc', 5), arm('dddd', 7), arm('eeeee', 6));
    expect(liveCapacity(s)).toBe(0);
    const ch = addLiveArms(s, [arm('n1', 0)]);
    expect(ch.added).toEqual([]);
    expect(ch.retired).toEqual([]);
    expect(ch.skipped[0]!.reason).toMatch(/pool full/);
  });
});

describe('live candidates', () => {
  const diag = (cats: Array<Diagnosis['primary']>) => ({ matchId: 1, findings: cats.map((category) => ({ category, strength: 1, evidence: '' })) }) as unknown as Diagnosis;

  it('puts keyEdge first on lost-key-letters, then phase; all bounded and different from the parent', () => {
    const parent = { keyEdge: 1 };
    const c = liveCandidates(parent, [diag(['lost-key-letters-to-X'])], { seed: 1 });
    expect(c[0]!.label).toBe('keyEdge');
    expect(c[0]!.params.keyEdge).toBe(2);
    expect(c[1]!.label).toBe('phase');
    expect(c[1]!.delta.earlyScale).toBeLessThan(0);
    expect(c[1]!.delta.endWindow).toBeGreaterThan(0);
    expect(c[1]!.delta.endKappaLo).toBeGreaterThan(0);
    for (const x of c) {
      expect(paramsInBounds(x.params)).toBe(true);
      expect(paramsEqual(x.params, parent)).toBe(false);
    }
  });

  it('starts with phase when no key letters were lost', () => {
    const c = liveCandidates({}, [diag(['overspent-early'])], { seed: 1 });
    expect(c[0]!.label).toBe('phase');
  });
});

// ------------------------------------------------------------------------- end to end

function syntheticLog(matchId: number): string {
  const config = {
    matchId,
    kind: 'lobby',
    auctionType: 'Vickrey',
    auctionDurationMs: 1000,
    startingRackSize: 5,
    startingBalance: 100,
    players: [
      { id: 1, name: 'Malicious', isSim: false },
      { id: 2, name: 'Rival', isSim: false },
      { id: 3, name: 'ValueBidder-sim', isSim: true, simStrategy: 'ValueBidder' },
    ],
    myId: 1,
    totalAuctions: 83,
  };
  const lines: Array<Record<string, unknown>> = [];
  let ts = 1_794_000_000_000;
  const put = (r: Record<string, unknown>) => lines.push({ ts: ts++, matchId, ...r });
  put({ k: 'event', e: { t: 'start', config, myStartRack: 'ADENS' } });
  const auctions: Array<[string, number | null, number, number]> = [
    ['E', 1, 30, 35],
    ['R', 1, 30, 35],
    ['T', 1, 30, 35],
    ['Q', 2, 9, 9],
    ['Z', 2, 9, 9],
    ['X', 2, 8, 8],
    ['I', null, 0, 0],
  ];
  auctions.forEach(([letter, winnerId, paid, bid], index) => {
    const auctionId = 5000 + index;
    put({ k: 'event', e: { t: 'open', auction: { auctionId, index, letter, opensAtMs: 0, closesAtMs: 1000, remainingAfter: 82 - index } } });
    put({ k: 'decision', auctionId, index, pass: 'refine', bid, words: [], decideMs: 1, budgetMs: 200, late: false });
    put({ k: 'submit', what: 'bid', auctionId, value: bid, outcome: 'ok', rttMs: 50 });
    put({ k: 'event', e: { t: 'result', outcome: { auctionId, index, letter, winnerId, paid } } });
  });
  put({ k: 'event', e: { t: 'balance', id: 2, balance: 124, score: 50 } });
  put({ k: 'event', e: { t: 'balance', id: 3, balance: 105, score: 5 } });
  put({ k: 'info', msg: 'match ended', source: 'live', score: 10, balance: 10, unplayed: { rack: 'EIRT', letters: 4, value: 4 } });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function writeLog(root: string, matchId: number): void {
  mkdirSync(join(root, 'live'), { recursive: true });
  const f = join(root, 'live', `match-${matchId}.jsonl`);
  writeFileSync(f, syntheticLog(matchId));
  const old = new Date(Date.now() - 600_000);
  utimesSync(f, old, old);
}

describe('live-only cycle', () => {
  it('diagnoses, adds <= 2 live arms without a sim gate, then waits for 3 new matches', async () => {
    const root = tmp();
    const o: CycleOptions = { statePath: join(root, 'state.json'), logsDir: join(root, 'live'), journalPath: join(root, 'LEARNING.md'), matches: 2, workers: 0, graceMs: 0, liveOnly: true };
    saveState(emptyState(), o.statePath);
    writeLog(root, 777);
    const r = await runCycle(o);
    expect(r.status).toBe('done');
    expect(r.outcomes).toEqual([]); // no sim gate
    expect(r.pool!.added.length).toBeGreaterThan(0);
    expect(r.pool!.added.length).toBeLessThanOrEqual(2);
    const s = loadStateStrict(o.statePath);
    for (const id of r.pool!.added) {
      const a = s.arms.find((x) => x.id === id)!;
      expect(a).toMatchObject({ origin: 'cycle', parent: 'default', plays: 0, alpha: 1, beta: 1 });
      expect(a.gate!.lineups).toEqual(['live-only']);
      expect(isEligible(a)).toBe(true);
      expect(paramsInBounds(a.params)).toBe(true);
    }
    expect(s.matches.find((m) => m.matchId === 777)!.analyzed).toBe(true);
    expect(readMarker(markerPath(o.statePath))!.lastMatchId).toBe(777);
    const journal = readFileSync(o.journalPath, 'utf8');
    expect(journal).toContain('Loss 777');
    expect(journal).toContain('live-only');

    // two more losses: rate limit holds (needs 3 new matches)
    writeLog(root, 778);
    writeLog(root, 779);
    const r2 = await runCycle(o);
    expect(r2.status).toBe('idle');
    expect(loadStateStrict(o.statePath).matches.filter((m) => !m.analyzed).map((m) => m.matchId)).toEqual([778, 779]);
    // third new match: cycle runs, but 2 untested arms already => nothing added
    writeLog(root, 780);
    const r3 = await runCycle(o);
    expect(r3.status).toBe('done');
    expect(r3.analyzed).toEqual([778, 779, 780]);
    expect(untestedArms(loadStateStrict(o.statePath)).length).toBeLessThanOrEqual(2);
  });
});
