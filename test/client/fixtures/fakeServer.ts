// A tiny in-memory ScrabbleBot server for client unit tests (no network). It produces the same
// per-transaction row deltas the live client receives (normalized MatchTx), validates our reducer
// calls with the module's exact error strings, and can dump an unordered snapshot of all rows.
// Rules mirrored from RULES.md: sims bid at open (base + jitter), Vickrey/FirstPrice pricing,
// a winning sim plays findBestPlayable(rack, 3) inside the close transaction, the final close ends
// the match, close runs 1.5 ms after closes_at, the next auction opens in the close transaction.
import { BAG, LETTERS, NUM_LETTERS, VALUE, idx, totalAuctions, wordReward } from '../../../src/core/letters.js';
import { emptyRack, rackFromWord, type Rack } from '../../../src/core/rack.js';
import { Rng } from '../../../src/core/rng.js';
import { simBid } from '../../../src/core/simbots.js';
import type { AuctionType, SimStrategy } from '../../../src/core/types.js';
import { getEngine } from '../../../src/engine/index.js';
import {
  emptyMatchTx,
  type AuctionRow,
  type BotRow,
  type MatchStateRow,
  type MatchTx,
  type ParticipantRow,
  type RackRow,
  type ResultRow,
  type TournamentMatchRow,
  type WordRow,
} from '../../../src/client/adapter.js';

export interface FakePlayer {
  botId: number;
  name: string;
  isSim: boolean;
  strategy: SimStrategy;
}

export interface FakeServerOptions {
  matchId?: number;
  players: FakePlayer[];
  meId: number;
  rackSize?: number;
  durationMs?: number;
  auctionType?: AuctionType;
  seed?: number;
  /** Server start time (epoch µs). */
  startUs?: bigint;
  /** Words the "dictionary" rejects (exact module message). */
  rejectWords?: Set<string>;
  /** Deterministic bids of non-sim opponents at each open. */
  opponentBid?: (botId: number, letter: string, index: number, balance: number) => number;
  tournamentPhase?: TournamentMatchRow['phase'];
}

export interface ReducerCall {
  name: string;
  args: Record<string, unknown>;
  serverUs: bigint;
  ok: boolean;
  error?: string;
}

const CLOSE_LAG_US = 1500n;

export class FakeServer {
  readonly matchId: number;
  readonly players: FakePlayer[];
  readonly meId: number;
  readonly rackSize: number;
  readonly durationMs: number;
  readonly auctionType: AuctionType;
  readonly total: number;
  serverUs: bigint;
  readonly calls: ReducerCall[] = [];
  /** Delivery hook: every transaction (incl. those caused by our reducers). */
  onTx: ((tx: MatchTx) => void) | undefined;
  /** When false, transactions are produced but not delivered (simulated disconnect). */
  connected = true;

  private readonly rng: Rng;
  private readonly bag = new Uint8Array(NUM_LETTERS);
  private bagTotal = 0;
  readonly racks = new Map<number, Rack>();
  readonly participants = new Map<number, ParticipantRow>();
  readonly auctions: AuctionRow[] = [];
  readonly results: ResultRow[] = [];
  readonly words: WordRow[] = [];
  private readonly myRack = new Map<string, RackRow>();
  private bids = new Map<number, { amount: number; seq: number }>();
  private bidSeq = 0;
  state!: MatchStateRow;
  private nextWordId = 1;
  /** Timestamp of the last transaction: transaction timestamps are strictly increasing. */
  private lastTxUs = 0n;
  private readonly opts: FakeServerOptions;

  constructor(opts: FakeServerOptions) {
    this.opts = opts;
    this.matchId = opts.matchId ?? 4242;
    this.players = opts.players;
    this.meId = opts.meId;
    this.rackSize = opts.rackSize ?? 5;
    this.durationMs = opts.durationMs ?? 1000;
    this.auctionType = opts.auctionType ?? 'Vickrey';
    this.total = totalAuctions(this.players.length, this.rackSize);
    this.serverUs = opts.startUs ?? 1_760_000_000_000_000n;
    this.rng = new Rng(opts.seed ?? 1);
    for (let i = 0; i < NUM_LETTERS; i++) {
      this.bag[i] = BAG[i]!;
      this.bagTotal += BAG[i]!;
    }
  }

  get serverMs(): number {
    return Number(this.serverUs) / 1000;
  }

  bots(): BotRow[] {
    return this.players.map((p) => ({ id: p.botId, name: p.name, isSimulated: p.isSim, strategy: p.isSim ? p.strategy : 'Human' }));
  }

  botInfo = (id: number): BotRow | undefined => this.bots().find((b) => b.id === id);

  advanceMs(ms: number): void {
    this.serverUs += BigInt(Math.round(ms * 1000));
  }

  get current(): AuctionRow | undefined {
    const a = this.auctions[this.auctions.length - 1];
    return a && a.open ? a : undefined;
  }

  get ended(): boolean {
    return this.state?.status === 'Ended';
  }

  private draw(): string | undefined {
    if (this.bagTotal === 0) return undefined;
    let k = this.rng.int(0, this.bagTotal - 1);
    for (let i = 0; i < NUM_LETTERS; i++) {
      const n = this.bag[i]!;
      if (k < n) {
        this.bag[i] = n - 1;
        this.bagTotal--;
        return LETTERS[i]!;
      }
      k -= n;
    }
    throw new Error('draw: bag accounting');
  }

  /** Timestamp for a new transaction (strictly after the previous one). */
  private txTime(): bigint {
    if (this.serverUs <= this.lastTxUs) this.serverUs = this.lastTxUs + 1n;
    this.lastTxUs = this.serverUs;
    return this.serverUs;
  }

  private deliver(tx: MatchTx): MatchTx {
    if (this.connected) this.onTx?.(tx);
    return tx;
  }

  private addToRack(botId: number, letter: string, tx: MatchTx): void {
    const r = this.racks.get(botId)!;
    r[idx(letter)]!++;
    if (botId === this.meId) this.touchMyRack(letter, tx);
  }

  private touchMyRack(letter: string, tx: MatchTx): void {
    const li = idx(letter);
    const count = this.racks.get(this.meId)![li]!;
    const id = this.matchId * 100 + li;
    if (count > 0) {
      const row: RackRow = { id, matchId: this.matchId, botId: this.meId, letter, count };
      this.myRack.set(letter, row);
      tx.rack.push(row);
    } else {
      const old = this.myRack.get(letter);
      if (old) {
        this.myRack.delete(letter);
        tx.rackDeleted.push(old);
      }
    }
  }

  private openAuction(tx: MatchTx, letter: string): void {
    const a: AuctionRow = {
      id: this.matchId * 1000 + this.auctions.length + 1,
      matchId: this.matchId,
      letter,
      opensAtUs: this.serverUs,
      closesAtUs: this.serverUs + BigInt(this.durationMs) * 1000n,
      open: true,
    };
    this.auctions.push(a);
    this.state = {
      ...this.state,
      currentRound: this.auctions.length,
      currentAuctionId: a.id,
      bagTotal: this.bagTotal,
    };
    tx.matchStates.push(this.state);
    tx.auctions.push(a);
    this.bids = new Map();
    const li = idx(letter);
    for (const p of this.players) {
      if (p.botId === this.meId) continue;
      const bal = this.participants.get(p.botId)!.balance;
      let amount = 0;
      if (p.isSim) amount = simBid(p.strategy, li, bal, this.rng.int(-2, 2));
      else if (this.opts.opponentBid) amount = Math.min(bal, Math.max(0, this.opts.opponentBid(p.botId, letter, this.auctions.length - 1, bal)));
      if (amount > 0) this.bids.set(p.botId, { amount, seq: ++this.bidSeq });
    }
  }

  /** Match start transaction. */
  startTx(): MatchTx {
    this.txTime();
    const tx = emptyMatchTx();
    this.state = {
      id: this.matchId,
      status: 'Running',
      currentRound: 0,
      currentAuctionId: null,
      bagTotal: this.bagTotal,
      auctionType: this.auctionType,
      auctionDurationMs: this.durationMs,
      startingRackSize: this.rackSize,
      createdAtUs: this.serverUs,
    };
    this.players.forEach((p, seat) => {
      const row: ParticipantRow = { id: this.matchId * 10 + seat, matchId: this.matchId, botId: p.botId, balance: 100, score: 0 };
      this.participants.set(p.botId, row);
      tx.participants.push(row);
      this.racks.set(p.botId, emptyRack());
    });
    for (const p of this.players) {
      for (let k = 0; k < this.rackSize; k++) {
        const l = this.draw();
        if (l) this.addToRack(p.botId, l, tx);
      }
    }
    if (this.opts.tournamentPhase) {
      tx.tournamentMatches.push({ id: 1, tournamentId: 1, matchId: this.matchId, round: 1, phase: this.opts.tournamentPhase });
    }
    this.openAuction(tx, this.draw()!);
    return this.deliver(tx);
  }

  private setBalance(botId: number, delta: number, scoreDelta: number, tx: MatchTx): void {
    const p = this.participants.get(botId)!;
    const row = { ...p, balance: p.balance + delta, score: p.score + scoreDelta };
    this.participants.set(botId, row);
    tx.participants.push(row);
  }

  private playWord(botId: number, word: string, tx: MatchTx): WordRow {
    const rack = this.racks.get(botId)!;
    const need = rackFromWord(word);
    for (let i = 0; i < NUM_LETTERS; i++) rack[i] = rack[i]! - need[i]!;
    if (botId === this.meId) for (let i = 0; i < NUM_LETTERS; i++) if (need[i]! > 0) this.touchMyRack(LETTERS[i]!, tx);
    const reward = wordReward(word);
    const row: WordRow = { id: this.nextWordId++, matchId: this.matchId, botId, word, reward, playedAtUs: this.serverUs };
    this.words.push(row);
    tx.words.push(row);
    this.setBalance(botId, reward, reward, tx);
    return row;
  }

  /** Close the current auction (at closes_at + 1.5 ms) and open the next one (or end the match). */
  closeTx(): MatchTx {
    const a = this.current;
    if (!a) throw new Error('closeTx: no open auction');
    if (this.serverUs < a.closesAtUs + CLOSE_LAG_US) this.serverUs = a.closesAtUs + CLOSE_LAG_US;
    this.txTime();
    const tx = emptyMatchTx();
    const sorted = [...this.bids.entries()].filter(([, b]) => b.amount > 0).sort((x, y) => x[1].seq - y[1].seq);
    this.rng.shuffle(sorted);
    sorted.sort((x, y) => y[1].amount - x[1].amount);
    const top = sorted[0];
    let winner: number | null = null;
    let paid = 0;
    if (top) {
      winner = top[0];
      paid = this.auctionType === 'FirstPrice' ? top[1].amount : sorted[1] ? sorted[1][1].amount : Math.min(1, top[1].amount);
      this.setBalance(winner, -paid, 0, tx);
      this.addToRack(winner, a.letter, tx);
    }
    const result: ResultRow = { auctionId: a.id, matchId: this.matchId, letter: a.letter, winnerBotId: winner, paid, closedAtUs: this.serverUs };
    this.results.push(result);
    tx.results.push(result);
    const closed = { ...a, open: false };
    this.auctions[this.auctions.length - 1] = closed;
    tx.auctions.push(closed);
    const wp = winner === null ? undefined : this.players.find((p) => p.botId === winner);
    if (wp?.isSim) {
      const w = getEngine().index.findBestPlayable(this.racks.get(wp.botId)!, 3);
      if (w) this.playWord(wp.botId, w, tx);
    }
    const next = this.draw();
    if (!next) {
      this.state = { ...this.state, status: 'Ended', currentAuctionId: null, bagTotal: 0 };
      tx.matchStates.push(this.state);
    } else this.openAuction(tx, next);
    return this.deliver(tx);
  }

  /** A word transaction by a (non-sim) opponent. Throws on an unplayable word. */
  opponentWordTx(botId: number, word: string): MatchTx {
    const rack = this.racks.get(botId)!;
    const need = rackFromWord(word);
    for (let i = 0; i < NUM_LETTERS; i++) if (rack[i]! < need[i]!) throw new Error(`opponent ${botId} cannot play ${word}`);
    const tx = emptyMatchTx();
    this.txTime();
    this.playWord(botId, word, tx);
    return this.deliver(tx);
  }

  /** Best opponent word (>= minLen) or undefined. */
  opponentBestWord(botId: number, minLen = 4): string | undefined {
    return getEngine().index.findBestPlayable(this.racks.get(botId)!, minLen);
  }

  /** Reducer surface (camelCase accessors, like DbConnection.reducers). */
  readonly reducers = {
    submitBid: async (args: { auctionId: bigint; amount: bigint }): Promise<void> => {
      await Promise.resolve();
      const fail = (msg: string): never => {
        this.calls.push({ name: 'submit_bid', args, serverUs: this.serverUs, ok: false, error: msg });
        throw new Error(msg);
      };
      const amount = Number(args.amount);
      if (amount < 0) fail('Bid must be non-negative');
      const a = this.auctions.find((x) => x.id === Number(args.auctionId));
      if (!a) fail('Unknown auction');
      if (!a!.open) fail('Auction closed');
      if (this.serverUs >= a!.closesAtUs) fail('Auction window expired');
      if (this.participants.get(this.meId)!.balance < amount) fail('Insufficient balance');
      this.bids.set(this.meId, { amount, seq: ++this.bidSeq });
      this.calls.push({ name: 'submit_bid', args, serverUs: this.serverUs, ok: true });
    },
    submitWord: async (args: { matchId: bigint; word: string }): Promise<void> => {
      await Promise.resolve();
      const fail = (msg: string): never => {
        this.calls.push({ name: 'submit_word', args, serverUs: this.serverUs, ok: false, error: msg });
        throw new Error(msg);
      };
      if (Number(args.matchId) !== this.matchId) fail('Unknown match');
      if (this.state.status !== 'Running') fail('Match not running');
      const w = args.word.toUpperCase();
      if (w.length < 2) fail('Word must be at least 2 letters');
      if (!/^[A-Z]*$/.test(w)) fail('Word must be A-Z only');
      if (this.opts.rejectWords?.has(w) || !getEngine().dict.isValid(w)) fail(`'${w}' is not in the dictionary`);
      const rack = this.racks.get(this.meId)!;
      const need = rackFromWord(w);
      for (let i = 0; i < NUM_LETTERS; i++) {
        if (rack[i]! < need[i]!) fail(`Not enough '${LETTERS[i]}': need ${need[i]}, have ${rack[i]}`);
      }
      const tx = emptyMatchTx();
      this.txTime();
      this.playWord(this.meId, w, tx);
      this.calls.push({ name: 'submit_word', args, serverUs: this.serverUs, ok: true });
      this.deliver(tx);
    },
  };

  /** Bids the server currently holds for the open auction (test introspection only). */
  pendingBid(botId: number): number | undefined {
    return this.bids.get(botId)?.amount;
  }

  /** Every row of this match (what a fresh per-match subscription returns), optionally shuffled. */
  snapshot(shuffleSeed?: number): MatchTx {
    const tx = emptyMatchTx();
    tx.matchStates.push(this.state);
    tx.participants.push(...this.participants.values());
    tx.auctions.push(...this.auctions);
    tx.results.push(...this.results);
    tx.words.push(...this.words);
    tx.rack.push(...this.myRack.values());
    if (this.opts.tournamentPhase) {
      tx.tournamentMatches.push({ id: 1, tournamentId: 1, matchId: this.matchId, round: 1, phase: this.opts.tournamentPhase });
    }
    if (shuffleSeed !== undefined) {
      const r = new Rng(shuffleSeed);
      r.shuffle(tx.participants);
      r.shuffle(tx.auctions);
      r.shuffle(tx.results);
      r.shuffle(tx.words);
      r.shuffle(tx.rack);
    }
    return tx;
  }

  /** Total face value of a bot's rack. */
  rackValue(botId: number): number {
    const r = this.racks.get(botId)!;
    let v = 0;
    for (let i = 0; i < NUM_LETTERS; i++) v += r[i]! * VALUE[i]!;
    return v;
  }
}

export const DEFAULT_PLAYERS: FakePlayer[] = [
  { botId: 101, name: 'bawt', isSim: false, strategy: 'Human' },
  { botId: 3, name: 'Brutus-sim', isSim: true, strategy: 'Aggressive' },
  { botId: 2, name: 'Valor-sim', isSim: true, strategy: 'ValueBidder' },
  { botId: 150, name: 'rival', isSim: false, strategy: 'Human' },
];
