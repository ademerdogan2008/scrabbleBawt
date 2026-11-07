import { describe, expect, it } from 'vitest';
import { NUM_LETTERS, VALUE, idx, totalAuctions } from '../../src/core/letters.js';
import { rackFromWord } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import { simBid } from '../../src/core/simbots.js';
import type { MatchConfig, PlayerInfo, SimStrategy } from '../../src/core/types.js';
import { MatchTracker } from '../../src/state/tracker.js';
import {
  FieldModel,
  OpponentModel,
  expectedPay,
  loadProfileBook,
  midPit,
  normCdf,
  normInv,
  winProb,
} from '../../src/bots/bawt/opponents.js';
import { DEFAULT_PARAMS, PROFILES, checkOverrides, resolveParams, selectProfile } from '../../src/bots/bawt/params.js';
import { MARG, floorBid, isUseful, tableAt, tableValue, usabilityFactor } from '../../src/bots/bawt/heuristic.js';

function config(players: PlayerInfo[], auctionType: MatchConfig['auctionType'] = 'Vickrey'): MatchConfig {
  return {
    matchId: 1,
    auctionType,
    auctionDurationMs: 1000,
    startingRackSize: 5,
    startingBalance: 100,
    players,
    myId: 1,
    totalAuctions: totalAuctions(players.length, 5),
  };
}

const me: PlayerInfo = { id: 1, name: 'bawt', isSim: false };
const sim = (id: number, s: SimStrategy): PlayerInfo => ({ id, name: `${s}-sim`, isSim: true, simStrategy: s });

describe('params', () => {
  it('selects profiles from the match shape', () => {
    expect(selectProfile(config([me, sim(2, 'Aggressive'), sim(3, 'Cheapskate')]))).toBe('lobby');
    expect(selectProfile(config([me, { id: 2, name: 'x', isSim: false }]))).toBe('headsUp');
    const six = [me, ...[2, 3, 4, 5, 6].map((id) => ({ id, name: `r${id}`, isSim: false }))];
    expect(selectProfile(config(six))).toBe('fullTable');
    const seven = [...six, { id: 7, name: 'r7', isSim: false }];
    expect(selectProfile(config(seven))).toBe('bigTable');
    expect(selectProfile(config(six, 'FirstPrice'))).toBe('firstPrice');
    expect(selectProfile({ ...config([me, { id: 2, name: 'x', isSim: false }]), kind: 'final' })).toBe('headsUp');
  });

  it('merges defaults < profile < overrides and validates overrides', () => {
    const c = config([me, { id: 2, name: 'x', isSim: false }]);
    const p = resolveParams(c, { reserve: 7 });
    expect(p.profile).toBe('headsUp');
    expect(p.reserve).toBe(7);
    expect(p.maxOverbid).toBe(PROFILES.headsUp.maxOverbid);
    expect(resolveParams(c, { profile: 'default' }).maxOverbid).toBe(DEFAULT_PARAMS.maxOverbid);
    expect(() => checkOverrides({ nope: 1 })).toThrow(/unknown parameter/);
    expect(() => checkOverrides({ reserve: 'x' })).toThrow(/must be number/);
    expect(() => checkOverrides({ profile: 'zzz' })).toThrow(/unknown profile/);
    expect(JSON.parse(JSON.stringify(DEFAULT_PARAMS))).toEqual(DEFAULT_PARAMS);
  });
});

describe('heuristic values', () => {
  it('interpolates the marginal table and matches 2.5·face + 4 at n=20', () => {
    for (let i = 0; i < NUM_LETTERS; i++) {
      expect(tableAt(5, i, 0)).toBe(MARG[0]![i]);
      expect(tableAt(20, i, 0)).toBe(MARG[4]![i]);
      const mid = tableAt(10, i, 0);
      expect(mid).toBeCloseTo((MARG[1]![i]! + MARG[2]![i]!) / 2, 9);
    }
    // n=20 row ≈ 2.5·face + 4 for most letters (STRATEGY §4.2)
    let err = 0;
    for (let i = 0; i < NUM_LETTERS; i++) err += Math.abs(MARG[4]![i]! - (2.5 * VALUE[i]! + 4));
    expect(err / NUM_LETTERS).toBeLessThan(2);
  });

  it('discounts duplicates, vowel overload and Q without U', () => {
    const E = idx('E');
    const base = tableValue(rackFromWord('RST'), E, 12, 0.5);
    expect(tableValue(rackFromWord('RSTE'), E, 12, 0.5)).toBeLessThan(base);
    expect(tableValue(rackFromWord('AEIOUE'), E, 12, 0.5)).toBeLessThan(0.5 * base);
    const Q = idx('Q');
    expect(usabilityFactor(rackFromWord('RST'), Q, 0)).toBeLessThan(0.1);
    expect(usabilityFactor(rackFromWord('RSTU'), Q, 0)).toBeGreaterThan(1);
    expect(isUseful(rackFromWord('AEIRT'), idx('O'), 0.4, 2, 0.5)).toBe(false);
    expect(isUseful(rackFromWord('AEIRT'), idx('S'), 0.4, 2, 0.5)).toBe(true);
    expect(isUseful(rackFromWord('SSRT'), idx('S'), 0.4, 2, 0.5)).toBe(false);
    expect(floorBid(idx('Z'), 2.5, 3.5)).toBe(28);
  });
});

describe('opponent models', () => {
  it('loads profiles and the market prior', () => {
    const book = loadProfileBook();
    const bron = book.byName.get('Bron');
    expect(bron).toBeDefined();
    expect(bron!.caps[idx('J')]).toBe(30);
    for (const n of ['1', '2', '3']) {
      const med = book.market.medianByReal[n]!;
      expect(med[idx('E')]).toBeGreaterThan(2);
      expect(med[idx('E')]).toBeLessThan(20);
      expect(med[idx('Z')]).toBeGreaterThan(med[idx('E')]!);
    }
    expect(normInv(0.975)).toBeCloseTo(1.959964, 4);
    expect(normCdf(1.959964)).toBeCloseTo(0.975, 5);
  });

  it('field CDF matches brute-force enumeration for sim-only fields', () => {
    const strategies: SimStrategy[] = ['Aggressive', 'ValueBidder', 'Cheapskate', 'Aggressive'];
    const players = [me, ...strategies.map((s, k) => sim(k + 2, s))];
    const cfg = config(players);
    const tracker = new MatchTracker(cfg, rackFromWord('AEIRS'));
    const view = tracker.view;
    // distinct balances incl. caps that bind
    const balances = [100, 3, 7, 1];
    strategies.forEach((_, k) => {
      view.players.get(k + 2)!.balance = balances[k]!;
    });
    const field = new FieldModel(cfg);
    for (const letter of ['E', 'T', 'D', 'K', 'Z', 'Q']) {
      const li = idx(letter);
      const G = field.fieldCdf(view, li, 3);
      // brute force: 5^4 jitter combinations
      const counts = new Map<number, number>();
      let total = 0;
      const rec = (k: number, mx: number) => {
        if (k === strategies.length) {
          counts.set(mx, (counts.get(mx) ?? 0) + 1);
          total++;
          return;
        }
        for (let j = -2; j <= 2; j++) rec(k + 1, Math.max(mx, simBid(strategies[k]!, li, balances[k]!, j)));
      };
      rec(0, 0);
      let cum = 0;
      for (let x = 0; x < G.length; x++) {
        cum += (counts.get(x) ?? 0) / total;
        expect(G[x]).toBeCloseTo(cum, 10);
      }
      expect(field.knownFieldMax(view, li)).toBe(Math.max(...[...counts.keys()]));
      // win probability and Vickrey payment vs brute force with random ties among k+1 bidders
      for (const b of [1, 3, 6, 9, 14]) {
        let pw = 0;
        let pay = 0;
        const rec2 = (k: number, bids: number[]) => {
          if (k === strategies.length) {
            const mx = Math.max(0, ...bids);
            const w = 1 / total;
            if (mx < b) {
              pw += w;
              pay += w * Math.max(1, mx);
            } else if (mx === b) {
              const tied = bids.filter((x) => x === b).length;
              pw += w / (tied + 1);
              pay += (w * b) / (tied + 1);
            }
            return;
          }
          for (let j = -2; j <= 2; j++) rec2(k + 1, [...bids, simBid(strategies[k]!, li, balances[k]!, j)]);
        };
        rec2(0, []);
        // two-way tie approximation: exact when at most one rival can tie; bounded error otherwise
        expect(Math.abs(winProb(G, b) - pw)).toBeLessThan(0.08);
        expect(Math.abs(expectedPay(G, b, 'Vickrey') - pay)).toBeLessThan(0.08 * b + 1e-9);
      }
    }
  });

  it('caps real bidders at their public balance', () => {
    const cfg = config([me, { id: 2, name: 'Bron', isSim: false }, { id: 3, name: 'mystery-bot', isSim: false }]);
    const tracker = new MatchTracker(cfg, rackFromWord('AEIRS'));
    const view = tracker.view;
    view.players.get(2)!.balance = 12;
    view.players.get(3)!.balance = 5;
    const field = new FieldModel(cfg);
    expect(field.get(2)!.kind).toBe('profiled');
    expect(field.get(3)!.kind).toBe('market');
    const G = field.fieldCdf(view, idx('Z'), 10);
    expect(G[12]).toBe(1);
    expect(G[11]!).toBeLessThan(1);
    for (let x = 1; x < G.length; x++) expect(G[x]!).toBeGreaterThanOrEqual(G[x - 1]!);
  });

  it('mid-interval PIT', () => {
    const F = Float64Array.from([0.1, 0.3, 0.6, 1]);
    expect(midPit(F, 0, 0)).toBeCloseTo(0.05);
    expect(midPit(F, 2, 3)).toBeCloseTo((0.3 + 1) / 2);
    expect(midPit(F, 0, 3)).toBeCloseTo(0.5);
  });

  for (const [label, trueScale, type] of [
    ['up (Vickrey)', 1.8, 'Vickrey'],
    ['down (Vickrey)', 0.55, 'Vickrey'],
    ['up (FirstPrice)', 1.6, 'FirstPrice'],
  ] as const) {
    it(`calibration converges on synthetic data: scale ${label}`, () => {
      const cfg = config([me, { id: 2, name: 'mystery-bot', isSim: false }, sim(3, 'Aggressive')], type);
      const field = new FieldModel(cfg, { calibTemper: 0.7, calibPriorSd: 0.5, calibMin: 0.3, calibMax: 3, deadAfter: 1e9 });
      const truth = new OpponentModel(2, 'truth', undefined, undefined, field.get(2)!.marketMedian);
      truth.logScale = Math.log(trueScale);
      const rng = new Rng(42);
      const F = new Float64Array(102);
      const pre = new Map([
        [2, 100],
        [3, 100],
      ]);
      const T = cfg.totalAuctions;
      for (let t = 0; t < 300; t++) {
        const li = rng.int(0, 25);
        const index = rng.int(0, T - 3); // skip penultimate/final
        // opponent's true bid by inverse CDF
        truth.cdfInto(F, li, field.phase(index), 100);
        const u = rng.float();
        let ob = 0;
        while (ob < 100 && F[ob]! < u) ob++;
        const sb = simBid('Aggressive', li, 100, rng.int(-2, 2));
        const mine = rng.int(0, 2 * VALUE[li]! + 12);
        const bids = [
          { id: 1, b: mine },
          { id: 2, b: ob },
          { id: 3, b: sb },
        ].filter((x) => x.b > 0);
        rng.shuffle(bids);
        bids.sort((a, b) => b.b - a.b);
        const winner = bids[0];
        const paid = !winner ? 0 : type === 'FirstPrice' ? winner.b : bids[1] ? bids[1].b : 1;
        field.observe({ auctionId: t + 1, index, letter: String.fromCharCode(65 + li), winnerId: winner?.id ?? null, paid }, pre, mine, 1);
      }
      const est = field.get(2)!.scale;
      expect(est).toBeGreaterThan(trueScale * 0.8);
      expect(est).toBeLessThan(trueScale * 1.25);
    });
  }

  it('marks seats that never win as dead', () => {
    const cfg = config([me, { id: 2, name: 'mystery-bot', isSim: false }]);
    const field = new FieldModel(cfg, { calibTemper: 0.7, calibPriorSd: 0.5, calibMin: 0.3, calibMax: 3, deadAfter: 10 });
    const pre = new Map([[2, 100]]);
    for (let t = 0; t < 40; t++) field.observe({ auctionId: t + 1, index: t, letter: 'E', winnerId: 1, paid: 1 }, pre, 5, 1);
    expect(field.get(2)!.alive).toBeLessThan(0.1);
    expect(field.get(2)!.scale).toBeLessThan(0.5);
  });
});
