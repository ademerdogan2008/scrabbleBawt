import { describe, expect, it } from 'vitest';
import { BAG, totalAuctions } from '../../src/core/letters.js';
import { rackFromWord, rackToString } from '../../src/core/rack.js';
import type { AuctionInfo, MatchConfig } from '../../src/core/types.js';
import {
  MatchTracker,
  bagRemaining,
  isLastAuction,
  leader,
  maxOpponentBalance,
  opponentById,
  rackSizeOf,
  scoreGapToLeader,
  unseenBalance,
} from '../../src/state/index.js';

function config(n = 2, rackSize = 5): MatchConfig {
  return {
    matchId: 1,
    auctionType: 'Vickrey',
    auctionDurationMs: 1000,
    startingRackSize: rackSize,
    startingBalance: 100,
    players: Array.from({ length: n }, (_, k) => ({ id: 10 + k, name: `p${k}`, isSim: k > 0 })),
    myId: 10,
    totalAuctions: totalAuctions(n, rackSize),
  };
}

function open(index: number, letter: string, cfg: MatchConfig): AuctionInfo {
  return {
    auctionId: 1000 + index,
    index,
    letter,
    opensAtMs: index * 1000,
    closesAtMs: index * 1000 + 1000,
    remainingAfter: cfg.totalAuctions - index - 1,
  };
}

describe('MatchTracker basics', () => {
  it('initial view: unseen = BAG - my start rack, invariant holds', () => {
    const cfg = config(3);
    const t = new MatchTracker(cfg, rackFromWord('AEQST'));
    const v = t.view;
    expect(v.me.info.id).toBe(10);
    expect(v.opponents.map((p) => p.info.id)).toEqual([11, 12]);
    expect(v.players.size).toBe(3);
    expect(v.unseen[0]).toBe(BAG[0]! - 1);
    expect(v.unseen[16]).toBe(BAG[16]! - 1); // Q
    expect(v.auctionsDone).toBe(0);
    expect(v.auctionsRemaining).toBe(83);
    expect(t.bagRemaining).toBe(83);
    expect(unseenBalance(v)).toEqual({ unseen: 93, expected: 93, ok: true });
    for (const p of v.opponents) expect(p.hiddenUnknown).toBe(5);
    expect(v.me.balance).toBe(100);
    expect(rackToString(v.me.rack)).toBe('AEQST');
  });

  it('auction open marks the letter seen once; result applies payment and rack', () => {
    const cfg = config(2);
    const t = new MatchTracker(cfg, rackFromWord('AAAAA'));
    const a = open(0, 'Q', cfg);
    t.auctionOpen(a);
    t.auctionOpen({ ...a, closesAtMs: 5000 }); // re-open/update: no double count
    expect(t.view.current?.closesAtMs).toBe(5000);
    expect(t.view.unseen[16]).toBe(0);
    expect(t.bagRemaining).toBe(cfg.totalAuctions - 1);
    expect(unseenBalance(t.view).ok).toBe(true);
    t.auctionResult({ auctionId: a.auctionId, index: 0, letter: 'Q', winnerId: 10, paid: 7 });
    t.auctionResult({ auctionId: a.auctionId, index: 0, letter: 'Q', winnerId: 10, paid: 7 }); // dup
    expect(t.view.current).toBeUndefined();
    expect(t.view.auctionsDone).toBe(1);
    expect(t.view.me.balance).toBe(93);
    expect(t.view.me.totalPaid).toBe(7);
    expect(t.view.me.lettersWon).toBe(1);
    expect(rackToString(t.view.me.rack)).toBe('AAAAAQ');
    expect(unseenBalance(t.view).ok).toBe(true);
    expect(t.view.unseen[16]).toBe(0);
  });

  it('result without a prior open still removes the letter from unseen', () => {
    const cfg = config(2);
    const t = new MatchTracker(cfg, rackFromWord('AAAAA'));
    t.auctionResult({ auctionId: 1, index: 0, letter: 'Z', winnerId: null, paid: 0 });
    expect(t.view.unseen[25]).toBe(0);
    expect(t.view.history).toHaveLength(1);
    expect(unseenBalance(t.view).ok).toBe(true);
  });

  it('opponent word beyond wins reveals hidden tiles; knownHeld stays a lower bound', () => {
    const cfg = config(2);
    const t = new MatchTracker(cfg, rackFromWord('EEEEE'));
    const a = open(0, 'T', cfg);
    t.auctionOpen(a);
    t.auctionResult({ auctionId: a.auctionId, index: 0, letter: 'T', winnerId: 11, paid: 3 });
    const opp = t.player(11);
    expect(rackToString(opp.knownHeld)).toBe('T');
    t.wordPlay({ playerId: 11, word: 'CAT', reward: 5, auctionIndex: 1 });
    expect(rackToString(opp.revealedHidden)).toBe('AC');
    expect(rackToString(opp.played)).toBe('ACT');
    expect(rackToString(opp.knownHeld)).toBe('');
    expect(opp.hiddenUnknown).toBe(3);
    expect(opp.balance).toBe(102);
    expect(opp.score).toBe(5);
    expect(rackSizeOf(t.view, opp)).toBe(3);
    expect(unseenBalance(t.view).ok).toBe(true);
    expect(t.view.unseen[2]).toBe(BAG[2]! - 1);
  });

  it('my word debits my rack; unspellable word throws without mutating', () => {
    const cfg = config(2);
    const t = new MatchTracker(cfg, rackFromWord('CATSE'));
    t.wordPlay({ playerId: 10, word: 'CAT', reward: 5, auctionIndex: 0 });
    expect(rackToString(t.view.me.rack)).toBe('ES');
    expect(t.view.me.score).toBe(5);
    const before = t.snapshot();
    expect(() => t.wordPlay({ playerId: 10, word: 'SEE', reward: 3, auctionIndex: 0 })).toThrow(
      /cannot spell/,
    );
    expect(t.snapshot()).toEqual(before);
    expect(() => t.wordPlay({ playerId: 99, word: 'AT', reward: 2, auctionIndex: 0 })).toThrow(
      /unknown player/,
    );
    expect(() => t.wordPlay({ playerId: 11, word: 'a1', reward: 2, auctionIndex: 0 })).toThrow(
      /invalid letter/,
    );
  });

  it('hidden overflow is clamped and counted', () => {
    const cfg = config(2, 2);
    const t = new MatchTracker(cfg, rackFromWord('EE'));
    t.wordPlay({ playerId: 11, word: 'CAT', reward: 5, auctionIndex: 0 });
    const opp = t.player(11);
    expect(t.diagnostics.hiddenOverflow).toBe(1);
    expect(rackRevealedTotal(opp.revealedHidden)).toBe(2);
    expect(opp.hiddenUnknown).toBe(0);
  });

  it('resyncs count mismatches', () => {
    const cfg = config(2);
    const t = new MatchTracker(cfg, rackFromWord('CATSE'));
    t.setBalance(11, 100, 0);
    t.setMyRack(rackFromWord('ACEST'));
    expect(t.diagnostics).toEqual({
      balanceMismatches: 0,
      rackMismatches: 0,
      hiddenOverflow: 0,
      unseenNegative: 0,
    });
    t.setBalance(11, 90, 4);
    t.setMyRack(rackFromWord('ACESTX'));
    expect(t.diagnostics.balanceMismatches).toBe(1);
    expect(t.diagnostics.rackMismatches).toBe(1);
    expect(t.player(11).balance).toBe(90);
    expect(t.player(11).score).toBe(4);
    expect(rackToString(t.view.me.rack)).toBe('ACESTX');
  });

  it('snapshot is a deep copy', () => {
    const cfg = config(2);
    const t = new MatchTracker(cfg, rackFromWord('CATSE'));
    const s = t.snapshot();
    t.auctionOpen(open(0, 'E', cfg));
    t.wordPlay({ playerId: 10, word: 'CAT', reward: 5, auctionIndex: 0 });
    expect(rackToString(s.me.rack)).toBe('ACEST');
    expect(s.me.score).toBe(0);
    expect(s.current).toBeUndefined();
    expect(s.words).toHaveLength(0);
    expect(s.unseen[4]).toBe(BAG[4]! - 1);
    expect(s.players.get(10)).toBe(s.me);
    expect(t.view).toBe(t.view); // stable live object
  });

  it('rejects configs without me or with duplicate ids', () => {
    const cfg = config(2);
    expect(() => new MatchTracker({ ...cfg, myId: 77 }, rackFromWord('A'))).toThrow();
    expect(
      () =>
        new MatchTracker({ ...cfg, players: [cfg.players[0]!, cfg.players[0]!] }, rackFromWord('A')),
    ).toThrow(/duplicate/);
  });
});

function rackRevealedTotal(r: Uint8Array): number {
  return r.reduce((a, b) => a + b, 0);
}

describe('view helpers', () => {
  it('leader / gap / balances / opponentById / last auction', () => {
    const cfg = config(3);
    const t = new MatchTracker(cfg, rackFromWord('CATSE'));
    const v = t.view;
    expect(leader(v).info.id).toBe(10); // all tied -> config order
    expect(scoreGapToLeader(v)).toBe(0);
    t.wordPlay({ playerId: 12, word: 'QI', reward: 11, auctionIndex: 0 });
    t.wordPlay({ playerId: 10, word: 'AT', reward: 2, auctionIndex: 0 });
    expect(leader(v).info.id).toBe(12);
    expect(scoreGapToLeader(v)).toBe(9);
    expect(scoreGapToLeader(v, 12)).toBe(-9);
    expect(maxOpponentBalance(v)).toBe(111);
    expect(opponentById(v, 11)?.info.name).toBe('p1');
    expect(opponentById(v, 10)).toBeUndefined();
    expect(isLastAuction({ ...open(0, 'A', cfg), remainingAfter: 0 })).toBe(true);
    expect(isLastAuction(open(0, 'A', cfg))).toBe(false);
    expect(bagRemaining(v)).toBe(cfg.totalAuctions);
    t.auctionOpen(open(0, 'B', cfg));
    expect(bagRemaining(v)).toBe(cfg.totalAuctions - 1);
    expect(t.auctionsRemaining).toBe(cfg.totalAuctions);
  });
});
