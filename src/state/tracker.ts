// MatchTracker: turns the public event stream of one match into the MatchView every Policy reads.
// Used by both the simulator and the live client, so it is the single source of truth for strategy
// inputs. Pure and deterministic; all state is maintained incrementally so `view` is O(1).
//
// Accounting model (multiset reasoning, exact under consistent input):
//   opponent rack  = knownHeld + hiddenUnknown tiles that are still unrevealed starting tiles
//   knownHeld      = won + revealedHidden - played                  (never negative)
//   revealedHidden = letters played beyond what the player has won (proven starting tiles)
//   unseen         = BAG - myStartRack - every auctioned letter (closed + open) - Σ_opp revealedHidden
//                  = undrawn bag letters + Σ_opp unrevealed starting tiles
// Invariant: total(unseen) == bagRemaining + Σ_opp hiddenUnknown.
import { BAG, LETTERS, NUM_LETTERS, idx } from '../core/letters.js';
import { emptyRack, rackClone, rackEquals, rackToString, type Rack } from '../core/rack.js';
import type {
  AuctionInfo,
  AuctionOutcome,
  MatchConfig,
  MatchView,
  MyState,
  PlayerId,
  PlayerInfo,
  PlayerState,
  WordPlayEvent,
} from '../core/types.js';

/** Counters of inconsistencies observed in the event stream (all 0 for a consistent stream). */
export interface TrackerDiagnostics {
  /** setBalance() resyncs whose balance or score differed from the tracked value. */
  balanceMismatches: number;
  /** setMyRack() resyncs whose rack differed from the tracked rack. */
  rackMismatches: number;
  /** Opponent words that would push total(revealedHidden) above startingRackSize (clamped). */
  hiddenOverflow: number;
  /** Letter removals that would have made an unseen count negative (clamped at 0). */
  unseenNegative: number;
}

/** Mutable backing object for the MatchView handed out by `MatchTracker.view`. */
interface ViewImpl {
  config: MatchConfig;
  me: MyState;
  players: Map<PlayerId, PlayerState>;
  opponents: PlayerState[];
  history: AuctionOutcome[];
  words: WordPlayEvent[];
  auctionsDone: number;
  auctionsRemaining: number;
  unseen: Rack;
  current: AuctionInfo | undefined;
}

function newPlayerState(info: PlayerInfo, balance: number): PlayerState {
  return {
    info,
    balance,
    score: 0,
    won: emptyRack(),
    played: emptyRack(),
    revealedHidden: emptyRack(),
    knownHeld: emptyRack(),
    hiddenUnknown: 0,
    lettersWon: 0,
    totalPaid: 0,
    words: [],
  };
}

function letterIndex(letter: string): number {
  const i = idx(letter);
  if (i < 0) throw new Error(`MatchTracker: invalid letter '${letter}'`);
  return i;
}

export class MatchTracker {
  readonly config: MatchConfig;
  readonly diagnostics: TrackerDiagnostics = {
    balanceMismatches: 0,
    rackMismatches: 0,
    hiddenOverflow: 0,
    unseenNegative: 0,
  };

  private readonly v: ViewImpl;
  /** Signed unseen counts; `v.unseen` is the clamped (>= 0) public copy. */
  private readonly unseenRaw = new Int16Array(NUM_LETTERS);
  /** Auction ids whose letter has already been removed from unseen. */
  private readonly counted = new Set<number>();
  /** Auction ids whose result has been applied (duplicate results are ignored). */
  private readonly resolved = new Set<number>();
  /** Scratch letter counts for word plays (avoids per-word allocation). */
  private readonly need = new Uint8Array(NUM_LETTERS);

  constructor(config: MatchConfig, myStartRack: Rack) {
    if (myStartRack.length !== NUM_LETTERS) throw new Error('MatchTracker: rack must have 26 counts');
    this.config = config;
    const players = new Map<PlayerId, PlayerState>();
    const opponents: PlayerState[] = [];
    let me: MyState | undefined;
    for (const info of config.players) {
      if (players.has(info.id)) throw new Error(`MatchTracker: duplicate player id ${info.id}`);
      const p = newPlayerState(info, config.startingBalance);
      p.hiddenUnknown = config.startingRackSize;
      if (info.id === config.myId) {
        me = Object.assign(p, { rack: rackClone(myStartRack), startRack: rackClone(myStartRack) });
        players.set(info.id, me);
      } else {
        players.set(info.id, p);
        opponents.push(p);
      }
    }
    if (!me) throw new Error(`MatchTracker: myId ${config.myId} is not a participant`);

    const unseen = emptyRack();
    this.v = {
      config,
      me,
      players,
      opponents,
      history: [],
      words: [],
      auctionsDone: 0,
      auctionsRemaining: config.totalAuctions,
      unseen,
      current: undefined,
    };
    for (let i = 0; i < NUM_LETTERS; i++) {
      this.unseenRaw[i] = BAG[i]!;
      unseen[i] = BAG[i]!;
      if (myStartRack[i]! > 0) this.removeUnseen(i, myStartRack[i]!);
    }
  }

  /** Live, incrementally maintained view (same object every call; mutates as events arrive). */
  get view(): MatchView {
    return this.v;
  }

  get me(): MyState {
    return this.v.me;
  }

  /**
   * Letters still in the bag (not yet drawn). While an auction is open this is its
   * `remainingAfter` (the server's bag_total, which excludes the open letter); otherwise
   * totalAuctions - auctionsDone.
   */
  get bagRemaining(): number {
    const cur = this.v.current;
    return cur ? cur.remainingAfter : this.config.totalAuctions - this.v.auctionsDone;
  }

  /** Auctions not yet closed, including the open one. */
  get auctionsRemaining(): number {
    return this.v.auctionsRemaining;
  }

  player(id: PlayerId): PlayerState {
    const p = this.v.players.get(id);
    if (!p) throw new Error(`MatchTracker: unknown player ${id}`);
    return p;
  }

  /** An auction opened: becomes `current`; its letter is now seen. Re-opening the same id updates it. */
  auctionOpen(info: AuctionInfo): void {
    const li = letterIndex(info.letter);
    if (this.resolved.has(info.auctionId)) return; // stale open after its result
    if (!this.counted.has(info.auctionId)) {
      this.counted.add(info.auctionId);
      this.removeUnseen(li, 1);
    }
    this.v.current = info;
  }

  /** An auction closed. Duplicate results (same auctionId) are ignored. */
  auctionResult(o: AuctionOutcome): void {
    const li = letterIndex(o.letter);
    const winner = o.winnerId === null ? undefined : this.player(o.winnerId);
    if (this.resolved.has(o.auctionId)) return;
    this.resolved.add(o.auctionId);
    if (!this.counted.has(o.auctionId)) {
      // Result seen without its open (e.g. rebuilding from history rows).
      this.counted.add(o.auctionId);
      this.removeUnseen(li, 1);
    }
    const v = this.v;
    v.history.push(o);
    if (v.current && v.current.auctionId === o.auctionId) v.current = undefined;
    if (winner) {
      winner.won[li]!++;
      winner.knownHeld[li]!++;
      winner.lettersWon++;
      winner.balance -= o.paid;
      winner.totalPaid += o.paid;
      if (winner === v.me) v.me.rack[li]!++;
    }
    v.auctionsDone++;
    v.auctionsRemaining = this.config.totalAuctions - v.auctionsDone;
  }

  /**
   * A player played a word: reward goes to balance and score. Letters beyond the player's
   * knownHeld are attributed to hidden starting tiles (revealedHidden). For me the exact rack
   * is debited; an unspellable word throws (tracker or caller bug) without mutating state.
   * My own revealedHidden/knownHeld follow the same public inference as opponents (i.e. what
   * the table can deduce about me); my exact holdings are `me.rack`.
   */
  wordPlay(ev: WordPlayEvent): void {
    const p = this.player(ev.playerId);
    const need = this.need;
    need.fill(0);
    const w = ev.word;
    for (let k = 0; k < w.length; k++) {
      const i = w.charCodeAt(k) - 65;
      if (i < 0 || i >= NUM_LETTERS) {
        throw new Error(`MatchTracker: invalid letter '${w[k]}' in word '${w}'`);
      }
      need[i]!++;
    }
    const v = this.v;
    const isMe = p === v.me;
    if (isMe) {
      const rack = v.me.rack;
      for (let i = 0; i < NUM_LETTERS; i++) {
        if (rack[i]! < need[i]!) {
          throw new Error(
            `MatchTracker: my rack '${rackToString(rack)}' cannot spell '${w}' (missing '${LETTERS[i]}')`,
          );
        }
      }
      for (let i = 0; i < NUM_LETTERS; i++) rack[i] = rack[i]! - need[i]!;
    }

    const cap = this.config.startingRackSize;
    let revealedTotal = cap - p.hiddenUnknown;
    let overflow = false;
    for (let i = 0; i < NUM_LETTERS; i++) {
      const n = need[i]!;
      if (n === 0) continue;
      const avail = p.knownHeld[i]!;
      let excess = n - avail;
      if (excess > 0) {
        if (revealedTotal + excess > cap) {
          overflow = true;
          excess = Math.max(0, cap - revealedTotal);
        }
        if (excess > 0) {
          p.revealedHidden[i] = p.revealedHidden[i]! + excess;
          revealedTotal += excess;
          if (!isMe) this.removeUnseen(i, excess);
        }
      } else excess = 0;
      p.played[i] = p.played[i]! + n;
      p.knownHeld[i] = Math.max(0, avail + excess - n);
    }
    if (overflow) this.diagnostics.hiddenOverflow++;
    p.hiddenUnknown = cap - revealedTotal;
    p.balance += ev.reward;
    p.score += ev.reward;
    p.words.push(ev);
    v.words.push(ev);
  }

  /** Authoritative balance/score resync (live rows). Mismatches are counted in diagnostics. */
  setBalance(id: PlayerId, balance: number, score: number): void {
    const p = this.player(id);
    if (p.balance !== balance || p.score !== score) this.diagnostics.balanceMismatches++;
    p.balance = balance;
    p.score = score;
  }

  /** Authoritative resync of my exact rack (live my_rack). Mismatches are counted in diagnostics. */
  setMyRack(rack: Rack): void {
    const mine = this.v.me.rack;
    if (!rackEquals(mine, rack)) {
      this.diagnostics.rackMismatches++;
      mine.set(rack);
    }
  }

  /** Deep copy of the current view, independent of later events. */
  snapshot(): MatchView {
    const v = this.v;
    const config: MatchConfig = { ...v.config, players: v.config.players.map((p) => ({ ...p })) };
    const infoById = new Map<PlayerId, PlayerInfo>(config.players.map((p) => [p.id, p]));
    const copyPlayer = (p: PlayerState): PlayerState => ({
      info: infoById.get(p.info.id) ?? { ...p.info },
      balance: p.balance,
      score: p.score,
      won: rackClone(p.won),
      played: rackClone(p.played),
      revealedHidden: rackClone(p.revealedHidden),
      knownHeld: rackClone(p.knownHeld),
      hiddenUnknown: p.hiddenUnknown,
      lettersWon: p.lettersWon,
      totalPaid: p.totalPaid,
      words: p.words.map((w) => ({ ...w })),
    });
    const players = new Map<PlayerId, PlayerState>();
    const opponents: PlayerState[] = [];
    let me: MyState | undefined;
    for (const [id, p] of v.players) {
      if (p === v.me) {
        me = Object.assign(copyPlayer(p), {
          rack: rackClone(v.me.rack),
          startRack: rackClone(v.me.startRack),
        });
        players.set(id, me);
      } else {
        const c = copyPlayer(p);
        players.set(id, c);
        opponents.push(c);
      }
    }
    return {
      config,
      me: me!,
      players,
      opponents,
      history: v.history.map((o) => ({ ...o })),
      words: v.words.map((w) => ({ ...w })),
      auctionsDone: v.auctionsDone,
      auctionsRemaining: v.auctionsRemaining,
      unseen: rackClone(v.unseen),
      current: v.current ? { ...v.current } : undefined,
    };
  }

  private removeUnseen(i: number, n: number): void {
    const raw = this.unseenRaw[i]! - n;
    this.unseenRaw[i] = raw;
    if (raw < 0) {
      this.diagnostics.unseenNegative++;
      this.v.unseen[i] = 0;
    } else this.v.unseen[i] = raw;
  }
}
