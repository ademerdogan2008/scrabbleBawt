// Bid construction (STRATEGY §3.4, §3.6, §6, §10, §11).
//
// Vickrey (HYB-κ):
//   selfish = max(V̂·κ, floor)                              truthful value bid in coins
//   denial  = min(maxOverbid, w·V̂_rival·κ) when the predicted price is below (V̂ + w·V̂_rival)·κ
//             and pacing allows (κ >= 1)
//   bid     = clamp(⌊(selfish + denial)·(1 ± noise)⌋ ± jitter + tieNudge, 0, B)
//   shaping: focal caps (rival modal cap c, bid c+1 when our value reaches c-2), and when every
//   competitor's max possible bid is known (sims, broke seats) never bid above that max + 1
//   (same price, less information leaked through the spectator view).
// FirstPrice: argmax_b (v - b)·P(win | b), v = value in coins (selfish + denial; no overbid).
import type { AuctionType } from '../../core/types.js';
import type { Rng } from '../../core/rng.js';
import { expectedMaxBelow, pTie, winProb } from './opponents.js';

export interface BidInput {
  auctionType: AuctionType;
  /** Our value of the letter in points (V̂). */
  value: number;
  kappa: number;
  /** HYB floor in coins (0 = not useful / disabled). */
  floor: number;
  /** Rival denial value in points and its weight. */
  rivalValue: number;
  denyWeight: number;
  maxOverbid: number;
  /** Field max-bid CDF for the open letter. */
  G: Float64Array;
  balance: number;
  /** Max possible competing bid when known exactly. */
  knownMax: number | undefined;
  focalCap: number | undefined;
  tieNudgeMinP: number;
  jitter: number;
  jitterBelow: number;
  bidNoise: number;
  sureWinCap: boolean;
  rng: Rng;
}

export interface BidResult {
  bid: number;
  selfish: number;
  denial: number;
  reason: string;
}

/** Expected-utility FirstPrice bid: argmax over integers b in [0, min(balance, ⌈v⌉)]. */
export function firstPriceBid(G: Float64Array, valueCoins: number, balance: number): number {
  let best = 0;
  let bestU = 0;
  const hi = Math.min(Math.floor(balance), Math.ceil(valueCoins));
  for (let b = 1; b <= hi; b++) {
    const u = (valueCoins - b) * winProb(G, b);
    if (u > bestU + 1e-12) {
      bestU = u;
      best = b;
    }
  }
  return best;
}

export function makeBid(inp: BidInput): BidResult {
  const B = Math.max(0, Math.floor(inp.balance));
  const selfish = Math.max(0, Math.max(inp.value * inp.kappa, inp.floor));
  let denial = 0;
  if (inp.denyWeight > 0 && inp.rivalValue > 0 && inp.kappa >= 1) {
    const combined = (inp.value + inp.denyWeight * inp.rivalValue) * inp.kappa;
    const pb = Math.max(1, Math.floor(combined));
    const predicted = expectedMaxBelow(inp.G, pb + 1);
    if (predicted < combined && winProb(inp.G, pb) > 0.05) {
      denial = Math.min(inp.maxOverbid, inp.denyWeight * inp.rivalValue * inp.kappa);
    }
  }
  if (selfish + denial <= 0) return { bid: 0, selfish, denial, reason: 'worthless' };

  if (inp.auctionType === 'FirstPrice') {
    let b = firstPriceBid(inp.G, selfish + denial, B);
    if (inp.knownMax !== undefined && b > inp.knownMax + 1) b = Math.min(B, inp.knownMax + 1);
    return { bid: b, selfish, denial, reason: 'firstPrice' };
  }

  const target = selfish + denial;
  let raw = target;
  if (inp.bidNoise > 0) raw *= 1 + inp.bidNoise * (2 * inp.rng.float() - 1);
  let b = Math.floor(raw);
  if (inp.jitter > 0 && inp.value < inp.jitterBelow) b += inp.rng.int(-inp.jitter, inp.jitter);
  b = Math.max(1, b);
  let reason = 'value';
  // tie nudge: a likely integer tie at b is worth +1 when the value permits
  if (inp.tieNudgeMinP > 0 && b + 1 <= target + 1 && pTie(inp.G, b) >= inp.tieNudgeMinP) {
    b++;
    reason = 'tieNudge';
  }
  // focal point: a rival's modal cap c just above us
  if (inp.focalCap !== undefined && b <= inp.focalCap && target >= inp.focalCap - 2 && inp.focalCap + 1 <= B) {
    b = inp.focalCap + 1;
    reason = 'focal';
  }
  if (inp.sureWinCap && inp.knownMax !== undefined && b > inp.knownMax + 1) {
    b = inp.knownMax + 1;
    reason = 'sureWin';
  }
  b = Math.max(0, Math.min(B, b));
  return { bid: b, selfish, denial, reason };
}
