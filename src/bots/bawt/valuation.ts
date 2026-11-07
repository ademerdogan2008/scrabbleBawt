// Monte Carlo letter valuation with common random numbers (STRATEGY §7.3, COMPETITORS §3.1).
//
// A scenario is one random completion of the future: shuffle the unseen pool (bag + rivals'
// unrevealed start tiles, open letter excluded); the first `futureUseful` letters are the usable
// future auctions. Each future letter ℓ is won with probability pWin[ℓ] from the PRICE MODEL
// (never from our own past win share: that feeds back into an underbidding spiral, §9.3), up to H
// acquisitions. Every value in one decision is computed on the same scenarios, so differences
// (with/without the letter, play/hold) have low variance.
//
//   V_mc(L) = mean_s [Pack(R + L + F_s) - Pack(R + F_s)]        (exact packer: unbiased, §7.3)
//
// Pack = Packer.packExact with a deterministic node limit plus a time limit as a safety net.
// The packer's memo is shared across scenarios (sub-racks repeat), which keeps S=16 cheap.
//
// rollout (ablation 'bawt-rollout'): budget-aware futures. In each scenario the field's max bid on
// each future letter is drawn from the field model; we win iff our pacing bid beats the draw and
// we can afford it, paying the draw (Vickrey). V(R, B) = mean_s Pack(R ∪ F_s(B)); the letter's
// break-even price p* = max p with V(R + L, B - p) >= V(R, B) (bisection).
import { NUM_LETTERS } from '../../core/letters.js';
import type { Rack } from '../../core/rack.js';
import type { Rng } from '../../core/rng.js';
import type { Packer } from '../../engine/packer.js';

export interface PackLimits {
  nodeLimit: number;
  timeLimitMs: number;
  minLen?: number;
  /** Absolute deadline (ms on `now`): each call's time limit is cut to the time left (>= 0.5 ms). */
  deadlineAt?: number;
  now?: () => number;
}

/** packExact options for one call under `lim` (time limit shrinks toward the deadline). */
export function packOpts(lim: PackLimits): { nodeLimit: number; timeLimitMs: number; minLen?: number } {
  let t = lim.timeLimitMs;
  if (lim.deadlineAt !== undefined && lim.now) t = Math.max(0.5, Math.min(t, lim.deadlineAt - lim.now()));
  return lim.minLen !== undefined ? { nodeLimit: lim.nodeLimit, timeLimitMs: t, minLen: lim.minLen } : { nodeLimit: lim.nodeLimit, timeLimitMs: t };
}

/** Best packing value under limits (never unbounded). */
export function packValue(packer: Packer, rack: Rack, lim: PackLimits): number {
  return packer.packExact(rack, packOpts(lim)).score;
}

/** Flattened unseen pool (letter indices, A..Z order). */
export function poolOf(unseen: Rack): number[] {
  const arr: number[] = [];
  for (let i = 0; i < NUM_LETTERS; i++) for (let k = 0; k < unseen[i]!; k++) arr.push(i);
  return arr;
}

export interface Scenario {
  /** Future auction letters in order (useful ones only). */
  letters: Uint8Array;
  /** CRN uniforms, one per future letter (win draws / field max draws). */
  u: Float64Array;
}

/** S scenarios of the future auction sequence. */
export function sampleScenarios(unseen: Rack, futureUseful: number, S: number, rng: Rng): Scenario[] {
  const pool = poolOf(unseen);
  const m = Math.max(0, Math.min(futureUseful, pool.length));
  const out: Scenario[] = [];
  for (let s = 0; s < S; s++) {
    // partial Fisher-Yates: first m positions
    for (let a = 0; a < m; a++) {
      const j = a + rng.int(0, pool.length - 1 - a);
      const t = pool[a]!;
      pool[a] = pool[j]!;
      pool[j] = t;
    }
    const letters = Uint8Array.from(pool.slice(0, m));
    const u = new Float64Array(m);
    for (let a = 0; a < m; a++) u[a] = rng.float();
    out.push({ letters, u });
  }
  return out;
}

/** Future acquisitions of a scenario: win letter a iff u[a] < pWin[letter], at most H. */
export function acquisitions(sc: Scenario, pWin: Float64Array, H: number): Rack {
  const F = new Uint8Array(NUM_LETTERS);
  let added = 0;
  for (let a = 0; a < sc.letters.length && added < H; a++) {
    const l = sc.letters[a]!;
    if (sc.u[a]! < pWin[l]!) {
      F[l]!++;
      added++;
    }
  }
  return F;
}

function addInto(dst: Uint8Array, a: Rack, b: Rack): Uint8Array {
  for (let i = 0; i < NUM_LETTERS; i++) dst[i] = a[i]! + b[i]!;
  return dst;
}

export interface McResult {
  /** Mean marginal value (points). */
  value: number;
  /** Mean Pack(R + F) (expected end value without the letter). */
  base: number;
  samples: number;
  /** Standard error of the marginal value. */
  se: number;
}

/**
 * V_mc(L) over the given acquisition racks (CRN). Stops when the node budget is spent (after at
 * least minSamples; deterministic) or when `deadline()` returns true (safety net; may yield 0
 * samples, in which case the caller falls back to the table value).
 */
export function mcMarginal(
  packer: Packer,
  rack: Rack,
  li: number,
  futures: readonly Rack[],
  lim: PackLimits,
  deadline: () => boolean,
  minSamples = 4,
  nodeBudget = Infinity,
): McResult & { nodes: number } {
  const buf = new Uint8Array(NUM_LETTERS);
  let sum = 0;
  let sum2 = 0;
  let base = 0;
  let n = 0;
  let nodes = 0;
  for (const F of futures) {
    // deterministic work cap (search nodes) first; the clock is only a safety net
    if (deadline() || (n >= minSamples && nodes >= nodeBudget)) break;
    addInto(buf, rack, F);
    const r0 = packer.packExact(buf, packOpts(lim));
    buf[li]!++;
    const r1 = packer.packExact(buf, packOpts(lim));
    nodes += r0.nodes + r1.nodes;
    const v0 = r0.score;
    const v1 = r1.score;
    const d = v1 - v0;
    sum += d;
    sum2 += d * d;
    base += v0;
    n++;
  }
  if (n === 0) return { value: 0, base: 0, samples: 0, se: Infinity, nodes };
  const mean = sum / n;
  const varr = n > 1 ? Math.max(0, (sum2 - n * mean * mean) / (n - 1)) : 0;
  return { value: mean, base: base / n, samples: n, se: Math.sqrt(varr / n), nodes };
}

/** Expected end value E_s[Pack(rack + F_s)] on the given futures. */
export function meanPack(packer: Packer, rack: Rack, futures: readonly Rack[], lim: PackLimits): number {
  if (futures.length === 0) return packValue(packer, rack, lim);
  const buf = new Uint8Array(NUM_LETTERS);
  let s = 0;
  for (const F of futures) s += packValue(packer, addInto(buf, rack, F), lim);
  return s / futures.length;
}

// ------------------------------------------------------------------------------------ rollout

export interface RolloutInput {
  packer: Packer;
  rack: Rack;
  li: number;
  balance: number;
  scenarios: readonly Scenario[];
  /** Our pacing bid per letter (coins). */
  bidOf: Float64Array;
  /** Field max-bid CDF per letter at the future phase. */
  fieldCdf: readonly Float64Array[];
  H: number;
  lim: PackLimits;
  deadline: () => boolean;
}

/** Inverse-CDF draw of the field max from uniform u. */
function drawMax(G: Float64Array, u: number): number {
  for (let x = 0; x < G.length; x++) if (G[x]! >= u) return x;
  return G.length - 1;
}

/** Acquisitions of a scenario under a budget (Vickrey: pay the field max, at least 1). */
export function budgetAcquisitions(sc: Scenario, inp: RolloutInput, budget: number): Rack {
  const F = new Uint8Array(NUM_LETTERS);
  let b = budget;
  let added = 0;
  for (let a = 0; a < sc.letters.length && added < inp.H; a++) {
    const l = sc.letters[a]!;
    const m = drawMax(inp.fieldCdf[l]!, sc.u[a]!);
    const price = Math.max(1, m);
    if (inp.bidOf[l]! > m && b >= price) {
      F[l]!++;
      b -= price;
      added++;
    }
  }
  return F;
}

/** V(R, B) on the scenarios. */
function rolloutValue(inp: RolloutInput, rack: Rack, budget: number, n: number): number {
  const buf = new Uint8Array(NUM_LETTERS);
  let s = 0;
  for (let k = 0; k < n; k++) s += packValue(inp.packer, addInto(buf, rack, budgetAcquisitions(inp.scenarios[k]!, inp, budget)), inp.lim);
  return s / Math.max(1, n);
}

/** Break-even price p* = max p in [0, balance] with V(R+L, B-p) >= V(R, B). -1 = worthless. */
export function rolloutBreakEven(inp: RolloutInput): { price: number; gain0: number; samples: number } {
  let n = inp.scenarios.length;
  const withL = new Uint8Array(inp.rack);
  withL[inp.li]!++;
  const v0 = rolloutValue(inp, inp.rack, inp.balance, n);
  if (inp.deadline()) n = Math.min(n, 4);
  const gain = (p: number) => rolloutValue(inp, withL, inp.balance - p, n) - v0;
  const g0 = gain(0);
  if (g0 <= 0) return { price: -1, gain0: g0, samples: n };
  let lo = 0;
  let hi = Math.floor(inp.balance);
  if (gain(hi) >= 0) return { price: hi, gain0: g0, samples: n };
  while (hi - lo > 1) {
    if (inp.deadline()) break;
    const mid = (lo + hi) >> 1;
    if (gain(mid) >= 0) lo = mid;
    else hi = mid;
  }
  return { price: lo, gain0: g0, samples: n };
}
