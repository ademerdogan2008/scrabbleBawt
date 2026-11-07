// Counterfactual replay: harness correctness (mimic reproduces history exactly), attribution
// (never credit a letter our policy did not win), skips, rejections, determinism, Wilson CI.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rackTotal } from '../../src/core/rack.js';
import type { Decision, Policy, PolicyFactory } from '../../src/core/types.js';
import { getEngine } from '../../src/engine/index.js';
import { loadMatches, resolveBot } from '../../src/history/load.js';
import { mimicFactory } from '../../src/history/mimic.js';
import { ReplaySkipError, replayMatch, replayMatches, replayStartRack } from '../../src/history/replay.js';
import { Rng } from '../../src/core/rng.js';
import { wilson } from '../../src/history/stats.js';
import type { HistMatch } from '../../src/history/types.js';

const SAMPLE = path.join(__dirname, '..', '..', 'data', 'history-sample');

const constant = (bid: number | ((balance: number) => number), words: string[] = []): PolicyFactory => () => ({
  name: 'const',
  onMatchStart(): void {},
  decide(view): Decision {
    return { words, bid: typeof bid === 'number' ? bid : bid(view.me.balance) };
  },
});

describe('replay on the committed sample', async () => {
  const D = await loadMatches(SAMPLE);
  const { dict } = getEngine();
  const complete = D.matches.filter((m) => m.complete);
  const bron = resolveBot(D.bots, 'Bron')!.id;
  const bronMatches = complete.filter((m) => m.participants.some((p) => p.botId === bron));

  it('mimic + tieMode historical reproduces every real target exactly (score, letters, no rejections)', () => {
    let seats = 0;
    for (const m of complete) {
      for (const p of m.participants) {
        const bot = D.bots.get(p.botId)!;
        if (bot.isSim) continue; // sims play inside closes; not replayable word-for-word
        const r = replayMatch(m, D.bots, p.botId, mimicFactory(m, p.botId), { dict, tieMode: 'historical' });
        seats++;
        expect(r.ourScore, `m${m.id} bot ${p.botId}`).toBe(p.score);
        expect(r.ourRank).toBe(r.targetRank);
        expect(r.lettersWon).toBe(r.targetLettersWon);
        expect(r.rejectedWords + r.rejectedBids + r.policyErrors + r.unattributedLosses).toBe(0);
        expect(r.diagnostics.hiddenOverflow + r.diagnostics.unseenNegative).toBe(0);
        const paid = m.auctions.filter((a) => a.winnerId === p.botId).reduce((s, a) => s + a.paid, 0);
        expect(r.totalPaid).toBe(paid);
      }
    }
    expect(seats).toBeGreaterThan(1000);
  });

  it('a zero-bid policy never gains a letter; unattributed losses == target historical wins', () => {
    for (const m of bronMatches.slice(0, 40)) {
      const r = replayMatch(m, D.bots, bron, constant(0), { dict, trace: true });
      const wins = m.auctions.filter((a) => a.winnerId === bron).length;
      expect(r.lettersWon).toBe(0);
      expect(r.unattributedLosses).toBe(wins);
      expect(r.ourScore).toBe(0);
      expect(r.trace!.every((t) => t.outcome.winnerId !== bron)).toBe(true);
      expect(r.unplayed).toBe(5);
    }
  });

  it('never credits our seat with a letter it did not win (all-in policy, coin ties)', () => {
    for (const m of bronMatches.slice(0, 40)) {
      const r = replayMatch(m, D.bots, bron, constant((b) => b), { dict, trace: true, seed: 3 });
      let credited = 0;
      for (const t of r.trace!) {
        if (t.outcome.winnerId === bron) {
          credited++;
          expect(t.won).toBe(true);
          expect(t.bid >= t.field && t.bid >= 1).toBe(true);
          expect(t.outcome.paid).toBe(t.field === 0 ? 1 : t.field);
          expect(t.outcome.paid).toBeLessThanOrEqual(t.bid);
        } else {
          expect(t.won).toBe(false);
          // when the target had won historically and we lost, nobody is credited
          const a = m.auctions[t.k]!;
          if (a.winnerId === bron) expect(t.outcome.winnerId).toBeNull();
          else expect(t.outcome.winnerId).toBe(a.winnerId);
        }
      }
      expect(credited).toBe(r.lettersWon);
    }
  });

  it('skips non-Vickrey, incomplete and target-absent matches and counts them', () => {
    const m = bronMatches[0]!;
    const fp: HistMatch = { ...structuredClone(m), auctionType: 'FirstPrice', rawAuctionType: 'firstPrice' };
    expect(() => replayMatch(fp, D.bots, bron, constant(0), { dict })).toThrow(ReplaySkipError);
    const incomplete = D.matches.find((x) => !x.complete)!;
    const absent = complete.find((x) => !x.participants.some((p) => p.botId === bron))!;
    const rep = replayMatches([m, fp, incomplete, absent], D.bots, bron, (x) => mimicFactory(x, bron), { dict });
    expect(rep.results).toHaveLength(1);
    expect(rep.skipped).toEqual({ incomplete: 1, 'non-vickrey': 1, 'target-absent': 1 });
  });

  it('counts rejected words and bids', () => {
    const m = bronMatches[1]!;
    let calls = 0;
    const bad: PolicyFactory = (): Policy => ({
      name: 'bad',
      onMatchStart(): void {},
      decide(): Decision {
        calls++;
        if (calls === 1) return { words: ['ZZZZQ', 'qi', 'JUKEBOX'], bid: 1e6 }; // invalid, malformed, not on rack; too high
        if (calls === 2) return { words: [], bid: 1.5 }; // not an integer
        if (calls === 3) return { words: [], bid: -1 };
        if (calls === 4) throw new Error('policy bug');
        return { words: [], bid: 0 };
      },
    });
    const r = replayMatch(m, D.bots, bron, bad, { dict });
    expect(r.rejectedWords).toBe(3);
    expect(r.rejectedBids).toBe(3);
    expect(r.policyErrors).toBe(1);
    expect(r.lettersWon).toBe(0);
  });

  it('is deterministic for a seed; coin ties differ from historical ties only at ties', () => {
    const m = bronMatches[2]!;
    const a = replayMatch(m, D.bots, bron, mimicFactory(m, bron), { dict, seed: 9, trace: true });
    const b = replayMatch(m, D.bots, bron, mimicFactory(m, bron), { dict, seed: 9, trace: true });
    expect(a).toEqual(b);
    const h = replayMatch(m, D.bots, bron, mimicFactory(m, bron), { dict, tieMode: 'historical', trace: true });
    for (let k = 0; k < h.trace!.length; k++) {
      if (!h.trace![k]!.tie) expect(a.trace![k]!.won).toBe(h.trace![k]!.won);
    }
    expect(h.tiesWon).toBe(h.ties);
  });

  it('starting rack = proven start tiles topped up to the rack size from the unknown pool', () => {
    for (const m of bronMatches.slice(0, 20)) {
      const r = replayStartRack(m, bron, new Rng(m.id));
      expect(rackTotal(r)).toBe(m.startingRackSize);
    }
  });

  it('aggregates with Wilson CIs', () => {
    const rep = replayMatches(bronMatches.slice(0, 30), D.bots, bron, (x) => mimicFactory(x, bron), {
      dict,
      tieMode: 'historical',
    });
    const ag = rep.aggregate;
    expect(ag.n).toBe(30);
    expect(ag.exactScoreMatches).toBe(30);
    expect(ag.ourWinRate).toEqual(ag.targetWinRate);
    expect(ag.ourWinRate.lo).toBeLessThanOrEqual(ag.ourWinRate.p);
    expect(ag.ourWinRate.hi).toBeGreaterThanOrEqual(ag.ourWinRate.p);
    expect(ag.avgScoreDelta.mean).toBe(0);
  });
});

describe('wilson', () => {
  it('matches reference values', () => {
    const w = wilson(81, 263);
    expect(w.lo).toBeCloseTo(0.2553, 3);
    expect(w.hi).toBeCloseTo(0.3662, 3);
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(0, 0)).toEqual({ p: 0, lo: 0, hi: 1 });
  });
});
