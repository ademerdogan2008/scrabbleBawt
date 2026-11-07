// Loader: gz NDJSON streaming, per-match grouping, word attribution at equal timestamps,
// completeness, deleted bot rows, canonical schedule and per-seat helpers.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rackTotal } from '../../src/core/rack.js';
import {
  attributeWords,
  auctionInfo,
  canonicalSchedule,
  compareWords,
  loadMatches,
  matchConfig,
  rankOf,
  resolveBot,
  revealStartTiles,
} from '../../src/history/load.js';
import type { HistMatch, HistWord } from '../../src/history/types.js';

const MINI = path.join(__dirname, 'fixtures', 'mini'); // matches 1 (all sims), 292 (deleted bot 34), 42656 (incomplete)

describe('loadMatches on the mini fixture (gz)', async () => {
  const D = await loadMatches(MINI);
  const byId = new Map(D.matches.map((m) => [m.id, m]));

  it('loads every match in id order with roster-ordered participants', () => {
    expect(D.matches.map((m) => m.id)).toEqual([1, 292, 42656]);
    for (const m of D.matches) {
      const ids = m.participants.map((p) => p.rowId);
      expect([...ids].sort((a, b) => a - b)).toEqual(ids);
      expect(m.participants).toHaveLength(6);
    }
    expect(D.orphanTopBids).toBe(0);
  });

  it('flags completeness exactly (status ended, 98-5P auctions, every top bid present)', () => {
    const m1 = byId.get(1)!;
    expect(m1.complete).toBe(true);
    expect(m1.auctions).toHaveLength(68);
    expect(m1.expectedAuctions).toBe(68);
    expect(m1.auctionType).toBe('Vickrey');
    expect(m1.kind).toBe('lobby');
    expect(byId.get(292)!.complete).toBe(true);
    const inc = byId.get(42656)!;
    expect(inc.status).toBe('ended');
    expect(inc.auctions).toHaveLength(11);
    expect(inc.auctions.every((a) => a.topBid === null)).toBe(true);
    expect(inc.complete).toBe(false);
  });

  it('assigns a sim word sharing the close timestamp to the auction that just closed (inClose)', () => {
    const m1 = byId.get(1)!;
    const achy = m1.words.find((w) => w.word === 'ACHY')!;
    expect(achy.playedAtUs).toBe(1792795760065667);
    expect(m1.auctions[0]!.closedAtUs).toBe(1792795760065667);
    expect(achy.auctionIndex).toBe(0);
    expect(achy.inClose).toBe(true);
    const sched = canonicalSchedule(m1);
    expect(sched.steps[0]!.after.map((w) => w.word)).toContain('ACHY');
    expect(sched.steps[0]!.before).toHaveLength(0);
    expect(sched.trailing).toHaveLength(0);
    // All-sim match: every word is a close-transaction word right after its player's win.
    for (const w of m1.words) {
      expect(w.inClose).toBe(true);
      expect(m1.auctions[w.auctionIndex]!.winnerId).toBe(w.botId);
    }
  });

  it('attributes real-bot words to the auction open at play time (before its result)', () => {
    const m = byId.get(292)!;
    const realWords = m.words.filter((w) => !D.bots.get(w.botId)!.isSim);
    expect(realWords.length).toBeGreaterThan(0);
    for (const w of realWords) {
      expect(w.inClose).toBe(false);
      const a = m.auctions[w.auctionIndex]!;
      expect(a.closedAtUs).toBeGreaterThan(w.playedAtUs);
      if (w.auctionIndex > 0) expect(m.auctions[w.auctionIndex - 1]!.closedAtUs).toBeLessThan(w.playedAtUs);
    }
    // words are in canonical order
    for (let i = 1; i < m.words.length; i++) expect(compareWords(m.words[i - 1]!, m.words[i]!)).toBeLessThan(0);
  });

  it('loads deleted bot rows as missing placeholders (PITFALLS m6)', () => {
    const b = D.bots.get(34)!;
    expect(b).toEqual({ id: 34, name: '#34', isSim: false, missing: true });
    const m = byId.get(292)!;
    expect(m.participants.some((p) => p.botId === 34)).toBe(true);
    expect(m.nReal + m.nSim).toBe(6);
    expect(D.bots.get(3)!.isSim).toBe(true);
    expect(D.bots.get(3)!.simStrategy).toBe('Aggressive');
    expect(resolveBot(D.bots, 'Brutus-sim')!.id).toBe(3);
    expect(resolveBot(D.bots, '34')!.missing).toBe(true);
  });

  it('builds MatchConfig / AuctionInfo consistent with the live client conventions', () => {
    const m = byId.get(1)!;
    const me = m.participants[2]!.botId;
    const cfg = matchConfig(m, D.bots, me);
    expect(cfg.players.map((p) => p.id)).toEqual(m.participants.map((p) => p.botId));
    expect(cfg.totalAuctions).toBe(68);
    expect(cfg.auctionType).toBe('Vickrey');
    expect(cfg.players.every((p) => p.isSim && p.simStrategy)).toBe(true);
    const a0 = auctionInfo(m, 0);
    const a1 = auctionInfo(m, 1);
    expect(a0.remainingAfter).toBe(67);
    expect(auctionInfo(m, 67).remainingAfter).toBe(0);
    expect(a1.opensAtMs).toBe(Math.floor(m.auctions[0]!.closedAtUs / 1000));
    expect(a1.closesAtMs - a1.opensAtMs).toBe(1000);
  });

  it('reveals proven starting tiles without overdraw', () => {
    for (const m of D.matches.filter((x) => x.complete)) {
      const { revealed, overdraw } = revealStartTiles(m);
      expect(overdraw).toBe(0);
      for (const r of revealed.values()) expect(rackTotal(r)).toBeLessThanOrEqual(5);
    }
  });

  it('filters matches before streaming the big tables', async () => {
    const one = await loadMatches(MINI, { filter: (h) => h.state.id === 292 });
    expect(one.matches.map((m) => m.id)).toEqual([292]);
    expect(one.skippedRows).toBeGreaterThan(0);
    const noWords = await loadMatches(MINI, { skipWords: true, filter: (h) => h.state.id === 1 });
    expect(noWords.matches[0]!.words).toHaveLength(0);
    expect(noWords.matches[0]!.complete).toBe(true);
  });
});

describe('attributeWords (synthetic, strict < and equality)', () => {
  const mk = (id: number, at: number): HistWord => ({
    id,
    botId: 1,
    word: 'AT',
    baseScore: 2,
    bonus: 0,
    reward: 2,
    playedAtUs: at,
    auctionIndex: -1,
    inClose: false,
  });
  const m = {
    auctions: [100, 200, 300].map((t, i) => ({
      index: i,
      auctionId: 10 + i,
      letter: 'A',
      winnerId: null,
      paid: 0,
      topBid: 0,
      closedAtUs: t,
    })),
    words: [mk(5, 300), mk(1, 50), mk(2, 100), mk(3, 150), mk(4, 200), mk(6, 301), mk(7, 150)],
  } as unknown as HistMatch;

  it('counts strictly earlier closes and marks same-timestamp words inClose', () => {
    attributeWords(m);
    const got = m.words.map((w) => [w.id, w.auctionIndex, w.inClose]);
    expect(got).toEqual([
      [1, 0, false], // before the first close
      [2, 0, true], // in close of auction 0
      [3, 1, false], // between closes 0 and 1
      [7, 1, false],
      [4, 1, true],
      [5, 2, true], // in the final close
      [6, 3, false], // after the final close -> trailing
    ]);
    const s = canonicalSchedule(m);
    expect(s.trailing.map((w) => w.id)).toEqual([6]);
    expect(s.steps[1]!.before.map((w) => w.id)).toEqual([3, 7]);
    expect(s.steps[1]!.after.map((w) => w.id)).toEqual([4]);
  });

  it('rankOf: 1 + strictly higher scores', () => {
    expect(rankOf([10, 20, 20, 5], 20)).toBe(1);
    expect(rankOf([10, 20, 30], 20)).toBe(2);
  });
});
