import { describe, expect, it } from 'vitest';
import { VALUE, idx } from '../../src/core/letters.js';
import { rackFromWord, rackToString, rackTotal } from '../../src/core/rack.js';
import { getEngine } from '../../src/engine/index.js';
import { replay } from '../../src/state/events.js';
import { unseenBalance } from '../../src/state/view.js';
import {
  buildMatchConfig,
  classifyError,
  emptyMatchTx,
  MatchDriver,
  normAuction,
  normMatchState,
  normResult,
  normWord,
  rebuildFromSnapshot,
  type MatchTx,
} from '../../src/client/adapter.js';
import { eventsFromLog } from '../../src/client/log.js';
import { Reservations } from '../../src/client/words.js';
import { Harness, scriptedFactory } from './fixtures/harness.js';
import { DEFAULT_PLAYERS } from './fixtures/fakeServer.js';

const ZERO = { balanceMismatches: 0, rackMismatches: 0, hiddenOverflow: 0, unseenNegative: 0 };

describe('row normalizers (SDK shapes -> plain rows)', () => {
  const ts = (us: bigint) => ({ microsSinceUnixEpoch: us });
  it('keep µs timestamps exact and map enums/options', () => {
    const a = normAuction({ id: 5n, matchId: 9n, letter: 'Q', opensAt: ts(1_760_000_000_123_456n), closesAt: ts(1_760_000_001_123_456n), status: { tag: 'Open' } });
    expect(a).toEqual({ id: 5, matchId: 9, letter: 'Q', opensAtUs: 1_760_000_000_123_456n, closesAtUs: 1_760_000_001_123_456n, open: true });
    const r = normResult({ auctionId: 5n, matchId: 9n, letter: 'Q', winnerBotId: undefined, paid: 0n, closedAt: ts(7n) });
    expect(r.winnerBotId).toBeNull();
    const w = normWord({ id: 1n, matchId: 9n, botId: 3n, word: 'QAT', totalReward: 12n, playedAt: ts(9n) });
    expect(w).toMatchObject({ id: 1, botId: 3, reward: 12, playedAtUs: 9n });
    const s = normMatchState({
      id: 9n,
      status: { tag: 'Running' },
      currentRound: 3,
      currentAuctionId: 5n,
      bagTotal: 60,
      auctionType: { tag: 'FirstPrice' },
      createdAt: ts(1n),
      auctionDurationMs: 250n,
      startingRackSize: 7,
    });
    expect(s).toMatchObject({ id: 9, status: 'Running', currentAuctionId: 5, auctionType: 'FirstPrice', auctionDurationMs: 250, startingRackSize: 7 });
  });
});

describe('buildMatchConfig', () => {
  it('players in match_participant id order with sim strategies, totalAuctions = 98 - rack * P, kind from phase', () => {
    const h = new Harness({ tournamentPhase: 'Bracket' });
    h.server.startTx();
    const parts = [...h.server.participants.values()].reverse();
    const cfg = buildMatchConfig(h.server.state, parts, 101, h.server.botInfo, 'Bracket');
    expect(cfg.players.map((p) => p.id)).toEqual(DEFAULT_PLAYERS.map((p) => p.botId));
    expect(cfg.players[1]).toEqual({ id: 3, name: 'Brutus-sim', isSim: true, simStrategy: 'Aggressive' });
    expect(cfg.players[0]).toEqual({ id: 101, name: 'bawt', isSim: false });
    expect(cfg.totalAuctions).toBe(98 - 5 * 4);
    expect(cfg.kind).toBe('bracket');
    expect(buildMatchConfig(h.server.state, parts, 101, h.server.botInfo).kind).toBe('lobby');
  });
});

describe('MatchDriver on a scripted live match', () => {
  it('plays a full match: MatchEvent log replays to the same view with 0 diagnostics', async () => {
    const h = new Harness({ seed: 11 });
    h.start();
    await h.runToEnd(async (hh, i) => {
      if (i % 9 === 4) {
        const w = hh.server.opponentBestWord(150, 3);
        if (w) hh.server.opponentWordTx(150, w);
      }
    });
    const d = h.driver;
    expect(d.ended).toBe(true);
    const tr = d.tracker!;
    expect(tr.diagnostics).toEqual(ZERO);
    expect(unseenBalance(tr.view).ok).toBe(true);
    // Every auction was seen and closed.
    expect(tr.view.history.length).toBe(h.server.total);
    // Server truth agrees with the tracker.
    for (const [id, p] of h.server.participants) {
      expect(tr.player(id).balance).toBe(p.balance);
      expect(tr.player(id).score).toBe(p.score);
    }
    expect(rackToString(tr.me.rack)).toBe(rackToString(h.server.racks.get(101)!));
    // The JSONL match log replays to the same view.
    const lines = h.logLines.filter((l) => l.includes('"k":"event"'));
    const replayed = replay(eventsFromLog(lines));
    expect(replayed.snapshot()).toEqual(tr.snapshot());
    expect(replayed.diagnostics).toEqual(ZERO);
    // We actually played: bids sent, some auctions won, words played, no timing errors.
    expect(d.stats.bidsSent).toBeGreaterThan(10);
    expect(tr.me.lettersWon).toBeGreaterThan(0);
    expect(tr.me.words.length).toBeGreaterThan(0);
    expect(d.stats.timingErrors).toBe(0);
    expect(h.server.calls.filter((c) => !c.ok)).toEqual([]);
    // Sims played words inside close transactions.
    expect(tr.view.words.some((w) => w.playerId === 3 || w.playerId === 2)).toBe(true);
  });

  it('batching order: results -> words -> balances -> rack -> open; a sim word in close tx k gets index k after result(k)', async () => {
    const h = new Harness({ seed: 3 });
    h.start();
    let checked = 0;
    await h.runToEnd();
    const ev = h.driver.events;
    for (let i = 0; i < ev.length; i++) {
      const e = ev[i]!;
      if (e.t !== 'word' || (e.ev.playerId !== 3 && e.ev.playerId !== 2)) continue;
      // Sim words only happen in close transactions: the previous non-word event is the result of
      // the same auction index, and the next open (if any) comes after the word.
      let j = i - 1;
      while (j >= 0 && ev[j]!.t === 'word') j--;
      const prev = ev[j]!;
      expect(prev.t).toBe('result');
      if (prev.t === 'result') expect(prev.outcome.index).toBe(e.ev.auctionIndex);
      const nextOpen = ev.slice(i + 1).find((x) => x.t === 'open');
      if (nextOpen && nextOpen.t === 'open') expect(nextOpen.auction.index).toBe(e.ev.auctionIndex + 1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // Per close transaction: result, [words], balance(s), [rack], open in this order.
    const firstClose = ev.findIndex((e) => e.t === 'result');
    const nextOpenIdx = ev.findIndex((e, k) => k > firstClose && e.t === 'open');
    const between = ev.slice(firstClose, nextOpenIdx).map((e) => e.t);
    const order = ['result', 'word', 'balance', 'rack', 'open'];
    for (let k = 1; k < between.length; k++) expect(order.indexOf(between[k]!)).toBeGreaterThanOrEqual(order.indexOf(between[k - 1]!));
  });

  it('dedupes word_play rows by id and ignores re-delivered results/opens', async () => {
    const h = new Harness({ seed: 5 });
    h.start();
    for (let k = 0; k < 6; k++) await h.step();
    const before = h.driver.events.length;
    const snap = h.server.snapshot(99);
    h.driver.applyTx(snap, h.localMs()); // full re-delivery of every row
    await h.settle();
    const after = h.driver.events.slice(before).map((e) => e.t);
    expect(after.every((t) => t === 'balance' || t === 'rack')).toBe(true);
    expect(h.driver.tracker!.diagnostics).toEqual(ZERO);
  });

  it('anchor bid is sent right after the open, refine resubmits only when the bid changes, 0 withdraws', async () => {
    let refineBid = 7;
    let calls = 0;
    const h = new Harness({
      seed: 9,
      policyFactory: scriptedFactory({
        words: () => [],
        bid: (_v, a) => {
          calls++;
          if (a.index !== 1) return 2;
          return calls % 2 === 1 ? 5 : refineBid;
        },
      }),
    });
    h.start();
    await h.step();
    // Auction 1 open now; its anchor (5) went out synchronously with the close transaction.
    const a1 = h.server.current!;
    const subs1 = () => h.submissions.filter((s) => s.what === 'bid' && s.auctionId === a1.id);
    expect(subs1().map((s) => s.value)).toEqual([5, 7]); // anchor + refine (settled)
    expect(subs1()[0]!.pass).toBe('anchor');
    expect(subs1()[1]!.pass).toBe('refine');
    expect(h.server.pendingBid(101)).toBe(7);
    // Mid-auction state change triggers another refine; this time the policy withdraws (0).
    refineBid = 0;
    calls = 1; // next call returns refineBid
    const w = h.server.opponentBestWord(150, 2);
    if (w) h.server.opponentWordTx(150, w);
    else h.driver.applyTx({ ...emptyMatchTx(), participants: [h.server.participants.get(150)!] }, h.localMs());
    await h.settle();
    expect(subs1().map((s) => s.value)).toEqual([5, 7, 0]);
    expect(h.server.pendingBid(101)).toBe(0);
    // Unchanged decisions never resend.
    calls = 1;
    refineBid = 0;
    h.driver.applyTx({ ...emptyMatchTx(), participants: [h.server.participants.get(150)!] }, h.localMs());
    await h.settle();
    expect(subs1().length).toBe(3);
  });

  it('never submits after deadlineFor(), even when state changes late in the window', async () => {
    const h = new Harness({ seed: 13, policyFactory: scriptedFactory({ words: () => [], bid: (v) => Math.min(v.me.balance, 1 + v.auctionsDone) }) });
    h.start();
    await h.step();
    await h.step();
    const a = h.server.current!;
    const deadline = h.driver.currentDeadline!;
    expect(deadline).toBeDefined();
    // Jump past the deadline (still before closes_at on the server) and poke the driver.
    h.server.serverUs = BigInt(Math.ceil((deadline - 0 + 1) * 1000)); // skew 0 => local == server
    expect(h.server.serverUs).toBeLessThan(a.closesAtUs);
    const before = h.submissions.length;
    h.driver.applyTx({ ...emptyMatchTx(), participants: [h.server.participants.get(150)!] }, h.localMs());
    await h.settle();
    expect(h.submissions.length).toBe(before);
    // Across a whole match, every submission is sent strictly before its deadline.
    await h.runToEnd();
    for (const s of h.submissions) expect(s.sentAt).toBeLessThan(s.deadline);
    expect(h.driver.stats.timingErrors).toBe(0);
  });

  it('late deliveries (snapshot / stall) get the conservative deadline', async () => {
    const h = new Harness({ seed: 17, skewMs: 40 });
    h.start();
    for (let k = 0; k < 5; k++) await h.step();
    // Offset learned from steady-state opens (lag == skew == 40 ms).
    expect(h.clock.offsetEst).toBe(40);
    // Next open is delivered 400 ms late (event-loop stall): tagged late, not sampled.
    const samples = h.clock.lagSamples;
    h.server.onTx = undefined;
    const a = h.server.current!;
    h.server.serverUs = a.closesAtUs;
    const tx = h.server.closeTx();
    h.server.advanceMs(400);
    h.driver.applyTx(tx, h.localMs());
    expect(h.clock.lagSamples).toBe(samples);
    expect(h.driver.stats.lateOpens).toBeGreaterThanOrEqual(2); // first auction (initial rows) + this one
    const next = h.server.current!;
    const cap = Number(next.closesAtUs) / 1000 + 40 - h.clock.rttP90 - h.clock.marginMs;
    expect(h.driver.currentDeadline!).toBeLessThanOrEqual(cap);
  });

  it('reservation multiset: two in-flight words never double-spend a letter', () => {
    const r = new Reservations();
    const rack = rackFromWord('CATS');
    expect(r.reserve(rack, 'CAT')).toBeDefined();
    expect(r.reserve(rack, 'AT')).toBeUndefined(); // A and T are in flight
    expect(r.canReserve(rack, 'S')).toBe(true);
    expect(rackToString(r.available(rack))).toBe('S');
    expect(r.releaseEcho('CAT')).toBe(true);
    expect(r.reserve(rack, 'AT')).toBeDefined();
    const t = r.reserve(rack, 'CS')!;
    r.markSettled(t);
    expect(r.releaseSettled()).toBe(1);
    expect(r.pendingWords()).toEqual(['AT']);
  });

  it('driver never double-spends: duplicate policy words while in flight are skipped', async () => {
    const h = new Harness({
      seed: 21,
      policyFactory: scriptedFactory({
        words: (v) => {
          const w = getEngine().index.findBestPlayable(v.me.rack, 2);
          return w ? [w, w] : [];
        },
        bid: (v, a) => Math.min(v.me.balance, VALUE[idx(a.letter)]! + 2),
      }),
    });
    h.start();
    await h.runToEnd();
    const rejected = h.server.calls.filter((c) => c.name === 'submit_word' && !c.ok);
    expect(rejected.filter((c) => /Not enough/.test(c.error ?? ''))).toEqual([]);
    expect(h.driver.stats.wordsSkipped).toBeGreaterThan(0);
    expect(h.driver.tracker!.diagnostics).toEqual(ZERO);
  });

  it('"Insufficient balance" -> one resubmit with min(bid, tracker balance) before the deadline', async () => {
    // Policy bids its balance plus the reward of a word that the server rejects.
    const h = new Harness({
      seed: 23,
      rejectWords: new Set(['ZZZ']),
      policyFactory: scriptedFactory({
        words: (_v, a) => (a.index === 2 ? ['ZZZ'] : []),
        bid: (v, a) => (a.index === 2 ? v.me.balance + 10 : 1),
      }),
    });
    h.start();
    await h.step();
    await h.step();
    await h.settle();
    const a = h.server.current!;
    const bids = h.server.calls.filter((c) => c.name === 'submit_bid' && Number(c.args.auctionId) === a.id);
    expect(bids.map((c) => [Number(c.args.amount), c.ok])).toEqual([
      [h.driver.tracker!.me.balance + 10, false],
      [h.driver.tracker!.me.balance, true],
    ]);
    expect(h.driver.stats.balanceRetries).toBe(1);
  });

  it('final auction: words first, then bid; a rejected word triggers one re-plan; safety flush packs the leftover', async () => {
    // On the last auction the policy plays a non-word made of rack letters (server rejects it) and
    // only ONE real word, leaving value on the rack; the client must re-plan once and flush the rest.
    const { dict, index } = getEngine();
    const nonWordFrom = (letters: string): string | undefined => {
      for (let i = 0; i < letters.length; i++)
        for (let j = 0; j < letters.length; j++) {
          if (i === j) continue;
          const w = letters[i]! + letters[j]!;
          if (!dict.isValid(w)) return w;
        }
      return undefined;
    };
    let lastRack = '';
    const h = new Harness({
      seed: 31,
      policyFactory: scriptedFactory({
        words: (v, a) => {
          if (a.remainingAfter !== 0) return [];
          lastRack = rackToString(v.me.rack);
          const bad = nonWordFrom(lastRack);
          const w = index.findBestPlayable(v.me.rack, 2);
          return [...(bad ? [bad] : []), ...(w ? [w] : [])];
        },
        bid: (v, a) => Math.min(v.me.balance, VALUE[idx(a.letter)]! + 3),
      }),
    });
    h.start();
    await h.runToEnd();
    const d = h.driver;
    const tr = d.tracker!;
    expect(lastRack.length).toBeGreaterThan(3);
    const lastId = h.server.auctions[h.server.auctions.length - 1]!.id;
    const finalSubs = h.submissions.filter((s) => s.auctionId === lastId);
    const anchor = finalSubs.filter((s) => s.pass.startsWith('anchor'));
    // Anchor pass: every word (policy words, then the safety flush) strictly before the bid.
    const bidAt = anchor.findIndex((s) => s.what === 'bid');
    expect(bidAt).toBeGreaterThan(0);
    expect(anchor.slice(0, bidAt).every((s) => s.what === 'word')).toBe(true);
    expect(anchor.slice(bidAt + 1)).toEqual([]);
    expect(anchor.some((s) => s.pass === 'anchor-flush')).toBe(true);
    expect(d.stats.safetyFlushWords).toBeGreaterThan(0);
    expect(d.stats.replans).toBe(1);
    expect(h.server.calls.some((c) => c.name === 'submit_word' && /is not in the dictionary/.test(c.error ?? ''))).toBe(true);
    // Nothing playable is left on the rack at the end.
    expect(getEngine().packer.packExact(h.server.racks.get(101)!).score).toBe(0);
    expect(tr.diagnostics).toEqual(ZERO);
    expect(h.server.calls.filter((c) => c.error === 'Match not running')).toEqual([]);
  });

  it('penultimate auction: policy words are honoured, no forced flush', async () => {
    const h = new Harness({
      seed: 37,
      policyFactory: scriptedFactory({ words: () => [], bid: () => 1 }),
    });
    h.start();
    while (h.server.current && h.server.current.id !== undefined && h.server.state.bagTotal > 1) await h.step();
    await h.settle();
    expect(h.server.state.bagTotal).toBe(1);
    expect(h.driver.stats.safetyFlushWords).toBe(0);
    expect(h.submissions.filter((s) => s.what === 'word')).toEqual([]);
  });

  it('logs unplayed rack value at Ended (my_rack filtered by match_id)', async () => {
    const h = new Harness({ seed: 41, policyFactory: scriptedFactory({ words: () => [], bid: (v) => Math.min(v.me.balance, 3) }), driver: { flushPacker: { packExact: () => ({ score: 0, words: [] }) } } });
    h.start();
    await h.runToEnd();
    const end = h.logLines.map((l) => JSON.parse(l)).find((r) => r.msg === 'match ended');
    expect(end).toBeDefined();
    expect(end.unplayed.letters).toBe(rackTotal(h.server.racks.get(101)!));
    expect(end.unplayed.value).toBe(h.server.rackValue(101));
    expect(end.diagnostics).toEqual(ZERO);
    // A foreign match's rack rows are ignored.
    const foreign: MatchTx = { ...emptyMatchTx(), rack: [{ id: 1, matchId: 1, botId: 101, letter: 'Z', count: 9 }] };
    h.driver.applyTx(foreign, h.localMs());
    expect(rackToString(h.driver.storeRack())).toBe(rackToString(h.server.racks.get(101)!));
  });

  it('variable configs: 250 ms FirstPrice auctions with rack 7 and 2 players', async () => {
    const h = new Harness({
      seed: 43,
      durationMs: 250,
      rackSize: 7,
      auctionType: 'FirstPrice',
      players: [DEFAULT_PLAYERS[0]!, DEFAULT_PLAYERS[1]!],
    });
    h.start();
    await h.runToEnd();
    const tr = h.driver.tracker!;
    expect(tr.config.totalAuctions).toBe(98 - 14);
    expect(tr.config.auctionType).toBe('FirstPrice');
    expect(tr.view.history.length).toBe(84);
    expect(tr.diagnostics).toEqual(ZERO);
    for (const s of h.submissions) expect(s.sentAt).toBeLessThan(s.deadline);
  });
});

describe('classifyError', () => {
  it.each([
    ['Auction window expired', 'late'],
    ['Auction closed', 'late'],
    ['Insufficient balance', 'balance'],
    ['Match not running', 'match-over'],
    ["Not enough 'C': need 2, have 1", 'rejected'],
  ])('%s -> %s', (msg, outcome) => {
    expect(classifyError(new Error(msg)).outcome).toBe(outcome);
  });
});

describe('rebuildFromSnapshot (pure)', () => {
  it('orders an unordered snapshot chronologically and derives the start rack', async () => {
    const h = new Harness({ seed: 47 });
    h.start();
    for (let k = 0; k < 20; k++) await h.step();
    const snap = h.server.snapshot(5);
    const cfg = h.driver.config!;
    const rb = rebuildFromSnapshot(
      { state: snap.matchStates[0]!, participants: snap.participants, auctions: snap.auctions, results: snap.results, words: snap.words, rack: snap.rack },
      cfg,
    );
    expect(rackToString(rb.myStartRack)).toBe(rackToString(h.driver.tracker!.me.startRack));
    expect(rb.openAuction?.auctionId).toBe(h.server.current!.id);
    const opens = rb.events.filter((e) => e.t === 'open').map((e) => (e.t === 'open' ? e.auction.index : -1));
    expect(opens).toEqual([...Array(21).keys()]);
    expect(rb.startRackClamped).toBe(0);
  });
});

// Keep MatchDriver referenced for type-only consumers of this file.
void MatchDriver;
