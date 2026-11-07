// K-13 "palace" clone, faithful simplification (COMPETITORS.md §4.8; constants from params.ts +
// data/params.json). K-13 ships no license: re-implemented from the spec, nothing copied.
//
// Kept: Monte Carlo letter valuation with common random numbers over the exact unseen pool
// (k future tiles, fractional), shadow price λ by bisection so that the expected spend of the
// remaining auctions matches balance + income share, λ x 1.08 (< 7 seats) / x 0.8 (>= 7 seats),
// per-rival bid models (sims exact, unknown bots the generic market N(8 + 2.5 face, 3) with
// P(0) = .05), selfish argmax bid, placement-weighted price-driving capped at +4 coins (Vickrey),
// play-vs-hold on the same futures with coin bonus .32λ and margin 2.7, in-match PIT calibration
// (rate .056, scale in [.3, 3]), final-tile denial of sims, B == 1 valuation with k = 0.
//
// Simplified (compute budget, decide p99 < 50 ms):
//   * P(rack) = fast packing (greedy + 16-word first-word beam) instead of top-12 + greedy.
//   * Samples: 6 for the open letter (K-13: 8 quick), 2 per letter for the λ table (recomputed
//     only when the rack changes), 3 for play-vs-hold over the top 4 candidates; k capped at
//     kCap = 6 (K-13: 13) and so that sampled racks stay <= mcRackCap = 16 tiles.
//   * Hoard valve (not in K-13): at >= 16 tiles it cashes best-partition words down to 11.
//   * The λ table's rival CDFs use the generic prior at the current phase (no phaseF shift).
//   * Rival "cut" = P(rival outbids b) x max(0, b - median max of the other bids): price-driving
//     only, no separate denial term.
//   * PIT calibration uses our wins (paid = max rival bid) and losses where the price exceeded our
//     bid (paid = second-highest rival bid).
import { NUM_LETTERS, VALUE, wordReward } from '../../core/letters.js';
import { rackKey, type Rack } from '../../core/rack.js';
import type { Rng } from '../../core/rng.js';
import { simBidDistribution } from '../../core/simbots.js';
import type { AuctionOutcome, MatchView, PlayerState, Policy, PolicyFactory } from '../../core/types.js';
import { Turn, clamp, letterOf, normCdf, partition, partitionFast, rackMinusWord, rackPlus, rackSize, topWords } from './common.js';

export interface K13Params {
  futureScale: number;
  kCap: number;
  kInitPrice: number;
  maxWinShare: number;
  quickSamples: number;
  tableSamples: number;
  lambdaMin: number;
  lambdaMax: number;
  lambdaScale: number;
  lambdaScaleBig: number;
  incomeShare: number;
  futureValueScale: number;
  rivalWeight: number;
  maxOverbid: number;
  calibRate: number;
  genericBase: number;
  genericFace: number;
  genericSd: number;
  genericP0: number;
  equityPerTile: number;
  playCandidates: number;
  playSamples: number;
  coinBonus: number;
  playMargin: number;
  maxPlays: number;
  lastTileDeny: boolean;
  mcRackCap: number;
  hoardCap: number;
  hoardKeep: number;
}

export const K13_DEFAULTS: Readonly<K13Params> = Object.freeze({
  futureScale: 1.07,
  kCap: 6,
  kInitPrice: 13,
  maxWinShare: 0.5,
  quickSamples: 6,
  tableSamples: 2,
  lambdaMin: 0.02,
  lambdaMax: 4,
  lambdaScale: 1.08,
  lambdaScaleBig: 0.8,
  incomeShare: 0.47,
  futureValueScale: 1.14,
  rivalWeight: 0.9,
  maxOverbid: 4,
  calibRate: 0.056,
  genericBase: 8,
  genericFace: 2.5,
  genericSd: 3,
  genericP0: 0.05,
  equityPerTile: 2.5,
  playCandidates: 4,
  playSamples: 3,
  coinBonus: 0.32,
  playMargin: 2.7,
  maxPlays: 3,
  lastTileDeny: true,
  mcRackCap: 16,
  hoardCap: 16,
  hoardKeep: 11,
});

/** Multiset of the pool as a flat letter list. */
function poolList(pool: Rack): number[] {
  const out: number[] = [];
  for (let i = 0; i < NUM_LETTERS; i++) for (let k = 0; k < pool[i]!; k++) out.push(i);
  return out;
}

/** n future draws (k fractional: floor + Bernoulli remainder), each a Rack, sampled w/o replacement. */
function drawFutures(list: readonly number[], k: number, n: number, rng: Rng): Rack[] {
  const out: Rack[] = [];
  const buf = [...list];
  for (let s = 0; s < n; s++) {
    let m = Math.floor(k);
    if (rng.float() < k - m) m++;
    m = Math.min(m, buf.length);
    const r = new Uint8Array(NUM_LETTERS);
    for (let j = 0; j < m; j++) {
      const pick = j + rng.int(0, buf.length - 1 - j);
      const tmp = buf[j]!;
      buf[j] = buf[pick]!;
      buf[pick] = tmp;
      r[buf[j]!]!++;
    }
    out.push(r);
  }
  return out;
}

function addRacks(a: Rack, b: Rack): Rack {
  const r = new Uint8Array(NUM_LETTERS);
  for (let i = 0; i < NUM_LETTERS; i++) r[i] = a[i]! + b[i]!;
  return r;
}

const P = (r: Rack): number => partitionFast(r).score;

export const createK13: PolicyFactory = (_seed, opts) => {
  const p: K13Params = { ...K13_DEFAULTS, ...(opts as Partial<K13Params> | undefined) };
  let myId = -1;
  let lambda = 1;
  let logScale = 0;
  let spent = 0;
  let wins = 0;
  const tableCache = new Map<string, number[]>();
  // calibration memory for the open auction
  let lastBid = 0;
  let lastCdfs: Float64Array[] = [];

  /** Bid CDF F(x) = P(bid <= x) for x = 0..maxX of one rival on letter li. */
  function rivalCdf(o: PlayerState, li: number, maxX: number): Float64Array {
    const F = new Float64Array(maxX + 1);
    if (o.info.isSim && o.info.simStrategy) {
      const pmf = simBidDistribution(o.info.simStrategy, li, o.balance);
      for (const [amt, pr] of pmf) for (let x = Math.min(amt, maxX); x <= maxX; x++) F[x]! += x >= amt ? pr : 0;
      for (let x = 0; x <= maxX; x++) F[x] = Math.min(1, F[x]!);
      return F;
    }
    const scale = Math.exp(logScale);
    const mu = scale * (p.genericBase + p.genericFace * VALUE[li]!);
    const sd = Math.max(0.5, scale * p.genericSd);
    const cap = Math.max(0, o.balance);
    const norm = 1 - normCdf((0.5 - mu) / sd); // mass on bids >= 1
    for (let x = 0; x <= maxX; x++) {
      if (x >= cap) {
        F[x] = 1;
        continue;
      }
      const pos = norm > 0 ? (normCdf((x + 0.5 - mu) / sd) - normCdf((0.5 - mu) / sd)) / norm : 1;
      F[x] = p.genericP0 + (1 - p.genericP0) * clamp(pos, 0, 1);
    }
    return F;
  }

  /** CDF of the max rival bid. */
  function maxCdf(cdfs: readonly Float64Array[], maxX: number, skip = -1): Float64Array {
    const G = new Float64Array(maxX + 1).fill(1);
    cdfs.forEach((F, o) => {
      if (o === skip) return;
      for (let x = 0; x <= maxX; x++) G[x]! *= F[x]!;
    });
    return G;
  }

  /** Selfish Vickrey utility of bidding b against max-rival CDF G: Σ_{x<b} P(M=x)(v - λ max(x,1)). */
  function utilities(G: Float64Array, v: number, lam: number, maxB: number, firstPrice: boolean): Float64Array {
    const U = new Float64Array(maxB + 1);
    let acc = 0;
    for (let b = 1; b <= maxB; b++) {
      const x = b - 1;
      const pm = G[x]! - (x > 0 ? G[x - 1]! : 0);
      if (firstPrice) U[b] = G[b - 1]! * (v - lam * b);
      else {
        acc += pm * (v - lam * Math.max(x, 1));
        U[b] = acc;
      }
    }
    return U;
  }

  const policy: Policy = {
    name: 'clone:k13',
    onMatchStart(view) {
      myId = view.config.myId;
      lambda = 1;
      logScale = 0;
      spent = 0;
      wins = 0;
      tableCache.clear();
      lastBid = 0;
      lastCdfs = [];
    },
    onAuctionClosed(view: MatchView, o: AuctionOutcome) {
      if (o.winnerId === myId) {
        spent += o.paid;
        wins++;
      }
      if (view.config.auctionType !== 'Vickrey' || lastCdfs.length === 0 || o.winnerId === null) return;
      const x = o.paid;
      let u: number | undefined;
      if (o.winnerId === myId) {
        const G = maxCdf(lastCdfs, lastCdfs[0]!.length - 1);
        u = ((x > 0 ? G[Math.min(x - 1, G.length - 1)]! : 0) + G[Math.min(x, G.length - 1)]!) / 2;
      } else if (x > lastBid) {
        // paid = second-highest rival bid: CDF P(at most one rival above x)
        const at = (y: number): number => {
          if (y < 0) return 0;
          const yy = Math.min(y, lastCdfs[0]!.length - 1);
          let all = 1;
          for (const F of lastCdfs) all *= F[yy]!;
          let one = 0;
          lastCdfs.forEach((F, k) => {
            let prod = 1 - F[yy]!;
            lastCdfs.forEach((F2, k2) => {
              if (k2 !== k) prod *= F2[yy]!;
            });
            one += prod;
          });
          return Math.min(1, all + one);
        };
        u = (at(x - 1) + at(x)) / 2;
      }
      if (u !== undefined) logScale = clamp(logScale + p.calibRate * (u - 0.5), Math.log(0.3), Math.log(3));
    },
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const B = auction.remainingAfter;
      const t = new Turn(view);
      const rng = ctx.rng;
      lastCdfs = [];
      lastBid = 0;
      if (B === 0) {
        t.dump();
        const simAlive = view.opponents.some((o) => o.info.isSim && o.balance > 0);
        return t.decision(p.lastTileDeny && simAlive ? t.balance : 0);
      }
      const total = Math.max(1, view.config.totalAuctions);
      const future = Math.max(0, B - 1);
      const pool = view.unseen;
      const list = poolList(pool);
      const price = wins > 0 ? spent / wins : p.kInitPrice;
      const kRaw =
        B === 1 ? 0 : clamp(p.futureScale * Math.min(p.maxWinShare * future, t.balance / Math.max(1, price)), 0, Math.min(p.kCap, future));
      // compute guard: sampled racks stay <= mcRackCap tiles (packing cost grows fast with size)
      const k = Math.min(kRaw, Math.max(B === 1 ? 0 : 1, p.mcRackCap - rackSize(t.rack)));
      const firstPrice = view.config.auctionType === 'FirstPrice';

      // ---- compute guard: a hoard of >= hoardCap tiles cashes its best partition words (largest
      // first) down to hoardKeep tiles. With coins non-binding (λ at its floor) K-13's play rule
      // never fires, and heads-up against a weak rival the rack grows to 40+ tiles.
      if (rackSize(t.rack) >= p.hoardCap) {
        const words = [...partition(t.rack).words].sort((a, b) => wordReward(b) - wordReward(a));
        for (const w of words) {
          if (rackSize(t.rack) < p.hoardKeep) break;
          t.play(w);
        }
      }
      // ---- play vs hold on shared futures (B == 1: k = 0, i.e. the exact current rack)
      {
        const F = B === 1 ? [new Uint8Array(NUM_LETTERS)] : drawFutures(list, k, p.playSamples, rng);
        let base = F.reduce((s, f) => s + P(addRacks(t.rack, f)), 0) / F.length;
        for (let n = 0; n < p.maxPlays; n++) {
          let best = -Infinity;
          let pick: string | undefined;
          let pickHold = 0;
          for (const w of topWords(t.rack, 2, p.playCandidates)) {
            const rest = rackMinusWord(t.rack, w.word);
            const hold = F.reduce((s, f) => s + P(addRacks(rest, f)), 0) / F.length;
            const gain = hold + w.reward * (1 + p.coinBonus * lambda) - (base + p.playMargin);
            if (gain > best) {
              best = gain;
              pick = w.word;
              pickHold = hold;
            }
          }
          if (pick === undefined || best <= 0) break;
          t.play(pick);
          base = pickHold;
        }
      }
      const balance = t.balance;
      if (balance <= 0) return t.decision(0);

      // ---- value of the open letter (CRN)
      let value: number;
      let meanP: number;
      if (B === 1) {
        meanP = partition(t.rack).score;
        value = partition(rackPlus(t.rack, li)).score - meanP;
      } else {
        const F = drawFutures(list, k, p.quickSamples, rng);
        let sv = 0;
        let sp = 0;
        for (const f of F) {
          const base = P(addRacks(t.rack, f));
          sp += base;
          sv += P(addRacks(rackPlus(t.rack, li), f)) - base;
        }
        value = sv / F.length;
        meanP = sp / F.length;
      }
      value = Math.max(0, value);

      // ---- rival models
      const maxX = Math.max(1, Math.floor(balance));
      const opps = view.opponents;
      const cdfs = opps.map((o) => rivalCdf(o, li, maxX));
      lastCdfs = cdfs;
      const G = maxCdf(cdfs, maxX);

      // ---- λ by bisection over the remaining auctions (cached letter values per rack)
      if (future > 0) {
        // letter values for the λ equation: refreshed only when the rack changes
        const key = rackKey(t.rack);
        let vals = tableCache.get(key);
        if (!vals) {
          const F = drawFutures(list, Math.round(k), p.tableSamples, rng);
          const base = F.map((f) => P(addRacks(t.rack, f)));
          vals = new Array<number>(NUM_LETTERS).fill(0);
          for (let i = 0; i < NUM_LETTERS; i++) {
            if (pool[i]! === 0) continue;
            let s = 0;
            F.forEach((f, j) => (s += P(addRacks(rackPlus(t.rack, i), f)) - base[j]!));
            vals[i] = Math.max(0, s / F.length);
          }
          if (tableCache.size > 256) tableCache.clear();
          tableCache.set(key, vals);
        }
        let U = 0;
        for (let i = 0; i < NUM_LETTERS; i++) U += pool[i]!;
        // cumulative spend tables S_i[b] = Σ_{x<b} P(M_i = x) max(x, 1)
        const spendTabs: Array<Float64Array | null> = [];
        for (let i = 0; i < NUM_LETTERS; i++) {
          if (pool[i]! === 0 || vals[i]! <= 0) {
            spendTabs.push(null);
            continue;
          }
          const Gi = maxCdf(
            opps.map((o) => rivalCdf(o, i, maxX)),
            maxX,
          );
          const S = new Float64Array(maxX + 1);
          for (let b = 1; b <= maxX; b++) {
            const x = b - 1;
            const pm = Gi[x]! - (x > 0 ? Gi[x - 1]! : 0);
            S[b] = S[b - 1]! + pm * Math.max(x, 1);
          }
          spendTabs.push(S);
        }
        const W = balance + (p.incomeShare * meanP * future) / total;
        const spendAt = (lam: number): number => {
          let s = 0;
          for (let i = 0; i < NUM_LETTERS; i++) {
            const S = spendTabs[i];
            if (!S) continue;
            const b = Math.min(maxX, Math.floor((p.futureValueScale * vals![i]!) / lam));
            s += ((future * pool[i]!) / U) * S[Math.max(0, b)]!;
          }
          return s;
        };
        let lo = Math.log(p.lambdaMin);
        let hi = Math.log(p.lambdaMax);
        if (spendAt(Math.exp(lo)) <= W) lambda = Math.exp(lo);
        else if (spendAt(Math.exp(hi)) >= W) lambda = Math.exp(hi);
        else {
          for (let it = 0; it < 24; it++) {
            const mid = (lo + hi) / 2;
            if (spendAt(Math.exp(mid)) > W) lo = mid;
            else hi = mid;
          }
          lambda = Math.exp((lo + hi) / 2);
        }
        lambda *= view.config.players.length >= 7 ? p.lambdaScaleBig : p.lambdaScale;
      } else {
        lambda = p.lambdaMin;
      }

      // ---- selfish bid, then placement-weighted price driving (Vickrey)
      const Uself = utilities(G, value, lambda, maxX, firstPrice);
      let selfBid = 0;
      for (let b = 1; b <= maxX; b++) if (Uself[b]! > Uself[selfBid]! + 1e-12) selfBid = b;
      let bid = selfBid;
      if (!firstPrice && opps.length > 0) {
        const sigma = Math.sqrt(16 + (1600 * future) / total);
        const eq = (o: PlayerState, tiles: number) => o.score + lambda * o.balance + p.equityPerTile * tiles;
        const meEq = eq(view.me, rackSize(t.rack));
        const phis = opps.map((o) => {
          const z = (meEq - eq(o, rackSize(o.knownHeld) + o.hiddenUnknown)) / sigma;
          return Math.exp((-z * z) / 2);
        });
        const sumPhi = phis.reduce((a, b) => a + b, 0) || 1;
        const med = opps.map((_, oi) => {
          const Go = maxCdf(cdfs, maxX, oi);
          let m = 0;
          while (m < maxX && Go[m]! < 0.5) m++;
          return m;
        });
        let bestObj = -Infinity;
        for (let b = selfBid; b <= Math.min(maxX, selfBid + p.maxOverbid); b++) {
          let obj = Uself[b]!;
          opps.forEach((_, oi) => {
            const pAbove = 1 - cdfs[oi]![b]!;
            obj += ((p.rivalWeight * phis[oi]!) / sumPhi) * lambda * pAbove * Math.max(0, b - med[oi]!);
          });
          if (obj > bestObj + 1e-12) {
            bestObj = obj;
            bid = b;
          }
        }
      }
      lastBid = bid;
      return t.decision(bid);
    },
  };
  return policy;
};
