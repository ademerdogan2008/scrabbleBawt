import { describe, expect, it } from 'vitest';
import {
  OPENSKILL_MU,
  OPENSKILL_SIGMA,
  chiSquareP,
  meanCI,
  openSkillDisplay,
  pairedT,
  plackettLuce,
  signTest,
  summarize,
  tCdf,
  tQuantile,
  wilson,
  type MatchRecord,
  type SeatRecord,
} from '../../src/sim/stats.js';

describe('intervals and tests', () => {
  it('Wilson score interval matches reference values', () => {
    const a = wilson(5, 10);
    expect(a.p).toBe(0.5);
    expect(a.lo).toBeCloseTo(0.236593, 5);
    expect(a.hi).toBeCloseTo(0.763407, 5);
    const b = wilson(0, 10);
    expect(b.lo).toBe(0);
    expect(b.hi).toBeCloseTo(0.277533, 5);
    const c = wilson(81, 263);
    expect(c.lo).toBeCloseTo(0.2553, 3);
    expect(c.hi).toBeCloseTo(0.3662, 3);
    expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 1 });
  });

  it('Student t quantiles and CDF', () => {
    expect(tQuantile(0.975, 1)).toBeCloseTo(12.7062047362, 8);
    expect(tQuantile(0.975, 4)).toBeCloseTo(2.7764451052, 8);
    expect(tQuantile(0.975, 10)).toBeCloseTo(2.2281388520, 8);
    expect(tQuantile(0.975, 1000)).toBeCloseTo(1.9623390808, 8);
    expect(tQuantile(0.025, 10)).toBeCloseTo(-2.228138852, 8);
    expect(tCdf(0, 7)).toBeCloseTo(0.5, 12);
    expect(tCdf(2.228138852, 10)).toBeCloseTo(0.975, 9);
  });

  it('meanCI and paired t', () => {
    const m = meanCI([1, 2, 3, 4, 5]);
    expect(m.mean).toBe(3);
    expect(m.sd).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(m.lo).toBeCloseTo(3 - 2.7764451052 * Math.sqrt(0.5), 8);
    const t = pairedT([1, 2, 3, 4, 5]);
    expect(t.t).toBeCloseTo(4.242640687, 8);
    expect(t.p).toBeCloseTo(0.013236, 5); // R: t.test(1:5)$p.value = 0.01323581
    expect(pairedT([0, 0, 0]).p).toBe(1);
  });

  it('exact sign test', () => {
    const s = signTest([1, 1, 1, 1, 1, 1, 1, 1, 1, -1, 0, 0]);
    expect([s.pos, s.neg, s.ties]).toEqual([9, 1, 2]);
    expect(s.p).toBeCloseTo(0.021484375, 12); // 2 * 11 / 1024
    expect(signTest([1, -1]).p).toBe(1);
    expect(signTest([]).p).toBe(1);
  });

  it('chi-square upper tail', () => {
    expect(chiSquareP(3.841458820694124, 1)).toBeCloseTo(0.05, 10);
    expect(chiSquareP(18.307038053275146, 10)).toBeCloseTo(0.05, 10);
    expect(chiSquareP(0.1, 3)).toBeCloseTo(0.991837, 5);
    expect(chiSquareP(50, 5)).toBeLessThan(1e-8);
  });
});

describe('OpenSkill Plackett-Luce (module port)', () => {
  // Live rating_history of the first two matches ever played (all sims, fresh ratings).
  // Match 1 final scores: bot3 108, bot5 59, bot4 23, bot2 6, bot1 0, bot6 0.
  const m1 = { 3: 108, 5: 59, 4: 23, 2: 6, 1: 0, 6: 0 } as Record<number, number>;
  const m1After: Record<number, [number, number]> = {
    3: [27.535752581042438, 8.30511051299983],
    5: [26.92717196159225, 8.272478472774523],
    4: [26.16644618727952, 8.234073228800998],
    2: [25.152145154862545, 8.188322651139893],
    6: [22.109242057611624, 8.136545764562698],
    1: [22.109242057611624, 8.136545764562698],
  };
  // Match 2 final scores: bot5 85, bot3 65, bot2 20, bot4 0, bot1 0, bot6 0.
  const m2 = { 3: 65, 5: 85, 4: 0, 2: 20, 1: 0, 6: 0 } as Record<number, number>;
  const m2After: Record<number, [number, number]> = {
    5: [29.412735226501468, 8.242219209918943],
    3: [29.332983833502773, 8.237180342823683],
    2: [26.238537280212682, 8.090693776041084],
    6: [20.542334513433453, 8.008903311791888],
    4: [24.048115547576096, 8.083329648735738],
    1: [20.542334513433456, 8.008903311791888],
  };
  const place = (scores: Record<number, number>, id: number) =>
    Object.values(scores).filter((s) => s > scores[id]!).length;

  it('reproduces the module ratings of live match 1', () => {
    const ids = [3, 5, 4, 2, 6, 1];
    const out = plackettLuce(ids.map((id) => ({ mu: OPENSKILL_MU, sigma: OPENSKILL_SIGMA, place: place(m1, id) })));
    ids.forEach((id, i) => {
      expect(out[i]!.mu).toBeCloseTo(m1After[id]![0], 11);
      expect(out[i]!.sigma).toBeCloseTo(m1After[id]![1], 11);
    });
  });

  it('summarize runs PL sequentially in seed order (live match 2 after match 1)', () => {
    const rec = (seed: number, scores: Record<number, number>): MatchRecord => ({
      seed,
      seats: Object.keys(scores).map(Number).map(
        (id): SeatRecord => ({
          label: `bot${id}`,
          score: scores[id]!,
          rank: 1 + place(scores, id),
          win: place(scores, id) === 0,
          lettersWon: 0,
          totalPaid: 0,
          wordsPlayed: 0,
          unplayedTiles: 0,
          unplayedValue: 0,
          rejectedWords: 0,
          rejectedBids: 0,
          voidedDecisions: 0,
        }),
      ),
    });
    const stats = summarize([rec(1, m1), rec(2, m2)]);
    for (const s of stats) {
      const id = Number(s.label.slice(3));
      expect(s.openskill.mu).toBeCloseTo(m2After[id]![0], 5);
      expect(s.openskill.sigma).toBeCloseTo(m2After[id]![1], 5);
      expect(s.openskill.display).toBe(openSkillDisplay(m2After[id]![0]));
      expect(s.n).toBe(2);
    }
    const b5 = stats.find((s) => s.label === 'bot5')!;
    expect(b5.wins).toBe(1);
    expect(b5.avgRank).toBe(1.5);
    expect(b5.avgMargin).toBe(((59 - 108) + (85 - 65)) / 2);
    expect(openSkillDisplay(61.8)).toBe(2585);
  });
});
