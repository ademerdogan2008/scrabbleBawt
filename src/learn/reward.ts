// Match reward from the final standings, win-first: 1st = 1, 2nd = 0.35, 3rd = 0.1, worse = 0
// (last place always 0). Rank 1 = best; tied players share the average of the ranks they span
// and the reward interpolates (two players tied for first get rank 1.5 -> 0.675).
import type { MatchView, PlayerId } from '../core/types.js';

/** Average (fractional) rank of `myScore` among `scores` (which include my own score once). */
export function rankOf(scores: readonly number[], myScore: number): number {
  let higher = 0;
  let equal = 0;
  for (const s of scores) {
    if (s > myScore) higher++;
    else if (s === myScore) equal++;
  }
  // ranks higher+1 .. higher+equal, averaged
  return higher + (Math.max(1, equal) + 1) / 2;
}

/** (players - rank) / (players - 1); 1 for a solo match. */
/** Win-first place values (user goal: wins, rank as tiebreak): 1st 1, 2nd 0.35, 3rd 0.1, else 0.
 *  Last place is always 0 (heads-up: 1 / 0). */
export const PLACE_REWARD: readonly number[] = Object.freeze([1, 0.35, 0.1]);

function placeValue(place: number, players: number): number {
  if (place >= players) return 0;
  return PLACE_REWARD[place - 1] ?? 0;
}

export function rewardOf(rank: number, players: number): number {
  if (players <= 1) return 1;
  const r = Math.max(1, Math.min(players, rank));
  const lo = Math.floor(r);
  const hi = Math.ceil(r);
  // shared places (fractional rank): interpolate between the spanned integer places
  const v = lo === hi ? placeValue(lo, players) : placeValue(lo, players) + (r - lo) * (placeValue(hi, players) - placeValue(lo, players));
  return Math.max(0, Math.min(1, v));
}

export interface Standing {
  players: number;
  realPlayers: number;
  rank: number;
  score: number;
  bestOtherScore: number;
  /** Strictly the best score (a shared first place is not a win here). */
  won: boolean;
  reward: number;
}

export function standingFromScores(
  scores: ReadonlyMap<PlayerId, number>,
  myId: PlayerId,
  realPlayers: number,
): Standing {
  const all = [...scores.values()];
  const score = scores.get(myId) ?? 0;
  let bestOther = -Infinity;
  for (const [id, s] of scores) if (id !== myId && s > bestOther) bestOther = s;
  const players = all.length;
  const rank = rankOf(all, score);
  return {
    players,
    realPlayers,
    rank,
    score,
    bestOtherScore: bestOther === -Infinity ? 0 : bestOther,
    won: players <= 1 || score > bestOther,
    reward: rewardOf(rank, players),
  };
}

/** Standing of the viewer in a (final) MatchView. */
export function standingFromView(view: MatchView): Standing {
  const scores = new Map<PlayerId, number>();
  let real = 0;
  for (const info of view.config.players) {
    scores.set(info.id, view.players.get(info.id)?.score ?? 0);
    if (!info.isSim) real++;
  }
  return standingFromScores(scores, view.config.myId, real);
}
