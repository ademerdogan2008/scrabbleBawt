import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng.js';
import type { MatchConfig, PlayerInfo } from '../../src/core/types.js';
import { DEFAULT_PARAMS, resolveParams } from '../../src/bots/bawt/params.js';
import { LEARNABLE, armOverrides, clampParams } from '../../src/learn/arms.js';
import {
  MAX_ACTIVE_ARMS,
  activeArms,
  betaSample,
  gammaSample,
  isEligible,
  posteriorMean,
  selectArm,
  updateArm,
} from '../../src/learn/bandit.js';
import { rankOf, rewardOf, standingFromScores } from '../../src/learn/reward.js';
import {
  DEFAULT_ARM_ID,
  defaultStatePath,
  emptyState,
  loadState,
  normalizeState,
  saveState,
  type Arm,
  type LearnState,
} from '../../src/learn/store.js';

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'learn-a-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const gate = { lineups: ['lobbySims'], matches: 200, meanRankDelta: -0.1, ciLo: -0.2, ciHi: -0.01, lobbySimsWin: 0.5 };
function arm(id: string, extra: Partial<Arm> = {}): Arm {
  return { id, params: {}, origin: 'cycle', createdAt: '2026-11-01T00:00:00.000Z', alpha: 1, beta: 1, plays: 0, gate, ...extra };
}

describe('store', () => {
  it('round-trips the state atomically and leaves no tmp file', () => {
    const p = join(tmp(), 'sub', 'state.json');
    const s = emptyState(new Date('2026-11-07T00:00:00Z'));
    s.arms.push(arm('a1', { params: { tableScale: 1.1 }, alpha: 3.5, beta: 2 }));
    s.matches.push({
      matchId: 7,
      armId: 'a1',
      endedAt: '2026-11-07T00:00:00.000Z',
      players: 4,
      realPlayers: 2,
      rank: 1,
      score: 50,
      bestOtherScore: 40,
      won: true,
      reward: 1,
      opponents: ['x', 'y', 'z'],
    });
    s.book.Bron = { matches: 1, wins: 0, avgScore: 30, avgPricePaid: 5, lettersWon: 2, pricesByLetter: { E: { n: 2, mean: 5 } }, updatedAt: 'x' };
    saveState(s, p);
    expect(existsSync(`${p}.tmp-${process.pid}`)).toBe(false);
    const r = loadState(p);
    expect(r.status).toBe('ok');
    expect(r.state).toEqual(s);
  });

  it('returns a default state for a missing file', () => {
    const r = loadState(join(tmp(), 'nope.json'));
    expect(r.status).toBe('missing');
    expect(r.state.arms.map((a) => a.id)).toEqual([DEFAULT_ARM_ID]);
    expect(r.state.version).toBe(1);
  });

  it('backs up a corrupt file to .bak and starts fresh', () => {
    const p = join(tmp(), 'state.json');
    writeFileSync(p, '{"version": 1, "arms": [tru');
    const r = loadState(p);
    expect(r.status).toBe('corrupt');
    expect(r.backup).toBe(`${p}.bak`);
    expect(readFileSync(`${p}.bak`, 'utf8')).toContain('tru');
    expect(existsSync(p)).toBe(false);
    expect(r.state.arms).toHaveLength(1);
    // wrong shape is corrupt too
    writeFileSync(p, JSON.stringify({ version: 2, arms: [] }));
    expect(loadState(p).status).toBe('corrupt');
  });

  it('normalizes: default arm always present, never retired, params {}', () => {
    const s = normalizeState({ version: 1, arms: [{ id: 'default', params: { x: 1 }, retired: true, alpha: 2, beta: 3 }, { nope: 1 }], matches: [] });
    expect(s!.arms).toHaveLength(1);
    expect(s!.arms[0]!.retired).toBeUndefined();
    expect(s!.arms[0]!.params).toEqual({});
    expect(s!.arms[0]!.alpha).toBe(2);
    const t = normalizeState({ version: 1, arms: [arm('a1')] });
    expect(t!.arms.map((a) => a.id)).toEqual(['default', 'a1']);
    expect(t!.book).toEqual({});
  });

  it('honours LEARN_STATE', () => {
    expect(defaultStatePath({ LEARN_STATE: '/x/y.json' })).toBe('/x/y.json');
    expect(defaultStatePath({})).toMatch(/\.cache[\\/]learn[\\/]state\.json$/);
  });
});

describe('arms', () => {
  it('drops non-whitelisted keys and clamps ranges', () => {
    const c = clampParams({ tableScale: 9, kappaLo: 0, reserve: 12, mcSamples: 64, mode: 'static', floorA: NaN, incomeShare: '0.3' });
    expect(c).toEqual({ tableScale: LEARNABLE.tableScale.hi, kappaLo: LEARNABLE.kappaLo.lo, reserve: 12 });
    expect(clampParams(undefined)).toEqual({});
    for (const k of Object.keys(LEARNABLE) as Array<keyof typeof LEARNABLE>) {
      const kn = LEARNABLE[k];
      expect(kn.lo).toBeLessThanOrEqual(kn.def);
      expect(kn.hi).toBeGreaterThanOrEqual(kn.def);
      if (k !== 'denyScale') expect((DEFAULT_PARAMS as unknown as Record<string, number>)[k]).toBe(kn.def);
    }
  });

  it('turns denyScale into scaled profile denyWeights; empty arm = {}', () => {
    const players: PlayerInfo[] = [
      { id: 1, name: 'me', isSim: false },
      { id: 2, name: 'r', isSim: false },
      { id: 3, name: 's', isSim: true, simStrategy: 'Aggressive' },
    ];
    const config: MatchConfig = { matchId: 1, auctionType: 'Vickrey', auctionDurationMs: 1000, startingRackSize: 5, startingBalance: 100, players, myId: 1, totalAuctions: 83 };
    expect(armOverrides({}, config)).toEqual({});
    const o = armOverrides({ denyScale: 0.5, tableScale: 1.2, bogus: 3 }, config);
    const dw = resolveParams(config).denyWeights;
    expect(o.tableScale).toBe(1.2);
    expect(o.denyWeights).toEqual(Object.fromEntries(Object.entries(dw).map(([k, w]) => [k, w * 0.7])));
    expect('denyScale' in o).toBe(false);
  });
});

describe('bandit', () => {
  it('samples Gamma and Beta with the right means', () => {
    const rng = new Rng(1);
    for (const shape of [0.5, 1, 3.7]) {
      let s = 0;
      for (let i = 0; i < 20_000; i++) s += gammaSample(rng, shape);
      expect(s / 20_000).toBeCloseTo(shape, 1);
    }
    let b = 0;
    for (let i = 0; i < 20_000; i++) b += betaSample(rng, 2, 6);
    expect(b / 20_000).toBeCloseTo(0.25, 2);
  });

  it('Thompson sampling favours a clearly better arm (seeded)', () => {
    const s = emptyState();
    s.arms[0]!.alpha = 20;
    s.arms[0]!.beta = 20;
    s.arms.push(arm('good', { alpha: 30, beta: 10 }), arm('bad', { alpha: 10, beta: 30 }));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 2000; i++) {
      const { arm: a } = selectArm(s, new Rng(i));
      counts[a.id] = (counts[a.id] ?? 0) + 1;
    }
    expect(counts.good! / 2000).toBeGreaterThan(0.8);
    expect(counts.bad ?? 0).toBeLessThan(20);
    // reproducible from the seed
    expect(selectArm(s, new Rng(42)).arm.id).toBe(selectArm(s, new Rng(42)).arm.id);
  });

  it('learns to prefer the better arm from rewards (closed loop)', () => {
    const s = emptyState();
    s.arms.push(arm('better', { params: { tableScale: 1.1 } }));
    const truth: Record<string, number> = { default: 0.4, better: 0.7 };
    const env = new Rng(9);
    let late = 0;
    for (let t = 0; t < 600; t++) {
      const { arm: a } = selectArm(s, new Rng(1000 + t));
      const r = env.float() < truth[a.id]! ? 1 : 0;
      updateArm(s, a.id, r);
      if (t >= 400 && a.id === 'better') late++;
    }
    expect(late / 200).toBeGreaterThan(0.7);
  });

  it('applies the discount to every non-retired arm before the update', () => {
    const s: LearnState = emptyState();
    s.arms[0]!.alpha = 5;
    s.arms[0]!.beta = 3;
    s.arms.push(arm('a', { alpha: 2, beta: 4 }), arm('r', { alpha: 7, beta: 9, retired: true }));
    expect(updateArm(s, 'a', 0.25, 0.9)).toBe(true);
    const [d, a, r] = s.arms;
    expect(d!.alpha).toBeCloseTo(1 + 0.9 * 4, 12);
    expect(d!.beta).toBeCloseTo(1 + 0.9 * 2, 12);
    expect(a!.alpha).toBeCloseTo(1 + 0.9 * 1 + 0.25, 12);
    expect(a!.beta).toBeCloseTo(1 + 0.9 * 3 + 0.75, 12);
    expect(a!.plays).toBe(1);
    expect([r!.alpha, r!.beta]).toEqual([7, 9]);
    expect(updateArm(s, 'missing', 1)).toBe(false);
    // the evidence of a never-played arm decays to the prior
    for (let i = 0; i < 400; i++) updateArm(s, 'a', 1);
    expect(d!.alpha).toBeCloseTo(1, 3);
    expect(posteriorMean(a!)).toBeGreaterThan(0.95);
  });

  it('only gated, non-retired arms (and default) are live; at most 6', () => {
    const s = emptyState();
    s.arms.push(arm('nogate', { gate: undefined, alpha: 100 }), arm('ret', { retired: true, alpha: 100 }));
    for (let i = 0; i < 8; i++) s.arms.push(arm(`g${i}`, { alpha: 1 + i }));
    expect(isEligible(s.arms[0]!)).toBe(true);
    expect(isEligible(s.arms[1]!)).toBe(false);
    expect(isEligible(s.arms[2]!)).toBe(false);
    const act = activeArms(s);
    expect(act).toHaveLength(MAX_ACTIVE_ARMS);
    expect(act[0]!.id).toBe('default');
    expect(act.map((a) => a.id).slice(1)).toEqual(['g7', 'g6', 'g5', 'g4', 'g3']);
    for (let i = 0; i < 300; i++) expect(['nogate', 'ret', 'g0', 'g1', 'g2']).not.toContain(selectArm(s, new Rng(i)).arm.id);
  });
});

describe('reward', () => {
  it('ranks with shared ties and maps to [0, 1]', () => {
    expect(rankOf([10, 20, 30, 40], 40)).toBe(1);
    expect(rankOf([10, 20, 30, 40], 10)).toBe(4);
    expect(rankOf([40, 40, 30, 10], 40)).toBe(1.5);
    expect(rankOf([40, 30, 30, 30], 30)).toBe(3);
    expect(rewardOf(1, 4)).toBe(1);
    expect(rewardOf(4, 4)).toBe(0);
    expect(rewardOf(1.5, 4)).toBeCloseTo(0.675, 12);
    expect(rewardOf(2, 6)).toBeCloseTo(0.35, 12);
    expect(rewardOf(3, 6)).toBeCloseTo(0.1, 12);
    expect(rewardOf(4, 6)).toBe(0);
    expect(rewardOf(2, 2)).toBe(0);
    expect(rewardOf(1, 1)).toBe(1);
    const st = standingFromScores(new Map([[1, 40], [2, 40], [3, 5]]), 1, 2);
    expect(st).toMatchObject({ players: 3, realPlayers: 2, rank: 1.5, score: 40, bestOtherScore: 40, won: false });
    expect(st.reward).toBeCloseTo(0.675, 12);
  });
});
