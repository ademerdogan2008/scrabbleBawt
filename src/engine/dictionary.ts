// Dictionary: module-exact word validity plus anagram classes.
//
// Module reference (spacetimedb/src/dictionary.ts):
//   lexWords()      = WORDLIST.split("\n").filter(l => l.length > 0)   (file order)
//   wordsByLength() = [...lexWords()].sort((a,b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
//   isValidWord(w)  = asciiUppercase(w); byteLength < 2 -> false; non A-Z -> false; binary search lexWords()
//
// An anagram class groups every word with the same letter multiset. All words of a class have
// identical length, face value and reward, so search/packing works on classes, not words.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NUM_LETTERS, VALUE, rewardFromBase } from '../core/letters.js';

/** Struct-of-arrays table of anagram classes. Class ids are dense 0..count-1. */
export interface ClassTable {
  readonly count: number;
  /** 26 counts per class: counts[id*26 + letter]. Shared buffer — never mutate. */
  readonly counts: Uint8Array;
  readonly len: Uint8Array;
  readonly base: Uint16Array;
  readonly reward: Uint16Array;
  /** Sorted-letter key per class (e.g. "AEINRST"). */
  readonly keys: readonly string[];
  /** Words of class id are wordList[wordStart[id] .. wordStart[id+1]), lexicographic order. */
  readonly wordStart: Int32Array;
  readonly wordList: readonly string[];
  /** Class id of each entry of Dictionary.words (file order). */
  readonly classOfWord: Int32Array;
}

export interface Dictionary {
  /** Every word in file order (module lexWords()). */
  readonly words: readonly string[];
  readonly size: number;
  /** True when the file is strictly ascending, i.e. binary search == set membership. */
  readonly sorted: boolean;
  /** Module isValidWord semantics. */
  isValid(word: string): boolean;
  /** Module wordsByLength() order (length desc, then lexicographic). Built lazily. */
  readonly byLengthDesc: readonly string[];
  readonly classes: ClassTable;
  /** Class id of a word (exact uppercase spelling), or -1. */
  classOf(word: string): number;
  /** Class id for a sorted-letter key, or -1. */
  classOfKey(key: string): number;
  /** Representative (lexicographically smallest word) of a class. */
  classWord(id: number): string;
  classWords(id: number): string[];
  /** 26-count view of a class (subarray of the shared buffer; do not mutate). */
  classCounts(id: number): Uint8Array;
}

/** Module asciiUppercase: maps only a-z to A-Z, leaves every other code unit alone. */
export function asciiUppercase(word: string): string {
  let needs = false;
  for (let k = 0; k < word.length; k++) {
    const c = word.charCodeAt(k);
    if (c >= 97 && c <= 122) {
      needs = true;
      break;
    }
  }
  if (!needs) return word;
  let out = '';
  for (let k = 0; k < word.length; k++) {
    const c = word.charCodeAt(k);
    out += String.fromCharCode(c >= 97 && c <= 122 ? c - 32 : c);
  }
  return out;
}

/** UTF-8 byte length (module byteLength). */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && k + 1 < s.length) {
      const d = s.charCodeAt(k + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        k++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

function isAsciiUpper(s: string): boolean {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c < 65 || c > 90) return false;
  }
  return true;
}

/** Binary search exactly as the module does it (JS string comparison). */
export function binarySearchWords(words: readonly string[], target: string): boolean {
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const w = words[mid]!;
    if (w === target) return true;
    if (w < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

function sortedKey(word: string, scratch: Uint8Array): string {
  scratch.fill(0);
  for (let k = 0; k < word.length; k++) scratch[word.charCodeAt(k) - 65]!++;
  let key = '';
  for (let i = 0; i < NUM_LETTERS; i++) {
    const n = scratch[i]!;
    for (let j = 0; j < n; j++) key += String.fromCharCode(65 + i);
  }
  return key;
}

class DictionaryImpl implements Dictionary {
  readonly words: readonly string[];
  readonly size: number;
  readonly sorted: boolean;
  readonly classes: ClassTable;
  private readonly set: Set<string>;
  private readonly keyToClass: Map<string, number>;
  private byLen: string[] | undefined;

  constructor(text: string) {
    const words = text.split('\n').filter((l) => l.length > 0);
    this.words = words;
    this.size = words.length;
    let sorted = true;
    for (let i = 1; i < words.length; i++) {
      if (!(words[i - 1]! < words[i]!)) {
        sorted = false;
        break;
      }
    }
    this.sorted = sorted;
    this.set = new Set(words);

    // Anagram classes over the playable words (well-formed A-Z, length >= 2). Others can never
    // pass isValidWord and are excluded from search.
    const scratch = new Uint8Array(NUM_LETTERS);
    const keyToClass = new Map<string, number>();
    const keys: string[] = [];
    const members: number[][] = [];
    const classOfWord = new Int32Array(words.length).fill(-1);
    for (let w = 0; w < words.length; w++) {
      const word = words[w]!;
      if (word.length < 2 || !isAsciiUpper(word)) continue;
      const key = sortedKey(word, scratch);
      let id = keyToClass.get(key);
      if (id === undefined) {
        id = keys.length;
        keyToClass.set(key, id);
        keys.push(key);
        members.push([]);
      }
      members[id]!.push(w);
      classOfWord[w] = id;
    }
    const count = keys.length;
    const counts = new Uint8Array(count * NUM_LETTERS);
    const len = new Uint8Array(count);
    const base = new Uint16Array(count);
    const reward = new Uint16Array(count);
    const wordStart = new Int32Array(count + 1);
    const wordList: string[] = [];
    for (let id = 0; id < count; id++) {
      const key = keys[id]!;
      let b = 0;
      for (let k = 0; k < key.length; k++) {
        const li = key.charCodeAt(k) - 65;
        counts[id * NUM_LETTERS + li]!++;
        b += VALUE[li]!;
      }
      len[id] = key.length;
      base[id] = b;
      reward[id] = rewardFromBase(b, key.length);
      wordStart[id] = wordList.length;
      const ws = members[id]!.map((w) => words[w]!);
      if (!sorted) ws.sort((a, c) => (a < c ? -1 : a > c ? 1 : 0));
      for (const s of ws) wordList.push(s);
    }
    wordStart[count] = wordList.length;
    this.keyToClass = keyToClass;
    this.classes = { count, counts, len, base, reward, keys, wordStart, wordList, classOfWord };
  }

  isValid(word: string): boolean {
    const target = asciiUppercase(word);
    if (utf8ByteLength(target) < 2) return false;
    if (!isAsciiUpper(target)) return false;
    return this.sorted ? this.set.has(target) : binarySearchWords(this.words, target);
  }

  get byLengthDesc(): readonly string[] {
    if (!this.byLen) {
      this.byLen = [...this.words].sort(
        (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
      );
    }
    return this.byLen;
  }

  classOf(word: string): number {
    if (word.length < 2 || !isAsciiUpper(word) || !this.set.has(word)) return -1;
    const scratch = new Uint8Array(NUM_LETTERS);
    return this.keyToClass.get(sortedKey(word, scratch)) ?? -1;
  }

  classOfKey(key: string): number {
    return this.keyToClass.get(key) ?? -1;
  }

  classWord(id: number): string {
    return this.classes.wordList[this.classes.wordStart[id]!]!;
  }

  classWords(id: number): string[] {
    const { wordList, wordStart } = this.classes;
    return wordList.slice(wordStart[id]!, wordStart[id + 1]!);
  }

  classCounts(id: number): Uint8Array {
    return this.classes.counts.subarray(id * NUM_LETTERS, id * NUM_LETTERS + NUM_LETTERS);
  }
}

const DEFAULT_URL = new URL('../../data/wordlist.txt', import.meta.url);
let defaultDict: Dictionary | undefined;

/** Path to the vendored module wordlist. */
export function defaultWordlistPath(): string {
  return fileURLToPath(DEFAULT_URL);
}

/**
 * Load a dictionary. `source` is either raw wordlist text (contains '\n') or a file path.
 * With no argument the vendored data/wordlist.txt is loaded once and cached.
 */
export function loadDictionary(source?: string): Dictionary {
  if (source === undefined) {
    defaultDict ??= new DictionaryImpl(readFileSync(DEFAULT_URL, 'utf8'));
    return defaultDict;
  }
  if (source.includes('\n')) return new DictionaryImpl(source);
  return new DictionaryImpl(readFileSync(source, 'utf8'));
}
