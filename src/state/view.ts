// Pure helpers over a MatchView. The view interfaces themselves live in src/core/types.ts
// (avoids a core -> state import cycle) and are re-exported here for convenience.
import { NUM_LETTERS } from '../core/letters.js';
import { rackTotal } from '../core/rack.js';
import type { AuctionInfo, MatchView, PlayerId, PlayerState } from '../core/types.js';

export type { MatchView, MyState, PlayerState } from '../core/types.js';

/** True for the final auction (remainingAfter === 0): its letter can no longer be played. */
export function isLastAuction(auction: AuctionInfo): boolean {
  return auction.remainingAfter === 0;
}

export function opponentById(view: MatchView, id: PlayerId): PlayerState | undefined {
  if (id === view.config.myId) return undefined;
  return view.players.get(id);
}

/**
 * Player with the highest score; ties go to the earliest player in config (match_participant)
 * order, so the result is deterministic.
 */
export function leader(view: MatchView): PlayerState {
  let best: PlayerState | undefined;
  for (const info of view.config.players) {
    const p = view.players.get(info.id)!;
    if (!best || p.score > best.score) best = p;
  }
  return best!;
}

/**
 * Best score among the other players minus `id`'s score (default: me).
 * Positive = behind the leader, negative = leading by that margin, 0 = tied (or solo).
 */
export function scoreGapToLeader(view: MatchView, id: PlayerId = view.config.myId): number {
  const self = view.players.get(id);
  if (!self) throw new Error(`scoreGapToLeader: unknown player ${id}`);
  let best = -Infinity;
  for (const [pid, p] of view.players) if (pid !== id && p.score > best) best = p.score;
  return best === -Infinity ? 0 : best - self.score;
}

/** Highest opponent balance (0 with no opponents): caps what any rival can bid. */
export function maxOpponentBalance(view: MatchView): number {
  let m = 0;
  for (const p of view.opponents) if (p.balance > m) m = p.balance;
  return m;
}

/** Exact current rack size of any player: startingRackSize + lettersWon - letters played. */
export function rackSizeOf(view: MatchView, p: PlayerState): number {
  return view.config.startingRackSize + p.lettersWon - rackTotal(p.played);
}

/**
 * Letters still in the bag. While an auction is open this is its remainingAfter
 * (server bag_total, excluding the open letter); otherwise totalAuctions - auctionsDone.
 */
export function bagRemaining(view: MatchView): number {
  return view.current ? view.current.remainingAfter : view.config.totalAuctions - view.auctionsDone;
}

/** Σ over opponents of hiddenUnknown: unrevealed starting tiles still held by rivals. */
export function opponentsHiddenUnknown(view: MatchView): number {
  let s = 0;
  for (const p of view.opponents) s += p.hiddenUnknown;
  return s;
}

/**
 * Both sides of the tracker invariant total(unseen) == bagRemaining + Σ_opp hiddenUnknown.
 * They are equal for every consistent event stream.
 */
export function unseenBalance(view: MatchView): { unseen: number; expected: number; ok: boolean } {
  let unseen = 0;
  for (let i = 0; i < NUM_LETTERS; i++) unseen += view.unseen[i]!;
  const expected = bagRemaining(view) + opponentsHiddenUnknown(view);
  return { unseen, expected, ok: unseen === expected };
}
