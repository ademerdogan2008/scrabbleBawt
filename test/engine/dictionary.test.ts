import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NUM_LETTERS, wordReward, wordBase } from '../../src/core/letters.js';
import { rackFromWord, rackToString } from '../../src/core/rack.js';
import { Rng } from '../../src/core/rng.js';
import {
  asciiUppercase,
  binarySearchWords,
  defaultWordlistPath,
  loadDictionary,
  utf8ByteLength,
} from '../../src/engine/dictionary.js';

const TEXT = readFileSync(defaultWordlistPath(), 'utf8');
const LEX = TEXT.split('\n').filter((l) => l.length > 0);

/** Literal port of the module's isValidWord (binary search over lexWords()). */
function moduleIsValidWord(word: string): boolean {
  const target = word.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
  if (Buffer.byteLength(target, 'utf8') < 2) return false;
  if (!/^[A-Z]+$/.test(target)) return false;
  let lo = 0;
  let hi = LEX.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = LEX[mid]!;
    if (w === target) return true;
    if (w < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

describe('dictionary', () => {
  const dict = loadDictionary();

  it('loads the module wordlist in file order', () => {
    expect(dict.size).toBe(172_820);
    expect(dict.words.length).toBe(172_820);
    expect(dict.words[0]).toBe('AA');
    expect(dict.words[dict.size - 1]).toBe('ZYZZYVAS');
    expect(dict.sorted).toBe(true);
    expect(loadDictionary() === dict).toBe(true); // cached singleton
  });

  it('accepts raw text and file paths', () => {
    const small = loadDictionary('CAT\nACT\nDOG\n\nA\nca t\n');
    expect(small.size).toBe(5);
    expect(small.isValid('cat')).toBe(true);
    expect(small.isValid('A')).toBe(false);
    expect(small.classes.count).toBe(2); // {ACT,CAT}, {DGO}
    expect(small.classWords(small.classOf('CAT'))).toEqual(['ACT', 'CAT']);
    expect(small.sorted).toBe(false);
    const fromPath = loadDictionary(defaultWordlistPath());
    expect(fromPath === dict).toBe(false);
    expect(fromPath.size).toBe(dict.size);
  });

  it('isValid matches the module binary search on every word and its lowercase forms', () => {
    const bad: string[] = [];
    for (const w of LEX) {
      if (!dict.isValid(w) || !moduleIsValidWord(w)) bad.push(w);
      const lower = w.toLowerCase();
      if (dict.isValid(lower) !== moduleIsValidWord(lower) || !dict.isValid(lower)) bad.push(lower);
    }
    for (let i = 0; i < LEX.length; i += 97) {
      const w = LEX[i]!;
      const mixed = w[0]!.toLowerCase() + w.slice(1);
      if (!dict.isValid(mixed) || !moduleIsValidWord(mixed)) bad.push(mixed);
      if (dict.isValid(w + ' ') || moduleIsValidWord(w + ' ')) bad.push(w + ' ');
      if (dict.isValid(' ' + w) || moduleIsValidWord(' ' + w)) bad.push(' ' + w);
    }
    expect(bad).toEqual([]);
  });

  it('isValid matches the module on short, non-alpha and random strings', () => {
    const cases: string[] = ['', 'A', 'a', 'Z', 'AA', 'aa', 'Aa', 'É', 'ÉÉ', 'A1', '12', 'A-A', 'ÄA', 'ı', 'ss', 'ß'];
    for (let c = 0; c < 128; c++) cases.push(String.fromCharCode(c), String.fromCharCode(c, c));
    const rng = new Rng(1234);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0- éß';
    for (let i = 0; i < 20_000; i++) {
      const len = rng.int(0, 9);
      let s = '';
      for (let k = 0; k < len; k++) {
        // mostly uppercase letters so a decent fraction are real words
        s += rng.float() < 0.85 ? String.fromCharCode(65 + rng.int(0, 25)) : alphabet[rng.int(0, alphabet.length - 1)]!;
      }
      cases.push(s);
    }
    let valid = 0;
    const bad: string[] = [];
    for (const s of cases) {
      const v = dict.isValid(s);
      if (v !== moduleIsValidWord(s)) bad.push(s);
      if (v) valid++;
    }
    expect(bad).toEqual([]);
    expect(valid).toBeGreaterThan(100);
  });

  it('helpers mirror the module', () => {
    expect(asciiUppercase('abcXYZ-é')).toBe('ABCXYZ-é');
    expect(utf8ByteLength('é')).toBe(2);
    expect(utf8ByteLength('A')).toBe(1);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(binarySearchWords(LEX, 'QAT')).toBe(true);
    expect(binarySearchWords(LEX, 'QQ')).toBe(false);
  });

  it('byLengthDesc is module wordsByLength order', () => {
    const expected = [...LEX].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
    expect(dict.byLengthDesc).toEqual(expected);
  });

  it('anagram classes partition the dictionary with correct stats', () => {
    const { classes } = dict;
    console.log(`anagram classes: ${classes.count} (words ${dict.size})`);
    expect(classes.count).toBeGreaterThan(100_000);
    expect(classes.wordStart[classes.count]).toBe(dict.size);
    const seen = new Int32Array(classes.count);
    const bad: string[] = [];
    for (let w = 0; w < dict.size; w++) {
      const word = dict.words[w]!;
      const id = classes.classOfWord[w]!;
      if (id < 0) {
        bad.push(`unclassed ${word}`);
        continue;
      }
      seen[id]!++;
      if (
        classes.keys[id] !== rackToString(rackFromWord(word)) ||
        classes.len[id] !== word.length ||
        classes.base[id] !== wordBase(word) ||
        classes.reward[id] !== wordReward(word) ||
        dict.classOf(word) !== id ||
        !dict.classWords(id).includes(word)
      )
        bad.push(`stats ${word}`);
    }
    for (let id = 0; id < classes.count; id++) {
      const words = dict.classWords(id);
      if (seen[id] !== words.length || words.length === 0) bad.push(`size ${id}`);
      if (dict.classWord(id) !== words[0]) bad.push(`rep ${id}`);
      for (let k = 1; k < words.length; k++) if (!(words[k - 1]! < words[k]!)) bad.push(`order ${id}`);
      const counts = dict.classCounts(id);
      if (counts.length !== NUM_LETTERS || rackToString(counts) !== classes.keys[id]) bad.push(`counts ${id}`);
      if (dict.classOfKey(classes.keys[id]!) !== id) bad.push(`key ${id}`);
    }
    expect(bad).toEqual([]);
    expect(dict.classOf('XYZZYQ')).toBe(-1);
    expect(dict.classOf('qat')).toBe(-1); // exact spelling only
    expect(dict.classWords(dict.classOf('STAR'))).toContain('RATS');
  });
});
