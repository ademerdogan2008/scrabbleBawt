// Data-fitted clone machinery for the live top bots without public code (COMPETITORS.md §4.9).
//
//   bid  = κ · exp(c0 + cFace·face + cPhase·phase + cBal·bal/100 + cRack·rackTiles + cVowel·vowel
//                  + cSims·nSims + sd·z)                      z ~ N(0,1) from the seat stream
//   B == 0 (final)       : bid 0 (never won a final auction in 1,563 bot-matches)
//   B == 1 (penultimate) : penFrac · balance when the letter raises the exact best partition, else 0
//   words                : mid-match cash every word of length >= minLen (7 for all three); with
//                          probability altProb per auction also cash the best word of length
//                          altMinLen..minLen-1 (maverick cashes some 5-6 letter words);
//                          dump the exact best partition when auctionsLeft (B+1) <= dumpT
//
// Two documented additions to the published fit:
//   * pacing cap: bid <= paceMul · balance / (B + 1). The fitted balance slope is confounded with
//     phase (§2.4); without a cap a high-κ clone is broke by r20 (live: 66/88/85 coins at r20),
//     which also makes tiles/match non-monotone in κ and breaks bisection (first tuning run).
//   * optional rack need (off by default, needW = 0): + needW · (s - 0.5) in the log bid with
//     s = clamp(Δ/needScale, 0, 1), Δ = Monte Carlo letter value (needSamples > 0) or SookraBot
//     pack-value gain. Measured on 200-match grids it LOWERED scores (LUCENT 140 -> 127 at
//     needW 2) and made tiles non-monotone in κ, so the calibrated clones keep the pure fit.
//
// The log-bid coefficients are least-squares fits of WINNING bids (selection-biased upward), so κ
// and penFrac are calibrated in the simulator by scripts/zoo-calibrate.ts against the NOW
// fingerprints (§2.2: tiles/match, paid/tile, end balance, words/match) in 3-real + 3-sim tables.
import { IS_VOWEL, VALUE } from '../../core/letters.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import {
  Turn,
  bestWord,
  cashGreedy,
  gauss,
  letterOf,
  partition,
  progressOf,
  rackPlus,
  rackSize,
  simRivals,
} from './common.js';
import { mcLetterValue } from './blackswan.js';
import { sookraPackValue } from './sookra.js';

export interface FittedParams {
  c0: number;
  cFace: number;
  cPhase: number;
  cBal: number;
  cRack: number;
  cVowel: number;
  cSims: number;
  sd: number;
  kappa: number;
  penFrac: number;
  minLen: number;
  altMinLen: number;
  altProb: number;
  dumpT: number;
  /** Optional ceiling on J/X/Q/Z bids (Bron's stop at exactly 30, HISTORICAL §E3; 0 = none). */
  premiumCap: number;
  needW: number;
  needScale: number;
  /** > 0: need = Monte Carlo letter value over needSamples futures of <= needFuture tiles. */
  needSamples: number;
  needFuture: number;
  paceMul: number;
}

/** Shared defaults of the two additions (see header). */
export const FITTED_EXTRAS = Object.freeze({ needW: 0, needScale: 10, needSamples: 4, needFuture: 6, paceMul: 14 });

/** NOW targets (COMPETITORS §2.2, 3 real + sims) used by the calibration script and tests. */
export interface FittedTargets {
  tiles: number;
  paidPerTile: number;
  endBalance: number;
  words: number;
  score: number;
  firstWordRound: number;
  balR20: number;
  balR45: number;
  balR56: number;
}

export function fittedFactory(name: string, defaults: Readonly<FittedParams>): PolicyFactory {
  return (_seed, opts) => {
    const p: FittedParams = { ...defaults, ...(opts as Partial<FittedParams> | undefined) };
    const policy: Policy = {
      name,
      onMatchStart() {},
      decide(view, auction, ctx) {
        const li = letterOf(auction);
        const B = auction.remainingAfter;
        const T = B + 1;
        const t = new Turn(view);
        // seat-stream draws happen unconditionally so every branch consumes the same randomness
        const z = gauss(ctx.rng);
        const alt = ctx.rng.float();
        if (T <= p.dumpT) t.dump();
        else {
          t.playAll(cashGreedy(t.rack, p.minLen, 4));
          if (alt < p.altProb && p.altMinLen < p.minLen) {
            const w = bestWord(t.rack, p.altMinLen);
            if (w && w.word.length < p.minLen) t.play(w.word);
          }
        }
        if (B === 0) return t.decision(0);
        if (B === 1) {
          const gain = partition(rackPlus(t.rack, li)).score - partition(t.rack).score;
          return t.decision(gain > 0 ? p.penFrac * t.balance : 0);
        }
        const nSims = simRivals(view).length;
        const logBid =
          p.c0 +
          p.cFace * VALUE[li]! +
          p.cPhase * progressOf(view, auction) +
          (p.cBal * t.balance) / 100 +
          p.cRack * rackSize(t.rack) +
          p.cVowel * (IS_VOWEL[li] ? 1 : 0) +
          p.cSims * nSims +
          p.sd * z;
        let need = 0.5;
        if (p.needW !== 0) {
          const delta =
            p.needSamples > 0
              ? mcLetterValue(t.rack, li, view.unseen, Math.min(p.needFuture, Math.floor(B / 4)), p.needSamples, ctx.rng)
              : sookraPackValue(rackPlus(t.rack, li), 0.35) - sookraPackValue(t.rack, 0.35);
          need = Math.min(1, Math.max(0, delta / p.needScale));
        }
        let bid = p.kappa * Math.exp(logBid + p.needW * (need - 0.5));
        bid = Math.min(bid, (p.paceMul * t.balance) / T);
        if (p.premiumCap > 0 && VALUE[li]! >= 8) bid = Math.min(bid, p.premiumCap);
        return t.decision(bid);
      },
    };
    return policy;
  };
}
