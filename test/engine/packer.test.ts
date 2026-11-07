import { describe, expect, it } from 'vitest';
import { NUM_LETTERS, wordReward } from '../../src/core/letters.js';
import { emptyRack, rackClone, rackFromWord, rackToString, type Rack } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import { AnagramIndex, Packer, getEngine, loadDictionary, type PackResult } from '../../src/engine/index.js';
import { randomBagRack } from './helpers.js';

const dict = loadDictionary();
const index = new AnagramIndex(dict);
const C = dict.classes;

/** Linear scan: every class (len >= minLen) whose counts fit the rack. */
function fitting(rack: Rack, minLen: number): number[] {
  const out: number[] = [];
  outer: for (let id = 0; id < C.count; id++) {
    if (C.len[id]! < minLen) continue;
    const o = id * NUM_LETTERS;
    for (let i = 0; i < NUM_LETTERS; i++) if (C.counts[o + i]! > rack[i]!) continue outer;
    out.push(id);
  }
  return out;
}

/** Exhaustive search over all multisets of disjoint classes (non-decreasing list position). */
function bruteForce(rack: Rack, minLen = 2): number {
  const list = fitting(rack, minLen);
  const r = rackClone(rack);
  const rec = (start: number): number => {
    let best = 0;
    outer: for (let k = start; k < list.length; k++) {
      const o = list[k]! * NUM_LETTERS;
      for (let i = 0; i < NUM_LETTERS; i++) if (C.counts[o + i]! > r[i]!) continue outer;
      for (let i = 0; i < NUM_LETTERS; i++) r[i]! -= C.counts[o + i]!;
      const v = C.reward[list[k]!]! + rec(k);
      for (let i = 0; i < NUM_LETTERS; i++) r[i]! += C.counts[o + i]!;
      if (v > best) best = v;
    }
    return best;
  };
  return rec(0);
}

/** Result invariants: valid words, jointly inside the rack, score = Σ rewards. */
function checkResult(rack: Rack, res: PackResult, minLen = 2): void {
  const r = rackClone(rack);
  let sum = 0;
  expect(res.words.length).toBe(res.classIds.length);
  for (let k = 0; k < res.words.length; k++) {
    const w = res.words[k]!;
    expect(dict.isValid(w), w).toBe(true);
    expect(w.length).toBeGreaterThanOrEqual(minLen);
    expect(dict.classOf(w)).toBe(res.classIds[k]);
    const need = rackFromWord(w);
    for (let i = 0; i < NUM_LETTERS; i++) {
      r[i] = r[i]! - need[i]!;
      expect(r[i]!, `${rackToString(rack)} -> ${res.words.join(',')}`).toBeGreaterThanOrEqual(0);
    }
    sum += wordReward(w);
  }
  expect(res.score).toBe(sum);
}

describe('Packer', () => {
  it('packExact equals brute force on 300 random racks of 4..11 tiles', () => {
    const packer = new Packer(index);
    const rng = new Rng(31337);
    for (let t = 0; t < 300; t++) {
      const rack = randomBagRack(rng, 4 + (t % 8));
      const res = packer.packExact(rack);
      const bf = bruteForce(rack);
      if (res.score !== bf) throw new Error(`${rackToString(rack)}: exact ${res.score} != brute ${bf}`);
      expect(res.exact).toBe(true);
      checkResult(rack, res);
      const fast = packer.packFast(rack);
      expect(fast.score).toBeLessThanOrEqual(res.score);
      checkResult(rack, fast);
    }
  });

  it('packExact equals brute force with minLen 3 and with a fresh (cold) cache per rack', () => {
    const rng = new Rng(5);
    for (let t = 0; t < 120; t++) {
      const packer = new Packer(index, { cacheSize: 16 });
      const rack = randomBagRack(rng, 4 + (t % 8));
      const minLen = t & 1 ? 3 : 2;
      const res = packer.packExact(rack, { minLen });
      expect(res.score).toBe(bruteForce(rack, minLen));
      checkResult(rack, res, minLen);
    }
  });

  it('agrees with an independent cold packer on larger racks (cache consistency)', () => {
    const warm = new Packer(index);
    const rng = new Rng(77);
    for (let t = 0; t < 60; t++) {
      const rack = randomBagRack(rng, 12 + (t % 9));
      const a = warm.packExact(rack);
      const b = new Packer(index, { cacheSize: 64 }).packExact(rack);
      expect(a.exact && b.exact).toBe(true);
      expect(a.score).toBe(b.score);
      checkResult(rack, a);
      checkResult(rack, b);
      const again = warm.packExact(rack);
      expect(again.score).toBe(a.score);
      expect(again.nodes).toBe(0); // root cache hit
      expect(warm.value(rack)).toBe(a.score);
      const fast = warm.packFast(rack);
      expect(fast.score).toBeLessThanOrEqual(a.score);
      checkResult(rack, fast);
    }
  });

  it('node and time limits return a valid (inexact) best-so-far', () => {
    const rng = new Rng(9);
    let inexact = 0;
    let improved = 0;
    for (let t = 0; t < 20; t++) {
      const rack = randomBagRack(rng, 30);
      const packer = new Packer(index);
      const res = packer.packExact(rack, { nodeLimit: 50 });
      checkResult(rack, res);
      const fast = packer.packFast(rack);
      expect(res.score).toBeGreaterThanOrEqual(fast.score);
      if (!res.exact) {
        inexact++;
        expect(res.nodes).toBeGreaterThan(50);
      }
      if (res.score > fast.score) improved++;
      let clock = 0;
      const timed = new Packer(index).packExact(rack, { timeLimitMs: 5, now: () => (clock += 1) });
      checkResult(rack, timed);
      expect(timed.score).toBeGreaterThanOrEqual(fast.score);
      if (!timed.exact) expect(timed.nodes).toBeLessThan(256 * 8);
    }
    expect(inexact).toBeGreaterThan(0);
    console.log(`node-limited: ${inexact}/20 inexact, ${improved}/20 improved over packFast`);
  });

  it('is deterministic and packFast reuses cached exact results', () => {
    const rng = new Rng(4242);
    for (let t = 0; t < 30; t++) {
      const rack = randomBagRack(rng, 10 + (t % 15));
      const a = new Packer(index).packExact(rack);
      const b = new Packer(index).packExact(rack);
      expect(b.words).toEqual(a.words);
      expect(b.score).toBe(a.score);
      const p = new Packer(index);
      const f1 = p.packFast(rack);
      expect(new Packer(index).packFast(rack).words).toEqual(f1.words);
      p.packExact(rack);
      const f2 = p.packFast(rack);
      expect(f2.score).toBe(a.score);
      expect(f2.exact).toBe(true);
      p.clearCache();
      expect(p.packFast(rack).score).toBe(f1.score);
    }
  });

  it('handles trivial racks', () => {
    const packer = new Packer(index);
    expect(packer.packExact(emptyRack())).toMatchObject({ score: 0, words: [], exact: true });
    expect(packer.packFast(emptyRack())).toMatchObject({ score: 0, words: [] });
    expect(packer.packExact(rackFromWord('Q'))).toMatchObject({ score: 0, words: [] });
    expect(packer.packExact(rackFromWord('QQVVJ')).score).toBe(0);
    const zax = packer.packExact(rackFromWord('ZAX'));
    expect(zax.score).toBe(wordReward('ZAX'));
    const two = packer.packExact(rackFromWord('AXAX'));
    expect(two.score).toBe(bruteForce(rackFromWord('AXAX')));
    expect(two.score).toBeGreaterThanOrEqual(2 * wordReward('AX'));
    const big = packer.packExact(rackFromWord('RETAINSRETAINS'));
    expect(big.score).toBe(2 * wordReward('RETAINS'));
  });

  it('shared engine singleton', () => {
    const e = getEngine();
    expect(getEngine() === e).toBe(true);
    expect(e.packer.value(rackFromWord('QUIZ'))).toBe(wordReward('QUIZ'));
  });
});
