// Budget pacing (STRATEGY §3.3, §11; K-13 λ in COMPETITORS §3.1).
//
// κ = 1/λ converts points to coins: bid_ℓ(κ) = max(⌊V_ℓ·κ⌋, floor_ℓ). For a grid of κ the clearing-price
// model predicts the spend over the remaining useful auctions,
//   S(κ) = Σ_ℓ n_ℓ · E[pay_ℓ(bid_ℓ(κ))],   n_ℓ = futureUseful · unseen_ℓ / |unseen|,
// and the income that comes back as word rewards, I(κ) = incomeShare · Σ_ℓ n_ℓ · P(win_ℓ) · V_ℓ.
// κ is the largest value in [κ_lo, κ_hi] with S(κ) - I(κ) <= balance - reserve (bisection on log κ).
// Against sims the spend at any κ is bounded by their cheap prices, so κ runs to κ_hi ("buy
// everything"); against strong bidders spend explodes as κ grows, so κ stays near 0.6-1.
import { NUM_LETTERS } from '../../core/letters.js';
import type { AuctionType } from '../../core/types.js';
import { expectedPay, winProb } from './opponents.js';

export interface PacingInput {
  /** Point value per letter (rack-adjusted table). */
  values: Float64Array;
  /** Floor bid per letter in coins (0 = none). */
  floors: Float64Array;
  /** Expected number of future useful auctions per letter. */
  counts: Float64Array;
  /** Field max-bid CDF per letter (future phase). */
  fieldCdf: readonly Float64Array[];
  balance: number;
  reserve: number;
  incomeShare: number;
  auctionType: AuctionType;
  kappaLo: number;
  kappaHi: number;
}

export interface PacingResult {
  kappa: number;
  /** Predicted spend and income at κ. */
  spend: number;
  income: number;
  /** Expected number of future wins at κ and share of future auctions. */
  wins: number;
  share: number;
  /** Win probability per letter at κ (future phase). */
  pWin: Float64Array;
}

export function bidAt(values: Float64Array, floors: Float64Array, l: number, kappa: number, balance: number): number {
  return Math.max(0, Math.min(Math.floor(balance), Math.max(Math.floor(values[l]! * kappa), floors[l]!)));
}

/** Spend, income and wins at κ. */
export function evaluateKappa(inp: PacingInput, kappa: number, pWinOut?: Float64Array): Omit<PacingResult, 'kappa' | 'pWin'> {
  let spend = 0;
  let income = 0;
  let wins = 0;
  let total = 0;
  for (let l = 0; l < NUM_LETTERS; l++) {
    const n = inp.counts[l]!;
    total += n;
    const b = bidAt(inp.values, inp.floors, l, kappa, inp.balance);
    const G = inp.fieldCdf[l]!;
    const pw = winProb(G, b);
    if (pWinOut) pWinOut[l] = pw;
    if (n <= 0) continue;
    spend += n * expectedPay(G, b, inp.auctionType);
    income += n * pw * inp.values[l]!;
    wins += n * pw;
  }
  return { spend, income: inp.incomeShare * income, wins, share: total > 0 ? wins / total : 0 };
}

export function solveKappa(inp: PacingInput): PacingResult {
  const budget = inp.balance - inp.reserve;
  const ok = (k: number) => {
    const e = evaluateKappa(inp, k);
    return e.spend - e.income <= budget;
  };
  let kappa: number;
  if (ok(inp.kappaHi)) kappa = inp.kappaHi;
  else if (!ok(inp.kappaLo)) kappa = inp.kappaLo;
  else {
    let lo = Math.log(inp.kappaLo);
    let hi = Math.log(inp.kappaHi);
    for (let it = 0; it < 18; it++) {
      const mid = (lo + hi) / 2;
      if (ok(Math.exp(mid))) lo = mid;
      else hi = mid;
    }
    kappa = Math.exp(lo);
  }
  const pWin = new Float64Array(NUM_LETTERS);
  const e = evaluateKappa(inp, kappa, pWin);
  return { kappa, ...e, pWin };
}
