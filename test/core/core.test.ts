import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BAG,
  BAG_SIZE,
  IS_VOWEL,
  LETTERS,
  VALUE,
  idx,
  isWellFormedWord,
  lengthMultiplier,
  letterValue,
  rewardFromBase,
  totalAuctions,
  wordBase,
  wordReward,
} from '../../src/core/letters.js';
import {
  emptyRack,
  rackAdd,
  rackCanSpell,
  rackClone,
  rackContains,
  rackEquals,
  rackFromCounts,
  rackFromWord,
  rackKey,
  rackMask,
  rackSub,
  rackSubClamped,
  rackToString,
  rackTotal,
  rackValue,
} from '../../src/core/rack.js';
import { Rng, hashSeed } from '../../src/core/rng.js';

// Values copied from the official module (spacetimedb/src/letters.ts letterValue / DEFAULT_BAG).
const MODULE_VALUES: Record<string, number> = {
  A: 1, E: 1, I: 1, O: 1, U: 1, L: 1, N: 1, S: 1, T: 1, R: 1,
  D: 2, G: 2, B: 3, C: 3, M: 3, P: 3, F: 4, H: 4, V: 4, W: 4, Y: 4,
  K: 5, J: 8, X: 8, Q: 10, Z: 10,
};
const MODULE_BAG: Array<[string, number]> = [
  ['A', 9], ['B', 2], ['C', 2], ['D', 4], ['E', 12], ['F', 2], ['G', 3], ['H', 2], ['I', 9],
  ['J', 1], ['K', 1], ['L', 4], ['M', 2], ['N', 6], ['O', 8], ['P', 2], ['Q', 1], ['R', 6],
  ['S', 4], ['T', 6], ['U', 4], ['V', 2], ['W', 2], ['X', 1], ['Y', 2], ['Z', 1],
];

// Reference implementation of the module's reward: BigInt (base * num) / denom.
function moduleReward(word: string): number {
  let base = 0n;
  for (const c of word) base += BigInt(MODULE_VALUES[c] ?? 0);
  const len = word.length;
  const [num, den] =
    len <= 3 ? [1n, 1n] : len === 4 ? [3n, 2n] : len === 5 ? [2n, 1n] : len === 6 ? [5n, 2n] : [3n, 1n];
  return Number((base * num) / den);
}

describe('letters', () => {
  it('matches module letter values and bag', () => {
    for (let i = 0; i < 26; i++) {
      expect(VALUE[i]).toBe(MODULE_VALUES[LETTERS[i]!]);
      expect(BAG[i]).toBe(MODULE_BAG[i]![1]);
      expect(LETTERS[i]).toBe(MODULE_BAG[i]![0]);
    }
    expect(BAG.reduce((a, b) => a + b, 0)).toBe(98);
    expect(BAG_SIZE).toBe(98);
    expect(VALUE.reduce((s, v, i) => s + v * BAG[i]!, 0)).toBe(187);
  });

  it('idx / letterValue / vowels', () => {
    expect(idx('A')).toBe(0);
    expect(idx('Z')).toBe(25);
    expect(idx('a')).toBe(-1);
    expect(idx('AB')).toBe(-1);
    expect(letterValue('Q')).toBe(10);
    expect(letterValue('?')).toBe(0);
    expect(LETTERS.split('').filter((_, i) => IS_VOWEL[i])).toEqual(['A', 'E', 'I', 'O', 'U']);
  });

  it('length multipliers match module', () => {
    expect(lengthMultiplier(2)).toEqual([1, 1]);
    expect(lengthMultiplier(3)).toEqual([1, 1]);
    expect(lengthMultiplier(4)).toEqual([3, 2]);
    expect(lengthMultiplier(5)).toEqual([2, 1]);
    expect(lengthMultiplier(6)).toEqual([5, 2]);
    expect(lengthMultiplier(7)).toEqual([3, 1]);
    expect(lengthMultiplier(15)).toEqual([3, 1]);
  });

  it('wordReward equals module integer reward for many words', () => {
    const samples = ['QI', 'ZAX', 'QUIZ', 'JAZZY', 'QUARTZ', 'QUIZZED', 'AEIOU', 'BEE', 'OXYPHENBUTAZONE', 'ZYZZYVA', 'CAT', 'DOGS', 'FIGHT'];
    const rng = new Rng(7);
    for (let n = 0; n < 2000; n++) {
      const len = rng.int(2, 15);
      let w = '';
      for (let k = 0; k < len; k++) w += LETTERS[rng.int(0, 25)];
      samples.push(w);
    }
    for (const w of samples) {
      expect(wordReward(w)).toBe(moduleReward(w));
      expect(rewardFromBase(wordBase(w), w.length)).toBe(moduleReward(w));
    }
    expect(wordReward('QUIZ')).toBe(Math.floor((10 + 1 + 1 + 10) * 1.5)); // 33
    expect(wordReward('RETAINS')).toBe(21);
  });

  it('well-formedness and auction count', () => {
    expect(isWellFormedWord('AB')).toBe(true);
    expect(isWellFormedWord('A')).toBe(false);
    expect(isWellFormedWord('ab')).toBe(false);
    expect(isWellFormedWord('A-B')).toBe(false);
    expect(totalAuctions(6, 5)).toBe(68);
    expect(totalAuctions(2, 5)).toBe(88);
    expect(totalAuctions(6, 0)).toBe(98);
  });
});

describe('rack', () => {
  it('round-trips and counts', () => {
    const r = rackFromWord('BANANA');
    expect(rackToString(r)).toBe('AAABNN');
    expect(rackTotal(r)).toBe(6);
    expect(rackValue(r)).toBe(3 + 1 * 5);
    expect(rackMask(r)).toBe((1 << 0) | (1 << 1) | (1 << 13));
    expect(rackEquals(rackFromCounts({ A: 3, B: 1, N: 2 }), r)).toBe(true);
    expect(rackEquals(rackFromCounts(new Map([['A', 3], ['B', 1], ['N', 2]])), r)).toBe(true);
    expect(() => rackFromWord('ab')).toThrow();
  });

  it('add/sub/contains', () => {
    const r = rackFromWord('RETAINS');
    expect(rackCanSpell(r, 'STAIN')).toBe(true);
    expect(rackCanSpell(r, 'STAINS')).toBe(false);
    const c = rackClone(r);
    rackSub(c, rackFromWord('STAIN'));
    expect(rackToString(c)).toBe('ER');
    expect(() => rackSub(c, rackFromWord('EE'))).toThrow();
    const missing = rackSubClamped(c, rackFromWord('EEX'));
    expect(rackToString(missing)).toBe('EX');
    expect(rackToString(c)).toBe('R');
    rackAdd(c, rackFromWord('AB'));
    expect(rackToString(c)).toBe('ABR');
    expect(rackContains(r, emptyRack())).toBe(true);
  });

  it('rackKey is collision free for distinct racks', () => {
    const seen = new Map<string, string>();
    const rng = new Rng(3);
    for (let n = 0; n < 5000; n++) {
      const r = emptyRack();
      const len = rng.int(0, 30);
      for (let k = 0; k < len; k++) r[rng.int(0, 25)]!++;
      const key = rackKey(r);
      const s = rackToString(r);
      if (seen.has(key)) expect(seen.get(key)).toBe(s);
      seen.set(key, s);
    }
  });
});

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 10 }, () => a.nextU32());
    const sb = Array.from({ length: 10 }, () => b.nextU32());
    const sc = Array.from({ length: 10 }, () => c.nextU32());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
  });

  it('int is inclusive and roughly uniform', () => {
    const r = new Rng(1);
    const counts = new Map<number, number>();
    for (let n = 0; n < 50_000; n++) {
      const v = r.int(-2, 2);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThanOrEqual(2);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((x, y) => x - y)).toEqual([-2, -1, 0, 1, 2]);
    for (const c of counts.values()) expect(Math.abs(c - 10_000)).toBeLessThan(600);
    expect(r.int(5, 5)).toBe(5);
    expect(() => r.int(2, 1)).toThrow();
  });

  it('float in [0,1), shuffle is a permutation, fork independent', () => {
    const r = new Rng(9);
    for (let n = 0; n < 1000; n++) {
      const f = r.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
    const arr = Array.from({ length: 20 }, (_, i) => i);
    r.shuffle(arr);
    expect([...arr].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const f1 = new Rng(5).fork('a');
    const f2 = new Rng(5).fork('b');
    expect(f1.nextU32()).not.toBe(f2.nextU32());
    expect(hashSeed(1, 'x')).toBe(hashSeed(1, 'x'));
    expect(hashSeed(1, 'x')).not.toBe(hashSeed(1, 'y'));
  });
});

describe('vendored data', () => {
  it('wordlist matches module checksum', () => {
    const buf = readFileSync(new URL('../../data/wordlist.txt', import.meta.url));
    const sha = createHash('sha256').update(buf).digest('hex');
    expect(sha).toBe('b819e7b67f8f2c80640ae76f0edbe59a4a1befb6de0f348463642ad49bdd2ad3');
    const lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(172_820);
  });
});
