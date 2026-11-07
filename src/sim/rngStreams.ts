// Randomness and iteration-order models injected into the match core (src/sim/match.ts).
//
// The simulator (runMatch) uses INDEPENDENT seeded streams so that the deal and the letter
// sequence depend only on the seed, never on what the policies decide (perfect pairing for
// low-variance A/B comparisons). The host-parity replay (src/sim/hostReplay.ts, test-only) plugs
// in the server's timestamp-seeded RNG and its datastore iteration order instead, driving the
// SAME step functions.
import { SIM_BID_JITTER } from '../core/letters.js';
import { Rng, hashSeed } from '../core/rng.js';

/** Transaction boundary notification (host model: each transaction re-seeds the RNG). */
export type TxBoundary = { kind: 'start' } | { kind: 'close'; index: number };

/**
 * Every random choice the server makes, in the order the module makes them:
 *   start tx: deal (rack per seat in roster order), first draw, sim jitters
 *   close tx: tie shuffle, (sim word: no RNG), next draw, sim jitters
 * Each method returns a uniform integer like the module's integerInRange.
 */
export interface MatchRngSource {
  /** Called at the start of the match-start transaction and of each close transaction. */
  beginTx?(tx: TxBoundary): void;
  /** Deal draw: uniform integer in [0, bagTotal - 1]. */
  deal(bagTotal: number): number;
  /** Auction letter draw: uniform integer in [0, bagTotal - 1]. */
  draw(bagTotal: number): number;
  /** Sim bid jitter for the sim at roster position `seat`: uniform integer in [-2, 2]. */
  simJitter(seat: number): number;
  /** Tie-break shuffle step for auction `index`: uniform integer in [0, i]. */
  tieShuffle(i: number, index: number): number;
}

/**
 * Pre-shuffle ordering model (RULES.md §4.3). Decides which order the sims are iterated in at
 * each auction open (who receives which jitter) and the order of positive bids handed to the
 * tie-break shuffle.
 */
export interface BidOrderModel {
  /** Called once at match start with the number of seats (roster order 0..n-1). */
  reset(seatCount: number): void;
  /** Participant iteration order (seat positions) for simulateBids at the current open. */
  participantOrder(): readonly number[];
  /** The participant row of `seat` was updated by a close transaction (winner paid). */
  onCloseUpdated(seat: number | null): void;
  /** The close transaction committed. */
  onCloseCommit(): void;
  /** A real (policy) seat committed a word transaction. */
  onWord(seat: number): void;
}

/** Positive bid as stored in pending_bid (placement order = insertion order). */
export interface PendingBid {
  seat: number;
  amount: number;
}

/** runMatch default: sims iterate in seat order; bids = sims (seat order) then policies (seat order). */
export class SeatOrderModel implements BidOrderModel {
  private order: number[] = [];
  reset(seatCount: number): void {
    this.order = Array.from({ length: seatCount }, (_, k) => k);
  }
  participantOrder(): readonly number[] {
    return this.order;
  }
  onCloseUpdated(): void {}
  onCloseCommit(): void {}
  onWord(): void {}
}

/**
 * Independent seeded streams for runMatch:
 *   bag  = deal + letter draws (depends only on the seed: same letters for every policy)
 *   sim  = one jitter per sim per open, always consumed (even when the sim is broke)
 *   tie  = per-auction stream for the tie-break shuffle (decisions in one auction never shift
 *          the tie-breaks of another)
 */
export class IndependentStreams implements MatchRngSource {
  private readonly bag: Rng;
  private readonly sim: Rng;
  private readonly seed: number;
  private tieIndex = -1;
  private tie: Rng | undefined;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.bag = new Rng(hashSeed(this.seed, 'bag'));
    this.sim = new Rng(hashSeed(this.seed, 'sim'));
  }

  deal(bagTotal: number): number {
    return this.bag.int(0, bagTotal - 1);
  }

  draw(bagTotal: number): number {
    return this.bag.int(0, bagTotal - 1);
  }

  simJitter(): number {
    return this.sim.int(-SIM_BID_JITTER, SIM_BID_JITTER);
  }

  tieShuffle(i: number, index: number): number {
    if (index !== this.tieIndex || !this.tie) {
      this.tieIndex = index;
      this.tie = new Rng(hashSeed(this.seed, 'tie', index));
    }
    return this.tie.int(0, i);
  }
}

/** Per-policy-seat decision stream (DecideContext.rng). */
export function seatRng(seed: number, seatIndex: number): Rng {
  return new Rng(hashSeed(seed >>> 0, 'seat', seatIndex));
}
