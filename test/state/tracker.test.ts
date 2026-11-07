import { describe, expect, it } from 'vitest';
import { BAG, NUM_LETTERS, idx, letterAt, totalAuctions, wordReward } from '../../src/core/letters.js';
import {
  emptyRack,
  rackAdd,
  rackClone,
  rackContains,
  rackEquals,
  rackFromWord,
  rackSub,
  rackToString,
  rackTotal,
  type Rack,
} from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import type { AuctionInfo, MatchConfig, PlayerId } from '../../src/core/types.js';
import {
  MatchRecorder,
  MatchTracker,
  applyEvent,
  bagRemaining,
  rackSizeOf,
  replay,
  startEvent,
  unseenBalance,
  type MatchEvent,
} from '../../src/state/index.js';

const ZERO_DIAG = { balanceMismatches: 0, rackMismatches: 0, hiddenOverflow: 0, unseenNegative: 0 };

function mkConfig(ids: PlayerId[], myId: PlayerId, rackSize: number, matchId = 1): MatchConfig {
  return {
    matchId,
    auctionType: 'Vickrey',
    auctionDurationMs: 1000,
    startingRackSize: rackSize,
    startingBalance: 100,
    players: ids.map((id, k) => ({ id, name: `bot${id}`, isSim: k % 2 === 1 })),
    myId,
    totalAuctions: totalAuctions(ids.length, rackSize),
  };
}

function auction(cfg: MatchConfig, index: number, letter: string): AuctionInfo {
  return {
    auctionId: 5000 + index,
    index,
    letter,
    opensAtMs: 1_000_000 + index * 1000,
    closesAtMs: 1_000_000 + index * 1000 + cfg.auctionDurationMs,
    remainingAfter: cfg.totalAuctions - index - 1,
  };
}

function expectInvariant(t: MatchTracker): void {
  const b = unseenBalance(t.view);
  expect(b.unseen, 'total(unseen) == bagRemaining + Σ hiddenUnknown').toBe(b.expected);
  const me = t.view.me;
  const expectRack = rackClone(me.startRack);
  rackAdd(expectRack, me.won);
  rackSub(expectRack, me.played);
  expect(rackEquals(me.rack, expectRack), 'my rack == start + won - played').toBe(true);
}

describe('scripted 3-player match', () => {
  // me=1 (CATSE), A=2 (QUIRT), B=3 (DOGLY). Scripted letters first, then the rest of the bag.
  const ME = 1;
  const A = 2;
  const B = 3;
  const cfg = mkConfig([ME, A, B], ME, 5);
  const starts: Record<number, string> = { [ME]: 'CATSE', [A]: 'QUIRT', [B]: 'DOGLY' };
  const scripted = 'HONZEL';

  function buildDrawOrder(): string[] {
    const rest = Array.from(BAG);
    for (const s of [...Object.values(starts), scripted]) {
      for (const ch of s) rest[idx(ch)]!--;
    }
    const order = scripted.split('');
    for (let i = 0; i < NUM_LETTERS; i++) for (let n = 0; n < rest[i]!; n++) order.push(letterAt(i));
    return order;
  }

  function play(): { rec: MatchRecorder; checks: number } {
    const order = buildDrawOrder();
    expect(order).toHaveLength(cfg.totalAuctions);
    const rec = new MatchRecorder(cfg, starts[ME]!);
    const t = rec.tracker;
    let checks = 0;
    const step = (e: MatchEvent): void => {
      rec.apply(e);
      expectInvariant(t);
      checks++;
    };
    const openK = (k: number): AuctionInfo => {
      const a = auction(cfg, k, order[k]!);
      step({ t: 'open', auction: a });
      return a;
    };
    const close = (a: AuctionInfo, winnerId: PlayerId | null, paid: number): void =>
      step({ t: 'result', outcome: { auctionId: a.auctionId, index: a.index, letter: a.letter, winnerId, paid } });

    expectInvariant(t);
    // 0: H -> me, Vickrey second price 4
    let a = openK(0);
    expect(t.view.unseen[idx('H')]).toBe(BAG[idx('H')]! - 1);
    close(a, ME, 4);
    expect(t.view.me.balance).toBe(96);
    expect(rackToString(t.view.me.rack)).toBe('ACEHST');
    // 1: O -> A pays 6
    a = openK(1);
    close(a, A, 6);
    // 2: N -> B pays 3
    a = openK(2);
    close(a, B, 3);
    // 3: Z unbid (consumed)
    a = openK(3);
    close(a, null, 0);
    expect(t.view.unseen[idx('Z')]).toBe(0);
    expect(t.view.history[3]!.winnerId).toBeNull();
    // 4: E open; A plays ROT (O won, R+T hidden), B wins E for 10, me plays CHASTE
    a = openK(4);
    step({ t: 'word', ev: { playerId: A, word: 'ROT', reward: wordReward('ROT'), auctionIndex: 4 } });
    const pa = t.player(A);
    expect(rackToString(pa.revealedHidden)).toBe('RT');
    expect(rackToString(pa.knownHeld)).toBe('');
    expect(pa.hiddenUnknown).toBe(3);
    expect(pa.balance).toBe(97);
    expect(pa.score).toBe(3);
    expect(rackSizeOf(t.view, pa)).toBe(3);
    close(a, B, 10);
    step({ t: 'word', ev: { playerId: ME, word: 'CHASTE', reward: wordReward('CHASTE'), auctionIndex: 5 } });
    expect(wordReward('CHASTE')).toBe(27);
    expect(t.view.me.balance).toBe(123);
    expect(t.view.me.score).toBe(27);
    expect(rackTotal(t.view.me.rack)).toBe(0);
    // My public inference: C,A,S,E,T were never won -> revealed.
    expect(rackToString(t.view.me.revealedHidden)).toBe('ACEST');
    // 5: L -> me pays 1; B plays GLEN (E,N won; G,L hidden)
    a = openK(5);
    close(a, ME, 1);
    step({ t: 'word', ev: { playerId: B, word: 'GLEN', reward: wordReward('GLEN'), auctionIndex: 6 } });
    const pb = t.player(B);
    expect(wordReward('GLEN')).toBe(7);
    expect(rackToString(pb.won)).toBe('EN');
    expect(rackToString(pb.revealedHidden)).toBe('GL');
    expect(rackToString(pb.knownHeld)).toBe('');
    expect(pb.hiddenUnknown).toBe(3);
    expect(pb.balance).toBe(100 - 3 - 10 + 7);
    expect(pb.score).toBe(7);
    expect(pb.totalPaid).toBe(13);
    expect(pb.lettersWon).toBe(2);
    // Unseen exact check for revealed letters: G: BAG - B's revealed G (B's start G hidden until now)
    expect(t.view.unseen[idx('G')]).toBe(BAG[idx('G')]! - 1);
    expect(t.view.unseen[idx('R')]).toBe(BAG[idx('R')]! - 1); // A's revealed R
    // Authoritative resyncs with the true values: no mismatches.
    step({ t: 'balance', id: B, balance: 94, score: 7 });
    step({ t: 'rack', rack: 'L' });
    expect(t.diagnostics).toEqual(ZERO_DIAG);

    // Remaining auctions: rotate winners A, B, me, unbid; pay 1 each.
    const rot: Array<PlayerId | null> = [A, B, ME, null];
    for (let k = scripted.length; k < cfg.totalAuctions - 1; k++) {
      a = openK(k);
      const w = rot[k % 4]!;
      close(a, w, w === null ? 0 : 1);
    }
    // Final auction (remainingAfter == 0): me wins, letter unusable.
    a = openK(cfg.totalAuctions - 1);
    expect(a.remainingAfter).toBe(0);
    expect(bagRemaining(t.view)).toBe(0);
    expect(t.view.auctionsRemaining).toBe(1);
    close(a, ME, 2);
    expect(t.view.auctionsDone).toBe(cfg.totalAuctions);
    expect(t.view.auctionsRemaining).toBe(0);
    expect(t.view.current).toBeUndefined();
    return { rec, checks };
  }

  it('tracks balances, scores, holdings and the invariant after every event', () => {
    const { rec, checks } = play();
    const t = rec.tracker;
    expect(checks).toBe(rec.events.length - 1);
    const v = t.view;
    // At the end the bag is empty: unseen == Σ opp unrevealed start tiles (3 + 3).
    expect(rackTotal(v.unseen)).toBe(6);
    // Exact: A unrevealed = QUIRT - RT = IQU; B unrevealed = DOGLY - GL = DOY.
    expect(rackToString(v.unseen)).toBe('DIOQUY');
    expect(v.history).toHaveLength(cfg.totalAuctions);
    expect(v.words).toHaveLength(3);
    expect(t.diagnostics).toEqual(ZERO_DIAG);
    for (const p of v.players.values()) {
      expect(p.lettersWon).toBe(rackTotal(p.won));
      expect(p.balance).toBe(100 - p.totalPaid + p.score);
    }
  });

  it('replays deterministically from the recorded trace (and from JSON)', () => {
    const { rec } = play();
    const live = rec.tracker.snapshot();
    expect(replay(rec.events).snapshot()).toEqual(live);
    const json = JSON.stringify(rec.events);
    expect(replay(JSON.parse(json) as MatchEvent[]).snapshot()).toEqual(live);
    expect(JSON.stringify(play().rec.events)).toBe(json);
  });
});

describe('events', () => {
  const cfg = mkConfig([1, 2], 1, 5);

  it('replay requires a leading start event; applyEvent rejects start', () => {
    expect(() => replay([])).toThrow(/first event/);
    expect(() => replay([{ t: 'rack', rack: 'A' }])).toThrow(/first event/);
    const t = replay([startEvent(cfg, 'EDCBA')]);
    expect(rackToString(t.view.me.rack)).toBe('ABCDE');
    expect(() => applyEvent(t, startEvent(cfg, 'ABCDE'))).toThrow(/start/);
  });

  it('start event normalizes racks to sorted strings', () => {
    expect(startEvent(cfg, rackFromWord('ZEBRA'))).toMatchObject({ myStartRack: 'ABERZ' });
    expect(startEvent(cfg, 'ZEBRA')).toMatchObject({ myStartRack: 'ABERZ' });
  });
});

describe('diagnostics on inconsistent streams', () => {
  it('counts balance / rack / hidden / unseen inconsistencies and clamps', () => {
    const cfg = mkConfig([1, 2], 1, 2);
    const rec = new MatchRecorder(cfg, 'AB');
    const t = rec.tracker;
    rec.balance(2, 50, 0); // wrong balance
    rec.balance(2, 50, 0); // now consistent
    rec.rack('ABC'); // wrong rack
    rec.rack('ABC'); // consistent after resync
    expect(t.diagnostics.balanceMismatches).toBe(1);
    expect(t.diagnostics.rackMismatches).toBe(1);
    expect(rackToString(t.view.me.rack)).toBe('ABC');
    // Z (single tile) auctioned unbid, then the opponent "plays" ZZ from hidden: unseen would go negative.
    const a = auction(cfg, 0, 'Z');
    rec.open(a);
    rec.result({ auctionId: a.auctionId, index: 0, letter: 'Z', winnerId: null, paid: 0 });
    rec.word({ playerId: 2, word: 'ZZ', reward: 20, auctionIndex: 1 });
    expect(t.diagnostics.unseenNegative).toBeGreaterThanOrEqual(1);
    expect(t.view.unseen[idx('Z')]).toBe(0);
    // Opponent already revealed 2 = startingRackSize; any further hidden letter overflows.
    rec.word({ playerId: 2, word: 'QI', reward: 11, auctionIndex: 1 });
    expect(t.diagnostics.hiddenOverflow).toBe(1);
    expect(t.player(2).hiddenUnknown).toBe(0);
    expect(rackTotal(t.player(2).revealedHidden)).toBe(2);
    for (let i = 0; i < NUM_LETTERS; i++) expect(t.view.unseen[i]).toBeGreaterThanOrEqual(0);
    // Replay reproduces the diagnostics too.
    expect(replay(rec.events).diagnostics).toEqual(t.diagnostics);
  });
});

// ---------------------------------------------------------------------------------------------
// Property test: random consistent matches vs. ground-truth racks.

interface Truth {
  start: Map<PlayerId, Rack>;
  rack: Map<PlayerId, Rack>;
  won: Map<PlayerId, Rack>;
  played: Map<PlayerId, Rack>;
  balance: Map<PlayerId, number>;
  score: Map<PlayerId, number>;
  draw: string[];
  opened: number; // letters drawn from the bag so far (incl. the open one)
}

function randomWord(rng: Rng, rack: Rack): string | undefined {
  const tiles: number[] = [];
  for (let i = 0; i < NUM_LETTERS; i++) for (let n = 0; n < rack[i]!; n++) tiles.push(i);
  if (tiles.length < 2) return undefined;
  rng.shuffle(tiles);
  const len = rng.int(2, Math.min(8, tiles.length));
  let w = '';
  for (let k = 0; k < len; k++) w += letterAt(tiles[k]!);
  return w;
}

/** Plain-comparison oracle (no expect() in the hot loop); throws with a precise message. */
function checkAgainstTruth(t: MatchTracker, truth: Truth): void {
  const v = t.view;
  const fail = (msg: string): never => {
    throw new Error(`event-check failed after ${v.history.length} closed auctions: ${msg}`);
  };
  const d = t.diagnostics;
  if (d.balanceMismatches || d.rackMismatches || d.hiddenOverflow || d.unseenNegative) {
    fail(`diagnostics ${JSON.stringify(d)}`);
  }
  const bal = unseenBalance(v);
  if (!bal.ok) fail(`invariant: unseen ${bal.unseen} != expected ${bal.expected}`);
  if (bagRemaining(v) !== truth.draw.length - truth.opened) fail('bagRemaining');
  // Exact unseen: undrawn bag letters + Σ_opp unrevealed starting tiles.
  const expectUnseen = emptyRack();
  for (let k = truth.opened; k < truth.draw.length; k++) expectUnseen[idx(truth.draw[k]!)]!++;
  for (const p of v.players.values()) {
    const id = p.info.id;
    if (p.balance !== truth.balance.get(id)) fail(`balance of ${id}`);
    if (p.score !== truth.score.get(id)) fail(`score of ${id}`);
    if (!rackEquals(p.won, truth.won.get(id)!)) fail(`won of ${id}`);
    if (!rackEquals(p.played, truth.played.get(id)!)) fail(`played of ${id}`);
    const real = truth.rack.get(id)!;
    const start = truth.start.get(id)!;
    if (!rackContains(real, p.knownHeld)) fail(`knownHeld of ${id} not a lower bound`);
    if (!rackContains(start, p.revealedHidden)) fail(`revealedHidden of ${id} not within start`);
    if (rackTotal(real) !== rackTotal(p.knownHeld) + p.hiddenUnknown) fail(`rack size of ${id}`);
    if (rackSizeOf(v, p) !== rackTotal(real)) fail(`rackSizeOf ${id}`);
    if (id !== v.config.myId) {
      for (let i = 0; i < NUM_LETTERS; i++) expectUnseen[i] = expectUnseen[i]! + start[i]! - p.revealedHidden[i]!;
    }
  }
  if (!rackEquals(v.unseen, expectUnseen)) {
    fail(`unseen ${rackToString(v.unseen)} != ${rackToString(expectUnseen)}`);
  }
  const me = v.me;
  if (!rackEquals(me.rack, truth.rack.get(v.config.myId)!)) fail('my rack');
  for (let i = 0; i < NUM_LETTERS; i++) {
    if (me.rack[i] !== me.startRack[i]! + me.won[i]! - me.played[i]!) fail('my rack != start + won - played');
  }
}

function randomMatch(seed: number, check: boolean): { rec: MatchRecorder; events: number } {
  const rng = new Rng(seed);
  const nPlayers = rng.int(2, 6);
  const rackSize = rng.pick([0, 1, 3, 5, 5, 5, 7, 10, 12]);
  const ids = Array.from({ length: nPlayers }, (_, k) => 100 + k * 7);
  const myId = rng.pick(ids);
  const cfg = mkConfig(ids, myId, rackSize, seed);
  cfg.auctionType = rng.int(0, 1) ? 'Vickrey' : 'FirstPrice';

  const tiles: string[] = [];
  for (let i = 0; i < NUM_LETTERS; i++) for (let n = 0; n < BAG[i]!; n++) tiles.push(letterAt(i));
  rng.shuffle(tiles);
  const truth: Truth = {
    start: new Map(),
    rack: new Map(),
    won: new Map(),
    played: new Map(),
    balance: new Map(),
    score: new Map(),
    draw: [],
    opened: 0,
  };
  let pos = 0;
  for (const id of ids) {
    const r = rackFromWord(tiles.slice(pos, pos + rackSize).join(''));
    pos += rackSize;
    truth.start.set(id, r);
    truth.rack.set(id, rackClone(r));
    truth.won.set(id, emptyRack());
    truth.played.set(id, emptyRack());
    truth.balance.set(id, cfg.startingBalance);
    truth.score.set(id, 0);
  }
  truth.draw = tiles.slice(pos);
  expect(truth.draw).toHaveLength(cfg.totalAuctions);

  const rec = new MatchRecorder(cfg, truth.start.get(myId)!);
  const t = rec.tracker;
  let events = 0;
  const step = (e: MatchEvent): void => {
    rec.apply(e);
    events++;
    if (check) checkAgainstTruth(t, truth);
  };
  if (check) checkAgainstTruth(t, truth);

  const maybeWords = (auctionIndex: number): void => {
    for (const id of ids) {
      if (rng.float() >= 0.25) continue;
      const word = randomWord(rng, truth.rack.get(id)!);
      if (!word) continue;
      const reward = wordReward(word);
      const need = rackFromWord(word);
      rackSub(truth.rack.get(id)!, need);
      rackAdd(truth.played.get(id)!, need);
      truth.balance.set(id, truth.balance.get(id)! + reward);
      truth.score.set(id, truth.score.get(id)! + reward);
      step({ t: 'word', ev: { playerId: id, word, reward, auctionIndex } });
    }
  };

  for (let k = 0; k < cfg.totalAuctions; k++) {
    const a = auction(cfg, k, truth.draw[k]!);
    truth.opened = k + 1;
    step({ t: 'open', auction: a });
    maybeWords(k);
    let winnerId: PlayerId | null = rng.float() < 0.2 ? null : rng.pick(ids);
    let paid = 0;
    if (winnerId !== null) {
      const bal = truth.balance.get(winnerId)!;
      if (bal < 1) winnerId = null;
      else paid = rng.int(0, Math.min(bal, 25));
    }
    if (winnerId !== null) {
      const li = idx(a.letter);
      truth.rack.get(winnerId)![li]!++;
      truth.won.get(winnerId)![li]!++;
      truth.balance.set(winnerId, truth.balance.get(winnerId)! - paid);
    }
    step({ t: 'result', outcome: { auctionId: a.auctionId, index: k, letter: a.letter, winnerId, paid } });
    if (k < cfg.totalAuctions - 1) maybeWords(k + 1);
    if (rng.float() < 0.1) {
      const id = rng.pick(ids);
      step({ t: 'balance', id, balance: truth.balance.get(id)!, score: truth.score.get(id)! });
    }
    if (rng.float() < 0.1) step({ t: 'rack', rack: rackToString(truth.rack.get(myId)!) });
  }
  expect(t.view.auctionsDone).toBe(cfg.totalAuctions);
  expect(t.view.auctionsRemaining).toBe(0);
  return { rec, events };
}

describe('property: random consistent matches', () => {
  it('matches ground truth after every event (300 seeded matches)', () => {
    let totalEvents = 0;
    for (let s = 0; s < 300; s++) totalEvents += randomMatch(0xabc000 + s, true).events;
    expect(totalEvents).toBeGreaterThan(10_000);
  });

  it('replay of every recorded trace (in-memory and JSON) is identical; generation is deterministic', () => {
    for (let s = 0; s < 100; s++) {
      const { rec } = randomMatch(0x5eed00 + s, false);
      const live = rec.tracker.snapshot();
      expect(replay(rec.events).snapshot()).toEqual(live);
      const json = JSON.stringify(rec.events);
      expect(replay(JSON.parse(json) as MatchEvent[]).snapshot()).toEqual(live);
      if (s < 10) expect(JSON.stringify(randomMatch(0x5eed00 + s, false).rec.events)).toBe(json);
    }
  });
});
