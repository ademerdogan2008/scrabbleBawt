// Match reward from the final standings: reward = (players - rank) / (players - 1) in [0, 1],
// rank 1 = best, tied players share the average of the ranks they span (two players tied for
// first in a 4-seat match both get rank 1.5 -> reward 5/6).
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
export function rewardOf(rank: number, players: number): number {
  if (players <= 1) return 1;
  return Math.max(0, Math.min(1, (players - rank) / (players - 1)));
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
