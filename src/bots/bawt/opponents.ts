// Opponent bid models and the field max-bid distribution (STRATEGY §8, COMPETITORS §3.1/§5).
//
// Per opponent o, a bid distribution F_o(x) = P(bid_o <= x) over integers 0..cap:
//   - sims: exact (simBidDistribution, which already applies the public balance cap);
//   - profiled real bots (data/profiles.json, by name): reverse-KM survival curves
//     P(bid >= x | letter group, phase), scaled by a per-match calibration factor;
//   - unknown real bots: a market prior by number of real seats, from the profile market tables
//     (top-bid median of real-bot matches, de-maxed to a single-bot median assuming log-normal bids);
//   - every real curve is capped at the opponent's public balance (a bid above it is rejected), a
//     per-auction all-in mass sits at the balance, and seats that stop winning decay toward "dead".
// Field: P(M <= x) = Π_o F_o(x) (independent bidders), P(M < b) = G(b - 1).
// Online calibration: per real opponent a grid posterior over a log-scale s on its bids
// (bid = round(s · prior bid)), updated after every close with the exact censored likelihood of
// the public outcome (winner w, price p) given our own bid and the other seats' models:
//   Vickrey  o won:          X >= p
//            nobody won:     X = 0
//            price 1:        X <= 1 (reserve or second bid of 1)
//            someone else:   P(Z = p)·F(p-1) + P(Z <= p)·P(X = p), Z = max bid of everyone but o and w
//                            (o may itself be the price setter: this is what makes it informative)
//   FirstPrice o won: X = p; otherwise X <= p.
// A plain interval/PIT update ignores that o can be the price setter and is biased low
// (measured: mean PIT 0.42 at the true scale), hence the likelihood form. Each observation is
// tempered by calibTemper; the prior is N(0, calibPriorSd) on log s, grid [calibMin, calibMax].
import { readFileSync } from 'node:fs';
import { NUM_LETTERS, VALUE, letterAt } from '../../core/letters.js';
import { simBidDistribution, simMaxBid } from '../../core/simbots.js';
import type { AuctionOutcome, AuctionType, MatchConfig, MatchView, PlayerId, SimStrategy } from '../../core/types.js';
import {
  GROUPS,
  PHASES,
  groupOf,
  phaseOf,
  type BotProfile,
  type LetterGroup,
  type Phase,
  type ProfilesFile,
} from '../../history/profiles.js';
import { rackSizeOf } from '../../state/view.js';

// ------------------------------------------------------------------------------------ profiles

const PHASE_IDX: Readonly<Record<Phase, number>> = { early: 0, mid: 1, late: 2, penultimate: 3, final: 4 };
const GROUP_IDX: Readonly<Record<LetterGroup, number>> = Object.fromEntries(GROUPS.map((g, i) => [g, i])) as Record<
  LetterGroup,
  number
>;
const LETTER_GROUP: readonly number[] = Array.from({ length: NUM_LETTERS }, (_, i) => GROUP_IDX[groupOf(letterAt(i))]);

/** Survival curve ge[x] = P(bid >= x), x = 0..60 (ge[0] = 1). */
export type Survival = Float64Array;

export interface CompactProfile {
  name: string;
  matches: number;
  /** curves[group * 5 + phase]. */
  curves: Survival[];
  /** Detected modal cap per letter (null = none). */
  caps: Array<number | null>;
  /** Per-auction all-in rate on the penultimate auction. */
  penultimateAllIn: number;
}

export interface MarketPrior {
  /** Single-bot median bid per letter, keyed by number of real seats ('1'..'7'). */
  medianByReal: Record<string, Float64Array>;
}

export interface ProfileBook {
  byName: Map<string, CompactProfile>;
  market: MarketPrior;
}

const MARKET_SIGMA = 0.4;
const MARKET_NO_BID = 0.05;

/** Standard normal quantile (Acklam). */
export function normInv(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - pl) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 on erf; |err| < 1.5e-7). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function compactProfile(b: BotProfile): CompactProfile {
  const curves: Survival[] = new Array(GROUPS.length * PHASES.length);
  for (const g of GROUPS) {
    for (const ph of PHASES) {
      const c = b.bidCurves[g][ph];
      const ge = new Float64Array(c.pGe.length + 1);
      ge[0] = 1;
      for (let x = 1; x <= c.pGe.length; x++) ge[x] = c.pGe[x - 1]!;
      curves[GROUP_IDX[g] * PHASES.length + PHASE_IDX[ph]] = ge;
    }
  }
  const caps: Array<number | null> = new Array(NUM_LETTERS).fill(null);
  for (const c of b.caps) {
    const i = c.letter.charCodeAt(0) - 65;
    if (i >= 0 && i < NUM_LETTERS && c.cap !== null && c.aboveCapShare < 0.2) caps[i] = c.cap;
  }
  return {
    name: b.name,
    matches: b.matches,
    curves,
    caps,
    penultimateAllIn: b.penultimate.allInRateOfAuctions ?? 0.25,
  };
}

/** Build the profile book from a parsed profiles.json (pure; exported for tests). */
export function buildProfileBook(file: ProfilesFile): ProfileBook {
  const byName = new Map<string, CompactProfile>();
  for (const b of file.bots) {
    if (b.isSim) continue;
    const cp = compactProfile(b);
    byName.set(b.name, cp);
    const lower = b.name.toLowerCase();
    if (!byName.has(lower)) byName.set(lower, cp);
  }
  const medianByReal: Record<string, Float64Array> = {};
  for (const [nReal, table] of Object.entries(file.market.priceByRealBots)) {
    const n = Number(nReal);
    if (!(n >= 1)) continue;
    // In matches with n real bots the top bid is (almost always) the max of n real bids; for
    // iid log-normal bids its median is the single-bot quantile 0.5^(1/n).
    const z = normInv(Math.pow(0.5, 1 / n));
    const med = new Float64Array(NUM_LETTERS);
    for (let i = 0; i < NUM_LETTERS; i++) {
      const lp = table[letterAt(i)];
      const top50 = lp && lp.n >= 50 ? lp.top[0] : null;
      const fallback = 2.5 * VALUE[i]! + 4;
      med[i] = top50 !== null && top50 !== undefined ? Math.max(1, top50 / Math.exp(MARKET_SIGMA * z)) : fallback;
    }
    medianByReal[nReal] = med;
  }
  return { byName, market: { medianByReal } };
}

let sharedBook: ProfileBook | undefined;

/** data/profiles.json, loaded once per process. Missing file => empty book (market fallback). */
export function loadProfileBook(): ProfileBook {
  if (sharedBook) return sharedBook;
  try {
    const raw = readFileSync(new URL('../../../data/profiles.json', import.meta.url), 'utf8');
    sharedBook = buildProfileBook(JSON.parse(raw) as ProfilesFile);
  } catch {
    sharedBook = { byName: new Map(), market: { medianByReal: {} } };
  }
  return sharedBook;
}

// ------------------------------------------------------------------------------ opponent model

export interface CalibrationOptions {
  calibTemper: number;
  calibPriorSd: number;
  calibMin: number;
  calibMax: number;
  deadAfter: number;
}

export const DEFAULT_CALIBRATION: Readonly<CalibrationOptions> = Object.freeze({
  calibTemper: 0.7,
  calibPriorSd: 0.5,
  calibMin: 0.3,
  calibMax: 3,
  deadAfter: 25,
});

const GRID = 41;

export type OpponentKind = 'sim' | 'profiled' | 'market';

export class OpponentModel {
  readonly kind: OpponentKind;
  /** log of the calibration scale on bids (0 = prior); posterior mean of the grid. */
  logScale = 0;
  /** Grid of log-scales and their unnormalised log posterior. */
  readonly grid: Float64Array;
  readonly logPost: Float64Array;
  /** Probability the seat is still actively bidding. */
  alive = 1;
  wins = 0;
  sinceWin = 0;
  observed = 0;
  /** Wins at a price >= 60% of the pre-auction balance (balance >= 20): spoiler evidence. */
  allIns = 0;

  constructor(
    readonly id: PlayerId,
    readonly name: string,
    readonly simStrategy: SimStrategy | undefined,
    readonly profile: CompactProfile | undefined,
    /** Market single-bot medians (unknown real bots). */
    readonly marketMedian: Float64Array,
    calib: CalibrationOptions = DEFAULT_CALIBRATION,
  ) {
    this.kind = simStrategy !== undefined ? 'sim' : profile ? 'profiled' : 'market';
    const lo = Math.log(calib.calibMin);
    const hi = Math.log(calib.calibMax);
    this.grid = Float64Array.from({ length: GRID }, (_, g) => lo + ((hi - lo) * g) / (GRID - 1));
    const sd = calib.calibPriorSd;
    this.logPost = Float64Array.from(this.grid, (x) => -(x * x) / (2 * sd * sd));
  }

  /** Recompute logScale as the posterior mean over the grid. */
  updateScale(): void {
    let mx = -Infinity;
    for (let g = 0; g < GRID; g++) if (this.logPost[g]! > mx) mx = this.logPost[g]!;
    let z = 0;
    let m = 0;
    for (let g = 0; g < GRID; g++) {
      const w = Math.exp(this.logPost[g]! - mx);
      z += w;
      m += w * this.grid[g]!;
    }
    this.logScale = m / z;
  }

  get scale(): number {
    return Math.exp(this.logScale);
  }

  /** Per-auction probability of an all-in bid (penultimate prior from the profile). */
  allInRate(phase: Phase): number {
    if (phase === 'penultimate') return this.profile?.penultimateAllIn ?? 0.3;
    if (phase === 'final') return 0;
    return Math.min(0.5, this.allIns / (this.observed + 20));
  }

  /** P(want >= x) for x >= 1 before the balance cap / all-in mass (real seats only). */
  wantGe(li: number, phase: Phase, x: number, logScale = this.logScale): number {
    if (x <= 0) return 1;
    const y = (x - 0.5) / Math.exp(logScale); // bid = round(scale · base)
    if (this.profile) {
      const ge = this.profile.curves[LETTER_GROUP[li]! * PHASES.length + PHASE_IDX[phase]]!;
      const k = Math.ceil(y - 1e-9);
      if (k <= 0) return 1;
      const last = ge.length - 1;
      const p = k <= last ? ge[k]! : ge[last]! * Math.exp(-(k - last) / 10);
      return this.alive * p;
    }
    const m = this.marketMedian[li]! * (phase === 'late' ? 1.15 : 1);
    if (y <= 0) return 1;
    return this.alive * (1 - MARKET_NO_BID) * (1 - normCdf((Math.log(y) - Math.log(m)) / MARKET_SIGMA));
  }

  /**
   * Fill out[x] = P(bid <= x) for x = 0..out.length-1 given the public balance and phase.
   * Sims: exact module distribution.
   */
  /** P(bid <= x) at an explicit log-scale (real seats). */
  cdfAt(li: number, phase: Phase, balance: number, x: number, logScale: number): number {
    if (x < 0) return 0;
    const cap = Math.max(0, Math.floor(balance));
    if (x >= cap) return 1;
    const a = cap > 0 ? this.allInRate(phase) : 0;
    return (1 - a) * (1 - this.wantGe(li, phase, x + 1, logScale));
  }

  cdfInto(out: Float64Array, li: number, phase: Phase, balance: number): void {
    const n = out.length;
    if (this.simStrategy !== undefined) {
      const dist = simBidDistribution(this.simStrategy, li, Math.max(0, balance));
      out.fill(0);
      for (const [amount, p] of dist) if (amount < n) out[amount]! += p;
      for (let x = 1; x < n; x++) out[x]! += out[x - 1]!;
      for (let x = 0; x < n; x++) if (out[x]! > 1) out[x] = 1;
      return;
    }
    const cap = Math.max(0, Math.floor(balance));
    const a = cap > 0 ? this.allInRate(phase) : 0;
    for (let x = 0; x < n; x++) {
      if (x >= cap) {
        out[x] = 1;
        continue;
      }
      const ge = this.wantGe(li, phase, x + 1); // P(want >= x+1)
      out[x] = (1 - a) * (1 - ge);
    }
  }

  /** Highest bid this seat can make, when exactly known (sims, or broke seats that cannot cash). */
  knownMax(view: MatchView, li: number, balance: number): number | undefined {
    if (this.simStrategy !== undefined) return simMaxBid(this.simStrategy, li, balance);
    const p = view.players.get(this.id);
    if (p && balance <= 0 && rackSizeOf(view, p) < 2) return 0;
    return undefined;
  }
}

// ------------------------------------------------------------------------------------- field

/** Mid-interval PIT of an integer observation interval [lo, hi] under CDF F (F(-1) = 0). */
export function midPit(cdf: Float64Array, lo: number, hi: number): number {
  const F = (x: number) => (x < 0 ? 0 : x >= cdf.length ? 1 : cdf[x]!);
  return (F(lo - 1) + F(hi)) / 2;
}

export class FieldModel {
  readonly opponents: OpponentModel[];
  private readonly byId = new Map<PlayerId, OpponentModel>();
  private readonly scratch = new Float64Array(1024);
  readonly totalAuctions: number;
  readonly auctionType: AuctionType;

  constructor(
    config: MatchConfig,
    readonly calib: CalibrationOptions = DEFAULT_CALIBRATION,
    book: ProfileBook = loadProfileBook(),
  ) {
    this.totalAuctions = config.totalAuctions;
    this.auctionType = config.auctionType;
    let real = 0;
    for (const p of config.players) if (!p.isSim) real++;
    const key = String(Math.max(1, Math.min(7, real)));
    const fallback = Float64Array.from({ length: NUM_LETTERS }, (_, i) => 2.5 * VALUE[i]! + 4);
    const median = book.market.medianByReal[key] ?? fallback;
    this.opponents = [];
    for (const p of config.players) {
      if (p.id === config.myId) continue;
      const prof = p.isSim ? undefined : (book.byName.get(p.name) ?? book.byName.get(p.name.toLowerCase()));
      const m = new OpponentModel(p.id, p.name, p.isSim ? (p.simStrategy ?? 'Human') : undefined, prof, median, calib);
      this.opponents.push(m);
      this.byId.set(p.id, m);
    }
  }

  get(id: PlayerId): OpponentModel | undefined {
    return this.byId.get(id);
  }

  get realOpponents(): number {
    let n = 0;
    for (const o of this.opponents) if (o.kind !== 'sim') n++;
    return n;
  }

  phase(index: number): Phase {
    return phaseOf(index, this.totalAuctions);
  }

  /**
   * Field CDF G[x] = P(max competing bid <= x), x = 0..len-1 with len = max balance + 2.
   * `balances` maps opponent id -> balance (defaults to the view). `exclude` drops one opponent.
   */
  fieldCdf(
    view: MatchView,
    li: number,
    index: number,
    opts: { exclude?: PlayerId; balances?: ReadonlyMap<PlayerId, number> } = {},
  ): Float64Array {
    const phase = this.phase(index);
    let maxBal = 0;
    const bal = (o: OpponentModel) => Math.max(0, opts.balances?.get(o.id) ?? view.players.get(o.id)?.balance ?? 0);
    for (const o of this.opponents) if (o.id !== opts.exclude) maxBal = Math.max(maxBal, bal(o));
    const len = Math.min(this.scratch.length, Math.floor(maxBal) + 2);
    const G = new Float64Array(len).fill(1);
    const F = this.scratch.subarray(0, len);
    for (const o of this.opponents) {
      if (o.id === opts.exclude) continue;
      o.cdfInto(F, li, phase, bal(o));
      for (let x = 0; x < len; x++) G[x]! *= F[x]!;
    }
    return G;
  }

  /** Max bid every competitor can make when all are exactly known; undefined otherwise. */
  knownFieldMax(view: MatchView, li: number): number | undefined {
    let m = 0;
    for (const o of this.opponents) {
      const b = view.players.get(o.id)?.balance ?? 0;
      const k = o.knownMax(view, li, b);
      if (k === undefined) return undefined;
      if (k > m) m = k;
    }
    return m;
  }

  /** Lowest detected modal cap among profiled real rivals for this letter (focal point), if any. */
  focalCap(li: number): number | undefined {
    let best: number | undefined;
    for (const o of this.opponents) {
      const c = o.profile?.caps[li];
      if (c !== null && c !== undefined && o.alive > 0.5 && Math.abs(o.logScale) < 0.2) best = best === undefined ? c : Math.max(best, c);
    }
    return best;
  }

  /**
   * Update the opponent models from a closed auction. `preBalances` = opponent balances when the
   * auction opened (bids are capped by them); `myBid` = the bid we submitted (0 = none).
   */
  observe(outcome: AuctionOutcome, preBalances: ReadonlyMap<PlayerId, number>, myBid = 0, myId: PlayerId = -1): void {
    const li = outcome.letter.charCodeAt(0) - 65;
    if (li < 0 || li >= NUM_LETTERS) return;
    const phase = this.phase(outcome.index);
    const bal = (id: PlayerId) => Math.max(0, preBalances.get(id) ?? 0);
    let maxBal = Math.max(0, myBid);
    for (const o of this.opponents) maxBal = Math.max(maxBal, bal(o.id));
    const len = Math.min(this.scratch.length, Math.floor(maxBal) + 2);
    const cdfs = new Map<PlayerId, Float64Array>();
    for (const o of this.opponents) {
      const F = new Float64Array(len);
      o.cdfInto(F, li, phase, bal(o.id));
      cdfs.set(o.id, F);
    }
    const w = outcome.winnerId;
    const p = outcome.paid;
    const learn = phase !== 'penultimate' && phase !== 'final';
    for (const o of this.opponents) {
      if (o.kind === 'sim') continue;
      const balance = bal(o.id);
      o.observed++;
      const won = w === o.id;
      if (won) {
        o.wins++;
        o.sinceWin = 0;
        o.alive = 1;
        if (balance >= 20 && p >= 0.6 * balance) o.allIns++;
      } else {
        o.sinceWin++;
        if (o.wins === 0 ? o.sinceWin > this.calib.deadAfter : o.sinceWin > 2 * this.calib.deadAfter) {
          o.alive = Math.max(0.02, o.alive * 0.9);
        }
      }
      if (!learn || balance <= 0) continue;
      // Z = max bid of everyone except o and the winner (our own bid is known exactly).
      let zEq = 0;
      let zLe = 1;
      if (!won && w !== null) {
        const Z = (x: number): number => {
          if (x < 0) return 0;
          let v = w !== myId && myBid > x ? 0 : 1;
          for (const q of this.opponents) {
            if (q.id === o.id || q.id === w) continue;
            const F = cdfs.get(q.id)!;
            v *= x >= F.length ? 1 : F[x]!;
          }
          return v;
        };
        zLe = Z(p);
        zEq = zLe - Z(p - 1);
      }
      const temper = this.calib.calibTemper;
      for (let g = 0; g < o.grid.length; g++) {
        const ls = o.grid[g]!;
        const F = (x: number) => o.cdfAt(li, phase, balance, x, ls);
        let L: number;
        if (this.auctionType === 'FirstPrice') L = won ? F(p) - F(p - 1) : w === null ? F(0) : F(p);
        else if (won) L = 1 - F(p - 1);
        else if (w === null) L = F(0);
        else if (p <= 1) L = F(1); // reserve price: every non-winner bid <= 1
        else L = zEq * F(p - 1) + zLe * (F(p) - F(p - 1));
        o.logPost[g]! += temper * Math.log(Math.max(L, 1e-9));
      }
      o.updateScale();
    }
  }
}

// ------------------------------------------------------------------------- field statistics

const Gat = (G: Float64Array, x: number): number => (x < 0 ? 0 : x >= G.length ? 1 : G[x]!);

/** P(M < b). */
export function pBelow(G: Float64Array, b: number): number {
  return Gat(G, b - 1);
}

/** P(M = b). */
export function pTie(G: Float64Array, b: number): number {
  return Gat(G, b) - Gat(G, b - 1);
}

/** Win probability of bid b (> 0) with random tie-breaks (two-way tie approximation). */
export function winProb(G: Float64Array, b: number): number {
  if (b <= 0) return 0;
  return pBelow(G, b) + 0.5 * pTie(G, b);
}

/**
 * Expected payment E[pay · 1{win}] of bid b. Vickrey: max(M, 1) when M < b (reserve price 1 when
 * nobody else bids), b on a won tie. FirstPrice: b · P(win).
 */
export function expectedPay(G: Float64Array, b: number, auctionType: AuctionType): number {
  if (b <= 0) return 0;
  if (auctionType === 'FirstPrice') return b * winProb(G, b);
  let s = Gat(G, 0) * 1; // M = 0 -> pay 1
  for (let m = 1; m < b; m++) s += m * (Gat(G, m) - Gat(G, m - 1));
  return s + 0.5 * b * pTie(G, b);
}

/** E[M | M < b] (0 when P(M < b) = 0). */
export function expectedMaxBelow(G: Float64Array, b: number): number {
  const p = pBelow(G, b);
  if (p <= 0) return 0;
  let s = 0;
  for (let m = 1; m < b; m++) s += m * (Gat(G, m) - Gat(G, m - 1));
  return s / p;
}

/** Smallest integer x with P(M <= x) >= q. */
export function fieldQuantile(G: Float64Array, q: number): number {
  for (let x = 0; x < G.length; x++) if (G[x]! >= q) return x;
  return G.length - 1;
}
