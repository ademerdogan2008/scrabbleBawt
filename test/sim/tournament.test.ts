import { describe, expect, it } from 'vitest';
import { LETTERS, idx } from '../../src/core/letters.js';
import { simBidDistribution } from '../../src/core/simbots.js';
import type { SimStrategy } from '../../src/core/types.js';
import { padLineup, parseArgs } from '../../src/sim/cli.js';
import { chiSquareP, meanCI } from '../../src/sim/stats.js';
import {
  comparePaired,
  deterministicPart,
  lineupLabels,
  matchSeed,
  rosterOrder,
  runJobs,
  runTournament,
  type Job,
} from '../../src/sim/tournament.js';

const LINEUP = ['starter', 'greedy', 'hoarder', 'random', 'sim:Aggressive', 'sim:Aggressive'];

describe('runTournament', () => {
  it('is byte-identical for workers 0, 1 and 4 (aggregation in seed order)', async () => {
    const opts = { lineups: [LINEUP, ['greedy', 'sim:ValueBidder', 'sim:Cheapskate']], matches: 24, baseSeed: 7 };
    const r0 = await runTournament({ ...opts, workers: 0 });
    const r1 = await runTournament({ ...opts, workers: 1 });
    const r4 = await runTournament({ ...opts, workers: 4 });
    const j0 = JSON.stringify(deterministicPart(r0));
    expect(JSON.stringify(deterministicPart(r1))).toBe(j0);
    expect(JSON.stringify(deterministicPart(r4))).toBe(j0);
    expect(r0.stats.map((s) => s.label)).toEqual([
      'starter',
      'greedy',
      'hoarder',
      'random',
      'sim:Aggressive#1',
      'sim:Aggressive#2',
      'sim:ValueBidder',
      'sim:Cheapskate',
    ]);
    const greedy = r0.stats.find((s) => s.label === 'greedy')!;
    expect(greedy.n).toBe(24);
    expect(r4.timing.wallMs).toBeGreaterThan(0);
    expect(r4.timing.decideMs['greedy']!.n).toBeGreaterThan(0);
  }, 120_000);

  it('rotates roster order by seed (each slot visits several positions)', () => {
    const positions = new Set<number>();
    for (let k = 0; k < 30; k++) positions.add(rosterOrder(matchSeed(1, k), 6, true).indexOf(0));
    expect(positions.size).toBeGreaterThanOrEqual(5);
    expect(rosterOrder(5, 4, false)).toEqual([0, 1, 2, 3]);
    expect(lineupLabels(['a', 'b', 'a', 'sim:X', 'a'])).toEqual(['a#1', 'b', 'a#2', 'sim:X', 'a#3']);
  });
});

describe('comparePaired', () => {
  it('identical focal policies give exactly zero deltas (perfect pairing)', async () => {
    const r = await comparePaired({
      focalA: 'greedy',
      focalB: 'greedy',
      template: ['*', 'sim:Aggressive', 'sim:ValueBidder', 'starter'],
      matches: 20,
      workers: 0,
    });
    expect([r.score.mean, r.score.lo, r.score.hi, r.rank.mean, r.win.mean]).toEqual([0, 0, 0, 0, 0]);
    expect(r.scoreSign.ties).toBe(20);
    expect(r.a.find((s) => s.label === 'A:greedy')!.avgScore).toBe(r.b.find((s) => s.label === 'B:greedy')!.avgScore);
  });

  it('reports mean deltas with 95% CIs and a sign test (greedy vs starter)', async () => {
    const r = await comparePaired({
      focalA: 'greedy',
      focalB: 'starter',
      template: ['*', 'sim:Aggressive', 'sim:Aggressive', 'sim:ValueBidder', 'sim:ValueBidder', 'sim:Cheapskate'],
      matches: 60,
      workers: 2,
    });
    expect(r.score.n).toBe(60);
    expect(r.score.lo).toBeLessThanOrEqual(r.score.mean);
    expect(r.score.hi).toBeGreaterThanOrEqual(r.score.mean);
    expect(r.score.mean).toBeGreaterThan(0); // greedy cashes far more than the starter
    expect(r.score.lo).toBeGreaterThan(0);
    expect(r.scoreSign.p).toBeLessThan(0.01);
    expect(r.rank.mean).toBeLessThan(0);
  }, 120_000);

  it('rejects templates without exactly one focal seat', async () => {
    await expect(comparePaired({ focalA: 'a', focalB: 'b', template: ['starter'], matches: 1 })).rejects.toThrow(/exactly one/);
  });
});

describe('cli', () => {
  it('parses options and pads lineups with lobby sims', () => {
    const o = parseArgs(['--lineup', 'starter,sim:Aggressive', '--matches', '10', '--workers', '0', '--auction', 'first', '--rack', '4', '--players', '4', '--enforce-budget', '--budget-ms', '100']);
    expect(o.lineups).toEqual([['starter', 'sim:Aggressive']]);
    expect(o.spec).toEqual({ auctionType: 'FirstPrice', startingRackSize: 4, enforceBudget: true, decisionBudgetMs: 100 });
    expect(padLineup(o.lineups[0]!, o.players)).toEqual(['starter', 'sim:Aggressive', 'sim:Cheapskate', 'sim:ValueBidder']);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown option/);
  });
});

// ------------------------------------------------------------------ sim distribution check

/** P(X <= x) for a discrete PMF given as [value, prob] pairs. */
function cdf(pmf: Array<[number, number]>, x: number): number {
  let s = 0;
  for (const [v, p] of pmf) if (v <= x) s += p;
  return s;
}

describe('sims reproduce the module bid distributions (6-sim lobby, analytic)', () => {
  it('per-letter clearing price mean and max-bid PMF match the analytic computation', async () => {
    const strategies: SimStrategy[] = ['Aggressive', 'Aggressive', 'ValueBidder', 'ValueBidder', 'Cheapskate', 'Cheapskate'];
    const lineup = strategies.map((s) => `sim:${s}`);
    const labels = lineupLabels(lineup);
    const M = 3000;
    const jobs: Job[] = [];
    for (let k = 0; k < M; k++) {
      const seed = matchSeed(99, k);
      jobs.push({ k, lineup, labels, seed, order: [0, 1, 2, 3, 4, 5], spec: { trace: true } });
    }
    const results = await runJobs(jobs, 4);
    const paid = new Map<number, number[]>();
    const top = new Map<number, number[]>();
    for (const r of results) {
      const tr = r.trace!;
      const bal = new Map<number, number>([1, 2, 3, 4, 5, 6].map((id) => [id, 100]));
      const wordsAt = new Map<number, Array<{ seatId: number; reward: number }>>();
      for (const w of tr.words) wordsAt.set(w.index, [...(wordsAt.get(w.index) ?? []), w]);
      for (const a of tr.auctions) {
        // balances non-binding: every sim can afford the highest possible sim bid (14)
        if ([...bal.values()].every((b) => b >= 14)) {
          const li = idx(a.letter);
          if (!paid.has(li)) {
            paid.set(li, []);
            top.set(li, []);
          }
          paid.get(li)!.push(a.paid);
          top.get(li)!.push(a.top);
        }
        if (a.winnerId !== null) bal.set(a.winnerId, bal.get(a.winnerId)! - a.paid);
        for (const w of wordsAt.get(a.index) ?? []) bal.set(w.seatId, bal.get(w.seatId)! + w.reward);
      }
    }
    let tested = 0;
    const report: string[] = [];
    for (const [li, xs] of [...paid.entries()].sort((a, b) => a[0] - b[0])) {
      if (xs.length < 200) continue;
      tested++;
      const pmfs = strategies.map((s) => simBidDistribution(s, li, 1000));
      const support = [...new Set(pmfs.flatMap((p) => p.map(([v]) => v)))].sort((a, b) => a - b);
      const pMaxLe = (x: number) => pmfs.reduce((t, p) => t * cdf(p, x), 1);
      const pSecondLe = (x: number) => {
        let s = pMaxLe(x);
        for (let i = 0; i < pmfs.length; i++) {
          let prod = 1 - cdf(pmfs[i]!, x);
          for (let j = 0; j < pmfs.length; j++) if (j !== i) prod *= cdf(pmfs[j]!, x);
          s += prod;
        }
        return s;
      };
      let analyticPaid = 0;
      for (const v of support) analyticPaid += v * (pSecondLe(v) - pSecondLe(v - 1));
      const m = meanCI(xs);
      const dev = Math.abs(m.mean - analyticPaid);
      expect(dev, `${LETTERS[li]} paid mean ${m.mean} vs ${analyticPaid}`).toBeLessThanOrEqual(4 * m.se);
      expect(dev, `${LETTERS[li]} paid mean ${m.mean} vs ${analyticPaid}`).toBeLessThanOrEqual(0.15);

      // chi-square goodness of fit of the max sim bid, merging bins with expected < 5
      const tops = top.get(li)!;
      const n = tops.length;
      const bins: Array<{ e: number; o: number }> = [];
      let cur = { e: 0, o: 0 };
      for (const v of support) {
        cur.e += n * (pMaxLe(v) - pMaxLe(v - 1));
        cur.o += tops.filter((t) => t === v).length;
        if (cur.e >= 5) {
          bins.push(cur);
          cur = { e: 0, o: 0 };
        }
      }
      if (cur.e > 0 || cur.o > 0) {
        if (bins.length > 0) {
          bins[bins.length - 1]!.e += cur.e;
          bins[bins.length - 1]!.o += cur.o;
        } else bins.push(cur);
      }
      expect(tops.every((t) => support.includes(t))).toBe(true);
      let chi = 0;
      for (const b of bins) chi += ((b.o - b.e) * (b.o - b.e)) / b.e;
      const p = chiSquareP(chi, bins.length - 1);
      expect(p, `${LETTERS[li]} max-bid chi2=${chi} bins=${bins.length}`).toBeGreaterThan(0.001);
      report.push(`${LETTERS[li]} n=${n} paid ${m.mean.toFixed(3)}/${analyticPaid.toFixed(3)} chi2 p=${p.toFixed(3)}`);
    }
    expect(tested).toBe(26);
    console.log(`[sim-distribution] ${report.join('; ')}`);
  }, 120_000);
});
