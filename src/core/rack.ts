// Rack = multiset of letters as 26 counts (index 0 = 'A').
import { LETTERS, NUM_LETTERS, VALUE, idx } from './letters.js';

export type Rack = Uint8Array;

export function emptyRack(): Rack {
  return new Uint8Array(NUM_LETTERS);
}

export function rackClone(r: Rack): Rack {
  return new Uint8Array(r);
}

/** Counts of the letters in `word`; throws on characters outside A..Z. */
export function rackFromWord(word: string): Rack {
  const r = emptyRack();
  for (let k = 0; k < word.length; k++) {
    const i = word.charCodeAt(k) - 65;
    if (i < 0 || i >= NUM_LETTERS) throw new Error(`invalid letter '${word[k]}' in '${word}'`);
    r[i]!++;
  }
  return r;
}

export function rackFromCounts(counts: Record<string, number> | Map<string, number>): Rack {
  const r = emptyRack();
  const entries = counts instanceof Map ? counts.entries() : Object.entries(counts);
  for (const [ch, n] of entries) {
    const i = idx(ch);
    if (i < 0) throw new Error(`invalid letter '${ch}'`);
    r[i] = (r[i] ?? 0) + n;
  }
  return r;
}

/** Sorted letters, e.g. "AEINRST". */
export function rackToString(r: Rack): string {
  let s = '';
  for (let i = 0; i < NUM_LETTERS; i++) {
    const n = r[i]!;
    if (n > 0) s += LETTERS[i]!.repeat(n);
  }
  return s;
}

export function rackTotal(r: Rack): number {
  let t = 0;
  for (let i = 0; i < NUM_LETTERS; i++) t += r[i]!;
  return t;
}

/** Sum of face values. */
export function rackValue(r: Rack): number {
  let v = 0;
  for (let i = 0; i < NUM_LETTERS; i++) v += r[i]! * VALUE[i]!;
  return v;
}

/** 26-bit presence mask. */
export function rackMask(r: Rack): number {
  let m = 0;
  for (let i = 0; i < NUM_LETTERS; i++) if (r[i]! > 0) m |= 1 << i;
  return m >>> 0;
}

export function rackAddLetter(r: Rack, i: number, n = 1): Rack {
  r[i] = r[i]! + n;
  return r;
}

/** In-place a += b. */
export function rackAdd(a: Rack, b: Rack): Rack {
  for (let i = 0; i < NUM_LETTERS; i++) a[i] = a[i]! + b[i]!;
  return a;
}

/** In-place a -= b; throws if any count would go negative. */
export function rackSub(a: Rack, b: Rack): Rack {
  for (let i = 0; i < NUM_LETTERS; i++) {
    const v = a[i]! - b[i]!;
    if (v < 0) throw new Error(`rackSub underflow at '${LETTERS[i]}'`);
    a[i] = v;
  }
  return a;
}

/** In-place a -= b, clamping at 0. Returns the amount that could not be removed. */
export function rackSubClamped(a: Rack, b: Rack): Rack {
  const missing = emptyRack();
  for (let i = 0; i < NUM_LETTERS; i++) {
    const v = a[i]! - b[i]!;
    if (v < 0) {
      missing[i] = -v;
      a[i] = 0;
    } else a[i] = v;
  }
  return missing;
}

/** True if `a` contains multiset `b`. */
export function rackContains(a: Rack, b: Rack): boolean {
  for (let i = 0; i < NUM_LETTERS; i++) if (a[i]! < b[i]!) return false;
  return true;
}

/** True if the letters of `word` are all available in `r`. */
export function rackCanSpell(r: Rack, word: string): boolean {
  const need = rackFromWord(word);
  return rackContains(r, need);
}

export function rackEquals(a: Rack, b: Rack): boolean {
  for (let i = 0; i < NUM_LETTERS; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Compact, collision-free memo key (counts < 65536). */
export function rackKey(r: Rack): string {
  return String.fromCharCode(...r);
}
