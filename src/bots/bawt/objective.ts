// Rank / tournament-aware objective (STRATEGY §6, RULES §11, COMPETITORS K-13 place.ts).
//
// Ratings and Swiss points are roughly linear in place, so the lobby objective is expected
// placement = Σ_rivals P(our score > rival score). A letter denied to rival o is worth
// w_o·V_o(L) to us, with w_o = base(#real seats) · φ(z_o) where z_o is the projected equity gap
// over its sd (σ = sqrt(4² + 40²·remaining share)). Base weights by real seats (§6.2):
// heads-up 1.0, 3 real 0.4, 4 real 0.2, 5+ none (denial loses in big fields).
//   lobby / swiss / unknown: as above.
//   bracket: only last place is eliminated: weight the rivals adjacent to the bottom when we are
//            in the bottom two, none otherwise (play for safety, not for rank).
//   final: two seats, three-game score sum: zero-sum, full weight on the single rival (§6.3).
// Equity = score + latent rack value (known held letters at ~2.5 points per tile above face,
// unrevealed start tiles at 5.7) + a small balance term; sims never threaten rank and get 0.
import { NUM_LETTERS, VALUE } from '../../core/letters.js';
import type { MatchKind, MatchView, PlayerId, PlayerState } from '../../core/types.js';

export function equityOf(p: PlayerState, lambda: number): number {
  let held = 0;
  for (let i = 0; i < NUM_LETTERS; i++) held += p.knownHeld[i]! * (VALUE[i]! + 2.5);
  return p.score + held + 5.7 * p.hiddenUnknown + 0.3 * lambda * p.balance;
}

export function myEquity(view: MatchView, lambda: number): number {
  const me = view.me;
  let held = 0;
  for (let i = 0; i < NUM_LETTERS; i++) held += me.rack[i]! * (VALUE[i]! + 2.5);
  return me.score + held + 0.3 * lambda * me.balance;
}

export interface RivalWeight {
  id: PlayerId;
  weight: number;
}

export function denialWeights(
  view: MatchView,
  baseByReal: Record<string, number>,
  lambda: number,
  remainingShare: number,
): RivalWeight[] {
  const kind: MatchKind = view.config.kind ?? 'lobby';
  const reals = view.opponents.filter((p) => !p.info.isSim);
  const nReal = reals.length + 1;
  if (kind === 'final' && reals.length === 1) return [{ id: reals[0]!.info.id, weight: baseByReal['2'] ?? 1 }];
  const base = baseByReal[String(nReal)] ?? 0;
  if (base <= 0 || reals.length === 0) return [];
  const sigma = Math.sqrt(16 + 1600 * Math.max(0, remainingShare));
  const mine = myEquity(view, lambda);
  const eq = reals.map((p) => ({ p, e: equityOf(p, lambda) }));
  if (kind === 'bracket') {
    const below = eq.filter((x) => x.e < mine).length;
    if (below >= 2) return [];
  }
  return eq.map(({ p, e }) => {
    const z = (mine - e) / sigma;
    return { id: p.info.id, weight: base * Math.exp(-(z * z) / 2) };
  });
}
