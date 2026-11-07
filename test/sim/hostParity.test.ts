// SIM-04: the simulator's own step functions (runMatchCore + drawLetter/closeAuction/awardLetter/
// simWordPlay), driven by the server RNG and iteration-order model, reproduce historical all-sim
// matches bit-exactly. Reads only the committed fixtures (test/fixtures/allsim/matches.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AuctionType, SimStrategy } from '../../src/core/types.js';
import { HostRandom, hostShuffle, pcg32 } from '../../src/sim/hostRng.js';
import { hostReplay } from '../../src/sim/hostReplay.js';
import type { Fixture } from '../fixtures/allsim/extract.js';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/allsim/matches.json', import.meta.url), 'utf8'),
) as Fixture;
const sims = fixture.sims.map((s) => ({ id: s.id, name: s.name, strategy: s.strategy as SimStrategy }));

describe('host RNG primitives', () => {
  it('every integerInRange consumes at least one draw (incl. range of size 1)', () => {
    const r = new HostRandom(1792795759064790);
    expect(r.integerInRange(0, 0)).toBe(0);
    expect(r.gen.calls).toBe(1);
    for (let k = 0; k < 1000; k++) {
      const v = r.integerInRange(-2, 2);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThanOrEqual(2);
    }
    expect(r.gen.calls).toBeGreaterThanOrEqual(1001);
  });

  it('pcg32 seed is a signed 32-bit integer and depends on every microsecond', () => {
    const seeds = new Set<number>();
    for (let t = 0n; t < 64n; t++) {
      const s = pcg32(1792795759064790n + t);
      expect(Number.isInteger(s) && s >= -(2 ** 31) && s < 2 ** 31).toBe(true);
      seeds.add(s);
    }
    expect(seeds.size).toBeGreaterThan(4);
    expect(hostShuffle(new HostRandom(5), [1, 2, 3]).sort()).toEqual([1, 2, 3]);
  });
});

describe('bit-exact replay of historical all-sim matches', () => {
  it(`fixture holds the all-sim matches (${fixture.matches.length})`, () => {
    expect(fixture.matches.length).toBeGreaterThanOrEqual(3);
    for (const id of [1, 28962, 33893]) expect(fixture.matches.some((m) => m.id === id)).toBe(true);
  });

  const totals = { matches: 0, auctions: 0, ties: 0, simWords: 0, mismatches: 0 };
  for (const m of fixture.matches) {
    it(`match ${m.id}: letters, winners, paid, top bids, sim words, finals`, () => {
      const { result, predictedPadOrder } = hostReplay(
        {
          id: m.id,
          startedAt: m.startedAt,
          auctionType: m.auctionType as AuctionType,
          auctionDurationMs: m.auctionDurationMs,
          startingRackSize: m.startingRackSize,
          roster: m.roster,
          closedAt: m.auctions.map((a) => a[4]),
        },
        { sims, lobbyMaxSize: fixture.lobbyMaxSize },
      );
      const tr = result.trace!;
      // lobby-timeout padding shuffle predicts the roster order
      expect(predictedPadOrder).toEqual(m.roster);
      expect(result.auctions).toBe(m.auctions.length);
      const got = tr.auctions.map((a) => [a.letter, a.winnerId, a.paid, a.top]);
      const want = m.auctions.map(([letter, winner, paid, top]) => [letter, winner, paid, top]);
      let mism = 0;
      for (let k = 0; k < want.length; k++) if (JSON.stringify(got[k]) !== JSON.stringify(want[k])) mism++;
      expect(got).toEqual(want);
      // sim words: same bot, word, reward and transaction (played inside the close of auction index)
      const gotWords = tr.words.map((w) => [w.seatId, w.word, w.reward, m.auctions[w.index]![4]]);
      expect(gotWords).toEqual(m.words);
      const finals = result.seats.map((s) => [s.id, s.balance, s.score]);
      expect(finals).toEqual(m.final);
      // ties at the top resolved by the module shuffle
      const ties = tr.auctions.filter((a) => Object.values(a.bids).filter((b) => b === a.top).length > 1).length;
      totals.matches++;
      totals.auctions += result.auctions;
      totals.ties += ties;
      totals.simWords += tr.words.length;
      totals.mismatches += mism;
    });
  }

  it('summary', () => {
    console.log(
      `[host-parity] matches=${totals.matches} auctions=${totals.auctions} topTies=${totals.ties} simWords=${totals.simWords} mismatches=${totals.mismatches}`,
    );
    expect(totals.matches).toBe(fixture.matches.length);
    expect(totals.mismatches).toBe(0);
  });
});
