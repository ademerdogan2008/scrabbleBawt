// Shared helpers for the opponent-zoo clones and trick bots (03-02).
//
// Everything here is deterministic: noise comes from the per-seat ctx.rng, the word engine is the
// shared getEngine() instance, and exact packing is bounded by a node limit (deterministic) plus a
// wall-clock safety limit (timeLimitMs) so no decide() can stall the way the hoarder baseline's
// unbounded packExact can (02-01 follow-up). A time-limited search still returns a valid packing.
//
// Market tables (COMPETITORS.md §4.10):
//   NOW_PRICE      median paid per letter, Nov 7 lobby (sims present)
//   ALLREAL_PRICE  median paid per letter, Oct 28 six-real tables
//   FIELD_MEDIAN   Karthik field.json median (all-real, Oct 25) + 17 phase multipliers
import { IS_VOWEL, NUM_LETTERS, VALUE, idx, wordReward } from '../../core/letters.js';
import { rackKey, type Rack } from '../../core/rack.js';
import type { Rng } from '../../core/rng.js';
import { simMaxBid } from '../../core/simbots.js';
import type { AuctionInfo, Decision, MatchView, PlayerState } from '../../core/types.js';
import { getEngine, type PackResult, type SingleWord } from '../../engine/index.js';

// ------------------------------------------------------------------------------------ tables

const table = (s: string): readonly number[] => {
  const out = new Array<number>(NUM_LETTERS).fill(0);
  for (const tok of s.trim().split(/\s+/)) out[idx(tok[0]!)] = Number(tok.slice(1));
  return Object.freeze(out);
};

export const NOW_PRICE = table('A6 B10 C11 D8 E7 F12 G7 H13 I6 J22 K16 L6 M10 N5 O6 P10 Q21 R6 S6 T5 U7 V11 W12 X23 Y14 Z25');
export const ALLREAL_PRICE = table(
  'A11 B17 C19 D14 E11 F20 G13 H22 I10 J30 K22 L11 M18 N11 O10 P18 Q31 R11 S12 T10 U10 V18.5 W19 X32 Y21 Z40',
);
export const FIELD_MEDIAN = table(
  'A11.7 B18.9 C19.8 D16.2 E12.6 F21.6 G14.4 H23.4 I11.7 J33.3 K26.1 L11.7 M18.9 N11.7 O10.8 P18.0 Q32.4 R12.6 S13.5 T11.7 U11.7 V19.8 W20.7 X34.2 Y22.5 Z43.2',
);
export const FIELD_PHASE_MULT: readonly number[] = Object.freeze([
  1.124, 1.053, 1.011, 1.017, 0.988, 0.989, 0.98, 1.0, 1.005, 1.015, 1.0, 1.022, 1.014, 1.046, 1.094, 1.151, 1.09,
]);

/** Karthik's 17-bucket phase multiplier for progress in [0, 1]. */
export function fieldPhaseMult(progress: number): number {
  const k = Math.min(FIELD_PHASE_MULT.length - 1, Math.max(0, Math.floor(progress * FIELD_PHASE_MULT.length)));
  return FIELD_PHASE_MULT[k]!;
}

// ------------------------------------------------------------------------------- match clock

/** 0-based letter index of the auction (throws on a malformed letter). */
export function letterOf(auction: AuctionInfo): number {
  const li = idx(auction.letter);
  if (li < 0) throw new Error(`zoo: bad auction letter '${auction.letter}'`);
  return li;
}

/** COMPETITORS convention phase = (r-1)/totalAuctions = index/totalAuctions, in [0, 1). */
export function progressOf(view: MatchView, auction: AuctionInfo): number {
  return auction.index / Math.max(1, view.config.totalAuctions);
}

/** Auctions left INCLUDING the open one (Lala's T; 1 = final auction). */
export function auctionsLeft(auction: AuctionInfo): number {
  return auction.remainingAfter + 1;
}

// --------------------------------------------------------------------------------- numerics

/** Legal bid: integer, >= 0, <= balance (NaN/Infinity-safe). */
export function clampBid(x: number, balance: number): number {
  if (!Number.isFinite(x) || x <= 0 || balance <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(balance), Math.floor(x)));
}

/** Standard normal draw (Box-Muller on the seeded stream). */
export function gauss(rng: Rng): number {
  const u = Math.max(rng.float(), 1e-12);
  const v = rng.float();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 erf). */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp((-z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// ------------------------------------------------------------------------------------- racks

export function rackSize(r: Rack): number {
  let n = 0;
  for (let i = 0; i < NUM_LETTERS; i++) n += r[i]!;
  return n;
}

export function rackPlus(r: Rack, li: number, n = 1): Rack {
  const out = new Uint8Array(r);
  out[li] = out[li]! + n;
  return out;
}

/** rack - word letters (throws if the word does not fit; callers only pass fitting words). */
export function rackMinusWord(r: Rack, word: string): Rack {
  const out = new Uint8Array(r);
  for (let k = 0; k < word.length; k++) {
    const i = word.charCodeAt(k) - 65;
    if (out[i]! === 0) throw new Error(`zoo: word ${word} does not fit the rack`);
    out[i]!--;
  }
  return out;
}

export function rackMinusWords(r: Rack, words: readonly string[]): Rack {
  let out: Rack = r;
  for (const w of words) out = rackMinusWord(out, w);
  return out === r ? new Uint8Array(r) : out;
}

export function vowelCount(r: Rack): number {
  let n = 0;
  for (let i = 0; i < NUM_LETTERS; i++) if (IS_VOWEL[i]) n += r[i]!;
  return n;
}

// ------------------------------------------------------------------------------------ engine

const NODE_LIMIT = 60_000;
const TIME_LIMIT_MS = 20;

export interface PartitionOpts {
  minLen?: number;
  /** Wall-clock cap for packExact (default 20 ms); the node cap keeps results deterministic. */
  timeLimitMs?: number;
  nodeLimit?: number;
}

/** Above this many tiles partition() uses the fast packer (enumeration alone gets slow). */
export const EXACT_MAX_TILES = 24;

/**
 * Best partition, bounded: exact branch & bound (node + time limit) up to EXACT_MAX_TILES tiles,
 * the fast greedy + beam packer above (a 40-60 tile hoard would otherwise cost 100+ ms just to
 * enumerate its fitting classes). Always a valid set of disjoint words.
 */
export function partition(rack: Rack, opts: PartitionOpts = {}): PackResult {
  const { packer } = getEngine();
  if (rackSize(rack) > EXACT_MAX_TILES) return packer.packFast(rack, { minLen: opts.minLen ?? 2 });
  return packer.packExact(rack, {
    minLen: opts.minLen ?? 2,
    nodeLimit: opts.nodeLimit ?? NODE_LIMIT,
    timeLimitMs: opts.timeLimitMs ?? TIME_LIMIT_MS,
  });
}

/** Fast (greedy + beam) packing score; never better than exact. */
export function partitionFast(rack: Rack, minLen = 2): PackResult {
  return getEngine().packer.packFast(rack, { minLen });
}

export function bestWord(rack: Rack, minLen = 2): SingleWord | undefined {
  return getEngine().index.bestSingleWord(rack, minLen);
}

// Best single word per (rack, minLen), memoized: valuations that enumerate rack+E extensions
// (Lionel's pot, Lala's plans) revisit the same racks every auction.
const BEST_CACHE_CAP = 120_000;
const bestCache = new Map<string, SingleWord | null>();

export function bestWordCached(rack: Rack, minLen = 2): SingleWord | undefined {
  const key = `${minLen}|${rackKey(rack)}`;
  const hit = bestCache.get(key);
  if (hit !== undefined) return hit ?? undefined;
  const w = getEngine().index.bestSingleWord(rack, minLen) ?? null;
  if (bestCache.size >= BEST_CACHE_CAP) bestCache.delete(bestCache.keys().next().value!);
  bestCache.set(key, w);
  return w ?? undefined;
}

export function bestRewardCached(rack: Rack, minLen = 2): number {
  return bestWordCached(rack, minLen)?.reward ?? 0;
}

/** Top-n fitting classes by reward (ties: class id), as representative words. */
export function topWords(rack: Rack, minLen: number, n: number): SingleWord[] {
  const { index } = getEngine();
  const ids: number[] = [];
  index.forEachSubClass(rack, minLen, (id) => ids.push(id));
  const reward = index.classes.reward;
  ids.sort((a, b) => reward[b]! - reward[a]! || a - b);
  return ids.slice(0, n).map((id) => ({ word: index.classWord(id), reward: reward[id]!, classId: id }));
}

/** Greedily cash words of length >= minLen (best reward first), at most maxWords. */
export function cashGreedy(rack: Rack, minLen: number, maxWords = 4): string[] {
  const out: string[] = [];
  let r = rack;
  for (let k = 0; k < maxWords; k++) {
    const w = bestWord(r, minLen);
    if (!w) break;
    out.push(w.word);
    r = rackMinusWord(r, w.word);
  }
  return out;
}

// ------------------------------------------------------------------------------ the table

export function rivals(view: MatchView): readonly PlayerState[] {
  return view.opponents;
}

export function realRivals(view: MatchView): PlayerState[] {
  return view.opponents.filter((p) => !p.info.isSim);
}

export function simRivals(view: MatchView): PlayerState[] {
  return view.opponents.filter((p) => p.info.isSim);
}

/** Highest possible bid of any sim at this letter (sims bid face-based with jitter <= 2). */
export function maxSimBid(view: MatchView, li: number): number {
  let m = 0;
  for (const p of view.opponents) {
    if (!p.info.isSim || !p.info.simStrategy) continue;
    m = Math.max(m, simMaxBid(p.info.simStrategy, li, p.balance));
  }
  return m;
}

/** Highest public balance among rivals. */
export function richestRival(view: MatchView): number {
  let m = 0;
  for (const p of view.opponents) m = Math.max(m, p.balance);
  return m;
}

/** Highest bid any rival can place: sims by formula, real bots by balance. */
export function maxRivalCapacity(view: MatchView, li: number): number {
  let m = 0;
  for (const p of view.opponents) {
    if (p.info.isSim && p.info.simStrategy) m = Math.max(m, simMaxBid(p.info.simStrategy, li, p.balance));
    else m = Math.max(m, p.balance);
  }
  return m;
}

/** Rival with the highest score (ties: lower id). */
export function leadingRival(view: MatchView): PlayerState | undefined {
  let best: PlayerState | undefined;
  for (const p of view.opponents) {
    if (!best || p.score > best.score || (p.score === best.score && p.info.id < best.info.id)) best = p;
  }
  return best;
}

// -------------------------------------------------------------------------------- decisions

/**
 * Mutable per-decide working state: words are applied to a local rack/balance copy in order, so
 * the bid is computed on the post-word state exactly as the server will see it.
 */
export class Turn {
  rack: Rack;
  balance: number;
  readonly words: string[] = [];
  constructor(view: MatchView) {
    this.rack = new Uint8Array(view.me.rack);
    this.balance = view.me.balance;
  }
  play(word: string): void {
    this.rack = rackMinusWord(this.rack, word);
    this.balance += wordReward(word);
    this.words.push(word);
  }
  playAll(words: readonly string[]): void {
    for (const w of words) this.play(w);
  }
  dump(opts?: PartitionOpts): void {
    this.playAll(partition(this.rack, opts).words);
  }
  decision(bid: number): Decision {
    return { words: this.words, bid: clampBid(bid, this.balance) };
  }
}

/** Letters are face-weighted: price lookup helper. */
export function priceOf(t: readonly number[], li: number): number {
  return t[li]!;
}

export { VALUE, IS_VOWEL };
