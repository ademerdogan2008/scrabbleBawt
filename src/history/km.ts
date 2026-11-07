// Reverse Kaplan-Meier estimate of a bidder's bid distribution from sealed-bid auction outcomes
// (HISTORICAL.md §E2; port of scratchpad hist_tools/km.mjs).
//
// Observations [value, exact]:
//   exact = true : the bidder WON; value = its bid (the archived top bid)
//   exact = false: the bidder LOST; only bid <= value is known (value = the winner's top bid, or 0
//                  when nobody bid). The winner's top bid is the max of the OTHER bids, independent
//                  of this bidder's bid, so this is standard left-censoring: KM on t = -bid.
// Ties: an exact observation needs bid > field, or bid == field with the tie won (the server breaks
// ties uniformly at random). A loss censored at value c with bid == c is therefore only partly "at
// risk" of being observed at c. `tieWeight` is the weight of observations censored exactly at x in
// the risk set at x: 1 = textbook KM (ties counted at risk; biases P(bid >= x) low by ~0.02-0.05
// on synthetic data), 0 = ties always lost, 0.5 = coin-flip ties (default; matches the server for
// 2-way ties and recovers synthetic coin-tie data within ~0.01).
// Caveat: mass below ~3-5 is not identified (rivals rarely bid that low), so pNoBid and the low
// quantiles are biased toward 0. Use the upper tail.

export const DEFAULT_TIE_WEIGHT = 0.5;

export interface KmCurve {
  n: number;
  nExact: number;
  /** 1 - P(bid >= 1). */
  pNoBid: number;
  q50: number;
  q75: number;
  q90: number;
  /** P(bid >= x) for x = 1..maxX (non-increasing). */
  pGe: number[];
}

/** Accumulates observations as integer histograms (memory O(max value)). */
export class KmAccumulator {
  private all: number[] = [];
  private ex: number[] = [];
  n = 0;
  nExact = 0;

  add(value: number, exact: boolean): void {
    const v = Math.max(0, Math.floor(value));
    this.all[v] = (this.all[v] ?? 0) + 1;
    if (exact) this.ex[v] = (this.ex[v] ?? 0) + 1;
    this.n++;
    if (exact) this.nExact++;
  }

  /** Estimate; `digits` rounds probabilities (rounding preserves monotonicity). */
  curve(maxX = 60, digits = 4, tieWeight = DEFAULT_TIE_WEIGHT): KmCurve {
    return reverseKM(this.all, this.ex, this.n, this.nExact, maxX, digits, tieWeight);
  }
}

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Core estimator over histograms all[v] (all observations at v) and ex[v] (exact ones). */
export function reverseKM(
  all: readonly (number | undefined)[],
  ex: readonly (number | undefined)[],
  n: number,
  nExact: number,
  maxX = 60,
  digits = 4,
  tieWeight = DEFAULT_TIE_WEIGHT,
): KmCurve {
  const maxV = Math.max(0, all.length - 1);
  // cum[v] = # observations with value <= v
  const cum = new Float64Array(maxV + 2);
  let c = 0;
  for (let v = 0; v <= maxV + 1; v++) {
    c += all[v] ?? 0;
    cum[v] = c;
  }
  // P(bid < x) = prod over exact values x_i >= x of (1 - d_i / n_i)
  const pLt = new Float64Array(maxV + 2);
  let prod = 1;
  pLt[maxV + 1] = 1;
  for (let x = maxV; x >= 1; x--) {
    const d = ex[x] ?? 0;
    if (d > 0) {
      // risk set: every observation with value < x, the exact ones at x, and tieWeight x the
      // censored ones at x
      const censAtX = (all[x] ?? 0) - d;
      prod *= 1 - d / (cum[x - 1]! + d + tieWeight * censAtX);
    }
    pLt[x] = prod;
  }
  const pGeAt = (x: number): number => (x <= 0 ? 1 : x > maxV ? 0 : 1 - pLt[x]!);
  const quant = (p: number): number => {
    // smallest x >= 0 with P(bid <= x) >= p, where P(bid <= x) = 1 - P(bid >= x + 1)
    for (let x = 0; x <= maxV; x++) if (1 - pGeAt(x + 1) >= p - 1e-12) return x;
    return maxV;
  };
  const pGe: number[] = [];
  for (let x = 1; x <= maxX; x++) pGe.push(round(Math.max(0, Math.min(1, pGeAt(x))), digits));
  for (let i = 1; i < pGe.length; i++) if (pGe[i]! > pGe[i - 1]!) pGe[i] = pGe[i - 1]!; // float safety
  return {
    n,
    nExact,
    pNoBid: round(1 - pGeAt(1), digits),
    q50: quant(0.5),
    q75: quant(0.75),
    q90: quant(0.9),
    pGe,
  };
}

/** Convenience: estimate from a list of [value, exact] observations. */
export function reverseKMFromObs(
  obs: ReadonlyArray<readonly [number, boolean]>,
  maxX = 60,
  digits = 4,
  tieWeight = DEFAULT_TIE_WEIGHT,
): KmCurve {
  const acc = new KmAccumulator();
  for (const [v, e] of obs) acc.add(v, e);
  return acc.curve(maxX, digits, tieWeight);
}
