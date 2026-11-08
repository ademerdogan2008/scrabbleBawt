// Offline loss-learning cycle (src/learn/cycle): diagnosis, candidate clamping, gate decision,
// pool rules, cycle/watch idempotence. No network, no live client; sims are stubbed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPolicy } from '../../src/bots/registry.js';
import type { MatchConfig } from '../../src/core/types.js';
import { generateCandidates, steppable } from '../../src/learn/cycle/candidates.js';
import { acquireLock, releaseLock, runCycle, watch, type CycleOptions } from '../../src/learn/cycle/cycle.js';
import { diagnose, renderDiagnosis, type Diagnosis } from '../../src/learn/cycle/diagnose.js';
import { decideGate, focalSpec, gateLineups, MIRROR, type EvalResults, type Evaluator, type FocalOutcome } from '../../src/learn/cycle/gate.js';
import { averageRank, backfill, isLoss, parseLogLines, summarizeMatch, type MatchSummary } from '../../src/learn/cycle/ingest.js';
import { clampKnob, KNOBS, knobSpec, knobValues, paramsInBounds, PINNED_KNOBS, withKnobs } from '../../src/learn/arms.js';
import { mirrorLineup, specForPlayer } from '../../src/learn/cycle/mirror.js';
import { addArms, incumbentArm, updateArm as banditUpdate } from '../../src/learn/bandit.js';
import { rewardOf } from '../../src/learn/reward.js';
import { emptyState, loadStateStrict as loadState, saveState, type Arm, type LearnState } from '../../src/learn/store.js';

// ------------------------------------------------------------------------------- fixtures

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'learn-cycle-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CONFIG: MatchConfig = {
  matchId: 777,
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

/**
 * Synthetic lost match: we burn 90 coins on three vowels/consonants early (overspent), then lose
 * Q, Z, X to 'Rival' at exactly our bid (key-letter near misses). Rival scores 50, we 10, sim 5.
 */
function syntheticLog(matchId = 777, ended = true): string {
  const cfg = { ...CONFIG, matchId };
  const lines: Array<Record<string, unknown>> = [];
  let ts = 1_794_000_000_000;
  const put = (r: Record<string, unknown>) => lines.push({ ts: ts++, matchId, ...r });
  put({ k: 'event', e: { t: 'start', config: cfg, myStartRack: 'ADENS' } });
  const auctions: Array<[string, number | null, number, number]> = [
    // letter, winner, paid, our bid
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
  put({ k: 'event', e: { t: 'balance', id: 2, balance: 100 - 26 + 50, score: 50 } });
  put({ k: 'event', e: { t: 'balance', id: 3, balance: 105, score: 5 } });
  if (ended) put({ k: 'info', msg: 'match ended', source: 'live', score: 10, balance: 10, unplayed: { rack: 'EIRT', letters: 4, value: 4 } });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function summary(matchId = 777): MatchSummary {
  return summarizeMatch(parseLogLines(syntheticLog(matchId)).records)!;
}

function arm(id: string, alpha: number, beta: number, extra: Partial<Arm> = {}): Arm {
  return { id, params: { tableScale: 0.7 + 0.01 * id.length + alpha / 100 }, origin: 'cycle', createdAt: 'x', alpha, beta, plays: 1, ...extra };
}

const outcome = (rank: number, win = rank === 1): FocalOutcome => ({ rank, win, score: 100 - rank });
const repeat = <T>(n: number, f: (k: number) => T): T[] => Array.from({ length: n }, (_, k) => f(k));

// ------------------------------------------------------------------------------- ingest

describe('ingest', () => {
  it('summarizes a finished log: rank, reward, bids and balance at open', () => {
    const s = summary();
    expect(s.matchId).toBe(777);
    expect(s.won).toBe(false);
    expect(s.rank).toBe(2);
    expect(s.reward).toBeCloseTo(0.35);
    expect(s.winner.name).toBe('Rival');
    expect(s.me.balance).toBe(10);
    expect(s.auctions).toHaveLength(7);
    expect(s.auctions[3]).toMatchObject({ letter: 'Q', winnerId: 2, paid: 9, myBid: 9, myBalance: 10 });
    expect(s.unplayedTiles).toBe(4);
  });

  it('ignores unfinished logs and half-written lines', () => {
    expect(summarizeMatch(parseLogLines(syntheticLog(777, false)).records)).toBeUndefined();
    const text = syntheticLog() + '{"ts":1,"matchId":777,"k":"ev';
    const p = parseLogLines(text);
    expect(p.bad).toBe(1);
    expect(summarizeMatch(p.records)?.matchId).toBe(777);
  });

  it('averages tied ranks and maps them to a reward in [0,1]', () => {
    expect(averageRank([10, 10, 5], 10)).toBe(1.5);
    expect(averageRank([10, 20, 20, 5], 10)).toBe(4 - 1);
    expect(rewardOf(1, 6)).toBe(1);
    expect(rewardOf(6, 6)).toBe(0);
    expect(rewardOf(2.5, 4)).toBeCloseTo(0.225);
  });

  it('backfills only logs older than the grace period, once', () => {
    const s = emptyState();
    const sum = summary();
    expect(backfill(s, [sum], new Map([[777, 1_000]]), 1_500, 1_000)).toEqual([]);
    expect(backfill(s, [sum], new Map([[777, 1_000]]), 5_000, 1_000)).toEqual([777]);
    expect(backfill(s, [sum], new Map([[777, 1_000]]), 9_000, 1_000)).toEqual([]);
    expect(s.matches).toHaveLength(1);
    expect(s.arms[0]!.plays).toBe(1);
    expect(s.arms[0]!.alpha).toBeCloseTo(1.35);
  });
});

// ------------------------------------------------------------- merged live/offline contract

describe('live/offline contract', () => {
  it('does not backfill a match we never played in (no decisions), like the live learner', () => {
    const text = syntheticLog(779)
      .split('\n')
      .filter((l) => !l.includes('"k":"decision"') && !l.includes('"k":"submit"'))
      .join('\n');
    const sum = summarizeMatch(parseLogLines(text).records)!;
    expect(sum.decisions).toBe(0);
    const s = emptyState();
    expect(backfill(s, [sum], new Map([[779, 0]]), 1e12, 1)).toEqual([]);
    expect(summary().decisions).toBe(7);
  });

  it('counts a shared top score as neither a win nor a loss', () => {
    expect(isLoss({ rank: 1.5, won: false, score: 10, bestOtherScore: 10 })).toBe(false);
    expect(isLoss({ rank: 2, won: false, score: 9, bestOtherScore: 10 })).toBe(true);
    expect(isLoss({ rank: 1, won: true, score: 11, bestOtherScore: 10 })).toBe(false);
  });

  it('plays cycle arms through bawt-arm (LEARNABLE vocabulary only)', () => {
    expect(focalSpec({})).toBe('bawt');
    expect(focalSpec({ denyScale: 0.8 })).toBe('bawt-arm:{"denyScale":0.8}');
    expect(() => createPolicy('bawt-arm:{"denyScale":0.8,"tableScale":1.1}', 1)).not.toThrow();
    expect(() => createPolicy('bawt-arm:{"mcSamples":3}', 1)).toThrow(/not a learnable knob/);
  });

  it('strict load leaves a corrupt state file untouched', () => {
    const p = join(tmp(), 'state.json');
    writeFileSync(p, '{"version":1,"arms":');
    expect(() => loadState(p)).toThrow();
    expect(readFileSync(p, 'utf8')).toBe('{"version":1,"arms":');
  });
});

// ---------------------------------------------------------------------------- diagnosis

describe('diagnose', () => {
  it('explains a synthetic loss: overspent early, key letters lost to Rival, overpaid', () => {
    const d = diagnose(summary());
    const cats = d.findings.map((f) => f.category);
    expect(cats).toContain('overspent-early');
    expect(cats).toContain('lost-key-letters-to-X');
    expect(cats).toContain('opponent-mispriced');
    expect(cats).not.toContain('underspent-hoarded-cash');
    expect(cats).not.toContain('denial-missing');
    expect(d.findings.find((f) => f.category === 'lost-key-letters-to-X')!.target).toBe('Rival');
    expect(d.minBalanceFirstHalf).toBe(10);
    expect(d.nearMisses.map((m) => m.letter)).toEqual(['Q', 'Z', 'X']);
    expect(d.overpays).toHaveLength(3);
    expect(d.winner.name).toBe('Rival');
    const md = renderDiagnosis(d);
    expect(md).toContain('Loss 777');
    expect(md).toContain('lost-key-letters-to-Rival');
  });

  it('flags hoarded cash and an uncashed rack', () => {
    const s = summary();
    const hoard: MatchSummary = { ...s, me: { ...s.me, balance: 60 }, unplayedValue: 15, unplayedTiles: 5, auctions: s.auctions.map((r) => ({ ...r, myBalance: 80 })) };
    const cats = diagnose(hoard).findings.map((f) => f.category);
    expect(cats).toContain('underspent-hoarded-cash');
    expect(cats).toContain('words-not-cashed');
    expect(cats).not.toContain('overspent-early');
  });
});

// --------------------------------------------------------------------------- candidates

describe('candidates', () => {
  const diag = (): Diagnosis => diagnose(summary());

  it('clamps every knob to its range', () => {
    for (const k of KNOBS) {
      expect(clampKnob(k.name, 1e9)).toBe(k.hi);
      expect(clampKnob(k.name, -1e9)).toBe(k.lo);
      expect(clampKnob(k.name, Number.NaN)).toBe(k.base);
    }
    const p = withKnobs({ tableScale: 9, mcSamples: 64 }, { lambdaScale: 0.1, denyScale: 5 });
    expect(p).toEqual({ tableScale: 1.3, lambdaScale: 0.7, denyScale: 1.3 });
    expect(paramsInBounds(p)).toBe(true);
    expect(paramsInBounds({ mcSamples: 64 })).toBe(false);
    expect(paramsInBounds({ tableScale: 2 })).toBe(false);
    expect(paramsInBounds({ denyWeights: { '2': 1 } })).toBe(false);
  });

  it('proposes 2-4 bounded candidates from an incumbent at the range edges', () => {
    const inc = { tableScale: 1.3, lambdaScale: 0.7, kappaLo: 0.42, incomeShare: 0.245 };
    const cands = generateCandidates(inc, [diag()], { config: CONFIG, seed: 42 });
    expect(cands.length).toBeGreaterThanOrEqual(2);
    expect(cands.length).toBeLessThanOrEqual(4);
    for (const c of cands) {
      expect(paramsInBounds(c.params)).toBe(true);
      for (const k of KNOBS) {
        const v = knobValues(c.params)[k.name];
        expect(v).toBeGreaterThanOrEqual(k.lo - 1e-9);
        expect(v).toBeLessThanOrEqual(k.hi + 1e-9);
      }
      expect(() => createPolicy(focalSpec(c.params), 1)).not.toThrow();
    }
    expect(cands.some((c) => c.label === 'random')).toBe(true);
    expect(new Set(cands.map((c) => JSON.stringify(c.params))).size).toBe(cands.length);
  });

  it('is deterministic for a seed and leaves profile-pinned knobs alone unless the incumbent pins them', () => {
    const a = generateCandidates({}, [diag()], { config: CONFIG, seed: 7 });
    const b = generateCandidates({}, [diag()], { config: CONFIG, seed: 7 });
    expect(a).toEqual(b);
    expect([...PINNED_KNOBS].sort()).toEqual(['floorA', 'floorB', 'kappaHi', 'reserve']);
    for (const c of a) for (const k of PINNED_KNOBS) expect(k in c.params).toBe(false);
    expect(steppable({ kappaHi: 2.5 }).has('kappaHi')).toBe(true);
    const pinned = generateCandidates({ kappaHi: 2.5 }, [diag()], { config: CONFIG, seed: 7 });
    const dirn = pinned.find((c) => c.label === 'primary:overspent-early' || c.label === 'diagnosed')!;
    expect(dirn.params.kappaHi as number).toBeLessThan(2.5);
    expect(knobSpec('kappaHi').lo).toBeLessThanOrEqual(dirn.params.kappaHi as number);
  });
});

// --------------------------------------------------------------------------------- gate

describe('gate decision', () => {
  const lineups = gateLineups(['*', 'clone:lucent', 'sim:ValueBidder']);
  const N = 60;
  const inc: FocalOutcome[][] = lineups.map((l) => repeat(N, (k) => outcome(l.name === 'lobbySims' ? 1 : 1 + (k % 3))));

  it('uses the four standard lineups plus the live mirror', () => {
    expect(lineups.map((l) => l.name)).toEqual(['lobbyNow', 'lobbySims', 'fullTable', 'tricks', MIRROR]);
  });

  it('passes a candidate that is equal everywhere and better on the live mirror', () => {
    const cand = lineups.map((l, li) => inc[li]!.map((o, k) => (l.name === MIRROR && o.rank > 1 && k % 2 === 0 ? outcome(o.rank - 1) : o)));
    const g = decideGate(inc, cand, lineups);
    expect(g.reasons).toEqual([]);
    expect(g.pass).toBe(true);
    expect(g.gate.meanRankDelta).toBeLessThan(0);
    expect(g.gate.ciHi).toBeLessThanOrEqual(0.1);
    expect(g.gate.lobbySimsWin).toBe(1);
    expect(g.gate.matches).toBe(N);
  });

  it('rejects a candidate that wins no more often', () => {
    const g = decideGate(inc, inc, lineups);
    expect(g.pass).toBe(false);
    expect(g.reasons.join()).toMatch(/pooled win gain/);
  });

  it('rejects a significant regression on any lineup even if the mirror improves', () => {
    const cand = lineups.map((l, li) =>
      inc[li]!.map((o) => (l.name === MIRROR && o.rank > 1 ? outcome(o.rank - 1) : l.name === 'fullTable' ? outcome(Math.min(6, o.rank + 1)) : o)),
    );
    const g = decideGate(inc, cand, lineups);
    expect(g.pass).toBe(false);
    expect(g.reasons.join()).toMatch(/fullTable significantly fewer wins/);
  });

  it('rejects when lobbySims win rate drops below 98%', () => {
    const cand = lineups.map((l, li) =>
      inc[li]!.map((o, k) => (l.name === MIRROR && o.rank > 1 ? outcome(o.rank - 1) : l.name === 'lobbySims' && k < 3 ? outcome(2) : o)),
    );
    const g = decideGate(inc, cand, lineups);
    expect(g.pass).toBe(false);
    expect(g.reasons.join()).toMatch(/lobbySims win 95\.0% < 98%/);
  });
});

// --------------------------------------------------------------------------------- pool

describe('pool', () => {
  it('keeps at most 6 active arms, retiring the lowest posterior mean (never default)', () => {
    const s = emptyState();
    s.arms[0]!.alpha = 1;
    s.arms[0]!.beta = 9; // default is the worst arm but must survive
    s.arms.push(arm('a', 5, 1), arm('bb', 2, 3), arm('ccc', 3, 1), arm('dddd', 4, 2), arm('eeeee', 1, 2));
    const fresh = [arm('n1', 1, 1, { params: { tableScale: 1.1 } }), arm('n2', 1, 1, { params: { tableScale: 1.2 } })];
    const ch = addArms(s, fresh);
    expect(ch.added).toEqual(['n1', 'n2']);
    expect(ch.retired.sort()).toEqual(['bb', 'eeeee']);
    expect(s.arms.filter((a) => !a.retired)).toHaveLength(6);
    expect(s.arms.find((a) => a.id === 'default')!.retired).toBeFalsy();
  });

  it('drops the worst newcomer when only default and newcomers are active', () => {
    const s = emptyState();
    const fresh = repeat(7, (i) => arm(`n${i}`, 1, 1, { params: { tableScale: 0.8 + i / 100 }, gate: { lineups: [], matches: 1, meanRankDelta: -i / 10, ciLo: 0, ciHi: 0, lobbySimsWin: 1 } }));
    const ch = addArms(s, fresh);
    expect(s.arms.filter((a) => !a.retired)).toHaveLength(6);
    expect(ch.retired).toEqual(['n0', 'n1']);
    expect(ch.added).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('skips duplicate params, including retired arms', () => {
    const s = emptyState();
    s.arms.push(arm('old', 1, 1, { params: { tableScale: 1.1 }, retired: true }));
    const ch = addArms(s, [arm('new', 1, 1, { params: { tableScale: 1.1 } }), arm('default', 1, 1)]);
    expect(ch.added).toEqual([]);
    expect(ch.skipped.map((x) => x.id)).toEqual(['new', 'default']);
  });

  it('applies the discounted bandit update and picks the eligible incumbent', () => {
    const s = emptyState();
    s.arms.push(arm('gated', 3, 1, { gate: { lineups: [], matches: 200, meanRankDelta: -0.1, ciLo: -0.2, ciHi: 0, lobbySimsWin: 1 } }));
    s.arms.push(arm('ungated', 9, 1));
    expect(incumbentArm(s).id).toBe('gated');
    banditUpdate(s, 'default', 1);
    const g = s.arms.find((a) => a.id === 'gated')!;
    expect(g.alpha).toBeCloseTo(1 + 0.97 * 2);
    expect(s.arms[0]!.alpha).toBeCloseTo(2);
    expect(s.arms[0]!.plays).toBe(1);
    expect(banditUpdate(s, 'nope', 1)).toBe(false);
  });

  it('round-trips the state file atomically and recreates the default arm', () => {
    const d = tmp();
    const p = join(d, 'nested', 'state.json');
    expect(loadState(p).arms.map((a) => a.id)).toEqual(['default']);
    const s: LearnState = emptyState();
    s.arms = [arm('x', 2, 2)];
    saveState(s, p);
    const back = loadState(p);
    expect(back.arms.map((a) => a.id).sort()).toEqual(['default', 'x']);
    writeFileSync(p, '{not json');
    expect(() => loadState(p)).toThrow();
  });
});

// ------------------------------------------------------------------------------- mirror

describe('live mirror', () => {
  it('maps live names to registry specs', () => {
    expect(specForPlayer({ name: 'LUCENT', isSim: false })).toBe('clone:lucent');
    expect(specForPlayer({ name: 'maverick-bot', isSim: false })).toBe('clone:maverick');
    expect(specForPlayer({ name: 'K-13', isSim: false })).toBe('clone:k13');
    expect(specForPlayer({ name: 'Aggressive-sim', isSim: true })).toBe('sim:Aggressive');
    expect(specForPlayer({ name: 'odd', isSim: true, simStrategy: 'Cheapskate' })).toBe('sim:Cheapskate');
    expect(specForPlayer({ name: 'mystery-sim', isSim: true })).toBe('sim:ValueBidder');
    expect(specForPlayer({ name: 'Waupus', isSim: false })).toBe('profile:Waupus');
    expect(specForPlayer({ name: 'NeverSeenBot123', isSim: false })).toBe('clone:fieldVolume');
  });

  it('builds the most common table from recent matches', () => {
    const m = (names: string[]) => ({ myId: 1, players: [{ id: 1, name: 'Malicious', isSim: false }, ...names.map((n, i) => ({ id: i + 2, name: n, isSim: n.endsWith('-sim') }))] });
    const l = mirrorLineup([m(['LUCENT', 'Bron', 'Aggressive-sim', 'Aggressive-sim', 'X']), m(['LUCENT', 'Bron', 'Aggressive-sim', 'Y', 'Z']), m(['LUCENT'])]);
    expect(l).toEqual(['*', 'clone:fieldVolume', 'clone:fieldVolume', 'clone:lucent', 'sim:Aggressive', 'sim:Aggressive']);
    expect(mirrorLineup([])).toBeUndefined();
  });
});

// ------------------------------------------------------------------- cycle and watch loop

function stubEvaluator(calls: { n: number; focals: string[][] }): Evaluator {
  // incumbent: rank 2 on the mirror; candidate #1 improves the mirror, the others are unchanged
  return async (focals, lineups, o) => {
    calls.n++;
    calls.focals.push([...focals]);
    const out: EvalResults = focals.map((_, fi) =>
      lineups.map((l) => repeat(o.matches, (k) => (l.name === 'lobbySims' ? outcome(1) : l.name === MIRROR && fi === 1 && k % 2 === 0 ? outcome(1) : outcome(2)))),
    );
    return out;
  };
}

function cycleOpts(root: string, evaluator: Evaluator): CycleOptions {
  return {
    statePath: join(root, 'state.json'),
    logsDir: join(root, 'live'),
    journalPath: join(root, 'LEARNING.md'),
    matches: 40,
    workers: 0,
    graceMs: 0,
    evaluator,
  };
}

function writeLog(root: string, matchId: number): void {
  mkdirSync(join(root, 'live'), { recursive: true });
  const f = join(root, 'live', `match-${matchId}.jsonl`);
  writeFileSync(f, syntheticLog(matchId));
  const old = new Date(Date.now() - 600_000);
  utimesSync(f, old, old);
}

describe('cycle', () => {
  it('diagnoses a new loss, gates candidates and adds only the passing one; a rerun is idle', async () => {
    const root = tmp();
    writeLog(root, 777);
    writeFileSync(join(root, 'live', 'match-778.jsonl'), syntheticLog(778, false)); // in progress
    const calls = { n: 0, focals: [] as string[][] };
    const o = cycleOpts(root, stubEvaluator(calls));
    const r = await runCycle(o);
    expect(r.status).toBe('done');
    expect(r.backfilled).toEqual([777]);
    expect(r.analyzed).toEqual([777]);
    expect(r.incumbent).toBe('default');
    expect(calls.n).toBe(1);
    expect(calls.focals[0]![0]).toBe('bawt');
    const passed = r.outcomes.filter((x) => x.gate.pass);
    expect(passed).toHaveLength(1);
    expect(r.outcomes.length).toBeGreaterThanOrEqual(2);
    const s = loadState(o.statePath);
    const added = s.arms.find((a) => a.id === passed[0]!.armId)!;
    expect(added).toMatchObject({ origin: 'cycle', parent: 'default', plays: 0, beta: 1 });
    expect(added.gate!.lineups).toContain(MIRROR);
    expect(added.alpha).toBeGreaterThan(1);
    expect(paramsInBounds(added.params)).toBe(true);
    expect(s.matches.find((m) => m.matchId === 777)!.analyzed).toBe(true);
    expect(s.matches.some((m) => m.matchId === 778)).toBe(false);
    const journal = readFileSync(o.journalPath, 'utf8');
    expect(journal).toContain('Loss 777');
    expect(journal).toContain('**accepted**');
    expect(journal).toContain('**rejected**');

    const again = await runCycle(o);
    expect(again.status).toBe('idle');
    expect(calls.n).toBe(1);
    expect(readFileSync(o.journalPath, 'utf8')).toBe(journal);
  });

  it('watch loop runs one cycle per new loss and never re-analyses', async () => {
    const root = tmp();
    writeLog(root, 801);
    const calls = { n: 0, focals: [] as string[][] };
    const o = cycleOpts(root, stubEvaluator(calls));
    const h = watch(o, 25);
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => calls.n >= 1);
    await new Promise((r) => setTimeout(r, 120)); // several idle polls
    expect(calls.n).toBe(1);
    writeLog(root, 802);
    await until(() => calls.n >= 2);
    await new Promise((r) => setTimeout(r, 120));
    h.stop();
    await h.done;
    expect(calls.n).toBe(2);
    const s = loadState(o.statePath);
    expect(s.matches.map((m) => [m.matchId, m.analyzed])).toEqual([
      [801, true],
      [802, true],
    ]);
    expect(existsSync(`${o.statePath}.cycle.lock`)).toBe(false);
  });

  it('holds an exclusive lock and takes over a dead holder', () => {
    const p = join(tmp(), 'l', 'cycle.lock');
    expect(acquireLock(p)).toBe(true);
    expect(acquireLock(p)).toBe(false);
    releaseLock(p);
    expect(acquireLock(p)).toBe(true);
    releaseLock(p);
    writeFileSync(p, '999999999');
    expect(acquireLock(p)).toBe(true);
    releaseLock(p);
  });
});
