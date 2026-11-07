import { describe, expect, it } from 'vitest';
import { LETTERS, NUM_LETTERS, wordReward } from '../../src/core/letters.js';
import { emptyRack, rackCanSpell, rackFromWord, rackToString, type Rack } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import { AnagramIndex, IntBuffer } from '../../src/engine/anagram.js';
import { loadDictionary } from '../../src/engine/dictionary.js';
import { randomBagRack } from './helpers.js';

const dict = loadDictionary();
const index = new AnagramIndex(dict);
const C = dict.classes;

// Precomputed per-class letter masks so the linear-scan oracle stays fast (semantics unchanged).
const CLASS_MASK = new Int32Array(C.count);
for (let id = 0; id < C.count; id++) {
  let m = 0;
  for (let i = 0; i < NUM_LETTERS; i++) if (C.counts[id * NUM_LETTERS + i]! > 0) m |= 1 << i;
  CLASS_MASK[id] = m;
}
function maskOf(rack: Rack): number {
  let m = 0;
  for (let i = 0; i < NUM_LETTERS; i++) if (rack[i]! > 0) m |= 1 << i;
  return m;
}

/** Linear-scan oracle: every class whose counts fit the rack. */
function oracleSubClasses(rack: Rack, minLen: number, pivot = -1): number[] {
  const out: number[] = [];
  const notRack = ~maskOf(rack);
  outer: for (let id = 0; id < C.count; id++) {
    if (C.len[id]! < minLen || (CLASS_MASK[id]! & notRack) !== 0) continue;
    const o = id * NUM_LETTERS;
    if (pivot >= 0 && C.counts[o + pivot] === 0) continue;
    for (let i = 0; i < NUM_LETTERS; i++) if (C.counts[o + i]! > rack[i]!) continue outer;
    out.push(id);
  }
  return out;
}

// Module wordsByLength() with each word's letter counts precomputed (pure speed-up of the port).
const BY_LEN = dict.byLengthDesc;
const BY_LEN_COUNTS = new Uint8Array(BY_LEN.length * NUM_LETTERS);
const BY_LEN_MASK = new Int32Array(BY_LEN.length);
BY_LEN.forEach((w, k) => {
  for (let j = 0; j < w.length; j++) {
    const i = w.charCodeAt(j) - 65;
    BY_LEN_COUNTS[k * NUM_LETTERS + i]!++;
    BY_LEN_MASK[k]! |= 1 << i;
  }
});

/** Literal port of the module's findBestPlayable over wordsByLength(). */
function moduleFindBestPlayable(rackMap: Map<string, number>, minLen: number): string | undefined {
  let total = 0;
  for (const n of rackMap.values()) total += n;
  if (total < minLen) return undefined;
  const rack = emptyRack();
  for (const [ch, n] of rackMap) rack[ch.charCodeAt(0) - 65] = n;
  const notRack = ~maskOf(rack);
  for (let k = 0; k < BY_LEN.length; k++) {
    const word = BY_LEN[k]!;
    if (word.length < minLen) break;
    if (word.length > total) continue;
    if ((BY_LEN_MASK[k]! & notRack) !== 0) continue; // a letter the rack lacks entirely
    let ok = true;
    for (let i = 0; i < NUM_LETTERS; i++) {
      if (BY_LEN_COUNTS[k * NUM_LETTERS + i]! > rack[i]!) {
        ok = false;
        break;
      }
    }
    if (ok) return word;
  }
  return undefined;
}

function toMap(rack: Rack): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < NUM_LETTERS; i++) if (rack[i]! > 0) m.set(LETTERS[i]!, rack[i]!);
  return m;
}

const sortNum = (a: number[]) => [...a].sort((x, y) => x - y);

describe('AnagramIndex', () => {
  it('builds a compact trie', () => {
    console.log(`trie nodes: ${index.nodeCount}, classes: ${index.classCount}`);
    expect(index.nodeCount).toBeGreaterThan(C.count);
    let terms = 0;
    for (let n = 0; n < index.nodeCount; n++) if (index.term[n]! >= 0) terms++;
    expect(terms).toBe(C.count);
  });

  it('class accessors', () => {
    const id = dict.classOf('RETAINS');
    expect(index.classLen(id)).toBe(7);
    expect(index.classReward(id)).toBe(wordReward('RETAINS'));
    expect(index.classBase(id)).toBe(7);
    expect(index.classKey(id)).toBe('AEINRST');
    expect(index.classWord(id)).toBe(index.classWords(id)[0]);
    expect(index.classWords(id)).toContain('STAINER');
    expect(rackToString(index.classCounts(id))).toBe('AEINRST');
  });

  it('forEachSubClass equals a linear-scan oracle on 500 bag racks of 1..35 tiles', () => {
    const rng = new Rng(42);
    let total = 0;
    for (let t = 0; t < 500; t++) {
      const size = 1 + (t % 35);
      const rack = randomBagRack(rng, size);
      const before = rackToString(rack);
      const minLen = t % 3 === 0 ? 3 : 2;
      const got: number[] = [];
      index.forEachSubClass(rack, minLen, (id) => got.push(id));
      expect(rackToString(rack)).toBe(before); // not mutated
      const want = oracleSubClasses(rack, minLen);
      expect(new Set(got).size).toBe(got.length); // each exactly once
      expect(sortNum(got)).toEqual(want);
      expect(index.countSubClasses(rack, minLen)).toBe(want.length);
      total += want.length;
    }
    expect(total).toBeGreaterThan(10_000);
  });

  it('pivot-constrained collect equals the oracle', () => {
    const rng = new Rng(7);
    const buf = new IntBuffer(16);
    for (let t = 0; t < 200; t++) {
      const rack = randomBagRack(rng, 3 + (t % 25));
      const pivot = rng.int(0, 25);
      buf.length = 0;
      const n = index.collect(rack, 2, buf, pivot);
      const got = Array.from(buf.data.subarray(0, n));
      expect(sortNum(got)).toEqual(oracleSubClasses(rack, 2, pivot));
    }
  });

  it('subClasses defaults to minLen 2 and handles empty racks', () => {
    expect(index.subClasses(emptyRack())).toEqual([]);
    const ids = index.subClasses(rackFromWord('QAT'));
    const words = ids.map((id) => index.classWord(id)).sort();
    expect(words).toContain('QAT');
    expect(words).toContain('AT');
    for (const id of ids) expect(rackCanSpell(rackFromWord('QAT'), index.classWord(id))).toBe(true);
  });

  it('nested forEachSubClass is reentrant', () => {
    const outer = rackFromWord('STARE');
    const pairs: string[] = [];
    index.forEachSubClass(outer, 2, (a) => {
      index.forEachSubClass(index.classCounts(a), 2, (b) => pairs.push(`${a}:${b}`));
    });
    let expected = 0;
    for (const a of oracleSubClasses(outer, 2)) expected += oracleSubClasses(index.classCounts(a), 2).length;
    expect(pairs.length).toBe(expected);
  });

  it('findBestPlayable equals the literal module port on 5,000 racks (sizes 0..30, minLen 2/3)', () => {
    const rng = new Rng(2024);
    let found = 0;
    for (let t = 0; t < 5000; t++) {
      const size = t % 31;
      const rack = randomBagRack(rng, size);
      const minLen = t & 1 ? 3 : 2;
      const got = index.findBestPlayable(rack, minLen);
      const want = moduleFindBestPlayable(toMap(rack), minLen);
      if (got !== want) throw new Error(`rack ${rackToString(rack)} minLen ${minLen}: ${got} != ${want}`);
      if (got) found++;
    }
    expect(found).toBeGreaterThan(3500);
  });

  it('findBestPlayable edge cases', () => {
    expect(index.findBestPlayable(emptyRack(), 2)).toBeUndefined();
    expect(index.findBestPlayable(emptyRack(), 0)).toBeUndefined();
    expect(index.findBestPlayable(rackFromWord('A'), 2)).toBeUndefined();
    expect(index.findBestPlayable(rackFromWord('QQ'), 2)).toBeUndefined();
    expect(index.findBestPlayable(rackFromWord('AA'), 3)).toBeUndefined();
    expect(index.findBestPlayable(rackFromWord('AA'), 1)).toBe('AA');
    expect(index.findBestPlayable(rackFromWord('AEINRST'), 2)).toBe(moduleFindBestPlayable(toMap(rackFromWord('AEINRST')), 2));
    expect(index.findBestPlayable(rackFromWord('AEINRST'), 8)).toBeUndefined();
  });

  it('bestSingleWord maximizes reward', () => {
    const rng = new Rng(99);
    for (let t = 0; t < 200; t++) {
      const rack = randomBagRack(rng, 1 + (t % 20));
      const all = oracleSubClasses(rack, 2);
      const got = index.bestSingleWord(rack);
      if (all.length === 0) {
        expect(got).toBeUndefined();
        continue;
      }
      let best = -1;
      for (const id of all) best = Math.max(best, C.reward[id]!);
      expect(got!.reward).toBe(best);
      expect(wordReward(got!.word)).toBe(best);
      expect(rackCanSpell(rack, got!.word)).toBe(true);
      expect(dict.isValid(got!.word)).toBe(true);
    }
  });
});
