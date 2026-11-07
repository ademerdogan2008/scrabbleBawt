// Word packing: choose a multiset of dictionary words whose combined letters fit in a rack,
// maximizing the total reward. Letters may stay unused. Reward depends only on the anagram class,
// so the search runs over classes and reports class representatives.
//
// packExact — depth-first branch & bound:
//   * Root: enumerate every fitting class once. For each letter l, m2[l] = 2 × the best length
//     multiplier of any fitting class containing l (0 = dead letter, stripped from the rack).
//     Since reward(c) <= Σ_{l∈c} VALUE[l] × mult(c), ub(R) = floor(Σ_l R[l]·VALUE[l]·m2[l] / 2)
//     is a valid upper bound for every sub-rack R. For |R| < 7 each m2 is also capped by
//     2 × mult(|R|) (no word can be longer than the rack).
//   * Canonical pivot branching: the pivot is the rack's highest-value letter (ties: the letter
//     contained in fewest classes). Either some further word contains the pivot (one branch per
//     fitting class containing it) or no further word does (remove every copy of the pivot).
//     This partitions the solution space, so each sub-problem f(R) depends only on R.
//   * Children are sorted by optimistic bound reward(c) + ub(R − c); the loop stops at the first
//     child whose bound cannot beat max(alpha, best).
//   * Fail-soft alpha search with a bounded LRU memo keyed by the rack: entries are either exact
//     values (with the best move, used for reconstruction) or proven upper bounds. The memo is
//     shared across calls, so repeated sub-racks (Monte Carlo valuation) are nearly free.
//   * The incumbent comes from packFast; if it already meets the root bound the search is skipped.
//   * nodeLimit / timeLimitMs abort the search and return the best complete solution seen
//     (exact=false).
//
// packFast — reward-greedy with a first-word beam:
//   The fitting classes are counting-sorted by reward (desc) into contiguous arrays (ids, letter
//   masks, lengths). Greedy = one pass over that list taking each class while it still fits
//   (mask + length + count test). The beam forces each of the fastBeam highest-reward classes as
//   the first word, completes greedily and keeps the best; a first word is skipped when
//   reward + ub(rest) cannot beat the best packing found. Never worse than plain greedy.
//   An exact root result already in the cache is returned instead (it is at least as good).
import { NUM_LETTERS, VALUE } from '../core/letters.js';
import type { Rack } from '../core/rack.js';
import { AnagramIndex, IntBuffer } from './anagram.js';
import type { ClassTable } from './dictionary.js';

export interface PackResult {
  score: number;
  /** Submittable words (class representatives); disjoint, jointly contained in the rack. */
  words: string[];
  classIds: number[];
  /** True when the score is proven optimal. */
  exact: boolean;
  /** Search nodes expanded (0 for cache hits / fast results). */
  nodes: number;
}

export interface PackOptions {
  minLen?: number;
  /** Abort packExact after this many search nodes (default 2,000,000). */
  nodeLimit?: number;
  /** Abort packExact after this many milliseconds (default unlimited). */
  timeLimitMs?: number;
  /** Clock for timeLimitMs (default performance.now). */
  now?: () => number;
}

export interface PackerOptions {
  /** Max memo entries per minLen (default 200,000). Root results use a quarter of this. */
  cacheSize?: number;
  /** packFast: first-word candidates taken from the top of the reward order (default 16). */
  fastBeam?: number;
}

const MOVE_BITS = 19;
const MOVE_RANGE = 1 << MOVE_BITS; // memo entry = (value*2 + exact) * MOVE_RANGE + (move + 2)
const DISCARD = MOVE_RANGE - 1; // child sentinel for "pivot unused"
const BMAX = 1023;
const DEFAULT_NODE_LIMIT = 2_000_000;
const DEFAULT_CACHE = 200_000;

/** 2 × length multiplier: 2,2,2,3,4,5,6 for len 1..7+. */
function mult2(len: number): number {
  return len <= 3 ? 2 : len >= 7 ? 6 : len - 1;
}

function rackKey26(r: Uint8Array): string {
  return String.fromCharCode(
    r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, r[5]!, r[6]!, r[7]!, r[8]!, r[9]!, r[10]!, r[11]!, r[12]!,
    r[13]!, r[14]!, r[15]!, r[16]!, r[17]!, r[18]!, r[19]!, r[20]!, r[21]!, r[22]!, r[23]!, r[24]!, r[25]!,
  );
}

interface RootEntry {
  score: number;
  classIds: number[];
  exact: boolean;
}

class Lru<V> {
  readonly map = new Map<string, V>();
  constructor(readonly cap: number) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    const m = this.map;
    if (m.has(k)) m.delete(k);
    else if (m.size >= this.cap) m.delete(m.keys().next().value!);
    m.set(k, v);
  }
}

interface ClassTables {
  classMask: Int32Array;
  letterStart: Int32Array;
  letters: Uint8Array;
  pivotOrder: Uint8Array;
}

const TABLES = new WeakMap<AnagramIndex, ClassTables>();

/** Per-index static tables (letter masks, packed letter lists, pivot order), built once. */
function classTables(index: AnagramIndex): ClassTables {
  const hit = TABLES.get(index);
  if (hit) return hit;
  const C = index.classes;
  const classMask = new Int32Array(C.count);
  const letterStart = new Int32Array(C.count + 1);
  const perLetter = new Int32Array(NUM_LETTERS);
  let nLetters = 0;
  for (let id = 0; id < C.count; id++) {
    let m = 0;
    const o = id * NUM_LETTERS;
    for (let i = 0; i < NUM_LETTERS; i++) {
      if (C.counts[o + i]! > 0) {
        m |= 1 << i;
        nLetters++;
        perLetter[i]!++;
      }
    }
    classMask[id] = m;
    letterStart[id + 1] = nLetters;
  }
  const letters = new Uint8Array(nLetters);
  for (let id = 0, k = 0; id < C.count; id++) {
    const o = id * NUM_LETTERS;
    for (let i = 0; i < NUM_LETTERS; i++) if (C.counts[o + i]! > 0) letters[k++] = i;
  }
  const order = Array.from({ length: NUM_LETTERS }, (_, i) => i);
  order.sort((a, b) => VALUE[b]! - VALUE[a]! || perLetter[a]! - perLetter[b]! || a - b);
  const t = { classMask, letterStart, letters, pivotOrder: Uint8Array.from(order) };
  TABLES.set(index, t);
  return t;
}

export class Packer {
  readonly index: AnagramIndex;
  private readonly C: ClassTable;
  private readonly classMask: Int32Array;
  /** Letters of each class as a packed list: letters[letterStart[id] .. letterStart[id+1]). */
  private readonly letterStart: Int32Array;
  private readonly letters: Uint8Array;
  /** Pivot preference: letters by VALUE desc, then by number of classes containing them asc. */
  private readonly pivotOrder: Uint8Array;
  private readonly cacheSize: number;
  private readonly fastBeam: number;
  private readonly memos = new Map<number, Lru<number>>();
  private readonly roots = new Map<number, Lru<RootEntry>>();

  // ---- search state (instance fields keep the recursion allocation-free)
  private readonly rack = new Uint8Array(NUM_LETTERS);
  private readonly m2 = new Uint8Array(NUM_LETTERS);
  private readonly vm2 = new Uint16Array(NUM_LETTERS); // VALUE[l] * m2[l]
  private total = 0;
  private lin2 = 0;
  private minLen = 2;
  private memo!: Lru<number>;
  private readonly stack = new IntBuffer(1 << 14);
  private readonly rootList = new IntBuffer(1 << 14);
  private readonly sortBuf = new IntBuffer(1 << 14);
  private nodes = 0;
  private nodeLimit = DEFAULT_NODE_LIMIT;
  private deadline = Infinity;
  private now: () => number = () => performance.now();
  private aborted = false;
  // best complete solution seen (for aborted searches)
  private path = new Int32Array(256);
  private pathLen = 0;
  private pathReward = 0;
  private bestTotal = -1;
  private bestPath: number[] = [];
  private readonly bestTailRack = new Uint8Array(NUM_LETTERS);
  private bestTailValue = 0;
  private readonly fastRack = new Uint8Array(NUM_LETTERS);
  // packFast candidate list (reward-sorted): ids, letter masks, lengths.
  private fIds = new Int32Array(1 << 14);
  private fMask = new Int32Array(1 << 14);
  private fLen = new Uint8Array(1 << 14);
  private bucket = new Int32Array(1024);

  constructor(index: AnagramIndex, opts: PackerOptions = {}) {
    this.index = index;
    const C = index.classes;
    this.C = C;
    if (C.count >= DISCARD) throw new Error(`Packer: too many classes (${C.count})`);
    this.cacheSize = Math.max(16, opts.cacheSize ?? DEFAULT_CACHE);
    this.fastBeam = Math.max(1, opts.fastBeam ?? 16);
    const t = classTables(index);
    this.classMask = t.classMask;
    this.letterStart = t.letterStart;
    this.letters = t.letters;
    this.pivotOrder = t.pivotOrder;
  }

  /** Total reward of the best packing (packExact with default limits). */
  value(rack: Rack, opts: PackOptions = {}): number {
    return this.packExact(rack, opts).score;
  }

  /** Drop all memoized results. */
  clearCache(): void {
    this.memos.clear();
    this.roots.clear();
  }

  // ======================================================================== exact

  packExact(rack: Rack, opts: PackOptions = {}): PackResult {
    const minLen = Math.max(2, opts.minLen ?? 2);
    const rawKey = rackKey26(rack);
    const roots = this.rootsFor(minLen);
    const cached = roots.get(rawKey);
    if (cached && cached.exact) return this.result(cached.score, cached.classIds, true, 0);

    this.minLen = minLen;
    this.memo = this.memoFor(minLen);
    const n = this.prepareRoot(rack, minLen);
    const ids = this.rootList.data;
    const fast = this.fastFromList(ids, n);
    const rootUb = this.upperBound();
    if (fast.score >= rootUb) {
      roots.set(rawKey, { score: fast.score, classIds: fast.classIds, exact: true });
      return this.result(fast.score, fast.classIds, true, 0);
    }

    this.nodes = 0;
    this.nodeLimit = opts.nodeLimit ?? DEFAULT_NODE_LIMIT;
    this.now = opts.now ?? (() => performance.now());
    this.deadline = opts.timeLimitMs !== undefined ? this.now() + opts.timeLimitMs : Infinity;
    this.aborted = false;
    this.pathLen = 0;
    this.pathReward = 0;
    this.bestTotal = fast.score;
    this.bestPath = fast.classIds;
    this.bestTailValue = 0;
    this.bestTailRack.fill(0);
    this.stack.length = 0;

    const r = this.solve(fast.score);
    const nodes = this.nodes;
    if (this.aborted) {
      const tail = this.walkMemo(this.bestTailRack, this.bestTailValue, false);
      const out =
        tail !== undefined
          ? { score: this.bestTotal, classIds: this.bestPath.concat(tail) }
          : { score: fast.score, classIds: fast.classIds };
      return this.result(out.score, out.classIds, false, nodes);
    }
    let score = fast.score;
    let classIds = fast.classIds;
    if ((r & 1) === 1 && r >> 1 > fast.score) {
      score = r >> 1;
      classIds = this.walkMemo(this.rack, score, true)!;
    }
    roots.set(rawKey, { score, classIds, exact: true });
    return this.result(score, classIds, true, nodes);
  }

  private result(score: number, classIds: number[], exact: boolean, nodes: number): PackResult {
    return { score, words: classIds.map((id) => this.index.classWord(id)), classIds: [...classIds], exact, nodes };
  }

  private memoFor(minLen: number): Lru<number> {
    let m = this.memos.get(minLen);
    if (!m) this.memos.set(minLen, (m = new Lru<number>(this.cacheSize)));
    return m;
  }

  private rootsFor(minLen: number): Lru<RootEntry> {
    let m = this.roots.get(minLen);
    if (!m) this.roots.set(minLen, (m = new Lru<RootEntry>(Math.max(16, this.cacheSize >> 2))));
    return m;
  }

  /**
   * Enumerate fitting classes into rootList, compute per-letter multipliers m2, strip dead
   * letters and load this.rack/total/lin2. Returns the number of fitting classes.
   */
  private prepareRoot(rack: Rack, minLen: number): number {
    const list = this.rootList;
    list.length = 0;
    const n = this.index.collect(rack, minLen, list);
    const m2 = this.m2;
    m2.fill(0);
    const ids = list.data;
    const len = this.C.len;
    const mask = this.classMask;
    for (let k = 0; k < n; k++) {
      const id = ids[k]!;
      const m = mult2(len[id]!);
      let bits = mask[id]!;
      while (bits !== 0) {
        const l = 31 - Math.clz32(bits & -bits);
        bits &= bits - 1;
        if (m2[l]! < m) m2[l] = m;
      }
    }
    let total = 0;
    let lin2 = 0;
    for (let l = 0; l < NUM_LETTERS; l++) {
      const c = m2[l] === 0 ? 0 : rack[l]!;
      this.rack[l] = c;
      this.vm2[l] = VALUE[l]! * m2[l]!;
      total += c;
      lin2 += c * this.vm2[l]!;
    }
    this.total = total;
    this.lin2 = lin2;
    return n;
  }

  /** Upper bound for the current this.rack. */
  private upperBound(): number {
    if (this.total < this.minLen) return 0;
    if (this.total >= 7) return this.lin2 >> 1;
    return this.smallBound(this.total, -1, 0);
  }

  /** Bound for (this.rack − class `id`, or − all copies of letter `drop`) with `total` tiles left. */
  private smallBound(total: number, id: number, drop: number, rack: Uint8Array = this.rack): number {
    if (total < this.minLen) return 0;
    const cap = mult2(total);
    const counts = this.C.counts;
    const o = id * NUM_LETTERS;
    let s = 0;
    for (let l = 0; l < NUM_LETTERS; l++) {
      let c = rack[l]!;
      if (c === 0) continue;
      if (id >= 0) c -= counts[o + l]!;
      else if (id === -2 && l === drop) c = 0;
      if (c === 0) continue;
      const m = this.m2[l]!;
      s += c * VALUE[l]! * (m < cap ? m : cap);
    }
    return s >> 1;
  }

  private pickPivot(rack: Uint8Array): number {
    const order = this.pivotOrder;
    for (let k = 0; k < NUM_LETTERS; k++) {
      const l = order[k]!;
      if (rack[l]! > 0) return l;
    }
    return -1;
  }

  /** Record an exact sub-result for the abort fallback. */
  private noteExact(v: number): void {
    const t = this.pathReward + v;
    if (t > this.bestTotal) {
      this.bestTotal = t;
      this.bestPath = Array.from(this.path.subarray(0, this.pathLen));
      this.bestTailRack.set(this.rack);
      this.bestTailValue = v;
    }
  }

  /**
   * f(this.rack) with fail-soft alpha semantics. Returns value*2 + exactFlag:
   * exact => value == f(rack); otherwise f(rack) <= value <= alpha.
   */
  private solve(alpha: number): number {
    const nodes = ++this.nodes;
    if (nodes > this.nodeLimit || ((nodes & 255) === 0 && this.now() > this.deadline)) this.aborted = true;
    if (this.aborted) return 0;
    const total = this.total;
    if (total < this.minLen) {
      this.noteExact(0);
      return 1;
    }
    const rack = this.rack;
    const key = rackKey26(rack);
    const e = this.memo.get(key);
    let ub = BMAX;
    if (e !== undefined) {
      const vx = Math.floor(e / MOVE_RANGE);
      const v = vx >> 1;
      if ((vx & 1) === 1) {
        this.noteExact(v);
        return vx;
      }
      if (v <= alpha) return vx;
      ub = v;
    }
    const nodeUb = total >= 7 ? this.lin2 >> 1 : this.smallBound(total, -1, 0);
    if (nodeUb < ub) ub = nodeUb;
    if (ub === 0) {
      this.noteExact(0);
      return 1;
    }
    if (ub <= alpha) return ub * 2;

    // ---- children
    const pivot = this.pickPivot(rack);
    const stack = this.stack;
    const base = stack.length;
    const n = this.index.collect(rack, this.minLen, stack, pivot);
    let data = stack.data;
    const C = this.C;
    const counts = C.counts;
    const reward = C.reward;
    const len = C.len;
    const vm2 = this.vm2;
    const lin2 = this.lin2;
    let maxPruned = -1;
    let m = 0;
    for (let k = 0; k < n; k++) {
      const id = data[base + k]!;
      const t = total - len[id]!;
      let b: number;
      if (t >= 7) {
        let w2 = 0;
        const o = id * NUM_LETTERS;
        for (let ls = this.letterStart[id]!, le = this.letterStart[id + 1]!; ls < le; ls++) {
          const l = this.letters[ls]!;
          w2 += counts[o + l]! * vm2[l]!;
        }
        b = reward[id]! + ((lin2 - w2) >> 1);
      } else {
        b = reward[id]! + this.smallBound(t, id, 0);
      }
      if (b > ub) b = ub;
      if (b <= alpha) {
        if (b > maxPruned) maxPruned = b;
        continue;
      }
      data[base + m++] = (BMAX - b) * MOVE_RANGE + id;
    }
    {
      const pc = rack[pivot]!;
      const t = total - pc;
      let b = t >= 7 ? (lin2 - pc * vm2[pivot]!) >> 1 : this.smallBound(t, -2, pivot);
      if (b > ub) b = ub;
      if (b <= alpha) {
        if (b > maxPruned) maxPruned = b;
      } else {
        if (base + m >= data.length) {
          stack.length = base + m;
          stack.grow(base + m + 1);
          data = stack.data;
        }
        data[base + m++] = (BMAX - b) * MOVE_RANGE + DISCARD;
      }
    }
    stack.length = base + m;
    if (m > 1) data.subarray(base, base + m).sort();

    let best = -1;
    let bestMove = -2;
    for (let k = 0; k < m; k++) {
      const packed = this.stack.data[base + k]!;
      const b = BMAX - (packed >>> MOVE_BITS);
      const id = packed & (MOVE_RANGE - 1);
      const local = best > alpha ? best : alpha;
      if (b <= local) {
        if (b > maxPruned) maxPruned = b;
        break;
      }
      let r: number;
      let gain: number;
      if (id === DISCARD) {
        const pc = rack[pivot]!;
        rack[pivot] = 0;
        this.total = total - pc;
        this.lin2 = lin2 - pc * vm2[pivot]!;
        r = this.solve(local);
        rack[pivot] = pc;
        gain = 0;
      } else {
        const o = id * NUM_LETTERS;
        let w2 = 0;
        for (let ls = this.letterStart[id]!, le = this.letterStart[id + 1]!; ls < le; ls++) {
          const l = this.letters[ls]!;
          const c = counts[o + l]!;
          rack[l]! -= c;
          w2 += c * vm2[l]!;
        }
        gain = reward[id]!;
        this.total = total - len[id]!;
        this.lin2 = lin2 - w2;
        if (this.pathLen === this.path.length) {
          const p = new Int32Array(this.path.length * 2);
          p.set(this.path);
          this.path = p;
        }
        this.path[this.pathLen++] = id;
        this.pathReward += gain;
        r = this.solve(local - gain);
        this.pathLen--;
        this.pathReward -= gain;
        for (let ls = this.letterStart[id]!, le = this.letterStart[id + 1]!; ls < le; ls++) {
          const l = this.letters[ls]!;
          rack[l]! += counts[o + l]!;
        }
      }
      this.total = total;
      this.lin2 = lin2;
      if (this.aborted) {
        this.stack.length = base;
        return 0;
      }
      const val = gain + (r >> 1);
      if ((r & 1) === 1) {
        if (val > best) {
          best = val;
          bestMove = id === DISCARD ? -1 : id;
        }
      } else if (val > maxPruned) maxPruned = val;
      if (best >= ub) break;
    }
    this.stack.length = base;

    if (best > alpha) {
      this.memo.set(key, (best * 2 + 1) * MOVE_RANGE + (bestMove + 2));
      this.noteExact(best);
      return best * 2 + 1;
    }
    const u = best > maxPruned ? best : maxPruned;
    const ubOut = u < 0 ? 0 : u;
    this.memo.set(key, ubOut * 2 * MOVE_RANGE);
    return ubOut * 2;
  }

  /**
   * Follow memoized best moves from `start` (value v) down to an empty solution. With `resolve`,
   * missing/evicted entries are recomputed by an unlimited search; without it, returns undefined.
   */
  private walkMemo(start: Uint8Array, v: number, resolve: boolean): number[] | undefined {
    const r = new Uint8Array(start);
    const out: number[] = [];
    const C = this.C;
    let guard = 0;
    while (v > 0) {
      if (++guard > 10_000) throw new Error('Packer.walkMemo: no progress');
      const key = rackKey26(r);
      let e = this.memo.map.get(key);
      const ok = (x: number | undefined) => x !== undefined && Math.floor(x / MOVE_RANGE) === v * 2 + 1;
      if (!ok(e)) {
        if (!resolve) return undefined;
        this.rack.set(r);
        let total = 0;
        let lin2 = 0;
        for (let l = 0; l < NUM_LETTERS; l++) {
          total += r[l]!;
          lin2 += r[l]! * this.vm2[l]!;
        }
        this.total = total;
        this.lin2 = lin2;
        this.nodeLimit = Infinity;
        this.deadline = Infinity;
        this.aborted = false;
        this.stack.length = 0;
        const res = this.solve(v - 1);
        if (res !== v * 2 + 1) throw new Error(`Packer.walkMemo: inconsistent memo (${res >> 1} != ${v})`);
        e = this.memo.map.get(key);
        if (!ok(e)) throw new Error('Packer.walkMemo: entry missing after re-solve');
      }
      const move = (e! % MOVE_RANGE) - 2;
      if (move === -1) {
        r[this.pickPivot(r)] = 0;
      } else if (move >= 0) {
        const o = move * NUM_LETTERS;
        for (let l = 0; l < NUM_LETTERS; l++) r[l]! -= C.counts[o + l]!;
        out.push(move);
        v -= C.reward[move]!;
      } else {
        throw new Error('Packer.walkMemo: leaf with positive value');
      }
    }
    return out;
  }

  // ======================================================================== fast

  packFast(rack: Rack, opts: { minLen?: number } = {}): PackResult {
    const minLen = Math.max(2, opts.minLen ?? 2);
    const roots = this.roots.get(minLen);
    if (roots !== undefined && roots.map.size > 0) {
      const cached = roots.map.get(rackKey26(rack));
      if (cached !== undefined) return this.result(cached.score, cached.classIds, cached.exact, 0);
    }
    this.minLen = minLen;
    const n = this.prepareRoot(rack, minLen);
    const fast = this.fastFromList(this.rootList.data, n);
    const exact = fast.score >= this.upperBound();
    return this.result(fast.score, fast.classIds, exact, 0);
  }

  /** Greedy + first-word beam over the given fitting classes (uses this.rack as the root rack). */
  private fastFromList(ids: Int32Array, n: number): { score: number; classIds: number[] } {
    if (n === 0) return { score: 0, classIds: [] };
    const C = this.C;
    const reward = C.reward;
    // Counting sort by reward (desc); ties keep enumeration (sorted-key) order. Deterministic.
    const sb = this.sortBuf;
    if (sb.data.length < n) sb.grow(n);
    const sorted = sb.data;
    let maxR = 0;
    for (let k = 0; k < n; k++) {
      const rw = reward[ids[k]!]!;
      if (rw > maxR) maxR = rw;
    }
    if (this.bucket.length < maxR + 2) this.bucket = new Int32Array(maxR + 2);
    const bucket = this.bucket;
    bucket.fill(0, 0, maxR + 2);
    for (let k = 0; k < n; k++) bucket[maxR - reward[ids[k]!]! + 1]!++;
    for (let b = 1; b <= maxR + 1; b++) bucket[b]! += bucket[b - 1]!;
    for (let k = 0; k < n; k++) {
      const id = ids[k]!;
      sorted[bucket[maxR - reward[id]!]!++] = id;
    }
    const view = sorted.subarray(0, n);
    if (this.fIds.length < n) this.growFast(n);
    const fIds = this.fIds;
    const fMask = this.fMask;
    const fLen = this.fLen;
    for (let k = 0; k < n; k++) {
      const id = view[k]!;
      fIds[k] = id;
      fMask[k] = this.classMask[id]!;
      fLen[k] = C.len[id]!;
    }
    const counts = C.counts;
    const vm2 = this.vm2;
    const total = this.total;
    const lin2 = this.lin2;
    let bestScore = 0;
    let bestIds: number[] = [];
    const picked: number[] = [];
    const rootUb = this.upperBound();
    const beam = Math.min(this.fastBeam, n);
    for (let k = 0; k < beam && bestScore < rootUb; k++) {
      const first = fIds[k]!;
      const o = first * NUM_LETTERS;
      const ls0 = this.letterStart[first]!;
      const le = this.letterStart[first + 1]!;
      // Skip first words whose optimistic completion cannot beat the best packing so far.
      const t = total - fLen[k]!;
      let b: number;
      if (t >= 7) {
        let w2 = 0;
        for (let ls = ls0; ls < le; ls++) {
          const l = this.letters[ls]!;
          w2 += counts[o + l]! * vm2[l]!;
        }
        b = reward[first]! + ((lin2 - w2) >> 1);
      } else b = reward[first]! + this.smallBound(t, first, 0);
      if (b <= bestScore) continue;
      const r = this.fastRack;
      r.set(this.rack);
      for (let ls = ls0; ls < le; ls++) {
        const l = this.letters[ls]!;
        r[l]! -= counts[o + l]!;
      }
      picked.length = 0;
      picked.push(first);
      const score = reward[first]! + this.greedy(r, n, picked);
      if (score > bestScore) {
        bestScore = score;
        bestIds = picked.slice();
      }
    }
    return { score: bestScore, classIds: bestIds };
  }

  private growFast(min: number): void {
    let cap = this.fIds.length * 2;
    while (cap < min) cap *= 2;
    this.fIds = new Int32Array(cap);
    this.fMask = new Int32Array(cap);
    this.fLen = new Uint8Array(cap);
  }

  /** One reward-ordered pass over the candidate list taking each class while it fits `r`. */
  private greedy(r: Uint8Array, n: number, picked: number[]): number {
    const C = this.C;
    const counts = C.counts;
    const fIds = this.fIds;
    const fMask = this.fMask;
    const fLen = this.fLen;
    const letters = this.letters;
    const letterStart = this.letterStart;
    const minLen = this.minLen;
    let total = 0;
    let rmask = 0;
    for (let l = 0; l < NUM_LETTERS; l++) {
      total += r[l]!;
      if (r[l]! > 0) rmask |= 1 << l;
    }
    if (total < minLen) return 0;
    let score = 0;
    let notR = ~rmask;
    for (let k = 0; k < n; k++) {
      if ((fMask[k]! & notR) !== 0 || fLen[k]! > total) continue;
      const id = fIds[k]!;
      const o = id * NUM_LETTERS;
      const ls0 = letterStart[id]!;
      const le = letterStart[id + 1]!;
      for (;;) {
        let fits = true;
        for (let ls = ls0; ls < le; ls++) {
          const l = letters[ls]!;
          if (counts[o + l]! > r[l]!) {
            fits = false;
            break;
          }
        }
        if (!fits) break;
        for (let ls = ls0; ls < le; ls++) {
          const l = letters[ls]!;
          if ((r[l]! -= counts[o + l]!) === 0) notR |= 1 << l;
        }
        total -= fLen[k]!;
        score += C.reward[id]!;
        picked.push(id);
        if ((fMask[k]! & notR) !== 0 || fLen[k]! > total) break;
      }
      if (total < minLen) break;
    }
    return score;
  }
}
