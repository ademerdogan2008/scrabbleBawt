// Fast rack-aware letter values (points) for quick decisions and future-acquisition modelling.
//
// Base: the end-game marginal packing value MARG[n][L] = E[Pack(R+L) - Pack(R)] over random racks
// of n letters (STRATEGY §4.2, results/e4_marg_n*.json: 400 racks per size for n <= 12, 160 for
// n = 16/20, exact packer, real dictionary). Interpolated by the projected number of letters held
// over the match, then multiplied by usability factors measured in §4.3-4.4:
//   - duplicates: vowels ×[1, .7, .5, .3, .2], consonants ×[1, .85, .7, .5, .35] by copies held
//   - vowel balance of rack+letter (balance point ≈ 28-30% vowels; the bag is 43% vowels)
//   - Q: near 0 without a reachable U; U is worth ×1.5 to a rack holding a Q
// At n = 20 the table is ≈ 2.5·face + 4 (the live leader's bid curve).
import { IS_VOWEL, NUM_LETTERS, VALUE } from '../../core/letters.js';
import type { Rack } from '../../core/rack.js';

const L = (s: string): number => s.charCodeAt(0) - 65;
const Q = L('Q');
const U = L('U');

/** Rack sizes of the measured table rows. */
export const MARG_N: readonly number[] = [5, 8, 12, 16, 20];

/** MARG[row][letter], rows matching MARG_N, letters A..Z (STRATEGY §4.2 / marg_table.json). */
export const MARG: readonly (readonly number[])[] = [
  // n = 5
  [4.97, 5.45, 5.67, 5.34, 5.07, 6.11, 4.09, 7.04, 4.21, 7.19, 7.53, 4.26, 6.07, 3.96, 4.33, 5.62, 2.52, 4.46, 5.32, 3.79, 3.75, 4.47, 5.61, 8.54, 7.18, 10.53],
  // n = 8
  [5.67, 7.25, 8.08, 6.61, 5.55, 8.42, 5.19, 9.46, 4.51, 10.29, 9.6, 5.17, 7.68, 5.22, 4.8, 7.71, 5.99, 5.14, 6.31, 4.51, 4.29, 6.19, 6.36, 11.87, 8.12, 16.32],
  // n = 12
  [6.02, 8.18, 9.67, 7.15, 6.17, 9.89, 6.22, 11.52, 5.47, 14.41, 12.42, 5.54, 8.93, 5.78, 5.56, 8.64, 11.32, 5.79, 6.94, 4.99, 5.97, 7.74, 8.62, 16.16, 11.68, 21.3],
  // n = 16 (the dip is real: 16 ≈ 7+7+2, one more letter rarely completes a third word)
  [4.05, 8.05, 9.36, 6.18, 4.28, 9.71, 5.57, 10.87, 4.18, 17.7, 12.49, 4.06, 8.43, 3.64, 3.86, 8.03, 15.02, 4.44, 4.87, 3.26, 4.55, 8.25, 8.76, 19.05, 11.22, 24.19],
  // n = 20
  [6.21, 10.76, 11.53, 8.45, 6.0, 13.4, 7.88, 13.9, 5.83, 22.38, 16.38, 5.79, 10.97, 6.09, 5.69, 10.77, 21.75, 5.84, 6.58, 5.55, 6.63, 11.64, 12.61, 23.18, 13.8, 29.13],
];

/**
 * Smoothed table value: the n=16 dip depends on the exact distance to the next length threshold,
 * which a projection over a whole match cannot know, so rows 12..20 are blended with their
 * neighbours (weight `smooth`). smooth = 0 is the raw interpolation.
 */
export function tableAt(n: number, li: number, smooth = 0.5): number {
  const raw = (x: number): number => {
    if (x <= MARG_N[0]!) return MARG[0]![li]!;
    const last = MARG_N.length - 1;
    if (x >= MARG_N[last]!) return MARG[last]![li]!;
    for (let r = 0; r < last; r++) {
      const a = MARG_N[r]!;
      const b = MARG_N[r + 1]!;
      if (x <= b) {
        const t = (x - a) / (b - a);
        return MARG[r]![li]! * (1 - t) + MARG[r + 1]![li]! * t;
      }
    }
    return MARG[last]![li]!;
  };
  const v = raw(n);
  if (smooth <= 0 || n <= 12) return v;
  const s = (raw(n - 4) + raw(n + 4)) / 2;
  return (1 - smooth) * v + smooth * Math.max(v, s);
}

const DUP_V = [1, 0.7, 0.5, 0.3, 0.2];
const DUP_C = [1, 0.85, 0.7, 0.5, 0.35];

export interface RackStats {
  size: number;
  vowels: number;
}

export function rackStats(rack: Rack): RackStats {
  let size = 0;
  let vowels = 0;
  for (let i = 0; i < NUM_LETTERS; i++) {
    const n = rack[i]!;
    size += n;
    if (IS_VOWEL[i]) vowels += n;
  }
  return { size, vowels };
}

/**
 * Usability factor of letter `li` for `rack`: duplicates, vowel balance, Q/U interplay.
 * `pU` = probability of still getting a U (only used for Q without a U in the rack).
 */
export function usabilityFactor(rack: Rack, li: number, pU: number, st: RackStats = rackStats(rack)): number {
  const isV = IS_VOWEL[li]!;
  let f = (isV ? DUP_V : DUP_C)[Math.min(rack[li]!, 4)]!;
  if (st.size >= 4) {
    const vf = st.vowels / st.size;
    if (isV) f *= vf > 0.5 ? 0.55 : vf > 0.4 ? 0.8 : vf < 0.2 ? 1.35 : 1;
    else f *= vf < 0.2 ? 0.7 : vf > 0.5 ? 1.25 : 1;
  }
  if (li === Q) f *= rack[U]! > 0 ? 1.15 : Math.max(0.05, 1.1 * pU);
  if (li === U && rack[Q]! > 0 && rack[U]! === 0) f *= 1.5;
  return f;
}

/** P(at least one U among `futureWins` acquisitions drawn from `unseen`). */
export function probGetU(unseen: Rack, unseenTotal: number, futureWins: number): number {
  if (unseenTotal <= 0 || unseen[U]! === 0) return 0;
  const lam = (futureWins * unseen[U]!) / unseenTotal;
  return 1 - Math.exp(-lam);
}

/** Rack-adjusted table value (points) of letter `li` at projected match holdings `nProj`. */
export function tableValue(rack: Rack, li: number, nProj: number, pU: number, scale = 1, st?: RackStats): number {
  return scale * tableAt(nProj, li) * usabilityFactor(rack, li, pU, st);
}

/** 26-letter value vector for one rack (shared across a decision). */
export function tableVector(rack: Rack, nProj: number, pU: number, scale = 1): Float64Array {
  const st = rackStats(rack);
  const out = new Float64Array(NUM_LETTERS);
  for (let i = 0; i < NUM_LETTERS; i++) out[i] = tableValue(rack, i, nProj, pU, scale, st);
  return out;
}

/**
 * HYB floor predicate (§11): the letter is "useful" when it would not push the vowel share past
 * vowelCap·(size+1) + 1, we hold fewer than dupCap copies, and a Q has a reachable U.
 */
export function isUseful(rack: Rack, li: number, vowelCap: number, dupCap: number, pU: number): boolean {
  if (rack[li]! >= dupCap) return false;
  const st = rackStats(rack);
  if (IS_VOWEL[li] && st.vowels + 1 > vowelCap * (st.size + 1) + 1) return false;
  if (li === Q && rack[U]! === 0 && pU < 0.5) return false;
  return true;
}

/** HYB floor bid: ⌊a·face + b⌋. */
export function floorBid(li: number, a: number, b: number): number {
  return Math.floor(a * VALUE[li]! + b);
}
