// Binding interfaces shared by the simulator, the live client and every bot.
// See .planning/research/ARCHITECTURE.md. Changing these requires an orchestrator decision.
import type { Rack } from './rack.js';
import type { Rng } from './rng.js';

export type PlayerId = number; // bot_id (u64 on the server; < 2^53 in practice)
export type AuctionType = 'Vickrey' | 'FirstPrice';
export type SimStrategy = 'Cheapskate' | 'ValueBidder' | 'Aggressive' | 'Human';

export interface PlayerInfo {
  id: PlayerId;
  name: string;
  isSim: boolean;
  simStrategy?: SimStrategy; // only when isSim
}

/** What the match counts for (RULES.md §11): objectives differ by kind. */
export type MatchKind = 'lobby' | 'swiss' | 'bracket' | 'final' | 'unknown';

export interface MatchConfig {
  matchId: number;
  kind?: MatchKind; // default 'lobby'; tournament phase when known
  auctionType: AuctionType;
  auctionDurationMs: number; // default 1000 (range 250..10000)
  startingRackSize: number; // default 5 (range 0..20)
  startingBalance: number; // 100
  players: PlayerInfo[]; // match_participant order
  myId: PlayerId;
  totalAuctions: number; // 98 - startingRackSize * players.length
}

export interface AuctionInfo {
  auctionId: number;
  index: number; // 0-based (= match_state.current_round - 1)
  letter: string; // 'A'..'Z'
  opensAtMs: number; // server clock
  closesAtMs: number; // server clock
  remainingAfter: number; // match_state.bag_total while open; 0 => LAST auction (letter unusable)
}

export interface AuctionOutcome {
  auctionId: number;
  index: number;
  letter: string;
  winnerId: PlayerId | null;
  paid: number;
}

export interface WordPlayEvent {
  playerId: PlayerId;
  word: string;
  reward: number;
  auctionIndex: number; // index of the auction that was open when the word was played
}

export interface Decision {
  words: string[]; // submitted in order BEFORE the bid; each playable sequentially from the rack
  bid: number; // integer >= 0 (0 = no bid); <= balance after the words' rewards
}

export interface DecideContext {
  budgetMs: number; // compute budget for this call
  rng: Rng; // per-seat seeded stream
  now(): number; // monotonic ms clock for budget checks
  netRttMs?: number; // live: measured reducer round-trip p90 (sim: simulated); lets policies flush earlier when slow
}

export interface PlayerState {
  info: PlayerInfo;
  balance: number;
  score: number;
  won: Rack; // letters won at auction (cumulative)
  played: Rack; // letters used in this player's words (cumulative)
  revealedHidden: Rack; // letters proven to come from hidden starting tiles (played beyond won)
  knownHeld: Rack; // won + revealedHidden - played (lower bound on current rack)
  hiddenUnknown: number; // startingRackSize - total(revealedHidden)
  lettersWon: number;
  totalPaid: number;
  words: WordPlayEvent[];
}

export interface MyState extends PlayerState {
  rack: Rack; // exact current rack
  startRack: Rack; // exact starting tiles
}

export interface MatchView {
  readonly config: MatchConfig;
  readonly me: MyState;
  readonly players: ReadonlyMap<PlayerId, PlayerState>;
  readonly opponents: readonly PlayerState[];
  readonly history: readonly AuctionOutcome[];
  readonly words: readonly WordPlayEvent[];
  readonly auctionsDone: number; // closed auctions
  readonly auctionsRemaining: number; // including the open one
  readonly unseen: Rack; // BAG - my start - auctioned letters (incl. open) - Σ opp revealedHidden
  readonly current: AuctionInfo | undefined;
}

export interface Policy {
  readonly name: string;
  onMatchStart(view: MatchView): void;
  decide(view: MatchView, auction: AuctionInfo, ctx: DecideContext): Decision;
  onAuctionClosed?(view: MatchView, outcome: AuctionOutcome): void;
  onMatchEnd?(view: MatchView): void;
  /**
   * SIMULATOR-ONLY threat modelling: seats flagged `oracle` receive every player's true rack before
   * each decide(), emulating rivals that reconstruct hidden deals via the server RNG flaw.
   * Our own bot never implements this (fair-play decision in PROJECT.md).
   */
  onOracle?(trueRacks: ReadonlyMap<PlayerId, Rack>): void;
}

export type PolicyFactory = (seed: number, opts?: Record<string, unknown>) => Policy;
