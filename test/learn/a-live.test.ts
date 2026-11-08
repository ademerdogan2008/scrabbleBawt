import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { totalAuctions } from '../../src/core/letters.js';
import { hashSeed } from '../../src/core/rng.js';
import type { MatchConfig, PlayerInfo, Policy } from '../../src/core/types.js';
import { FieldModel, setFieldModelHook, BOOK_PRIOR_K } from '../../src/bots/bawt/opponents.js';
import type { BawtParams } from '../../src/bots/bawt/params.js';
import { createPolicy, parseSeat } from '../../src/bots/registry.js';
import { runMatch, type SeatSpec } from '../../src/sim/match.js';
import { startEvent, type MatchEvent } from '../../src/state/events.js';
import { bookPrior, factsFromEvents, updateBook } from '../../src/learn/book.js';
import { createLearningFactory, learningEnabled, type LearnHandle } from '../../src/learn/index.js';
import { emptyState, loadState, saveState, type Arm } from '../../src/learn/store.js';
import { learningFactory } from '../../src/client/main.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'learn-a-live-'));
  dirs.push(d);
  return d;
}
const handles: LearnHandle[] = [];
afterEach(() => {
  while (handles.length) handles.pop()!.dispose();
  setFieldModelHook(undefined);
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const me: PlayerInfo = { id: 1, name: 'bawt', isSim: false };
const bron: PlayerInfo = { id: 2, name: 'Bron', isSim: false };
const anon: PlayerInfo = { id: 3, name: 'someNewBot', isSim: false };
const sim: PlayerInfo = { id: 4, name: 'Aggressive-sim', isSim: true, simStrategy: 'Aggressive' };

function cfg(players: PlayerInfo[], matchId = 1): MatchConfig {
  return {
    matchId,
    auctionType: 'Vickrey',
    auctionDurationMs: 1000,
    startingRackSize: 5,
    startingBalance: 100,
    players,
    myId: 1,
    totalAuctions: totalAuctions(players.length, 5),
  };
}

describe('opponent book', () => {
  it('updates from a scripted event stream (real rivals by name; sims skipped)', () => {
    const c = cfg([me, bron, anon, sim]);
    const T = c.totalAuctions;
    const ev: MatchEvent[] = [startEvent(c, 'AEINR')];
    const results: Array<[string, number | null, number]> = [
      ['E', 2, 6],
      ['Q', 3, 20],
      ['S', 2, 8],
      ['A', 4, 3],
      ['Z', null, 0],
      ['E', 1, 4],
    ];
    results.forEach(([letter, winnerId, paid], k) => {
      ev.push({ t: 'open', auction: { auctionId: 100 + k, index: k, letter, opensAtMs: k * 1000, closesAtMs: k * 1000 + 1000, remainingAfter: T - k - 1 } });
      ev.push({ t: 'result', outcome: { auctionId: 100 + k, index: k, letter, winnerId, paid } });
    });
    ev.push({ t: 'balance', id: 1, balance: 90, score: 30 });
    ev.push({ t: 'balance', id: 2, balance: 80, score: 45 });
    ev.push({ t: 'balance', id: 3, balance: 70, score: 12 });
    ev.push({ t: 'balance', id: 4, balance: 60, score: 20 });
    const facts = factsFromEvents(ev);
    expect(facts.outcomes).toHaveLength(6);
    const s = emptyState();
    const t = new Date('2026-11-07T10:00:00Z');
    expect(updateBook(s, facts, t).sort()).toEqual(['Bron', 'someNewBot']);
    expect(Object.keys(s.book).sort()).toEqual(['Bron', 'someNewBot']);
    expect(s.book.Bron).toMatchObject({ matches: 1, wins: 1, avgScore: 45, lettersWon: 2, avgPricePaid: 7, updatedAt: t.toISOString() });
    expect(s.book.Bron!.pricesByLetter).toEqual({ E: { n: 1, mean: 6 }, S: { n: 1, mean: 8 } });
    expect(s.book.someNewBot).toMatchObject({ matches: 1, wins: 0, avgScore: 12, lettersWon: 1, avgPricePaid: 20 });

    // second match: running means, plus a calibration scale (only with enough observations)
    const scales = new Map([
      ['Bron', { logScale: 0.4, kind: 'profiled' as const, observed: 30 }],
      ['someNewBot', { logScale: -1, kind: 'market' as const, observed: 3 }],
    ]);
    updateBook(s, facts, t, scales);
    expect(s.book.Bron).toMatchObject({ matches: 2, wins: 2, lettersWon: 4, avgPricePaid: 7 });
    expect(s.book.Bron!.pricesByLetter.E).toEqual({ n: 2, mean: 6 });
    expect(s.book.Bron!.scale).toEqual({ n: 1, meanLog: 0.4, kind: 'profiled' });
    expect(s.book.someNewBot!.scale).toBeUndefined();
    updateBook(s, facts, t, new Map([['Bron', { logScale: 0.2, kind: 'profiled' as const, observed: 30 }]]));
    expect(s.book.Bron!.scale!.meanLog).toBeCloseTo(0.3, 12);
    expect(bookPrior(s.book.Bron, 'profiled')).toEqual({ logScale: s.book.Bron!.scale!.meanLog, n: 2 });
    expect(bookPrior(s.book.Bron, 'market')).toBeUndefined();
  });

  it('field model starts real rivals from the book prior, blended by count; no hook = unchanged', () => {
    const c = cfg([me, bron, anon, sim]);
    const plain = new FieldModel(c);
    expect(plain.opponents.map((o) => o.logScale)).toEqual(plain.opponents.map(() => plain.opponents[0]!.logScale));
    const seen: FieldModel[] = [];
    setFieldModelHook((config) =>
      config.matchId === 1
        ? {
            prior: (name, kind) => (name === 'Bron' && kind === 'profiled' ? { logScale: 0.5, n: 8 } : name === 'someNewBot' ? { logScale: -0.6, n: 6 } : undefined),
            attach: (f) => seen.push(f),
          }
        : undefined,
    );
    const f = new FieldModel(c);
    expect(seen).toEqual([f]);
    const b = f.get(2)!;
    const a = f.get(3)!;
    expect(b.kind).toBe('profiled');
    expect(a.kind).toBe('market');
    expect(b.priorCentre).toBeCloseTo((8 / (8 + BOOK_PRIOR_K.profiled)) * 0.5, 12);
    expect(a.priorCentre).toBeCloseTo((6 / (6 + BOOK_PRIOR_K.market)) * -0.6, 12);
    // the grid is asymmetric (log 0.3 .. log 3), so compare against the no-hook posterior mean
    expect(b.logScale - plain.get(2)!.logScale).toBeCloseTo(b.priorCentre, 1);
    expect(a.logScale).toBeLessThan(plain.get(3)!.logScale - 0.3);
    expect(f.get(4)!.priorCentre).toBe(0);
    // other matches: untouched, and a throwing hook never breaks the field model
    expect(new FieldModel(cfg([me, bron], 2)).get(2)!.priorCentre).toBe(0);
    setFieldModelHook(() => {
      throw new Error('boom');
    });
    expect(new FieldModel(c).get(2)!.priorCentre).toBe(0);
  });
});

describe('learning wrapper', () => {
  const fast = { mcSamples: 4, mcHorizon: 8 };
  const lineup = ['sim:Aggressive', 'starter', 'greedy'];
  const seatSeed = hashSeed(5, 'p', 0);
  const others = (seed: number): SeatSpec[] => lineup.map((s, i) => ({ ...parseSeat(s, hashSeed(seed, 'p', i + 1)), id: i + 2 }) as SeatSpec);
  const createSpy = (log: Array<Partial<BawtParams>>) => (seed: number, extra: Partial<BawtParams>): Policy => {
    log.push(extra);
    return createPolicy(`bawt:${JSON.stringify({ ...fast, ...extra })}`, seed);
  };
  const play = (policy: Policy, matchId: number, seed = 1234) =>
    runMatch({ trace: true, matchId, decisionBudgetMs: 250 }, [{ id: 1, name: policy.name, kind: 'policy', policy }, ...others(5)], seed);

  it('is enabled for bawt by default; LEARN=0 disables', () => {
    expect(learningEnabled({}, 'bawt')).toBe(true);
    expect(learningEnabled({ LEARN: '0' }, 'bawt')).toBe(false);
    expect(learningEnabled({ LEARN: 'off' }, 'bawt')).toBe(false);
    expect(learningEnabled({}, 'greedy')).toBe(false);
    expect(learningEnabled({}, 'bawt:{"x":1}')).toBe(false);
  });

  it('main.ts wires the learning factory for bawt only (LEARN_STATE honoured)', () => {
    const dir = tmp();
    const env = { LEARN_STATE: join(dir, 's.json') };
    expect(learningFactory({ policy: 'bawt', params: {}, logDir: dir }, { ...env, LEARN: '0' })).toBeUndefined();
    expect(learningFactory({ policy: 'greedy', params: {}, logDir: dir }, env)).toBeUndefined();
    const h = learningFactory({ policy: 'bawt', params: fast, logDir: dir }, env)!;
    handles.push(h);
    expect(h.statePath).toBe(env.LEARN_STATE);
    expect(h.factory(1).name).toBe('bawt');
  });

  it("arm 'default' with an empty book is bit-identical to plain bawt, then learns from the match", () => {
    const dir = tmp();
    const statePath = join(dir, 'state.json');
    const logFile = join(dir, 'runs', 'learn.jsonl');
    const lines: string[] = [];
    const warns: string[] = [];
    const created: Array<Partial<BawtParams>> = [];
    const h = createLearningFactory({ create: createSpy(created), statePath, logFile, log: (l) => lines.push(l), warn: (w) => warns.push(w) });
    handles.push(h);

    const plain = play(createPolicy(`bawt:${JSON.stringify(fast)}`, seatSeed), 11);
    const wrapped = play(h.factory(seatSeed), 11);
    expect(wrapped.seats.map((s) => s.score)).toEqual(plain.seats.map((s) => s.score));
    expect(wrapped.trace!.auctions).toEqual(plain.trace!.auctions);
    expect(wrapped.trace!.words).toEqual(plain.trace!.words);
    expect(created).toEqual([{}]);
    expect(warns).toEqual([]);

    const st = loadState(statePath);
    expect(st.status).toBe('ok');
    const s = st.state;
    expect(s.matches).toHaveLength(1);
    const rec = s.matches[0]!;
    const mine = wrapped.seats.find((x) => x.id === 1)!;
    expect(rec).toMatchObject({ matchId: 11, armId: 'default', players: 4, realPlayers: 3, score: mine.score });
    expect(rec.opponents).toEqual(['Aggressive-sim', 'starter', 'greedy']);
    expect(rec.reward).toBeCloseTo((4 - rec.rank) / 3, 12);
    expect(s.arms[0]!.plays).toBe(1);
    expect(s.arms[0]!.alpha + s.arms[0]!.beta).toBeCloseTo(3, 12);
    expect(Object.keys(s.book).sort()).toEqual(['greedy', 'starter']);
    expect(s.book.starter!.matches).toBe(1);
    expect(s.book.starter!.scale?.kind).toBe('market');
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!) as { learn: { armId: string; rank: number; reward: number; posteriorMeans: Record<string, number> } };
    expect(line.learn).toMatchObject({ armId: 'default', rank: rec.rank, reward: rec.reward });
    expect(line.learn.posteriorMeans.default).toBeCloseTo(s.arms[0]!.alpha / 3, 3);
    const fileLines = readFileSync(logFile, 'utf8').trim().split('\n');
    expect(fileLines).toEqual([JSON.stringify({ armStart: { matchId: 11, armId: 'default' } }), lines[0]]);

    // same match id again (e.g. a resumed client): not learned twice
    play(h.factory(seatSeed), 11);
    expect(loadState(statePath).state.matches).toHaveLength(1);
  }, 120_000);

  it('plays a gated arm with clamped params and feeds the book back as priors', () => {
    const dir = tmp();
    const statePath = join(dir, 'state.json');
    const s = emptyState();
    s.arms[0]!.alpha = 1;
    s.arms[0]!.beta = 50; // default looks bad -> the gated arm wins the Thompson draw
    const gated: Arm = {
      id: 'c1',
      params: { tableScale: 5, reserve: 12, mode: 'static' },
      origin: 'cycle',
      createdAt: '2026-11-07T00:00:00.000Z',
      alpha: 50,
      beta: 1,
      plays: 0,
      gate: { lineups: ['lobbySims'], matches: 200, meanRankDelta: -0.1, ciLo: -0.2, ciHi: -0.02, lobbySimsWin: 0.5 },
    };
    const ungated: Arm = { ...gated, id: 'c2', gate: undefined, alpha: 500 };
    s.arms.push(gated, ungated);
    s.book.starter = { matches: 5, wins: 0, avgScore: 10, avgPricePaid: 4, lettersWon: 9, pricesByLetter: {}, updatedAt: 'x', scale: { n: 5, meanLog: 0.3, kind: 'market' } };
    saveState(s, statePath);

    const created: Array<Partial<BawtParams>> = [];
    const fields: FieldModel[] = [];
    const h = createLearningFactory({ create: createSpy(created), statePath, warn: () => {} });
    handles.push(h);
    // observe the field model the inner bawt builds (chained after the learning hook)
    const inner = setFieldModelHook(undefined)!;
    setFieldModelHook((c) => {
      const sess = inner(c);
      return sess && { prior: sess.prior, attach: (f) => (fields.push(f), sess.attach?.(f)) };
    });
    play(h.factory(seatSeed), 21);
    expect(created).toEqual([{ tableScale: 1.3, reserve: 12 }]);
    expect(fields).toHaveLength(1);
    const starter = fields[0]!.opponents.find((o) => o.name === 'starter')!;
    expect(starter.priorCentre).toBeCloseTo((5 / (5 + BOOK_PRIOR_K.market)) * 0.3, 12);
    const after = loadState(statePath).state;
    const c1 = after.arms.find((a) => a.id === 'c1')!;
    expect(c1.plays).toBe(1);
    expect(after.matches[0]!.armId).toBe('c1');
    expect(after.arms.find((a) => a.id === 'c2')!.plays).toBe(0);
    expect(after.book.starter!.matches).toBe(6);
    expect(after.book.starter!.scale!.n).toBe(6);
  }, 120_000);

  it('falls back to default behaviour when the state file is unwritable or unreadable', () => {
    const dir = tmp();
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const warns: string[] = [];
    const created: Array<Partial<BawtParams>> = [];
    const h1 = createLearningFactory({ create: createSpy(created), statePath: join(blocker, 'state.json'), warn: (w) => warns.push(w) });
    handles.push(h1);
    const plain = play(createPolicy(`bawt:${JSON.stringify(fast)}`, seatSeed), 31);
    const a = play(h1.factory(seatSeed), 31);
    expect(a.trace!.auctions).toEqual(plain.trace!.auctions);
    expect(warns.some((w) => /match-end update failed/.test(w))).toBe(true);
    h1.dispose();
    handles.pop();

    // the state "file" is a directory: load fails at match start -> default arm, no throw
    const asDir = join(dir, 'state-dir');
    mkdirSync(asDir);
    const warns2: string[] = [];
    const h2 = createLearningFactory({ create: createSpy(created), statePath: asDir, warn: (w) => warns2.push(w) });
    handles.push(h2);
    const b = play(h2.factory(seatSeed), 31);
    expect(b.trace!.auctions).toEqual(plain.trace!.auctions);
    expect(warns2.some((w) => /state load failed/.test(w))).toBe(true);
    expect(created).toEqual([{}, {}]);
    expect(existsSync(join(blocker, 'state.json'))).toBe(false);
  }, 120_000);

  it('a policy that rejects the arm params falls back to the default arm', () => {
    const dir = tmp();
    const statePath = join(dir, 'state.json');
    const s = emptyState();
    s.arms[0]!.beta = 100;
    s.arms.push({
      id: 'c1',
      params: { reserve: 10 },
      origin: 'manual',
      createdAt: 'x',
      alpha: 100,
      beta: 1,
      plays: 0,
      gate: { lineups: [], matches: 1, meanRankDelta: 0, ciLo: 0, ciHi: 0, lobbySimsWin: 0 },
    });
    saveState(s, statePath);
    const warns: string[] = [];
    const h = createLearningFactory({
      create: (seed, extra) => {
        if (Object.keys(extra).length) throw new Error('nope');
        return createPolicy(`bawt:${JSON.stringify(fast)}`, seed);
      },
      statePath,
      warn: (w) => warns.push(w),
    });
    handles.push(h);
    play(h.factory(seatSeed), 41);
    expect(warns.some((w) => /arm params rejected/.test(w))).toBe(true);
    const after = loadState(statePath).state;
    expect(after.matches[0]!.armId).toBe('default');
    expect(after.arms.find((a) => a.id === 'c1')!.plays).toBe(0);
  }, 120_000);
});
