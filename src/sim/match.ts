// Deterministic match simulator: reproduces the server rules of RULES.md §6-§9 and §15.
//
// The per-transaction step functions (drawLetter, closeAuction, awardLetter, simWordPlay) are
// exported and driven by runMatchCore, which is shared by
//   - runMatch: independent seeded streams (deal/letters depend only on the seed), seat order;
//   - hostReplay (test-only): the server's timestamp-seeded RNG + datastore iteration order,
//     which reproduces historical all-sim matches bit-exactly.
// Each policy seat owns a MatchTracker fed ONLY through applyEvent(tracker, MatchEvent), the same
// event stream format the live client produces.
import { BAG, BAG_SIZE, LETTERS, NUM_LETTERS, STARTING_BALANCE, VALUE, wordReward } from '../core/letters.js';
import { emptyRack, rackClone, rackToString, type Rack } from '../core/rack.js';
import { simBid } from '../core/simbots.js';
import type {
  AuctionInfo,
  AuctionOutcome,
  AuctionType,
  DecideContext,
  Decision,
  MatchConfig,
  PlayerId,
  PlayerInfo,
  Policy,
  SimStrategy,
} from '../core/types.js';
import { asciiUppercase } from '../engine/dictionary.js';
import { getEngine, type Engine } from '../engine/index.js';
import { applyEvent, startEvent, trackerFromStart, type MatchEvent } from '../state/events.js';
import type { MatchTracker } from '../state/tracker.js';
import {
  IndependentStreams,
  SeatOrderModel,
  seatRng,
  type BidOrderModel,
  type MatchRngSource,
  type PendingBid,
} from './rngStreams.js';

export type { BidOrderModel, MatchRngSource, PendingBid } from './rngStreams.js';

// ------------------------------------------------------------------------------------------ types

export interface MatchSpec {
  auctionType: AuctionType;
  auctionDurationMs: number;
  startingRackSize: number;
  startingBalance: number;
  /** DecideContext.budgetMs handed to every policy. */
  decisionBudgetMs: number;
  /** When true, a decide() slower than auctionDurationMs - simulatedLatencyMs is voided. */
  enforceBudget: boolean;
  /** Simulated reducer round trip (DecideContext.netRttMs). */
  simulatedLatencyMs: number;
  /** Record per-auction bids, words, final racks and each policy seat's MatchEvent stream. */
  trace: boolean;
  matchId: number;
  /** Keep raw decide() durations per seat (used by the tournament runner for exact percentiles). */
  keepDecideSamples?: boolean;
}

export const DEFAULT_SPEC: Readonly<MatchSpec> = Object.freeze({
  auctionType: 'Vickrey',
  auctionDurationMs: 1000,
  startingRackSize: 5,
  startingBalance: STARTING_BALANCE,
  decisionBudgetMs: 250,
  enforceBudget: false,
  simulatedLatencyMs: 60,
  trace: false,
  matchId: 1,
  keepDecideSamples: false,
});

export type SeatSpec =
  | { id: PlayerId; name: string; kind: 'policy'; policy: Policy; oracle?: boolean }
  | { id: PlayerId; name: string; kind: 'sim'; simStrategy: SimStrategy };

export interface TimingSummary {
  n: number;
  mean: number;
  p50: number;
  p99: number;
  max: number;
}

export interface SeatResult {
  id: PlayerId;
  name: string;
  kind: 'policy' | 'sim';
  score: number;
  balance: number;
  /** 1 + number of seats with a strictly higher score (ties share the better place). */
  rank: number;
  /** score equals the maximum score (all tied leaders win, like bot_stats.wins). */
  win: boolean;
  lettersWon: number;
  totalPaid: number;
  wordsPlayed: number;
  words: string[];
  unplayedTiles: number;
  unplayedValue: number;
  rejectedWords: number;
  rejectedBids: number;
  voidedDecisions: number;
  decideMs: TimingSummary;
  decideSamples?: number[];
}

export interface TraceAuction {
  index: number;
  letter: string;
  /** Positive accepted bids by seat id. */
  bids: Record<string, number>;
  winnerId: PlayerId | null;
  paid: number;
  top: number;
}

export interface TraceWord {
  index: number;
  seatId: PlayerId;
  word: string;
  reward: number;
}

export interface MatchTrace {
  auctions: TraceAuction[];
  words: TraceWord[];
  startRacks: Record<string, string>;
  finalRacks: Record<string, string>;
  /** MatchEvent stream of every policy seat (replay(events) rebuilds its view). */
  events: Record<string, MatchEvent[]>;
}

export interface MatchResult {
  seed: number;
  auctions: number;
  seats: SeatResult[];
  winnerIds: PlayerId[];
  trace?: MatchTrace;
}

// ------------------------------------------------------------------------------- seat & bag state

/** Mutable per-seat server state (match_participant + holding rows). */
export interface SeatState {
  readonly pos: number;
  readonly spec: SeatSpec;
  readonly id: PlayerId;
  readonly isSim: boolean;
  balance: number;
  score: number;
  readonly rack: Rack;
  readonly startRack: Rack;
  lettersWon: number;
  totalPaid: number;
  words: string[];
  rejectedWords: number;
  rejectedBids: number;
  voidedDecisions: number;
  decideTimes: number[];
}

/** bag_letter rows of one match: 26 counts plus match_state.bag_total. */
export interface Bag {
  counts: Uint8Array;
  total: number;
}

export function newBag(): Bag {
  return { counts: Uint8Array.from(BAG), total: BAG_SIZE };
}

// --------------------------------------------------------------------------------- step functions

/**
 * Module drawLetter: no RNG call when the bag is empty (returns -1); otherwise one uniform index
 * in [0, total-1] walked over the A..Z-sorted remaining counts.
 */
export function drawLetter(bag: Bag, pick: (bagTotal: number) => number): number {
  if (bag.total === 0) return -1;
  let k = pick(bag.total);
  if (!Number.isInteger(k) || k < 0 || k >= bag.total) throw new Error(`drawLetter: bad index ${k}`);
  const c = bag.counts;
  for (let i = 0; i < NUM_LETTERS; i++) {
    const n = c[i]!;
    if (n === 0) continue;
    if (k < n) {
      c[i] = n - 1;
      bag.total--;
      return i;
    }
    k -= n;
  }
  throw new Error('drawLetter: bag counts inconsistent with total');
}

export interface CloseResult {
  /** Seat position of the winner (highest bid after the tie shuffle), or null with no positive bid. */
  winner: number | null;
  top: number;
  paid: number;
  /** True when the winner could pay (letter awarded, balance debited). */
  applied: boolean;
  /** Positive bids after shuffle + stable sort (descending). */
  sorted: PendingBid[];
}

/**
 * Module closeAuction pricing: keep bids > 0 (in the given pre-shuffle order), module shuffle
 * (len-1 calls of integerInRange(0, i) for i = len-1..1), stable sort by amount descending.
 * Vickrey pays second ?? min(1, top); FirstPrice pays top. The letter is awarded only when the
 * winner's balance covers the price (always true in practice).
 */
export function closeAuction(
  bids: readonly PendingBid[],
  auctionType: AuctionType,
  shuffleStep: (i: number) => number,
  balanceOf: (seat: number) => number,
): CloseResult {
  const sorted = bids.filter((b) => b.amount > 0);
  for (let i = sorted.length - 1; i >= 1; i--) {
    const j = shuffleStep(i);
    const t = sorted[i]!;
    sorted[i] = sorted[j]!;
    sorted[j] = t;
  }
  sorted.sort((a, b) => b.amount - a.amount); // Array.prototype.sort is stable
  const first = sorted[0];
  if (!first) return { winner: null, top: 0, paid: 0, applied: false, sorted };
  const second = sorted[1];
  const paid = auctionType === 'FirstPrice' ? first.amount : second ? second.amount : Math.min(1, first.amount);
  return { winner: first.seat, top: first.amount, paid, applied: balanceOf(first.seat) >= paid, sorted };
}

/** Winner pays and receives the letter (module: participant update + addToRack). */
export function awardLetter(seat: SeatState, letterIdx: number, paid: number): void {
  seat.balance -= paid;
  seat.totalPaid += paid;
  seat.rack[letterIdx]!++;
  seat.lettersWon++;
}

/** Debit an already-validated word from the rack and credit its reward to balance and score. */
function creditWord(seat: SeatState, word: string): number {
  for (let k = 0; k < word.length; k++) seat.rack[word.charCodeAt(k) - 65]!--;
  const reward = wordReward(word);
  seat.balance += reward;
  seat.score += reward;
  seat.words.push(word);
  return reward;
}

/**
 * Module simulateWordPlay: right after a sim wins, it plays findBestPlayable(rack, 3) (longest,
 * then lexicographically first) if any. At most one word. Returns the played word or undefined.
 */
export function simWordPlay(seat: SeatState, engine: Engine): { word: string; reward: number } | undefined {
  const word = engine.index.findBestPlayable(seat.rack, 3);
  if (word === undefined) return undefined;
  return { word, reward: creditWord(seat, word) };
}

/** submit_word validation (RULES.md §9): uppercase a-z, dictionary, rack. Returns the played word. */
export function tryPlayWord(
  seat: SeatState,
  raw: unknown,
  engine: Engine,
): { word: string; reward: number } | undefined {
  if (typeof raw !== 'string') return undefined;
  const word = asciiUppercase(raw);
  if (!engine.dict.isValid(word)) return undefined;
  const need = new Uint8Array(NUM_LETTERS);
  for (let k = 0; k < word.length; k++) {
    const i = word.charCodeAt(k) - 65;
    if (++need[i]! > seat.rack[i]!) return undefined;
  }
  return { word, reward: creditWord(seat, word) };
}

// ------------------------------------------------------------------------------------- match core

function timing(samples: readonly number[]): TimingSummary {
  const n = samples.length;
  if (n === 0) return { n: 0, mean: 0, p50: 0, p99: 0, max: 0 };
  const s = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const x of s) sum += x;
  const q = (p: number) => s[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]!;
  return { n, mean: sum / n, p50: q(0.5), p99: q(0.99), max: s[n - 1]! };
}

function validate(spec: MatchSpec, seats: readonly SeatSpec[]): void {
  const n = seats.length;
  if (n < 2) throw new Error(`runMatch: need at least 2 seats, got ${n}`);
  if (!Number.isInteger(spec.startingRackSize) || spec.startingRackSize < 0) {
    throw new Error(`runMatch: invalid startingRackSize ${spec.startingRackSize}`);
  }
  if (n * spec.startingRackSize >= BAG_SIZE) {
    throw new Error(
      `runMatch: seats * startingRackSize must be < ${BAG_SIZE} (got ${n} * ${spec.startingRackSize})`,
    );
  }
  if (!(spec.auctionDurationMs > 0)) throw new Error(`runMatch: invalid auctionDurationMs ${spec.auctionDurationMs}`);
  const ids = new Set<PlayerId>();
  for (const s of seats) {
    if (ids.has(s.id)) throw new Error(`runMatch: duplicate seat id ${s.id}`);
    ids.add(s.id);
  }
}

interface PolicySeat {
  seat: SeatState;
  policy: Policy;
  oracle: boolean;
  tracker: MatchTracker;
  events: MatchEvent[] | undefined;
  ctx: DecideContext;
}

/**
 * Shared match loop. `source` supplies every random integer in module consumption order;
 * `order` supplies participant iteration order (sim jitter assignment) for each open.
 */
export function runMatchCore(
  spec: MatchSpec,
  seatSpecs: readonly SeatSpec[],
  source: MatchRngSource,
  order: BidOrderModel,
  seed = 0,
  engine: Engine = getEngine(),
): MatchResult {
  validate(spec, seatSpecs);
  const n = seatSpecs.length;
  const seats: SeatState[] = seatSpecs.map((s, pos) => ({
    pos,
    spec: s,
    id: s.id,
    isSim: s.kind === 'sim',
    balance: spec.startingBalance,
    score: 0,
    rack: emptyRack(),
    startRack: emptyRack(),
    lettersWon: 0,
    totalPaid: 0,
    words: [],
    rejectedWords: 0,
    rejectedBids: 0,
    voidedDecisions: 0,
    decideTimes: [],
  }));
  const bag = newBag();
  const trace: MatchTrace | undefined = spec.trace
    ? { auctions: [], words: [], startRacks: {}, finalRacks: {}, events: {} }
    : undefined;

  // ---- start transaction: deal in roster order, first letter, sim bids
  source.beginTx?.({ kind: 'start' });
  const dealPick = (t: number) => source.deal(t);
  for (const s of seats) {
    for (let k = 0; k < spec.startingRackSize; k++) {
      const l = drawLetter(bag, dealPick);
      if (l < 0) break;
      s.rack[l]!++;
    }
    s.startRack.set(s.rack);
    if (trace) trace.startRacks[s.id] = rackToString(s.rack);
  }
  const drawPick = (t: number) => source.draw(t);
  let letter = drawLetter(bag, drawPick);
  if (letter < 0) throw new Error('runMatch: bag empty at match start');

  const totalAuctions = BAG_SIZE - n * spec.startingRackSize;
  const players: PlayerInfo[] = seatSpecs.map((s) =>
    s.kind === 'sim'
      ? { id: s.id, name: s.name, isSim: true, simStrategy: s.simStrategy }
      : { id: s.id, name: s.name, isSim: false },
  );
  const policySeats: PolicySeat[] = [];
  for (const s of seats) {
    if (s.spec.kind !== 'policy') continue;
    const config: MatchConfig = {
      matchId: spec.matchId,
      kind: 'lobby',
      auctionType: spec.auctionType,
      auctionDurationMs: spec.auctionDurationMs,
      startingRackSize: spec.startingRackSize,
      startingBalance: spec.startingBalance,
      players: players.map((p) => ({ ...p })),
      myId: s.id,
      totalAuctions,
    };
    const start = startEvent(config, s.startRack);
    const tracker = trackerFromStart(start);
    const events = trace ? [start] : undefined;
    if (trace && events) trace.events[s.id] = events;
    const rng = seatRng(seed, s.pos);
    policySeats.push({
      seat: s,
      policy: s.spec.policy,
      oracle: s.spec.oracle === true,
      tracker,
      events,
      ctx: {
        budgetMs: spec.decisionBudgetMs,
        rng,
        now: () => performance.now(),
        netRttMs: spec.simulatedLatencyMs,
      },
    });
  }
  const emit = (e: MatchEvent): void => {
    for (const p of policySeats) {
      applyEvent(p.tracker, e);
      p.events?.push(e);
    }
  };
  for (const p of policySeats) p.policy.onMatchStart(p.tracker.view);
  order.reset(n);

  const voidLimit = spec.auctionDurationMs - spec.simulatedLatencyMs;
  let index = 0;
  for (;;) {
    // ---- open auction `index` (still inside the start / previous close transaction)
    const opensAtMs = index * (spec.auctionDurationMs + 1.5);
    const auction: AuctionInfo = {
      auctionId: index + 1,
      index,
      letter: LETTERS[letter]!,
      opensAtMs,
      closesAtMs: opensAtMs + spec.auctionDurationMs,
      remainingAfter: bag.total,
    };
    const pending: PendingBid[] = [];
    for (const pos of order.participantOrder()) {
      const s = seats[pos]!;
      if (s.spec.kind !== 'sim') continue;
      const jitter = source.simJitter(pos);
      const amount = simBid(s.spec.simStrategy, letter, s.balance, jitter);
      if (amount > 0) pending.push({ seat: pos, amount });
    }
    if (index > 0) order.onCloseCommit();
    emit({ t: 'open', auction });

    // ---- policies decide simultaneously on the same pre-decision state
    const decisions: Array<Decision | undefined> = [];
    for (const p of policySeats) {
      if (p.oracle && p.policy.onOracle) {
        const trueRacks = new Map<PlayerId, Rack>();
        for (const s of seats) trueRacks.set(s.id, rackClone(s.rack));
        p.policy.onOracle(trueRacks);
      }
      const t0 = performance.now();
      const d = p.policy.decide(p.tracker.view, auction, p.ctx);
      const dt = performance.now() - t0;
      p.seat.decideTimes.push(dt);
      if (spec.enforceBudget && dt > voidLimit) {
        p.seat.voidedDecisions++;
        decisions.push(undefined);
      } else decisions.push(d);
    }
    // ---- apply words (seat order), then that seat's bid
    for (let k = 0; k < policySeats.length; k++) {
      const p = policySeats[k]!;
      const d = decisions[k];
      if (!d) continue;
      const s = p.seat;
      const words = Array.isArray(d.words) ? d.words : [];
      for (const w of words) {
        const played = tryPlayWord(s, w, engine);
        if (!played) {
          s.rejectedWords++;
          continue;
        }
        emit({ t: 'word', ev: { playerId: s.id, word: played.word, reward: played.reward, auctionIndex: index } });
        trace?.words.push({ index, seatId: s.id, word: played.word, reward: played.reward });
        order.onWord(s.pos);
      }
      const bid = d.bid;
      if (typeof bid !== 'number' || !Number.isInteger(bid) || bid < 0 || bid > s.balance) {
        s.rejectedBids++;
        continue;
      }
      if (bid > 0) pending.push({ seat: s.pos, amount: bid });
    }

    // ---- close transaction
    source.beginTx?.({ kind: 'close', index });
    const res = closeAuction(
      pending,
      spec.auctionType,
      (i) => source.tieShuffle(i, index),
      (pos) => seats[pos]!.balance,
    );
    let winnerId: PlayerId | null = null;
    if (res.winner !== null) {
      winnerId = seats[res.winner]!.id;
      if (res.applied) awardLetter(seats[res.winner]!, letter, res.paid);
    }
    order.onCloseUpdated(res.applied ? res.winner : null);
    const outcome: AuctionOutcome = { auctionId: auction.auctionId, index, letter: auction.letter, winnerId, paid: res.paid };
    emit({ t: 'result', outcome });
    if (trace) {
      const bids: Record<string, number> = {};
      for (const b of pending) if (b.amount > 0) bids[seats[b.seat]!.id] = b.amount;
      trace.auctions.push({ index, letter: auction.letter, bids, winnerId, paid: res.paid, top: res.top });
    }
    if (res.winner !== null && res.applied && seats[res.winner]!.isSim) {
      const s = seats[res.winner]!;
      const played = simWordPlay(s, engine);
      if (played) {
        emit({ t: 'word', ev: { playerId: s.id, word: played.word, reward: played.reward, auctionIndex: index } });
        trace?.words.push({ index, seatId: s.id, word: played.word, reward: played.reward });
      }
    }
    for (const p of policySeats) p.policy.onAuctionClosed?.(p.tracker.view, outcome);

    const next = drawLetter(bag, drawPick);
    index++;
    if (next < 0) break;
    letter = next;
  }

  for (const p of policySeats) p.policy.onMatchEnd?.(p.tracker.view);

  // ---- results
  let maxScore = -Infinity;
  for (const s of seats) if (s.score > maxScore) maxScore = s.score;
  const results: SeatResult[] = seats.map((s) => {
    let higher = 0;
    for (const o of seats) if (o.score > s.score) higher++;
    let tiles = 0;
    let value = 0;
    for (let i = 0; i < NUM_LETTERS; i++) {
      tiles += s.rack[i]!;
      value += s.rack[i]! * VALUE[i]!;
    }
    const r: SeatResult = {
      id: s.id,
      name: s.spec.name,
      kind: s.spec.kind,
      score: s.score,
      balance: s.balance,
      rank: 1 + higher,
      win: s.score === maxScore,
      lettersWon: s.lettersWon,
      totalPaid: s.totalPaid,
      wordsPlayed: s.words.length,
      words: s.words,
      unplayedTiles: tiles,
      unplayedValue: value,
      rejectedWords: s.rejectedWords,
      rejectedBids: s.rejectedBids,
      voidedDecisions: s.voidedDecisions,
      decideMs: timing(s.decideTimes),
    };
    if (spec.keepDecideSamples) r.decideSamples = s.decideTimes;
    return r;
  });
  if (trace) for (const s of seats) trace.finalRacks[s.id] = rackToString(s.rack);
  const out: MatchResult = {
    seed,
    auctions: index,
    seats: results,
    winnerIds: results.filter((r) => r.win).map((r) => r.id),
  };
  if (trace) out.trace = trace;
  return out;
}

/**
 * Play one match. The deal, the letter sequence and the sim jitters depend only on `seed`
 * (independent streams), so different policies on the same seed face identical letters.
 */
export function runMatch(spec: Partial<MatchSpec>, seats: readonly SeatSpec[], seed: number): MatchResult {
  const full: MatchSpec = { ...DEFAULT_SPEC, ...spec };
  return runMatchCore(full, seats, new IndependentStreams(seed), new SeatOrderModel(), seed >>> 0);
}
