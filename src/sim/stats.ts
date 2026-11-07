// Statistics for tournaments and paired comparisons: Wilson intervals, Student-t intervals,
// paired t and sign tests, chi-square p-values, and the module's OpenSkill Plackett-Luce rating
// (port of spacetimedb/src/ratings.ts: BETA^2 = (25/6)^2, KAPPA = 1e-4, ties share a place).
// All functions are pure and deterministic.

// ------------------------------------------------------------------------- special functions

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/** ln Γ(x) for x > 0 (Lanczos, g = 7). */
export function lgamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < 8; i++) a += LANCZOS[i]! / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(a: number, b: number, x: number): number {
  const EPS = 1e-15;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Student-t CDF. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t);
  const tail = 0.5 * betaInc(x, df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

/** Student-t quantile (bisection on the CDF; |error| < 1e-12). */
export function tQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) throw new Error(`tQuantile: p must be in (0,1), got ${p}`);
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0;
  let hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 10000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
  }
  return 1 - gammaQcf(a, x);
}

function gammaQcf(a: number, x: number): number {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
}

/** Upper tail P(X >= stat) of a chi-square distribution with `df` degrees of freedom. */
export function chiSquareP(stat: number, df: number): number {
  if (df <= 0) return 1;
  if (stat <= 0) return 1;
  return stat < df / 2 + 1 ? 1 - gammaP(df / 2, stat / 2) : gammaQcf(df / 2, stat / 2);
}

// ------------------------------------------------------------------------------- estimators

export interface Interval {
  lo: number;
  hi: number;
}

/** Wilson score interval for k successes in n trials (default 95%). */
export function wilson(k: number, n: number, z = 1.959963984540054): Interval & { p: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

export interface MeanCI extends Interval {
  n: number;
  mean: number;
  sd: number;
  se: number;
}

/** Mean with a Student-t confidence interval (default 95%). */
export function meanCI(xs: readonly number[], level = 0.95): MeanCI {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, sd: 0, se: 0, lo: 0, hi: 0 };
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / n;
  if (n === 1) return { n, mean, sd: 0, se: 0, lo: mean, hi: mean };
  let ss = 0;
  for (const x of xs) ss += (x - mean) * (x - mean);
  const sd = Math.sqrt(ss / (n - 1));
  const se = sd / Math.sqrt(n);
  const t = tQuantile(1 - (1 - level) / 2, n - 1);
  return { n, mean, sd, se, lo: mean - t * se, hi: mean + t * se };
}

export interface PairedTest extends MeanCI {
  t: number;
  /** Two-sided p-value of H0: mean delta = 0. */
  p: number;
}

/** Paired t test on per-pair deltas (A - B). */
export function pairedT(deltas: readonly number[], level = 0.95): PairedTest {
  const ci = meanCI(deltas, level);
  if (ci.n < 2 || ci.se === 0) return { ...ci, t: 0, p: ci.mean === 0 || ci.n < 2 ? 1 : 0 };
  const t = ci.mean / ci.se;
  const p = 2 * (1 - tCdf(Math.abs(t), ci.n - 1));
  return { ...ci, t, p: Math.min(1, Math.max(0, p)) };
}

export interface SignTest {
  pos: number;
  neg: number;
  ties: number;
  /** Exact two-sided binomial p-value (ties dropped). */
  p: number;
}

export function signTest(deltas: readonly number[]): SignTest {
  let pos = 0;
  let neg = 0;
  let ties = 0;
  for (const d of deltas) {
    if (d > 0) pos++;
    else if (d < 0) neg++;
    else ties++;
  }
  const n = pos + neg;
  if (n === 0) return { pos, neg, ties, p: 1 };
  const k = Math.min(pos, neg);
  const lnHalfN = n * Math.log(0.5);
  const lnN = lgamma(n + 1);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(lnN - lgamma(i + 1) - lgamma(n - i + 1) + lnHalfN);
  return { pos, neg, ties, p: Math.min(1, 2 * tail) };
}

// ------------------------------------------------------------------------- OpenSkill (PL)

export interface Rating {
  mu: number;
  sigma: number;
}

export const OPENSKILL_MU = 25;
export const OPENSKILL_SIGMA = 25 / 3;
const BETA_SQ = (25 / 6) ** 2;
const KAPPA = 0.0001;

/**
 * One free-for-all match under Plackett-Luce (Weng & Lin 2011 alg. 4), each player a team of
 * one; `place` 0 = first, tied players share the better place. Port of module plackettLuce.
 */
export function plackettLuce(players: ReadonlyArray<Rating & { place: number }>): Rating[] {
  const c = Math.sqrt(players.reduce((sum, p) => sum + p.sigma * p.sigma + BETA_SQ, 0));
  const strength = players.map((p) => Math.exp(p.mu / c));
  const field = players.map((q) => players.reduce((sum, p, i) => (p.place >= q.place ? sum + strength[i]! : sum), 0));
  const tied = players.map((q) => players.filter((p) => p.place === q.place).length);
  return players.map((p, i) => {
    let omega = 0;
    let delta = 0;
    players.forEach((q, j) => {
      if (q.place > p.place) return;
      const share = strength[i]! / field[j]!;
      omega += (i === j ? 1 - share : -share) / tied[j]!;
      delta += (share * (1 - share)) / tied[j]!;
    });
    const sigmaSq = p.sigma * p.sigma;
    const gamma = p.sigma / c;
    return {
      mu: p.mu + omega * (sigmaSq / c),
      sigma: p.sigma * Math.sqrt(Math.max(1 - gamma * delta * (sigmaSq / (c * c)), KAPPA)),
    };
  });
}

/** Leaderboard display rating (src/rating.ts in the module web app). */
export function openSkillDisplay(mu: number): number {
  return Math.round(1500 + 29.4809 * (mu - 25));
}

// ------------------------------------------------------------------------------ summarize

/** One seat of one finished match, as aggregated by the tournament runner. */
export interface SeatRecord {
  label: string;
  score: number;
  rank: number;
  win: boolean;
  lettersWon: number;
  totalPaid: number;
  wordsPlayed: number;
  unplayedTiles: number;
  unplayedValue: number;
  rejectedWords: number;
  rejectedBids: number;
  voidedDecisions: number;
}

export interface MatchRecord {
  seed: number;
  seats: SeatRecord[];
}

export interface LabelStats {
  label: string;
  n: number;
  wins: number;
  winRate: number;
  winCI: Interval;
  avgRank: number;
  rankCI: Interval;
  avgScore: number;
  scoreCI: Interval;
  /** Mean of (own score - best other score). */
  avgMargin: number;
  marginCI: Interval;
  avgLettersWon: number;
  avgPaidPerLetter: number;
  avgWords: number;
  avgUnplayedTiles: number;
  avgUnplayedValue: number;
  rejectedWords: number;
  rejectedBids: number;
  voidedDecisions: number;
  openskill: { mu: number; sigma: number; display: number };
}

const round = (x: number, d = 4): number => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
const iv = (lo: number, hi: number): Interval => ({ lo: round(lo), hi: round(hi) });

/**
 * Aggregate matches (must be in seed order) into per-label stats. OpenSkill PL runs
 * sequentially over the matches in that order, starting every label at (25, 25/3).
 * Output follows `labelOrder` (labels not listed follow in order of first appearance).
 */
export function summarize(matches: readonly MatchRecord[], labelOrder: readonly string[] = []): LabelStats[] {
  const labels: string[] = [];
  const acc = new Map<
    string,
    {
      wins: number;
      ranks: number[];
      scores: number[];
      margins: number[];
      letters: number;
      paid: number;
      words: number;
      unplayed: number;
      unplayedValue: number;
      rw: number;
      rb: number;
      vd: number;
    }
  >();
  const ratings = new Map<string, Rating>();
  for (const m of matches) {
    for (const s of m.seats) {
      let a = acc.get(s.label);
      if (!a) {
        labels.push(s.label);
        a = { wins: 0, ranks: [], scores: [], margins: [], letters: 0, paid: 0, words: 0, unplayed: 0, unplayedValue: 0, rw: 0, rb: 0, vd: 0 };
        acc.set(s.label, a);
        ratings.set(s.label, { mu: OPENSKILL_MU, sigma: OPENSKILL_SIGMA });
      }
      let bestOther = -Infinity;
      for (const o of m.seats) if (o !== s && o.score > bestOther) bestOther = o.score;
      if (s.win) a.wins++;
      a.ranks.push(s.rank);
      a.scores.push(s.score);
      a.margins.push(s.score - (bestOther === -Infinity ? 0 : bestOther));
      a.letters += s.lettersWon;
      a.paid += s.totalPaid;
      a.words += s.wordsPlayed;
      a.unplayed += s.unplayedTiles;
      a.unplayedValue += s.unplayedValue;
      a.rw += s.rejectedWords;
      a.rb += s.rejectedBids;
      a.vd += s.voidedDecisions;
    }
    if (m.seats.length >= 2) {
      const before = m.seats.map((s) => ({ ...ratings.get(s.label)!, place: s.rank - 1 }));
      const after = plackettLuce(before);
      m.seats.forEach((s, i) => ratings.set(s.label, after[i]!));
    }
  }
  const rankOf = new Map<string, number>();
  for (const l of labelOrder) if (!rankOf.has(l)) rankOf.set(l, rankOf.size);
  const ordered = labels
    .map((l, i) => ({ l, key: rankOf.get(l) ?? labelOrder.length + i }))
    .sort((x, y) => x.key - y.key)
    .map((x) => x.l);
  return ordered.map((label) => {
    const a = acc.get(label)!;
    const n = a.scores.length;
    const w = wilson(a.wins, n);
    const rk = meanCI(a.ranks);
    const sc = meanCI(a.scores);
    const mg = meanCI(a.margins);
    const r = ratings.get(label)!;
    return {
      label,
      n,
      wins: a.wins,
      winRate: round(w.p),
      winCI: iv(w.lo, w.hi),
      avgRank: round(rk.mean),
      rankCI: iv(rk.lo, rk.hi),
      avgScore: round(sc.mean),
      scoreCI: iv(sc.lo, sc.hi),
      avgMargin: round(mg.mean),
      marginCI: iv(mg.lo, mg.hi),
      avgLettersWon: round(a.letters / n),
      avgPaidPerLetter: round(a.letters > 0 ? a.paid / a.letters : 0),
      avgWords: round(a.words / n),
      avgUnplayedTiles: round(a.unplayed / n),
      avgUnplayedValue: round(a.unplayedValue / n),
      rejectedWords: a.rw,
      rejectedBids: a.rb,
      voidedDecisions: a.vd,
      openskill: { mu: round(r.mu, 6), sigma: round(r.sigma, 6), display: openSkillDisplay(r.mu) },
    };
  });
}

/** Percentile summary of raw samples (nearest rank). */
export function percentiles(samples: readonly number[]): { n: number; p50: number; p99: number; max: number; mean: number } {
  const n = samples.length;
  if (n === 0) return { n: 0, p50: 0, p99: 0, max: 0, mean: 0 };
  const s = Float64Array.from(samples).sort();
  let sum = 0;
  for (const x of s) sum += x;
  const q = (p: number) => s[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))]!;
  return { n, p50: q(0.5), p99: q(0.99), max: s[n - 1]!, mean: sum / n };
}
