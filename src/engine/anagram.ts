// AnagramIndex: a trie over the sorted-letter keys of all anagram classes, stored in typed arrays
// (CSR edge lists, nodes in DFS preorder). Enumerating the classes that fit a rack is a DFS that
// decrements rack counts in place; because keys are sorted, each class is reached exactly once.
import { NUM_LETTERS } from '../core/letters.js';
import type { Rack } from '../core/rack.js';
import type { ClassTable, Dictionary } from './dictionary.js';

/** Growable Int32 output buffer (reused across calls to avoid allocation). */
export class IntBuffer {
  data: Int32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Int32Array(capacity);
  }
  push(v: number): void {
    if (this.length === this.data.length) this.grow(this.length + 1);
    this.data[this.length++] = v;
  }
  grow(min: number): void {
    let cap = this.data.length * 2;
    while (cap < min) cap *= 2;
    const next = new Int32Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

export interface SingleWord {
  word: string;
  reward: number;
  classId: number;
}

export class AnagramIndex {
  readonly dict: Dictionary;
  readonly classes: ClassTable;
  readonly nodeCount: number;
  /** Edges of node n are edgeStart[n] .. edgeStart[n+1], ascending by letter. */
  readonly edgeStart: Int32Array;
  readonly edgeLetter: Uint8Array;
  readonly edgeChild: Int32Array;
  /** Class id ending at node, or -1. */
  readonly term: Int32Array;
  /** Longest key length (absolute) in the subtree rooted at node. */
  readonly maxLen: Uint8Array;
  /** Bit l set when node has an outgoing edge labelled l. */
  readonly childMask: Int32Array;

  // DFS scratch (instance fields keep the inner loop allocation-free).
  private readonly work = new Uint8Array(NUM_LETTERS);
  private out: IntBuffer = new IntBuffer(4096);
  private minLen = 2;
  private pivot = -1;
  private bestId = -1;
  private bestLen = 0;
  private readonly stNode = new Int32Array(64);
  private readonly stEdge = new Int32Array(64);
  private readonly stMask = new Int32Array(64);
  private readonly stLetter = new Uint8Array(64);
  private readonly pool: IntBuffer[] = [];
  private poolDepth = 0;

  constructor(dict: Dictionary) {
    this.dict = dict;
    const classes = dict.classes;
    this.classes = classes;
    const ids = Array.from({ length: classes.count }, (_, i) => i);
    const keys = classes.keys;
    ids.sort((a, b) => (keys[a]! < keys[b]! ? -1 : keys[a]! > keys[b]! ? 1 : 0));

    // Build in preorder from sorted keys using the longest common prefix with the previous key.
    let totalChars = 0;
    for (const k of keys) totalChars += k.length;
    const cap = totalChars + 1;
    const parent = new Int32Array(cap);
    const letter = new Uint8Array(cap);
    const term = new Int32Array(cap).fill(-1);
    const depthOf = new Uint8Array(cap);
    let n = 1; // node 0 = root
    parent[0] = -1;
    const path = new Int32Array(64); // path[d] = node at depth d for the previous key
    path[0] = 0;
    let prev = '';
    for (const id of ids) {
      const key = keys[id]!;
      let l = 0;
      const lim = Math.min(prev.length, key.length);
      while (l < lim && prev.charCodeAt(l) === key.charCodeAt(l)) l++;
      for (let d = l; d < key.length; d++) {
        const node = n++;
        parent[node] = path[d]!;
        letter[node] = key.charCodeAt(d) - 65;
        depthOf[node] = d + 1;
        path[d + 1] = node;
      }
      term[path[key.length]!] = id;
      prev = key;
    }
    this.nodeCount = n;
    const edgeStart = new Int32Array(n + 1);
    for (let v = 1; v < n; v++) edgeStart[parent[v]! + 1]!++;
    for (let v = 0; v < n; v++) edgeStart[v + 1]! += edgeStart[v]!;
    const fill = edgeStart.slice(0, n);
    const edgeLetter = new Uint8Array(Math.max(1, n - 1));
    const edgeChild = new Int32Array(Math.max(1, n - 1));
    for (let v = 1; v < n; v++) {
      const e = fill[parent[v]!]!++;
      edgeLetter[e] = letter[v]!;
      edgeChild[e] = v;
    }
    // Children have larger preorder ids than parents: one reverse pass computes subtree maxima.
    const maxLen = new Uint8Array(n);
    for (let v = n - 1; v >= 0; v--) {
      if (term[v]! >= 0 && depthOf[v]! > maxLen[v]!) maxLen[v] = depthOf[v]!;
      if (v > 0) {
        const p = parent[v]!;
        if (maxLen[v]! > maxLen[p]!) maxLen[p] = maxLen[v]!;
      }
    }
    this.edgeStart = edgeStart;
    this.edgeLetter = edgeLetter;
    this.edgeChild = edgeChild;
    this.term = term.slice(0, n);
    this.maxLen = maxLen;
    const childMask = new Int32Array(n);
    for (let v = 1; v < n; v++) childMask[parent[v]!]! |= 1 << letter[v]!;
    this.childMask = childMask;
  }

  // ---------------------------------------------------------------- class accessors

  get classCount(): number {
    return this.classes.count;
  }
  classLen(id: number): number {
    return this.classes.len[id]!;
  }
  classReward(id: number): number {
    return this.classes.reward[id]!;
  }
  classBase(id: number): number {
    return this.classes.base[id]!;
  }
  classKey(id: number): string {
    return this.classes.keys[id]!;
  }
  /** Representative word: the lexicographically smallest word of the class. */
  classWord(id: number): string {
    return this.dict.classWord(id);
  }
  classWords(id: number): string[] {
    return this.dict.classWords(id);
  }
  /** 26-count view into the shared buffer. Do not mutate. */
  classCounts(id: number): Uint8Array {
    return this.dict.classCounts(id);
  }

  // ---------------------------------------------------------------- enumeration

  /**
   * Append to `out` every class whose letters fit in `rack` with length >= minLen. If `pivot` is a
   * letter index (0..25), only classes containing that letter are reported. Returns the number of
   * ids appended. `rack` is not modified.
   */
  collect(rack: Rack, minLen: number, out: IntBuffer, pivot = -1): number {
    const start = out.length;
    const work = this.work;
    for (let i = 0; i < NUM_LETTERS; i++) work[i] = rack[i]!;
    let mask = 0;
    for (let i = 0; i < NUM_LETTERS; i++) if (work[i]! > 0) mask |= 1 << i;
    this.out = out;
    this.minLen = minLen;
    if (pivot >= 0) {
      if (work[pivot]! > 0) {
        this.pivot = pivot;
        this.dfsBefore(0, 0, mask);
      }
    } else {
      this.dfsIter(mask);
    }
    return out.length - start;
  }

  /** Calls cb(classId) once for every class that fits `rack` with length >= minLen. */
  forEachSubClass(rack: Rack, minLen: number, cb: (classId: number) => void): void {
    const depth = this.poolDepth++;
    const buf = (this.pool[depth] ??= new IntBuffer(4096));
    buf.length = 0;
    try {
      const n = this.collect(rack, minLen, buf);
      const data = buf.data;
      for (let k = 0; k < n; k++) cb(data[k]!);
    } finally {
      this.poolDepth--;
    }
  }

  /** All class ids that fit `rack` (DFS order = ascending sorted key). */
  subClasses(rack: Rack, minLen = 2): number[] {
    const buf = new IntBuffer(1024);
    const n = this.collect(rack, minLen, buf);
    return Array.from(buf.data.subarray(0, n));
  }

  /** Number of fitting classes without materialising them. */
  countSubClasses(rack: Rack, minLen = 2): number {
    const buf = (this.pool[this.poolDepth] ??= new IntBuffer(4096));
    buf.length = 0;
    return this.collect(rack, minLen, buf);
  }

  /** Iterative full enumeration (same semantics as dfs(0, 0, mask)), output pushed inline. */
  private dfsIter(mask: number): void {
    const out = this.out;
    let data = out.data;
    let len = out.length;
    const work = this.work;
    const term = this.term;
    const maxLen = this.maxLen;
    const childMask = this.childMask;
    const edgeStart = this.edgeStart;
    const edgeLetter = this.edgeLetter;
    const edgeChild = this.edgeChild;
    const minLen = this.minLen;
    const stNode = this.stNode;
    const stEdge = this.stEdge;
    const stMask = this.stMask;
    const stLetter = this.stLetter;
    let sp = 0;
    stNode[0] = 0;
    stEdge[0] = edgeStart[0]!;
    stMask[0] = mask;
    for (;;) {
      const node = stNode[sp]!;
      const end = edgeStart[node + 1]!;
      const m0 = stMask[sp]!;
      const d1 = sp + 1;
      let e = stEdge[sp]!;
      let next = -1;
      for (; e < end; e++) {
        const c = edgeLetter[e]!;
        const left = work[c]!;
        if (left === 0) continue;
        const child = edgeChild[e]!;
        if (maxLen[child]! < minLen) continue;
        const m = left === 1 ? m0 & ~(1 << c) : m0;
        const t = term[child]!;
        if (t >= 0 && d1 >= minLen) {
          if (len === data.length) {
            out.length = len;
            out.grow(len + 1);
            data = out.data;
          }
          data[len++] = t;
        }
        if ((childMask[child]! & m) === 0) continue;
        stEdge[sp] = e + 1;
        stLetter[sp] = c;
        work[c] = left - 1;
        stNode[d1] = child;
        stEdge[d1] = edgeStart[child]!;
        stMask[d1] = m;
        next = d1;
        break;
      }
      if (next >= 0) {
        sp = next;
        continue;
      }
      if (sp === 0) break;
      sp--;
      work[stLetter[sp]!]!++;
    }
    out.length = len;
  }

  // `mask` = letters still available in this.work. A child is entered only if it can still report
  // something: it is a terminal at a reportable depth, or one of its edge letters is available.
  private dfs(node: number, depth: number, mask: number): void {
    const t = this.term[node]!;
    if (t >= 0 && depth >= this.minLen) this.out.push(t);
    const work = this.work;
    const term = this.term;
    const maxLen = this.maxLen;
    const childMask = this.childMask;
    const minLen = this.minLen;
    const d1 = depth + 1;
    const end = this.edgeStart[node + 1]!;
    for (let e = this.edgeStart[node]!; e < end; e++) {
      const c = this.edgeLetter[e]!;
      const left = work[c]!;
      if (left === 0) continue;
      const child = this.edgeChild[e]!;
      if (maxLen[child]! < minLen) continue;
      const m = left === 1 ? mask & ~(1 << c) : mask;
      if ((childMask[child]! & m) === 0) {
        if (term[child]! >= 0 && d1 >= minLen) this.out.push(term[child]!);
        continue;
      }
      work[c] = left - 1;
      this.dfs(child, d1, m);
      work[c] = left;
    }
  }

  /** Pivot not taken yet: only letters <= pivot may follow (keys are sorted). */
  private dfsBefore(node: number, depth: number, mask: number): void {
    const work = this.work;
    const pivot = this.pivot;
    const end = this.edgeStart[node + 1]!;
    for (let e = this.edgeStart[node]!; e < end; e++) {
      const c = this.edgeLetter[e]!;
      if (c > pivot) break;
      const left = work[c]!;
      if (left === 0) continue;
      const child = this.edgeChild[e]!;
      if (this.maxLen[child]! < this.minLen) continue;
      const m = left === 1 ? mask & ~(1 << c) : mask;
      work[c] = left - 1;
      if (c === pivot) this.dfs(child, depth + 1, m);
      else this.dfsBefore(child, depth + 1, m);
      work[c] = left;
    }
  }

  // ---------------------------------------------------------------- word choice

  /**
   * Module-exact sim word chooser: the longest word whose letters fit `rack`; among equal lengths
   * the lexicographically smallest word. undefined when the rack holds fewer than minLen tiles or
   * nothing fits.
   */
  findBestPlayable(rack: Rack, minLen: number): string | undefined {
    let total = 0;
    for (let i = 0; i < NUM_LETTERS; i++) total += rack[i]!;
    if (total < minLen) return undefined;
    const work = this.work;
    for (let i = 0; i < NUM_LETTERS; i++) work[i] = rack[i]!;
    this.minLen = Math.max(minLen, 2);
    this.bestId = -1;
    this.bestLen = 0;
    this.dfsLongest(0, 0);
    return this.bestId < 0 ? undefined : this.dict.classWord(this.bestId);
  }

  private dfsLongest(node: number, depth: number): void {
    const t = this.term[node]!;
    if (t >= 0 && depth >= this.minLen) {
      if (depth > this.bestLen) {
        this.bestLen = depth;
        this.bestId = t;
      } else if (depth === this.bestLen && this.dict.classWord(t) < this.dict.classWord(this.bestId)) {
        this.bestId = t;
      }
    }
    const work = this.work;
    const end = this.edgeStart[node + 1]!;
    for (let e = this.edgeStart[node]!; e < end; e++) {
      const c = this.edgeLetter[e]!;
      if (work[c] === 0) continue;
      const child = this.edgeChild[e]!;
      const ml = this.maxLen[child]!;
      if (ml < this.minLen || ml < this.bestLen) continue;
      work[c]!--;
      this.dfsLongest(child, depth + 1);
      work[c]!++;
    }
  }

  /** Highest-reward single word (ties: lexicographically smallest word). */
  bestSingleWord(rack: Rack, minLen = 2): SingleWord | undefined {
    const buf = (this.pool[this.poolDepth] ??= new IntBuffer(4096));
    buf.length = 0;
    const n = this.collect(rack, minLen, buf);
    const reward = this.classes.reward;
    let best = -1;
    for (let k = 0; k < n; k++) {
      const id = buf.data[k]!;
      if (
        best < 0 ||
        reward[id]! > reward[best]! ||
        (reward[id] === reward[best] && this.dict.classWord(id) < this.dict.classWord(best))
      )
        best = id;
    }
    if (best < 0) return undefined;
    return { word: this.dict.classWord(best), reward: reward[best]!, classId: best };
  }
}
