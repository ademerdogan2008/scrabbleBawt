// Live adapter: SpacetimeDB rows -> src/state MatchEvents -> Policy -> reducers (via guard.ts).
//
// One MatchDriver per match. The session batches each server transaction's row callbacks into a
// MatchTx and hands it over once (after the whole transaction is in the cache). Within a transaction
// events are applied in a fixed order, identical to the simulator's stream:
//     results -> words (deduped by word_play row id) -> balances -> my_rack -> new auction open
// Word attribution rule (shared with 02-01 runMatch and 02-02 load.ts): WordPlayEvent.auctionIndex
// is the index of the auction open when the word was played; a word inside a close transaction
// (sim winner) gets the index of the auction that just closed and is applied AFTER that result.
//
// Decision loop per auction (anytime bidding, PITFALLS C5):
//   anchor  decide(budget 15 ms) -> words (reservation-checked) -> submit_bid, right after the open
//   refine  decide(budget = clock.budgetFor(deadline)) -> resubmit only if the bid changed (0 withdraws)
//   nothing is ever sent after clock.deadlineFor(); late (snapshot / stalled) deliveries use the
//   conservative closesAt + offset deadline.
// Final auction (bag_total == 0): words first (all of them, immediately), then the packer safety
// flush on the leftover rack, then the bid; one re-plan on a rejected word (words.ts).
// Resume (CLI-05, PITFALLS M9): the tracker is rebuilt from the per-match snapshot rows in
// chronological order (rebuildFromSnapshot) and the bid for a still-open auction is resubmitted.
import { STARTING_BALANCE, isWellFormedWord, totalAuctions as totalAuctionsFor } from '../core/letters.js';
import { emptyRack, rackAdd, rackFromWord, rackSubClamped, rackToString, type Rack } from '../core/rack.js';
import { Rng } from '../core/rng.js';
import { parseSimStrategy } from '../core/simbots.js';
import type {
  AuctionInfo,
  AuctionOutcome,
  AuctionType,
  MatchConfig,
  MatchKind,
  Policy,
  PolicyFactory,
  PlayerInfo,
  WordPlayEvent,
} from '../core/types.js';
import { MatchRecorder, type MatchEvent } from '../state/events.js';
import type { MatchTracker } from '../state/tracker.js';
import type { ClientClock } from './clock.js';
import { callReducer, MaincloudGuardError, type GuardOptions, type GuardTarget, type ReducerHost } from './guard.js';
import type { MatchLog } from './log.js';
import {
  defaultFlushPacker,
  normalizeWord,
  planSafetyFlush,
  Reservations,
  unplayedValue,
  type FlushPacker,
} from './words.js';

// ---------------------------------------------------------------------------------------------
// Normalized rows (u64/i64 -> number, Timestamp -> bigint µs). Pure data, easy to fake in tests.

export type MatchStatus = 'Lobby' | 'Running' | 'Ended';
export type TournamentPhase = 'Swiss' | 'Bracket' | 'Final';

export interface MatchStateRow {
  id: number;
  status: MatchStatus;
  currentRound: number;
  currentAuctionId: number | null;
  bagTotal: number;
  auctionType: AuctionType;
  auctionDurationMs: number;
  startingRackSize: number;
  createdAtUs: bigint;
}
export interface ParticipantRow {
  id: number;
  matchId: number;
  botId: number;
  balance: number;
  score: number;
}
export interface AuctionRow {
  id: number;
  matchId: number;
  letter: string;
  opensAtUs: bigint;
  closesAtUs: bigint;
  open: boolean;
}
export interface ResultRow {
  auctionId: number;
  matchId: number;
  letter: string;
  winnerBotId: number | null;
  paid: number;
  closedAtUs: bigint;
}
export interface WordRow {
  id: number;
  matchId: number;
  botId: number;
  word: string;
  reward: number;
  playedAtUs: bigint;
}
export interface RackRow {
  id: number;
  matchId: number;
  botId: number;
  letter: string;
  count: number;
}
export interface BotRow {
  id: number;
  name: string;
  isSimulated: boolean;
  strategy: string;
}
export interface TournamentMatchRow {
  id: number;
  tournamentId: number;
  matchId: number;
  round: number;
  phase: TournamentPhase;
}

/** All row changes of one server transaction that belong to one match. */
export interface MatchTx {
  matchStates: MatchStateRow[];
  participants: ParticipantRow[];
  auctions: AuctionRow[];
  results: ResultRow[];
  words: WordRow[];
  /** my_rack inserts/updates for this match (filtered by match_id, PITFALLS M13). */
  rack: RackRow[];
  /** my_rack deletes for this match (count hit 0). */
  rackDeleted: RackRow[];
  tournamentMatches: TournamentMatchRow[];
}

export function emptyMatchTx(): MatchTx {
  return {
    matchStates: [],
    participants: [],
    auctions: [],
    results: [],
    words: [],
    rack: [],
    rackDeleted: [],
    tournamentMatches: [],
  };
}

export function usToMs(us: bigint): number {
  return Number(us) / 1000;
}

const toNum = (v: bigint | number): number => (typeof v === 'bigint' ? Number(v) : v);

// SDK row shapes (structural: matches src/client/module_bindings types without importing the SDK).
interface TsLike {
  microsSinceUnixEpoch: bigint;
}
interface TagLike {
  tag: string;
}

export function normMatchState(r: {
  id: bigint;
  status: TagLike;
  currentRound: number;
  currentAuctionId: bigint | undefined | null;
  bagTotal: number;
  auctionType: TagLike;
  createdAt: TsLike;
  auctionDurationMs: bigint;
  startingRackSize: number;
}): MatchStateRow {
  return {
    id: toNum(r.id),
    status: r.status.tag as MatchStatus,
    currentRound: r.currentRound,
    currentAuctionId: r.currentAuctionId === undefined || r.currentAuctionId === null ? null : toNum(r.currentAuctionId),
    bagTotal: r.bagTotal,
    auctionType: r.auctionType.tag === 'FirstPrice' ? 'FirstPrice' : 'Vickrey',
    auctionDurationMs: toNum(r.auctionDurationMs),
    startingRackSize: r.startingRackSize,
    createdAtUs: r.createdAt.microsSinceUnixEpoch,
  };
}
export function normParticipant(r: { id: bigint; matchId: bigint; botId: bigint; balance: bigint; score: bigint }): ParticipantRow {
  return { id: toNum(r.id), matchId: toNum(r.matchId), botId: toNum(r.botId), balance: toNum(r.balance), score: toNum(r.score) };
}
export function normAuction(r: { id: bigint; matchId: bigint; letter: string; opensAt: TsLike; closesAt: TsLike; status: TagLike }): AuctionRow {
  return {
    id: toNum(r.id),
    matchId: toNum(r.matchId),
    letter: r.letter,
    opensAtUs: r.opensAt.microsSinceUnixEpoch,
    closesAtUs: r.closesAt.microsSinceUnixEpoch,
    open: r.status.tag === 'Open',
  };
}
export function normResult(r: {
  auctionId: bigint;
  matchId: bigint;
  letter: string;
  winnerBotId: bigint | undefined | null;
  paid: bigint;
  closedAt: TsLike;
}): ResultRow {
  return {
    auctionId: toNum(r.auctionId),
    matchId: toNum(r.matchId),
    letter: r.letter,
    winnerBotId: r.winnerBotId === undefined || r.winnerBotId === null ? null : toNum(r.winnerBotId),
    paid: toNum(r.paid),
    closedAtUs: r.closedAt.microsSinceUnixEpoch,
  };
}
export function normWord(r: { id: bigint; matchId: bigint; botId: bigint; word: string; totalReward: bigint; playedAt: TsLike }): WordRow {
  return {
    id: toNum(r.id),
    matchId: toNum(r.matchId),
    botId: toNum(r.botId),
    word: r.word,
    reward: toNum(r.totalReward),
    playedAtUs: r.playedAt.microsSinceUnixEpoch,
  };
}
export function normRack(r: { id: bigint; matchId: bigint; botId: bigint; letter: string; count: number }): RackRow {
  return { id: toNum(r.id), matchId: toNum(r.matchId), botId: toNum(r.botId), letter: r.letter, count: r.count };
}
export function normBot(r: { id: bigint; name: string; isSimulated: boolean; strategy: TagLike }): BotRow {
  return { id: toNum(r.id), name: r.name, isSimulated: r.isSimulated, strategy: r.strategy.tag };
}
export function normTournamentMatch(r: { id: bigint; tournamentId: bigint; matchId: bigint; round: number; phase: TagLike }): TournamentMatchRow {
  return { id: toNum(r.id), tournamentId: toNum(r.tournamentId), matchId: toNum(r.matchId), round: r.round, phase: r.phase.tag as TournamentPhase };
}

// ---------------------------------------------------------------------------------------------
// Pure builders

export function kindFromPhase(phase: TournamentPhase | undefined): MatchKind {
  switch (phase) {
    case 'Swiss':
      return 'swiss';
    case 'Bracket':
      return 'bracket';
    case 'Final':
      return 'final';
    default:
      return 'lobby';
  }
}

/** MatchConfig from rows: players in match_participant id order; totalAuctions = 98 - rack * P. */
export function buildMatchConfig(
  state: MatchStateRow,
  participants: readonly ParticipantRow[],
  myBotId: number,
  botInfo: (id: number) => BotRow | undefined,
  phase?: TournamentPhase,
): MatchConfig {
  const seats = [...participants].sort((a, b) => a.id - b.id);
  const players: PlayerInfo[] = seats.map((p) => {
    const b = botInfo(p.botId);
    const info: PlayerInfo = { id: p.botId, name: b?.name ?? `bot-${p.botId}`, isSim: b?.isSimulated ?? false };
    if (info.isSim) {
      const s = b ? parseSimStrategy(b.strategy) : undefined;
      if (s) info.simStrategy = s;
    }
    return info;
  });
  return {
    matchId: state.id,
    kind: kindFromPhase(phase),
    auctionType: state.auctionType,
    auctionDurationMs: state.auctionDurationMs,
    startingRackSize: state.startingRackSize,
    startingBalance: STARTING_BALANCE,
    players,
    myId: myBotId,
    totalAuctions: totalAuctionsFor(players.length, state.startingRackSize),
  };
}

/** Exact rack from my_rack rows of one match. */
export function rackFromRows(rows: Iterable<RackRow>): Rack {
  const r = emptyRack();
  for (const h of rows) {
    const i = h.letter.charCodeAt(0) - 65;
    if (h.letter.length === 1 && i >= 0 && i < 26 && h.count > 0) r[i] = r[i]! + h.count;
  }
  return r;
}

export function auctionInfo(a: AuctionRow, index: number, remainingAfter: number): AuctionInfo {
  return {
    auctionId: a.id,
    index,
    letter: a.letter,
    opensAtMs: usToMs(a.opensAtUs),
    closesAtMs: usToMs(a.closesAtUs),
    remainingAfter,
  };
}

export function outcomeOf(r: ResultRow, index: number): AuctionOutcome {
  return { auctionId: r.auctionId, index, letter: r.letter, winnerId: r.winnerBotId, paid: r.paid };
}

export interface SnapshotRows {
  state: MatchStateRow;
  participants: readonly ParticipantRow[];
  auctions: readonly AuctionRow[];
  results: readonly ResultRow[];
  words: readonly WordRow[];
  rack: readonly RackRow[];
}

export interface RebuiltMatch {
  myStartRack: Rack;
  /** Chronological history, including the open event of the still-open auction (if any). */
  events: MatchEvent[];
  /** The still-open auction (match Running and the current auction has no result); already in `events`. */
  openAuction?: AuctionInfo;
  /** Inconsistencies found while rebuilding (letters I played/won not explained by the rows). */
  startRackClamped: number;
}

/**
 * Rebuild the chronological event stream of a match from (unordered) snapshot rows:
 * auctions by id; open(a) followed by its result if closed; each word_play (sorted by played_at,
 * then id) goes after the last open with opens_at <= played_at, before that auction's result if
 * played_at < closed_at, after it if played_at == closed_at and the word is the winner's
 * (close-transaction sim word).
 * myStartRack = current my_rack + letters I played - letters I won.
 */
export function rebuildFromSnapshot(rows: SnapshotRows, config: MatchConfig): RebuiltMatch {
  const me = config.myId;
  const auctions = [...rows.auctions].filter((a) => a.matchId === config.matchId).sort((a, b) => a.id - b.id);
  const results = new Map<number, ResultRow>();
  for (const r of rows.results) if (r.matchId === config.matchId) results.set(r.auctionId, r);
  const words = [...rows.words]
    .filter((w) => w.matchId === config.matchId)
    .sort((a, b) => (a.playedAtUs < b.playedAtUs ? -1 : a.playedAtUs > b.playedAtUs ? 1 : a.id - b.id));

  // Slot words: before[i] = played while auction i open; after[i] = in the close transaction of i.
  const before: WordRow[][] = auctions.map(() => []);
  const after: WordRow[][] = auctions.map(() => []);
  let j = -1;
  for (const w of words) {
    while (j + 1 < auctions.length && auctions[j + 1]!.opensAtUs <= w.playedAtUs) j++;
    if (j < 0) {
      if (auctions.length === 0) continue;
      before[0]!.push(w); // played before the first open (not possible on the server): attribute to 0
      continue;
    }
    const rj = results.get(auctions[j]!.id);
    if (rj && w.playedAtUs >= rj.closedAtUs) {
      after[j]!.push(w); // final close transaction (no next auction)
      continue;
    }
    if (j > 0) {
      // A close-transaction word is the (sim) winner's word stamped with the close timestamp
      // (= the next open). Requiring the winner disambiguates a same-µs word transaction.
      const rp = results.get(auctions[j - 1]!.id);
      if (rp && rp.closedAtUs === w.playedAtUs && rp.winnerBotId === w.botId) {
        after[j - 1]!.push(w);
        continue;
      }
    }
    before[j]!.push(w);
  }

  const events: MatchEvent[] = [];
  const played = emptyRack();
  const won = emptyRack();
  let openAuction: AuctionInfo | undefined;
  const wordEvent = (w: WordRow, index: number): MatchEvent => {
    if (w.botId === me) rackAdd(played, rackFromWord(w.word));
    const ev: WordPlayEvent = { playerId: w.botId, word: w.word, reward: w.reward, auctionIndex: index };
    return { t: 'word', ev };
  };
  auctions.forEach((a, i) => {
    const r = results.get(a.id);
    const isCurrent = !r && rows.state.status === 'Running' && (rows.state.currentAuctionId === a.id || i === auctions.length - 1);
    const remaining = isCurrent ? rows.state.bagTotal : Math.max(0, config.totalAuctions - 1 - i);
    const info = auctionInfo(a, i, remaining);
    if (isCurrent) openAuction = info;
    events.push({ t: 'open', auction: info });
    for (const w of before[i]!) events.push(wordEvent(w, i));
    if (r) {
      events.push({ t: 'result', outcome: outcomeOf(r, i) });
      if (r.winnerBotId === me) {
        const li = r.letter.charCodeAt(0) - 65;
        if (li >= 0 && li < 26) won[li]!++;
      }
    }
    for (const w of after[i]!) events.push(wordEvent(w, i));
  });

  const start = rackFromRows(rows.rack);
  rackAdd(start, played);
  const missing = rackSubClamped(start, won);
  let clamped = 0;
  for (let i = 0; i < 26; i++) clamped += missing[i]!;
  return { myStartRack: start, events, openAuction, startRackClamped: clamped };
}

// ---------------------------------------------------------------------------------------------
// Driver

export type SubmitOutcome = 'ok' | 'late' | 'balance' | 'rejected' | 'match-over' | 'timeout' | 'unknown' | 'guard';

/** Classify a reducer failure by the module's exact error strings (RULES §7.2, §9). */
export function classifyError(err: unknown): { outcome: SubmitOutcome; message: string; roundTrip: boolean } {
  if (err instanceof MaincloudGuardError) return { outcome: 'guard', message: err.message, roundTrip: false };
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError') return { outcome: 'timeout', message, roundTrip: false };
  if (name === 'DisconnectedError' || name === 'UnknownCallResultError') return { outcome: 'unknown', message, roundTrip: false };
  if (message.includes('Auction window expired') || message.includes('Auction closed')) {
    return { outcome: 'late', message, roundTrip: true };
  }
  if (message.includes('Match not running')) return { outcome: 'match-over', message, roundTrip: true };
  if (message.includes('Insufficient balance')) return { outcome: 'balance', message, roundTrip: true };
  return { outcome: 'rejected', message, roundTrip: true };
}

class TimeoutError extends Error {
  constructor(ms: number) {
    super(`reducer call timed out after ${ms} ms`);
    this.name = 'TimeoutError';
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(ms)), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export interface DriverStats {
  decisions: number;
  decideMs: number[];
  /** recv (tx callback) -> anchor action (submit_bid sent, or decision done when no bid). */
  anchorMs: number[];
  /** Event-loop lag: recv (tx callback) -> processing start, per processed transaction. */
  loopLagMs: number[];
  bidsSent: number;
  bidsSkippedDeadline: number;
  wordsSent: number;
  wordsSkipped: number;
  wordRejections: number;
  bidRejections: number;
  balanceRetries: number;
  timingErrors: number;
  matchOverErrors: number;
  safetyFlushWords: number;
  replans: number;
  lateOpens: number;
}

export interface SubmissionRecord {
  what: 'bid' | 'word';
  auctionId: number;
  value: number | string;
  sentAt: number;
  deadline: number;
  pass: string;
}

export interface DriverOptions {
  matchId: number;
  myBotId: number;
  policyFactory: PolicyFactory;
  policyOpts?: Record<string, unknown>;
  seed: number;
  host: ReducerHost;
  target: GuardTarget;
  guardOptions?: GuardOptions;
  clock: ClientClock;
  log?: MatchLog;
  botInfo: (id: number) => BotRow | undefined;
  /** Created mid-match (process restart / reconnect): resubmit the bid for the open auction. */
  resume?: boolean;
  /** Schedules refine passes (default setImmediate). */
  schedule?: (fn: () => void) => void;
  flushPacker?: FlushPacker;
  anchorBudgetMs?: number;
  maxRefineBudgetMs?: number;
  minRefineBudgetMs?: number;
  /** Max decide() calls per auction (anchor + refines + replan). */
  maxPassesPerAuction?: number;
  submitTimeoutMs?: number;
  /** Max ms for the final-auction safety flush pack. */
  flushBudgetMs?: number;
  onEnded?: (d: MatchDriver) => void;
  /** Test hook: every submission sent. */
  onSubmit?: (s: SubmissionRecord) => void;
}

interface AuctionPlay {
  info: AuctionInfo;
  recvLocalMs: number;
  late: boolean;
  deadline: number;
  final: boolean;
  closed: boolean;
  forceBid: boolean;
  lastSentBid: number | undefined;
  bidSends: number;
  balanceRetried: boolean;
  /** After an "Insufficient balance" rejection, bids are capped at the tracked balance. */
  capToBalance: boolean;
  replanned: boolean;
  /** Words the server rejected during this auction: never resubmitted in the same auction. */
  rejected: Set<string>;
  refineScheduled: boolean;
  passes: number;
}

type Store = {
  state?: MatchStateRow;
  participants: Map<number, ParticipantRow>; // by bot id
  auctions: Map<number, AuctionRow>;
  results: Map<number, ResultRow>;
  words: Map<number, WordRow>;
  rack: Map<number, RackRow>;
  phase?: TournamentPhase;
};

export class MatchDriver {
  readonly matchId: number;
  readonly myBotId: number;
  readonly stats: DriverStats = {
    decisions: 0,
    decideMs: [],
    anchorMs: [],
    loopLagMs: [],
    bidsSent: 0,
    bidsSkippedDeadline: 0,
    wordsSent: 0,
    wordsSkipped: 0,
    wordRejections: 0,
    bidRejections: 0,
    balanceRetries: 0,
    timingErrors: 0,
    matchOverErrors: 0,
    safetyFlushWords: 0,
    replans: 0,
    lateOpens: 0,
  };
  private readonly o: DriverOptions;
  private readonly store: Store = {
    participants: new Map(),
    auctions: new Map(),
    results: new Map(),
    words: new Map(),
    rack: new Map(),
  };
  private recorder: MatchRecorder | undefined;
  private policy: Policy | undefined;
  private rng: Rng;
  private readonly reservations = new Reservations();
  private readonly appliedResults = new Set<number>();
  private readonly appliedWords = new Set<number>();
  private readonly openedAuctions = new Set<number>();
  private play: AuctionPlay | undefined;
  private endedFlag = false;
  private disposed = false;
  private readOnly = false;

  constructor(opts: DriverOptions) {
    this.o = opts;
    this.matchId = opts.matchId;
    this.myBotId = opts.myBotId;
    this.rng = new Rng(opts.seed);
  }

  get started(): boolean {
    return this.recorder !== undefined;
  }
  get ended(): boolean {
    return this.endedFlag;
  }
  get tracker(): MatchTracker | undefined {
    return this.recorder?.tracker;
  }
  /** Every MatchEvent applied so far (start first). */
  get events(): readonly MatchEvent[] {
    return this.recorder?.events ?? [];
  }
  get config(): MatchConfig | undefined {
    return this.recorder?.tracker.config;
  }
  get currentDeadline(): number | undefined {
    return this.play && !this.play.closed ? this.play.deadline : undefined;
  }
  get pendingReservations(): string[] {
    return this.reservations.pendingWords();
  }

  /** Stop acting (connection lost / superseded). Pending callbacks become no-ops. */
  dispose(): void {
    this.disposed = true;
    if (this.play) this.play.closed = true;
  }

  private now(): number {
    return this.o.clock.now();
  }

  // ----- store --------------------------------------------------------------------------------

  private ingestRows(tx: MatchTx): void {
    const s = this.store;
    const m = this.matchId;
    for (const r of tx.matchStates) if (r.id === m) s.state = r;
    for (const r of tx.participants) if (r.matchId === m) s.participants.set(r.botId, r);
    for (const r of tx.auctions) if (r.matchId === m) s.auctions.set(r.id, r);
    for (const r of tx.results) if (r.matchId === m) s.results.set(r.auctionId, r);
    for (const r of tx.words) if (r.matchId === m) s.words.set(r.id, r);
    for (const r of tx.rack) if (r.matchId === m && r.botId === this.myBotId) s.rack.set(r.id, r);
    for (const r of tx.rackDeleted) if (r.matchId === m) s.rack.delete(r.id);
    for (const r of tx.tournamentMatches) if (r.matchId === m) s.phase = r.phase;
  }

  /** My exact rack for this match from my_rack rows (M13: filtered by match_id). */
  storeRack(): Rack {
    return rackFromRows(this.store.rack.values());
  }

  private auctionIndex(id: number): number {
    let n = 0;
    for (const k of this.store.auctions.keys()) if (k < id) n++;
    return n;
  }

  // ----- entry points -------------------------------------------------------------------------

  /**
   * Initial rows of the per-match subscription (fresh start or resume). Rebuilds the tracker from
   * the snapshot, then plays the still-open auction (tagged late).
   */
  applySnapshot(tx: MatchTx, recvLocalMs: number): void {
    if (this.disposed) return;
    this.ingestRows(tx);
    if (this.started) {
      // Duplicate snapshot (e.g. resubscribe on the same driver): treat as a live delta.
      this.processLive(tx, recvLocalMs, true);
      return;
    }
    this.startFromStore(recvLocalMs);
  }

  /** One live server transaction (rows for this match only). */
  applyTx(tx: MatchTx, recvLocalMs: number): void {
    if (this.disposed) return;
    this.ingestRows(tx);
    if (!this.started) return; // waiting for the per-match snapshot
    this.processLive(tx, recvLocalMs, false);
  }

  private startFromStore(recvLocalMs: number): void {
    this.stalled(recvLocalMs);
    const s = this.store;
    const state = s.state;
    if (!state) return;
    const participants = [...s.participants.values()];
    if (!participants.some((p) => p.botId === this.myBotId)) {
      this.o.log?.record({ k: 'error', msg: 'snapshot without my participant row' });
      return;
    }
    const config = buildMatchConfig(state, participants, this.myBotId, this.o.botInfo, s.phase);
    const rebuilt = rebuildFromSnapshot(
      {
        state,
        participants,
        auctions: [...s.auctions.values()],
        results: [...s.results.values()],
        words: [...s.words.values()],
        rack: [...s.rack.values()],
      },
      config,
    );
    this.recorder = new MatchRecorder(config, rebuilt.myStartRack);
    this.o.log?.event(this.recorder.events[0]!);
    if (rebuilt.startRackClamped > 0) {
      this.o.log?.record({ k: 'error', msg: 'start rack reconstruction clamped', clamped: rebuilt.startRackClamped });
    }
    this.policy = this.o.policyFactory(this.o.seed, this.o.policyOpts);
    for (const e of rebuilt.events) {
      this.emit(e);
      if (e.t === 'result') this.appliedResults.add(e.outcome.auctionId);
      if (e.t === 'open') this.openedAuctions.add(e.auction.auctionId);
    }
    for (const w of s.words.values()) this.appliedWords.add(w.id);
    // Resync with the authoritative rows.
    for (const info of config.players) {
      const p = s.participants.get(info.id);
      if (p) this.emit({ t: 'balance', id: p.botId, balance: p.balance, score: p.score });
    }
    this.emit({ t: 'rack', rack: rackToString(this.storeRack()) });
    this.o.log?.record({
      k: 'info',
      msg: this.o.resume ? 'resumed from snapshot' : 'started from snapshot',
      history: rebuilt.events.length,
      results: s.results.size,
      words: s.words.size,
    });
    this.policy.onMatchStart(this.recorder.tracker.view);

    if (state.status === 'Ended') {
      this.finish('snapshot');
      return;
    }
    const current = rebuilt.openAuction;
    if (current && state.status === 'Running' && this.recorder.tracker.view.current?.auctionId === current.auctionId) {
      this.beginAuction(current, recvLocalMs, true, false, !!this.o.resume);
    }
  }

  private emit(e: MatchEvent): void {
    this.recorder!.apply(e);
    this.o.log?.event(e);
  }

  /** Event-loop lag of this processing (recv -> now); a stall beyond clock.stallMs => late. */
  private stalled(recvLocalMs: number): boolean {
    const lag = this.now() - recvLocalMs;
    this.stats.loopLagMs.push(lag);
    return lag > this.o.clock.stallMs;
  }

  private processLive(tx: MatchTx, recvLocalMs: number, late: boolean): void {
    const tr = this.recorder!.tracker;
    const stalled = this.stalled(recvLocalMs);
    const m = this.matchId;
    let changedDuringOpen = false;

    // 1. results
    const newResults = tx.results
      .filter((r) => r.matchId === m && !this.appliedResults.has(r.auctionId))
      .sort((a, b) => a.auctionId - b.auctionId);
    let lastResultIndex: number | undefined;
    for (const r of newResults) {
      const index = this.auctionIndex(r.auctionId);
      this.appliedResults.add(r.auctionId);
      if (this.play && this.play.info.auctionId === r.auctionId) this.play.closed = true;
      const outcome = outcomeOf(r, index);
      this.emit({ t: 'result', outcome });
      lastResultIndex = index;
      try {
        this.policy?.onAuctionClosed?.(tr.view, outcome);
      } catch (e) {
        this.o.log?.record({ k: 'error', msg: 'policy.onAuctionClosed threw', error: String(e) });
      }
    }

    // 2. words (dedupe by row id; attribution per the shared rule)
    const newWords = tx.words
      .filter((w) => w.matchId === m && !this.appliedWords.has(w.id))
      .sort((a, b) => (a.playedAtUs < b.playedAtUs ? -1 : a.playedAtUs > b.playedAtUs ? 1 : a.id - b.id));
    for (const w of newWords) {
      this.appliedWords.add(w.id);
      const index =
        lastResultIndex ?? tr.view.current?.index ?? (tr.view.history.length > 0 ? tr.view.history[tr.view.history.length - 1]!.index : 0);
      if (w.botId === this.myBotId) {
        this.reservations.releaseEcho(w.word);
        const rack = tr.me.rack;
        const need = rackFromWord(w.word);
        let ok = true;
        for (let i = 0; i < 26; i++) if (rack[i]! < need[i]!) ok = false;
        if (!ok) {
          // Desync: restore the pre-word rack from the authoritative rows, then apply the word.
          const pre = this.storeRack();
          rackAdd(pre, need);
          this.emit({ t: 'rack', rack: rackToString(pre) });
        }
      }
      this.emit({ t: 'word', ev: { playerId: w.botId, word: w.word, reward: w.reward, auctionIndex: index } });
      if (lastResultIndex === undefined) changedDuringOpen = true;
    }

    // 3. balances
    const seen = new Set<number>();
    for (const p of tx.participants) {
      if (p.matchId !== m || seen.has(p.botId)) continue;
      seen.add(p.botId);
      const cur = this.store.participants.get(p.botId);
      if (!cur) continue;
      if (!tr.view.players.has(p.botId)) continue;
      this.emit({ t: 'balance', id: cur.botId, balance: cur.balance, score: cur.score });
      if (lastResultIndex === undefined) changedDuringOpen = true;
    }

    // 4. my_rack
    if (tx.rack.some((r) => r.matchId === m) || tx.rackDeleted.some((r) => r.matchId === m)) {
      this.reservations.releaseSettled();
      this.emit({ t: 'rack', rack: rackToString(this.storeRack()) });
    }

    // 5. new auction open
    const opens = tx.auctions
      .filter((a) => a.matchId === m && a.open && !this.openedAuctions.has(a.id) && !this.store.results.has(a.id))
      .sort((a, b) => a.id - b.id);
    for (const a of opens) {
      const cur = this.store.auctions.get(a.id)!;
      const index = this.auctionIndex(a.id);
      const state = this.store.state;
      const remaining =
        state && state.currentAuctionId === a.id ? state.bagTotal : Math.max(0, tr.config.totalAuctions - 1 - index);
      const info = auctionInfo(cur, index, remaining);
      let isLate = late || stalled;
      if (!isLate) isLate = this.o.clock.observeLiveOpen(info.opensAtMs, recvLocalMs);
      this.beginAuction(info, recvLocalMs, isLate, true, late && !!this.o.resume);
      changedDuringOpen = false;
    }

    // 6. match end
    if (this.store.state?.status === 'Ended') {
      this.finish('live');
      return;
    }

    if (changedDuringOpen && this.play && !this.play.closed) this.scheduleRefine(this.play);
  }

  // ----- decision loop ------------------------------------------------------------------------

  private beginAuction(info: AuctionInfo, recvLocalMs: number, late: boolean, applyOpen: boolean, forceBid: boolean): void {
    if (applyOpen) {
      this.openedAuctions.add(info.auctionId);
      this.emit({ t: 'open', auction: info });
    } else this.openedAuctions.add(info.auctionId);
    if (late) this.stats.lateOpens++;
    const deadline = this.o.clock.deadlineFor(info, recvLocalMs, { late });
    const play: AuctionPlay = {
      info,
      recvLocalMs,
      late,
      deadline,
      final: info.remainingAfter === 0,
      closed: false,
      forceBid,
      lastSentBid: undefined,
      bidSends: 0,
      balanceRetried: false,
      capToBalance: false,
      replanned: false,
      rejected: new Set(),
      refineScheduled: false,
      passes: 0,
    };
    if (this.play) this.play.closed = true;
    this.play = play;
    this.runPass(play, 'anchor', this.o.anchorBudgetMs ?? 15);
    if (!play.final) this.scheduleRefine(play);
  }

  private scheduleRefine(play: AuctionPlay): void {
    if (play.refineScheduled || play.closed || this.disposed || this.readOnly) return;
    if (play.passes >= (this.o.maxPassesPerAuction ?? 4)) return;
    play.refineScheduled = true;
    const sched = this.o.schedule ?? ((fn: () => void) => setImmediate(fn));
    sched(() => {
      play.refineScheduled = false;
      if (play.closed || this.disposed) return;
      const budget = Math.min(this.o.maxRefineBudgetMs ?? 250, this.o.clock.budgetFor(play.deadline, this.now()));
      if (budget < (this.o.minRefineBudgetMs ?? 3)) return;
      this.runPass(play, 'refine', budget);
    });
  }

  private runPass(play: AuctionPlay, pass: 'anchor' | 'refine' | 'replan', budgetMs: number): void {
    if (play.closed || this.disposed || this.readOnly || !this.policy) return;
    const tr = this.recorder!.tracker;
    if (tr.view.current?.auctionId !== play.info.auctionId) return;
    if (this.now() >= play.deadline) {
      if (pass === 'anchor') this.stats.bidsSkippedDeadline++;
      return;
    }
    play.passes++;
    const t0 = performance.now();
    let decision: { words: string[]; bid: number };
    try {
      decision = this.policy.decide(tr.view, play.info, {
        budgetMs,
        rng: this.rng,
        now: () => performance.now(),
        netRttMs: this.o.clock.rttP90,
      });
    } catch (e) {
      this.o.log?.record({ k: 'error', msg: 'policy.decide threw', error: String(e), auctionId: play.info.auctionId });
      decision = { words: [], bid: 0 };
    }
    const decideMs = performance.now() - t0;
    this.stats.decisions++;
    this.stats.decideMs.push(decideMs);
    this.o.log?.record({
      k: 'decision',
      auctionId: play.info.auctionId,
      index: play.info.index,
      pass,
      bid: decision.bid,
      words: decision.words,
      decideMs,
      budgetMs,
      late: play.late,
    });

    this.submitWords(play, decision.words, pass);
    if (play.final) this.safetyFlush(play, pass);
    this.submitBid(play, decision.bid, pass);
    if (pass === 'anchor') this.stats.anchorMs.push(this.now() - play.recvLocalMs);
  }

  private submitWords(play: AuctionPlay, words: readonly string[], pass: string): void {
    const tr = this.recorder!.tracker;
    for (const raw of words) {
      const w = normalizeWord(raw);
      if (!w) {
        this.stats.wordsSkipped++;
        this.o.log?.record({ k: 'info', msg: 'word skipped (malformed)', word: raw });
        continue;
      }
      if (this.now() >= play.deadline) {
        this.stats.wordsSkipped++;
        this.o.log?.record({ k: 'info', msg: 'word skipped (deadline)', word: w });
        break;
      }
      if (play.rejected.has(w)) {
        this.stats.wordsSkipped++;
        this.o.log?.record({ k: 'info', msg: 'word skipped (rejected earlier this auction)', word: w });
        continue;
      }
      const ticket = this.reservations.reserve(tr.me.rack, w);
      if (ticket === undefined) {
        this.stats.wordsSkipped++;
        this.o.log?.record({ k: 'info', msg: 'word skipped (letters reserved or missing)', word: w });
        continue;
      }
      this.sendWord(play, w, ticket, pass);
    }
  }

  private safetyFlush(play: AuctionPlay, pass: string): void {
    const packer = this.o.flushPacker ?? defaultFlushPacker();
    if (!packer) return;
    const tr = this.recorder!.tracker;
    const leftover = this.reservations.available(tr.me.rack);
    const remaining = play.deadline - this.now();
    if (remaining <= 0) return;
    const plan = planSafetyFlush(packer, leftover, Math.min(this.o.flushBudgetMs ?? 40, remaining / 2));
    if (plan.words.length === 0) return;
    this.o.log?.record({ k: 'info', msg: 'safety flush', pass, words: plan.words, score: plan.score, packMs: plan.ms });
    this.stats.safetyFlushWords += plan.words.length;
    this.submitWords(play, plan.words, `${pass}-flush`);
  }

  private call(name: string, args: Record<string, unknown>): Promise<void> {
    return withTimeout(callReducer(this.o.host, name, args, this.o.target, this.o.guardOptions), this.o.submitTimeoutMs ?? 2500);
  }

  private sendWord(play: AuctionPlay, word: string, ticket: number, pass: string): void {
    const t0 = this.now();
    this.stats.wordsSent++;
    this.o.onSubmit?.({ what: 'word', auctionId: play.info.auctionId, value: word, sentAt: t0, deadline: play.deadline, pass });
    let p: Promise<void>;
    try {
      p = this.call('submit_word', { matchId: BigInt(this.matchId), word });
    } catch (e) {
      this.reservations.release(ticket);
      this.onGuardFailure(e);
      return;
    }
    p.then(
      () => {
        this.o.clock.recordRtt(this.now() - t0);
        this.reservations.markSettled(ticket);
        this.o.log?.record({ k: 'submit', what: 'word', auctionId: play.info.auctionId, value: word, outcome: 'ok', rttMs: this.now() - t0 });
      },
      (err: unknown) => {
        const c = classifyError(err);
        if (c.roundTrip) this.o.clock.recordRtt(this.now() - t0);
        if (c.outcome === 'timeout' || c.outcome === 'unknown') this.reservations.markSettled(ticket);
        else this.reservations.release(ticket);
        if (c.outcome === 'rejected') play.rejected.add(word);
        this.stats.wordRejections++;
        if (c.outcome === 'match-over') this.stats.matchOverErrors++;
        this.o.log?.record({ k: 'submit', what: 'word', auctionId: play.info.auctionId, value: word, outcome: c.outcome, error: c.message });
        if (this.disposed) return;
        if (play.final && !play.replanned && !play.closed && c.outcome === 'rejected') this.replan(play);
      },
    );
  }

  /** Final auction: a word was rejected -> refresh the rack from my_rack and re-plan once. */
  private replan(play: AuctionPlay): void {
    play.replanned = true;
    this.stats.replans++;
    if (this.now() >= play.deadline) return;
    this.emit({ t: 'rack', rack: rackToString(this.storeRack()) });
    this.runPass(play, 'replan', Math.min(this.o.anchorBudgetMs ?? 15, Math.max(1, play.deadline - this.now())));
  }

  private submitBid(play: AuctionPlay, rawAmount: number, pass: string): void {
    let amount = Number.isFinite(rawAmount) ? Math.max(0, Math.floor(rawAmount)) : 0;
    if (play.capToBalance) amount = Math.min(amount, Math.max(0, this.recorder!.tracker.me.balance));
    if (!play.forceBid && amount === (play.lastSentBid ?? 0)) return;
    if (play.closed || this.disposed) return;
    if (this.now() >= play.deadline) {
      this.stats.bidsSkippedDeadline++;
      this.o.log?.record({ k: 'info', msg: 'bid skipped (deadline)', auctionId: play.info.auctionId, bid: amount });
      return;
    }
    play.forceBid = false;
    const prev = play.lastSentBid;
    play.lastSentBid = amount;
    play.bidSends++;
    this.stats.bidsSent++;
    const t0 = this.now();
    this.o.onSubmit?.({ what: 'bid', auctionId: play.info.auctionId, value: amount, sentAt: t0, deadline: play.deadline, pass });
    let p: Promise<void>;
    try {
      p = this.call('submit_bid', { auctionId: BigInt(play.info.auctionId), amount: BigInt(amount) });
    } catch (e) {
      play.lastSentBid = prev;
      this.onGuardFailure(e);
      return;
    }
    p.then(
      () => {
        this.o.clock.recordRtt(this.now() - t0);
        this.o.log?.record({ k: 'submit', what: 'bid', auctionId: play.info.auctionId, value: amount, outcome: 'ok', rttMs: this.now() - t0 });
      },
      (err: unknown) => {
        const c = classifyError(err);
        if (c.roundTrip) this.o.clock.recordRtt(this.now() - t0);
        this.stats.bidRejections++;
        if (c.outcome === 'late') this.stats.timingErrors++;
        this.o.log?.record({ k: 'submit', what: 'bid', auctionId: play.info.auctionId, value: amount, outcome: c.outcome, error: c.message });
        if (play.lastSentBid === amount) play.lastSentBid = prev;
        if (this.disposed || play.closed) return;
        if (c.outcome === 'balance') play.capToBalance = true;
        if (c.outcome === 'balance' && !play.balanceRetried && this.now() < play.deadline) {
          play.balanceRetried = true;
          const bal = Math.max(0, this.recorder!.tracker.me.balance);
          const retry = Math.min(amount, bal);
          if (retry !== amount) {
            this.stats.balanceRetries++;
            this.submitBid(play, retry, `${pass}-balance-retry`);
          }
        }
      },
    );
  }

  private onGuardFailure(e: unknown): void {
    this.readOnly = true;
    this.o.log?.record({ k: 'error', msg: 'reducer refused by guard; driver is read-only', error: String(e) });
  }

  // ----- end ----------------------------------------------------------------------------------

  private finish(source: string): void {
    if (this.endedFlag) return;
    this.endedFlag = true;
    if (this.play) this.play.closed = true;
    const tr = this.recorder?.tracker;
    if (tr) {
      try {
        this.policy?.onMatchEnd?.(tr.view);
      } catch (e) {
        this.o.log?.record({ k: 'error', msg: 'policy.onMatchEnd threw', error: String(e) });
      }
      const left = unplayedValue(this.storeRack());
      this.o.log?.record({
        k: 'info',
        msg: 'match ended',
        source,
        score: tr.me.score,
        balance: tr.me.balance,
        unplayed: left,
        diagnostics: { ...tr.diagnostics },
      });
      this.o.log?.record({ k: 'timing', ...summarizeStats(this.stats) });
    }
    this.o.log?.flush();
    this.o.onEnded?.(this);
  }
}

/** p50/p90/p99 + counters of a driver's stats (for logs and 02-04 reports). */
export function summarizeStats(s: DriverStats): Record<string, number> {
  const pct = (a: number[], p: number): number => {
    if (a.length === 0) return 0;
    const sorted = [...a].sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  };
  return {
    decisions: s.decisions,
    decideP50: pct(s.decideMs, 0.5),
    decideP99: pct(s.decideMs, 0.99),
    anchorP50: pct(s.anchorMs, 0.5),
    anchorP99: pct(s.anchorMs, 0.99),
    loopLagP99: pct(s.loopLagMs, 0.99),
    bidsSent: s.bidsSent,
    bidsSkippedDeadline: s.bidsSkippedDeadline,
    wordsSent: s.wordsSent,
    wordsSkipped: s.wordsSkipped,
    wordRejections: s.wordRejections,
    bidRejections: s.bidRejections,
    balanceRetries: s.balanceRetries,
    timingErrors: s.timingErrors,
    matchOverErrors: s.matchOverErrors,
    safetyFlushWords: s.safetyFlushWords,
    replans: s.replans,
    lateOpens: s.lateOpens,
  };
}

/** Exported for tests: well-formedness gate used before any submit_word. */
export const isSubmittableWord = (w: string): boolean => isWellFormedWord(w);
