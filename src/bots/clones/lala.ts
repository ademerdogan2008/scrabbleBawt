// Lala v2.7.5 clone (COMPETITORS.md §4.5). Re-implemented from the spec; nothing copied.
//
// The two data tables (phase prices, learned leave values) are transcribed from §4.5. Approximations:
//   * V(rack) plans: for each extension E (none, every single unseen letter, pairs among the
//     PAIR_TOP letters with the highest draw rate) the plan word is the best-reward word of rack+E
//     (lengths 2..8 are not capped at 8: words > 8 letters are rare). Its missing tiles are the
//     word's letters not in the rack. This is the max over plans whose word is the best word of
//     its own extension, a subset of Lala's full plan set.
//   * rackValue (for μ's `have`) = fast best-partition score of the rack.
//   * Word loop: candidate words are the top WORD_CANDIDATES fitting classes by reward.
//   * FirstPrice: argmax_b (bid - b) Φ((ln b - ln(1.25 price)) / 0.35) over integer b.
import { NUM_LETTERS, idx } from '../../core/letters.js';
import type { Rack } from '../../core/rack.js';
import type { AuctionOutcome, MatchView, Policy, PolicyFactory } from '../../core/types.js';
import {
  Turn,
  bestRewardCached,
  bestWordCached,
  clamp,
  letterOf,
  normCdf,
  partition,
  partitionFast,
  rackMinusWord,
  rackPlus,
  topWords,
} from './common.js';

const parseRow = (s: string): number[] => {
  const out = new Array<number>(NUM_LETTERS).fill(0);
  for (const tok of s.trim().split(/\s+/)) out[idx(tok[0]!)] = Number(tok.slice(1));
  return out;
};

/** phasePrice cuts: r <= 20 / 45 / 62 / else (1-based auction number). */
export const LALA_PHASE_PRICES: readonly (readonly number[])[] = [
  parseRow('A11 B16.9 C18 D14 E11 F20 G13 H21 I10 J31.5 K24.8 L10.1 M17 N10 O10 P17 Q33.2 R11 S12 T10 U10.9 V18.9 W19.9 X34.5 Y21.9 Z43.1'),
  parseRow('A10 B16 C18 D14 E11 F20 G12.1 H21 I10 J29.9 K24 L10 M17 N10 O9 P17 Q29.9 R11 S12 T10 U10 V18 W19 X32.8 Y21 Z39.9'),
  parseRow('A11 B16.9 C18 D14.9 E12 F20 G13 H21 I10 J25.2 K23.2 L11 M17.9 N11 O10 P17.9 Q22.7 R12 S12.9 T11 U10 V18 W19 X29 Y20.1 Z31.1'),
  parseRow('A11 B14.6 C13 D12.3 E10.1 F14.8 G12.2 H15.6 I10 J19.6 K16.8 L10.2 M14.7 N10 O10 P14.1 Q17 R10.1 S12 T10 U8.4 V12.4 W14.6 X22.2 Y17.4 Z23'),
];

export function lalaPhasePrice(r: number, li: number): number {
  const k = r <= 20 ? 0 : r <= 45 ? 1 : r <= 62 ? 2 : 3;
  return LALA_PHASE_PRICES[k]![li]!;
}

const parseLeave = (s: string): number[][] => {
  const out: number[][] = Array.from({ length: NUM_LETTERS }, () => [0, 0, 0]);
  for (const tok of s.trim().split(/\s+/)) {
    const vals = tok.slice(1).split('/').map(Number);
    out[idx(tok[0]!)] = vals;
  }
  return out;
};

/** LEAVE[bucket][letter][copy-1]; buckets by T: [41,99], [16,40], [3,15]. */
export const LALA_LEAVE: readonly (readonly (readonly number[])[])[] = [
  parseLeave(
    'A7.2/5.6/7.9 B10.9/5.5/0 C11.9/7.0/0 D9.2/9.7/7.7 E7.3/6.1/6.3 F12.7/15.7/0 G7.4/7.1/0 H14.8/6.6/0 I6.5/5.4/4.4 J19.2/0/0 K16.0/0/0 L5.8/6.4/.5 M10.9/9.7/0 N5.9/4.3/3.0 O6.6/5.4/5.5 P10.9/9.6/0 Q20.4/0/0 R6.4/5.1/4.9 S6.4/5.8/-3.1 T5.7/5.8/6.6 U7.1/4.3/-.4 V11.6/7.4/0 W12.7/8.9/0 X22.1/0/0 Y14.6/8.4/0 Z29.4/0/0',
  ),
  parseLeave(
    'A8.3/5.6/6.8 B9.3/2.8/0 C10.7/5.2/0 D9.9/9.6/8.4 E8.7/6.7/8.0 F10.0/13.7/0 G7.2/5.6/0 H11.9/7.6/0 I7.9/5.2/2.7 J13.7/0/0 K13.0/0/0 L7.2/4.0/.2 M10.4/6.8/0 N7.4/4.4/2.4 O7.5/5.4/4.3 P9.5/5.7/0 Q11.0/0/0 R7.7/4.7/2.0 S8.3/4.9/-.8 T6.9/5.0/6.0 U7.5/3.0/.5 V8.6/6.0/0 W9.8/6.7/0 X15.4/0/0 Y12.5/4.9/0 Z19.6/0/0',
  ),
  parseLeave(
    'A6.9/3.9/1.2 B5.6/2.2/0 C6.0/2.8/0 D6.0/5.7/1.6 E7.1/5.1/7.4 F5.9/6.1/0 G4.3/3.2/.5 H7.4/2.8/0 I6.0/3.3/3.0 J7.7/0/0 K7.7/0/0 L4.6/3.3/.4 M6.4/3.4/0 N5.1/2.3/1.9 O5.9/3.9/3.7 P5.6/4.8/0 Q4.4/0/0 R5.3/1.9/1.1 S6.0/4.0/1.0 T4.7/2.8/2.4 U5.2/2.1/-.1 V4.5/3.6/0 W6.0/2.7/0 X9.2/0/0 Y7.7/2.7/0 Z10.4/0/0',
  ),
];

export interface LalaParams {
  winP: number;
  maxMissing: number;
  rho: number;
  leaveScale: number;
  mu0: number;
  muAlpha: number;
  muMin: number;
  muMax: number;
  share: number;
  incomeW: number;
  lateN: number;
  lateMu: number;
  capMul: number;
  completeMul: number;
  completeMin: number;
  completeLen: number;
  starveBal: number;
  starveT: number;
  starveMinLen: number;
  priceN0: number;
  shadeSigma: number;
  pairTop: number;
  wordCandidates: number;
}

export const LALA_DEFAULTS: Readonly<LalaParams> = Object.freeze({
  winP: 0.9,
  maxMissing: 2,
  rho: 0.6,
  leaveScale: 0.7,
  mu0: 0.3,
  muAlpha: 0.6,
  muMin: 0.05,
  muMax: 1.5,
  share: 0.2,
  incomeW: 0.3,
  lateN: 12,
  lateMu: 0.6,
  capMul: 1.25,
  completeMul: 1.4,
  completeMin: 12,
  completeLen: 6,
  starveBal: 8,
  starveT: 10,
  starveMinLen: 7,
  priceN0: 8,
  shadeSigma: 0.35,
  pairTop: 5,
  wordCandidates: 5,
});

/** P(Poisson(lambda) >= k). */
export function poissonTail(lambda: number, k: number): number {
  if (k <= 0) return 1;
  if (lambda <= 0) return 0;
  let term = Math.exp(-lambda);
  let cdf = term;
  for (let i = 1; i < k; i++) {
    term *= lambda / i;
    cdf += term;
  }
  return Math.max(0, 1 - cdf);
}

function leaveBucket(T: number): number {
  return T >= 41 ? 0 : T >= 16 ? 1 : 2;
}

export function lalaLeftover(r: Rack, T: number, p: LalaParams): number {
  const L = LALA_LEAVE[leaveBucket(T)]!;
  let s = 0;
  for (let k = 0; k < NUM_LETTERS; k++) {
    const j = r[k]!;
    if (j === 0) continue;
    const row = L[k]!;
    let v = 0;
    for (let c = 0; c < Math.min(j, 3); c++) v += row[c]!;
    if (j > 3) v += 0.5 * (j - 3) * row[2]!;
    s += v;
  }
  return p.leaveScale * Math.max(0, s);
}

interface ValCtx {
  T: number;
  futureDraws: number;
  unseen: Rack;
  U: number;
  prices: number[];
  mu: number;
  /** Extension letters (singles) and pairs. */
  singles: number[];
  pairs: Array<[number, number]>;
}

/** Lala V(rack): best plan value (or the leave of the whole rack). */
export function lalaV(rack: Rack, c: ValCtx, p: LalaParams): number {
  let best = lalaLeftover(rack, c.T, p);
  const evalExt = (ext: Rack): void => {
    const w = bestWordCached(ext, 2);
    if (!w) return;
    // missing tiles = letters of w not covered by rack
    let prob = 1;
    let missCost = 0;
    let missing = 0;
    const used = new Uint8Array(NUM_LETTERS);
    for (let k = 0; k < w.word.length; k++) used[w.word.charCodeAt(k) - 65]!++;
    const rest = new Uint8Array(rack);
    for (let i = 0; i < NUM_LETTERS; i++) {
      const u = used[i]!;
      if (u === 0) continue;
      const have = rack[i]!;
      const deficit = u > have ? u - have : 0;
      rest[i] = have - (u - deficit);
      if (deficit > 0) {
        missing += deficit;
        const lambda = c.U > 0 ? (c.futureDraws * c.unseen[i]! * p.winP) / c.U : 0;
        prob *= poissonTail(lambda, deficit);
        missCost += deficit * c.prices[i]!;
      }
    }
    if (missing > p.maxMissing) return;
    const v = prob * w.reward - c.mu * p.rho * missCost + lalaLeftover(rest, c.T, p);
    if (v > best) best = v;
  };
  evalExt(rack);
  if (c.futureDraws > 0) {
    for (const i of c.singles) evalExt(rackPlus(rack, i));
    for (const [i, j] of c.pairs) evalExt(rackPlus(rackPlus(rack, i), j));
  }
  return best;
}

export const createLala: PolicyFactory = (_seed, opts) => {
  const p: LalaParams = { ...LALA_DEFAULTS, ...(opts as Partial<LalaParams> | undefined) };
  let sumRatio = 0;
  let nSold = 0;

  const priceTable = (r: number): number[] => {
    const scale = (sumRatio + p.priceN0) / (nSold + p.priceN0);
    return Array.from({ length: NUM_LETTERS }, (_, k) => Math.max(1, lalaPhasePrice(r, k) * scale));
  };

  const policy: Policy = {
    name: 'clone:lala',
    onMatchStart() {
      sumRatio = 0;
      nSold = 0;
    },
    onAuctionClosed(_view: MatchView, o: AuctionOutcome) {
      if (o.winnerId === null || o.paid <= 0) return;
      const li = idx(o.letter);
      sumRatio += o.paid / lalaPhasePrice(o.index + 1, li);
      nSold++;
    },
    decide(view, auction) {
      const li = letterOf(auction);
      const T = auction.remainingAfter + 1;
      const t = new Turn(view);
      if (T <= 1) {
        t.dump();
        return t.decision(0);
      }
      if (T === 2) {
        const now = partition(t.rack);
        const withL = partition(rackPlus(t.rack, li));
        const want = withL.score > now.score;
        // play the words common to both partitions (safe whether or not we win the letter)
        const pool = [...withL.words];
        for (const w of now.words) {
          const k = pool.indexOf(w);
          if (k >= 0) {
            pool.splice(k, 1);
            t.play(w);
          }
        }
        return t.decision(want ? t.balance : 0);
      }
      const r = auction.index + 1;
      const futureDraws = T - 2;
      const unseen = view.unseen;
      let U = 0;
      for (let i = 0; i < NUM_LETTERS; i++) U += unseen[i]!;
      const prices = priceTable(r);
      let priceSum = 0;
      for (let i = 0; i < NUM_LETTERS; i++) priceSum += unseen[i]! * prices[i]!;
      const avgUnseenPrice = U > 0 ? priceSum / U : 10;
      const rate = (i: number) => (U > 0 ? unseen[i]! / U : 0);
      const singles: number[] = [];
      for (let i = 0; i < NUM_LETTERS; i++) if (unseen[i]! > 0) singles.push(i);
      const top = [...singles].sort((a, b) => rate(b) - rate(a) || a - b).slice(0, p.pairTop);
      const pairs: Array<[number, number]> = [];
      for (let x = 0; x < top.length; x++)
        for (let y = x; y < top.length; y++) if (x !== y || unseen[top[x]!]! >= 2) pairs.push([top[x]!, top[y]!]);

      const muOf = (balance: number, rack: Rack): number => {
        const need = (futureDraws + 1) * p.share * avgUnseenPrice;
        const have = Math.max(1, balance + p.incomeW * Math.max(0, partitionFast(rack).score));
        return clamp(p.mu0 * (need / have) ** p.muAlpha * (T <= p.lateN ? p.lateMu : 1), p.muMin, p.muMax);
      };
      const ctxFor = (balance: number, rack: Rack): ValCtx => ({
        T,
        futureDraws,
        unseen,
        U,
        prices,
        mu: muOf(balance, rack),
        singles,
        pairs,
      });

      // ---- words
      for (let k = 0; k < 4; k++) {
        const vc = ctxFor(t.balance, t.rack);
        const vNow = lalaV(t.rack, vc, p);
        let bestGain = -Infinity;
        let bestW: string | undefined;
        for (const w of topWords(t.rack, 2, p.wordCandidates)) {
          const gain = w.reward + lalaV(rackMinusWord(t.rack, w.word), vc, p) - vNow;
          if (gain > bestGain) {
            bestGain = gain;
            bestW = w.word;
          }
        }
        if (bestW !== undefined && bestGain >= 0) {
          t.play(bestW);
          continue;
        }
        if (t.balance < p.starveBal && futureDraws >= p.starveT) {
          let bestS = -Infinity;
          let bestSW: string | undefined;
          for (const w of topWords(t.rack, p.starveMinLen, p.wordCandidates)) {
            const s = w.reward + lalaV(rackMinusWord(t.rack, w.word), vc, p);
            if (s > bestS) {
              bestS = s;
              bestSW = w.word;
            }
          }
          if (bestSW !== undefined) t.play(bestSW);
        }
        break;
      }
      // ---- bid
      const vc = ctxFor(t.balance, t.rack);
      const marginal = Math.max(0, lalaV(rackPlus(t.rack, li), vc, p) - lalaV(t.rack, vc, p));
      let bid = marginal / vc.mu;
      const price = prices[li]!;
      if (T > 3) bid = Math.min(bid, p.capMul * price);
      const complete =
        bestRewardCached(rackPlus(t.rack, li), p.completeLen) - bestRewardCached(t.rack, p.completeLen);
      if (complete >= p.completeMin) bid = Math.max(bid, p.completeMul * price);
      if (view.config.auctionType === 'FirstPrice' && bid > 0) {
        const ref = Math.log(p.capMul * price);
        let bestB = 0;
        let bestU = 0;
        for (let b = 1; b <= Math.min(t.balance, Math.floor(bid)); b++) {
          const u = (bid - b) * normCdf((Math.log(b) - ref) / p.shadeSigma);
          if (u > bestU) {
            bestU = u;
            bestB = b;
          }
        }
        bid = bestB;
      }
      return t.decision(clamp(bid, 0, t.balance));
    },
  };
  return policy;
};
