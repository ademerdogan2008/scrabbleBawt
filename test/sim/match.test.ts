import { describe, expect, it } from 'vitest';
import { BAG_SIZE, LETTERS, idx, totalAuctions, wordReward } from '../../src/core/letters.js';
import { rackFromWord, rackToString } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import { simBid } from '../../src/core/simbots.js';
import type { MatchView, Policy, SimStrategy } from '../../src/core/types.js';
import { getEngine } from '../../src/engine/index.js';
import { replay } from '../../src/state/events.js';
import {
  DEFAULT_SPEC,
  closeAuction,
  drawLetter,
  newBag,
  runMatch,
  runMatchCore,
  type MatchResult,
  type SeatSpec,
} from '../../src/sim/match.js';
import { IndependentStreams, SeatOrderModel, type MatchRngSource } from '../../src/sim/rngStreams.js';
import { constBid, noBid, policySeat, scripted, simSeat, simpleGreedy, sixSims } from './helpers.js';

const engine = getEngine();

function letters(r: MatchResult): string {
  return r.trace!.auctions.map((a) => a.letter).join('');
}

/** Rebuild every seat's rack/balance per auction from a trace; returns checks for sims. */
function walkTrace(r: MatchResult, seats: readonly SeatSpec[], startBalance = 100) {
  const tr = r.trace!;
  const racks = new Map(seats.map((s) => [s.id, rackFromWord(tr.startRacks[s.id]!)]));
  const bal = new Map(seats.map((s) => [s.id, startBalance]));
  const wordsByIndex = new Map<number, typeof tr.words>();
  for (const w of tr.words) {
    if (!wordsByIndex.has(w.index)) wordsByIndex.set(w.index, []);
    wordsByIndex.get(w.index)!.push(w);
  }
  return { tr, racks, bal, wordsByIndex };
}

describe('step functions', () => {
  it('drawLetter walks A..Z counts and makes no call on an empty bag', () => {
    const bag = newBag();
    expect(LETTERS[drawLetter(bag, () => 0)]).toBe('A');
    expect(LETTERS[drawLetter(bag, () => 8)]).toBe('B'); // 8 A's left -> index 8 is the first B
    expect(LETTERS[drawLetter(bag, (t) => t - 1)]).toBe('Z');
    expect(bag.total).toBe(BAG_SIZE - 3);
    const empty = { counts: new Uint8Array(26), total: 0 };
    let calls = 0;
    expect(
      drawLetter(empty, () => {
        calls++;
        return 0;
      }),
    ).toBe(-1);
    expect(calls).toBe(0);
  });

  it('closeAuction: Vickrey second price, sole bidder pays 1, FirstPrice pays top, filter > 0', () => {
    const noShuffle = () => 0;
    const bal = () => 100;
    const v = closeAuction(
      [
        { seat: 0, amount: 4 },
        { seat: 1, amount: 9 },
        { seat: 2, amount: 0 },
      ],
      'Vickrey',
      (i) => i,
      bal,
    );
    expect([v.winner, v.top, v.paid, v.applied]).toEqual([1, 9, 4, true]);
    const sole = closeAuction([{ seat: 3, amount: 7 }], 'Vickrey', noShuffle, bal);
    expect([sole.winner, sole.top, sole.paid]).toEqual([3, 7, 1]);
    const fp = closeAuction(
      [
        { seat: 0, amount: 4 },
        { seat: 1, amount: 9 },
      ],
      'FirstPrice',
      (i) => i,
      bal,
    );
    expect([fp.winner, fp.paid]).toEqual([1, 9]);
    const none = closeAuction([{ seat: 0, amount: 0 }], 'Vickrey', noShuffle, bal);
    expect([none.winner, none.paid, none.top]).toEqual([null, 0, 0]);
    // balance check: cannot pay -> not applied (module: no tile, no debit)
    const broke = closeAuction([{ seat: 0, amount: 5 }, { seat: 1, amount: 5 }], 'Vickrey', (i) => i, () => 4);
    expect(broke.applied).toBe(false);
  });

  it('closeAuction shuffle consumes len-1 calls and the stable sort keeps the shuffled tie order', () => {
    const calls: number[] = [];
    const r = closeAuction(
      [
        { seat: 0, amount: 5 },
        { seat: 1, amount: 5 },
        { seat: 2, amount: 3 },
      ],
      'Vickrey',
      (i) => {
        calls.push(i);
        return 0; // i=2: swap(2,0) -> [2,1,0]; i=1: swap(1,0) -> [1,2,0]
      },
      () => 100,
    );
    expect(calls).toEqual([2, 1]);
    expect(r.sorted.map((b) => b.seat)).toEqual([1, 0, 2]);
    expect([r.winner, r.paid]).toEqual([1, 5]);
  });
});

describe('runMatch rules', () => {
  it('Vickrey payments: second price and sole bidder pays 1', () => {
    const a = scripted('a', (_v, au) => ({ words: [], bid: au.index === 0 ? 10 : au.index === 1 ? 7 : 0 }));
    const b = scripted('b', (_v, au) => ({ words: [], bid: au.index === 0 ? 4 : 0 }));
    const r = runMatch({ trace: true }, [policySeat(1, a), policySeat(2, b)], 5);
    const [a0, a1, a2] = r.trace!.auctions;
    expect([a0!.winnerId, a0!.paid, a0!.top]).toEqual([1, 4, 10]);
    expect([a1!.winnerId, a1!.paid, a1!.top]).toEqual([1, 1, 7]);
    expect([a2!.winnerId, a2!.paid]).toEqual([null, 0]);
    expect(r.seats[0]!.totalPaid).toBe(5);
    expect(r.seats[0]!.lettersWon).toBe(2);
  });

  it('FirstPrice pays the top bid', () => {
    const a = scripted('a', (_v, au) => ({ words: [], bid: au.index === 0 ? 10 : 0 }));
    const b = scripted('b', (_v, au) => ({ words: [], bid: au.index === 0 ? 4 : 0 }));
    const r = runMatch({ trace: true, auctionType: 'FirstPrice' }, [policySeat(1, a), policySeat(2, b)], 5);
    expect([r.trace!.auctions[0]!.winnerId, r.trace!.auctions[0]!.paid]).toEqual([1, 10]);
    expect(r.seats[0]!.balance).toBe(90);
  });

  it('ties are resolved randomly (both outcomes occur) and deterministically per seed', () => {
    const tieFirst = new Set<number | null>();
    for (let seed = 1; seed <= 20; seed++) {
      const seats = [policySeat(1, scripted('a', constBid(1))), policySeat(2, scripted('b', constBid(1)))];
      const r = runMatch({ trace: true }, seats, seed);
      tieFirst.add(r.trace!.auctions[0]!.winnerId);
      const r2 = runMatch({ trace: true }, seats, seed);
      expect(r2.trace!.auctions.map((x) => x.winnerId)).toEqual(r.trace!.auctions.map((x) => x.winnerId));
      const wins = new Set(r.trace!.auctions.filter((x) => x.paid === 1).map((x) => x.winnerId));
      expect(wins.size).toBe(2); // within one match both seats win some ties
    }
    expect(tieFirst).toEqual(new Set([1, 2]));
  });

  it('unbid letters are consumed: auction count stays 98 - rack*N', () => {
    const seats = [policySeat(1, scripted('a', noBid)), policySeat(2, scripted('b', noBid)), policySeat(3, scripted('c', noBid))];
    const r = runMatch({ trace: true }, seats, 9);
    expect(r.auctions).toBe(totalAuctions(3, 5));
    expect(r.trace!.auctions.every((a) => a.winnerId === null && a.paid === 0)).toBe(true);
    for (const s of r.seats) expect([s.score, s.balance, s.lettersWon, s.unplayedTiles]).toEqual([0, 100, 0, 5]);
  });

  it('the final letter is unusable by policies; sims can use it', () => {
    const r = runMatch(
      { trace: true },
      [
        policySeat(1, scripted('g', simpleGreedy)),
        policySeat(2, scripted('w', (v, a) => ({ words: [], bid: a.remainingAfter === 0 ? v.me.balance : 0 }))),
      ],
      3,
    );
    const last = r.trace!.auctions[r.auctions - 1]!;
    expect(last.winnerId).toBe(2);
    expect(r.trace!.words.every((w) => w.index < r.auctions)).toBe(true);
    // the winner of the final letter still holds it
    expect(rackFromWord(r.trace!.finalRacks[2]!)[idx(last.letter)]).toBeGreaterThan(0);
    // sims: over a few seeds some sim word is played in the final close using the final letter
    let finalSimWords = 0;
    for (let seed = 1; seed <= 40 && finalSimWords === 0; seed++) {
      const m = runMatch({ trace: true }, sixSims(), seed);
      for (const w of m.trace!.words) {
        if (w.index === m.auctions - 1 && w.word.includes(m.trace!.auctions[w.index]!.letter)) finalSimWords++;
      }
    }
    expect(finalSimWords).toBeGreaterThan(0);
  });

  it('sims bid exactly simBid(strategy, letter, balance, jitter) and play only after a win (module word choice)', () => {
    const jitters: number[] = [];
    const base = new IndependentStreams(77);
    const source: MatchRngSource = {
      deal: (t) => base.deal(t),
      draw: (t) => base.draw(t),
      simJitter: (s) => {
        const j = base.simJitter();
        jitters.push(j);
        return j;
      },
      tieShuffle: (i, k) => base.tieShuffle(i, k),
    };
    const seats: SeatSpec[] = [
      simSeat(1, 'Aggressive'),
      policySeat(2, scripted('g', simpleGreedy)),
      simSeat(3, 'Cheapskate'),
      simSeat(4, 'ValueBidder'),
      simSeat(5, 'Human'),
    ];
    const sims = seats.filter((s) => s.kind === 'sim');
    const r = runMatchCore({ ...DEFAULT_SPEC, trace: true }, seats, source, new SeatOrderModel(), 77);
    expect(jitters.length).toBe(sims.length * r.auctions); // one jitter per sim per open, always
    const { tr, racks, bal, wordsByIndex } = walkTrace(r, seats);
    let j = 0;
    let simWords = 0;
    for (const a of tr.auctions) {
      for (const s of sims) {
        if (s.kind !== 'sim') continue;
        const expected = simBid(s.simStrategy, idx(a.letter), bal.get(s.id)!, jitters[j++]!);
        expect(a.bids[s.id] ?? 0).toBe(expected);
      }
      if (a.winnerId !== null) {
        bal.set(a.winnerId, bal.get(a.winnerId)! - a.paid);
        racks.get(a.winnerId)![idx(a.letter)]!++;
      }
      // policy words of this auction were played before the close, sim words after it
      const ws = wordsByIndex.get(a.index) ?? [];
      const simWs = ws.filter((w) => sims.some((s) => s.id === w.seatId));
      expect(simWs.length).toBeLessThanOrEqual(1);
      for (const w of ws) {
        const isSim = sims.some((s) => s.id === w.seatId);
        if (isSim) {
          expect(w.seatId).toBe(a.winnerId);
          expect(w.word.length).toBeGreaterThanOrEqual(3);
          expect(w.word).toBe(engine.index.findBestPlayable(racks.get(w.seatId)!, 3));
          simWords++;
        }
        const rk = racks.get(w.seatId)!;
        for (const c of w.word) rk[idx(c)]!--;
        bal.set(w.seatId, bal.get(w.seatId)! + w.reward);
      }
      // a winning sim that did not play has no 3+ word
      if (a.winnerId !== null && sims.some((s) => s.id === a.winnerId) && simWs.length === 0) {
        expect(engine.index.findBestPlayable(racks.get(a.winnerId)!, 3)).toBeUndefined();
      }
    }
    expect(simWords).toBeGreaterThan(5);
    for (const s of seats) expect(rackToString(racks.get(s.id)!)).toBe(tr.finalRacks[s.id]);
    expect(r.seats.find((s) => s.id === 5)!.lettersWon).toBe(0); // Human sims never bid
  });

  it('invalid words and over-balance / malformed bids are rejected without effect', () => {
    const bad = scripted('bad', (v, a) => ({
      words: ['XYZZYQ', 'ZZZ', '', 'cat!', 42 as unknown as string],
      bid: a.index % 3 === 0 ? v.me.balance + 1 : a.index % 3 === 1 ? 1.5 : -1,
    }));
    const r = runMatch({ trace: true }, [policySeat(1, bad), policySeat(2, scripted('n', noBid))], 4);
    const s = r.seats[0]!;
    expect(s.rejectedWords).toBe(5 * r.auctions);
    expect(s.rejectedBids).toBe(r.auctions);
    expect([s.score, s.balance, s.lettersWon, s.wordsPlayed]).toEqual([0, 100, 0, 0]);
  });

  it('lowercase words are accepted like the server (asciiUppercase) and credited', () => {
    let done = false;
    const p = scripted('lc', (v) => {
      if (done) return { words: [], bid: 0 };
      const w = engine.index.findBestPlayable(v.me.rack, 2);
      if (!w) return { words: [], bid: 0 };
      done = true;
      return { words: [w.toLowerCase()], bid: 0 };
    });
    for (let seed = 1; seed < 10; seed++) {
      done = false;
      const r = runMatch({ trace: true }, [policySeat(1, p), policySeat(2, scripted('n', noBid))], seed);
      if (!done) continue;
      const w = r.trace!.words[0]!;
      expect(w.word).toBe(w.word.toUpperCase());
      expect(r.seats[0]!.score).toBe(wordReward(w.word));
      return;
    }
    throw new Error('no seed produced a playable start rack');
  });

  it('same seed => identical deal and letter sequence for different policies', () => {
    for (const seed of [1, 2, 3, 1234567]) {
      const r1 = runMatch({ trace: true }, [policySeat(1, scripted('a', simpleGreedy)), ...sixSims(2).slice(0, 4)], seed);
      const r2 = runMatch({ trace: true }, [policySeat(1, scripted('b', constBid(30))), ...sixSims(2).slice(0, 4)], seed);
      expect(letters(r1)).toBe(letters(r2));
      expect(r1.trace!.startRacks).toEqual(r2.trace!.startRacks);
    }
  });

  it('works for N = 2..12 and rack sizes 0..8; rejects N*rack >= 98 and N < 2', () => {
    const strategies: SimStrategy[] = ['Aggressive', 'ValueBidder', 'Cheapskate'];
    for (let n = 2; n <= 12; n++) {
      for (let rack = 0; rack <= 8; rack++) {
        const seats: SeatSpec[] = [policySeat(1, scripted('g', simpleGreedy))];
        for (let k = 1; k < n; k++) seats.push(simSeat(k + 1, strategies[k % 3]!));
        if (n * rack >= 98) {
          expect(() => runMatch({ startingRackSize: rack }, seats, n)).toThrow(/startingRackSize/);
          continue;
        }
        const r = runMatch({ startingRackSize: rack }, seats, n * 100 + rack);
        expect(r.auctions).toBe(98 - n * rack);
        for (const s of r.seats) expect(s.balance).toBeGreaterThanOrEqual(0);
      }
    }
    expect(() => runMatch({}, [simSeat(1, 'Aggressive')], 1)).toThrow(/at least 2/);
  });

  it('balances never go negative and score == sum of word rewards (random policies)', () => {
    const randomPolicy = (name: string): Policy => {
      let rng = new Rng(1);
      return {
        name,
        onMatchStart() {},
        decide(v: MatchView, _a, ctx) {
          rng = ctx.rng;
          const words: string[] = [];
          if (rng.float() < 0.5) {
            const w = engine.index.bestSingleWord(v.me.rack, 2);
            if (w) words.push(w.word);
          }
          return { words, bid: rng.int(0, Math.max(0, v.me.balance)) };
        },
      };
    };
    for (let seed = 1; seed <= 15; seed++) {
      const seats = [policySeat(1, randomPolicy('r1')), policySeat(2, randomPolicy('r2')), ...sixSims(3).slice(0, 3)];
      const r = runMatch({ trace: true }, seats, seed);
      for (const s of r.seats) {
        const rewards = r.trace!.words.filter((w) => w.seatId === s.id).reduce((t, w) => t + w.reward, 0);
        expect(s.score).toBe(rewards);
        expect(s.balance).toBe(100 + rewards - s.totalPaid);
        expect(s.balance).toBeGreaterThanOrEqual(0);
      }
      // bids in the trace never exceed what the bidder could afford at the time
      const { tr, bal, wordsByIndex } = walkTrace(r, seats);
      for (const a of tr.auctions) {
        for (const w of (wordsByIndex.get(a.index) ?? []).filter((x) => x.seatId === 1 || x.seatId === 2)) {
          bal.set(w.seatId, bal.get(w.seatId)! + w.reward);
        }
        for (const [id, amt] of Object.entries(a.bids)) expect(amt).toBeLessThanOrEqual(bal.get(Number(id))!);
        if (a.winnerId !== null) bal.set(a.winnerId, bal.get(a.winnerId)! - a.paid);
        for (const w of (wordsByIndex.get(a.index) ?? []).filter((x) => x.seatId > 2)) {
          bal.set(w.seatId, bal.get(w.seatId)! + w.reward);
        }
      }
    }
  });

  it('ranks share places on ties and winners are all top scorers', () => {
    const r = runMatch({}, [policySeat(1, scripted('a', noBid)), policySeat(2, scripted('b', noBid))], 1);
    expect(r.seats.map((s) => [s.rank, s.win])).toEqual([
      [1, true],
      [1, true],
    ]);
    expect(r.winnerIds).toEqual([1, 2]);
  });

  it('trace.events[seat] replays into a view identical to the live tracker view', () => {
    const captured = new Map<number, unknown>();
    const capture = (id: number, inner: Policy): Policy => ({
      ...inner,
      name: inner.name,
      onMatchStart: (v) => inner.onMatchStart(v),
      decide: (v, a, c) => inner.decide(v, a, c),
      onMatchEnd: (v) => captured.set(id, structuredClone(v)),
    });
    const seats = [
      policySeat(1, capture(1, scripted('g', simpleGreedy))),
      policySeat(2, capture(2, scripted('c', constBid(6)))),
      ...sixSims(3).slice(0, 4),
    ];
    const r = runMatch({ trace: true }, seats, 2024);
    for (const id of [1, 2]) {
      const events = r.trace!.events[id]!;
      expect(events[0]!.t).toBe('start');
      const rebuilt = replay(JSON.parse(JSON.stringify(events)));
      expect(structuredClone(rebuilt.view)).toEqual(captured.get(id));
      expect(rebuilt.diagnostics).toEqual({ balanceMismatches: 0, rackMismatches: 0, hiddenOverflow: 0, unseenNegative: 0 });
      // tracker agrees with the simulator's ground truth
      const me = r.seats.find((s) => s.id === id)!;
      expect(rebuilt.view.me.score).toBe(me.score);
      expect(rebuilt.view.me.balance).toBe(me.balance);
      expect(rackToString(rebuilt.view.me.rack)).toBe(r.trace!.finalRacks[id]);
      for (const s of r.seats) expect(rebuilt.view.players.get(s.id)!.score).toBe(s.score);
    }
  });

  it('oracle seats receive every true rack before each decide', () => {
    let calls = 0;
    let checked = false;
    const oracle: Policy = {
      name: 'oracle',
      onMatchStart() {},
      onOracle(racks) {
        calls++;
        expect(racks.size).toBe(3);
      },
      decide: (v) => {
        checked = true;
        return { words: [], bid: Math.min(2, v.me.balance) };
      },
    };
    const r = runMatch({}, [policySeat(1, oracle, true), simSeat(2, 'Aggressive'), simSeat(3, 'Cheapskate')], 8);
    expect(checked).toBe(true);
    expect(calls).toBe(r.auctions);
  });

  it('enforceBudget voids slow decisions', () => {
    const slow = scripted('slow', () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 6) {
        /* spin */
      }
      return { words: [], bid: 1 };
    });
    const r = runMatch(
      { enforceBudget: true, auctionDurationMs: 10, simulatedLatencyMs: 5, startingRackSize: 8 },
      [policySeat(1, slow), simSeat(2, 'Cheapskate'), ...Array.from({ length: 10 }, (_, k) => simSeat(3 + k, 'Cheapskate'))],
      1,
    );
    expect(r.seats[0]!.voidedDecisions).toBe(r.auctions);
    expect(r.seats[0]!.lettersWon).toBe(0);
    expect(r.seats[0]!.decideMs.n).toBe(r.auctions);
    expect(r.seats[0]!.decideMs.p50).toBeGreaterThanOrEqual(6);
  });
});
