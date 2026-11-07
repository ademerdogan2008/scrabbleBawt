// Small statistics helpers for the history tools (profiles, replay reports).
// Wilson CI is implemented locally because 02-01's src/sim/stats.ts is built in a parallel
// worktree; consolidate the two after the merge.

export interface Interval {
  p: number;
  lo: number;
  hi: number;
}

/** Wilson score interval for k successes out of n (z = 1.96 -> 95%). n = 0 gives [0, 1]. */
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (n <= 0) return { p: 0, lo: 0, hi: 1 };
  if (k < 0 || k > n) throw new Error(`wilson: k=${k} outside 0..${n}`);
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export function mean(xs: ArrayLike<number>): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (let i = 0; i < xs.length; i++) s += xs[i]!;
  return s / xs.length;
}

/** Mean with a normal-approximation 95% CI half-width (sample sd / sqrt(n) * 1.96). */
export function meanCI(xs: ArrayLike<number>, z = 1.96): { mean: number; half: number; n: number } {
  const n = xs.length;
  if (n === 0) return { mean: NaN, half: NaN, n };
  const m = mean(xs);
  if (n === 1) return { mean: m, half: NaN, n };
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (xs[i]! - m) ** 2;
  return { mean: m, half: (z * Math.sqrt(ss / (n - 1))) / Math.sqrt(n), n };
}

/** Linear-interpolated quantiles (type 7). Empty input gives NaN for every q. */
export function quantiles(xs: ArrayLike<number>, qs: readonly number[]): number[] {
  if (xs.length === 0) return qs.map(() => NaN);
  const s = Float64Array.from(xs as ArrayLike<number>).sort();
  return qs.map((q) => {
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
  });
}

export function median(xs: ArrayLike<number>): number {
  return quantiles(xs, [0.5])[0]!;
}

/** Round to `d` decimals; non-finite values become null (JSON-safe). */
export function rnd(x: number, d = 3): number | null {
  if (!Number.isFinite(x)) return null;
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export interface OlsFit {
  beta: number[];
  r2: number;
  rmse: number;
  n: number;
}

/** Ordinary least squares via normal equations with partial pivoting (small k). */
export function ols(X: readonly (readonly number[])[], y: readonly number[]): OlsFit {
  const n = X.length;
  if (n === 0) return { beta: [], r2: NaN, rmse: NaN, n: 0 };
  const k = X[0]!.length;
  const A = Array.from({ length: k }, () => new Float64Array(k));
  const b = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const xi = X[i]!;
    for (let p = 0; p < k; p++) {
      b[p]! += xi[p]! * y[i]!;
      for (let q = 0; q < k; q++) A[p]![q]! += xi[p]! * xi[q]!;
    }
  }
  const beta = solve(A, b);
  let ssr = 0;
  let sst = 0;
  const ym = mean(y);
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let p = 0; p < k; p++) pred += X[i]![p]! * beta[p]!;
    ssr += (y[i]! - pred) ** 2;
    sst += (y[i]! - ym) ** 2;
  }
  return { beta, r2: sst > 0 ? 1 - ssr / sst : NaN, rmse: Math.sqrt(ssr / n), n };
}

function solve(A0: Float64Array[], b0: Float64Array): number[] {
  const k = b0.length;
  const A = A0.map((r) => Float64Array.from(r));
  const b = Float64Array.from(b0);
  for (let i = 0; i < k; i++) A[i]![i]! += 1e-9; // ridge epsilon for stability
  for (let c = 0; c < k; c++) {
    let piv = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[piv]![c]!)) piv = r;
    [A[c], A[piv]] = [A[piv]!, A[c]!];
    [b[c], b[piv]] = [b[piv]!, b[c]!];
    const d = A[c]![c]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r]![c]! / d;
      if (f === 0) continue;
      for (let q = c; q < k; q++) A[r]![q]! -= f * A[c]![q]!;
      b[r]! -= f * b[c]!;
    }
  }
  return Array.from(b, (v, i) => (Math.abs(A[i]![i]!) < 1e-12 ? 0 : v / A[i]![i]!));
}
