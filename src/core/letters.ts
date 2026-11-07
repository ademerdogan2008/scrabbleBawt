// Game constants and scoring, mirroring the official module exactly
// (clockworklabs/scrabblebot spacetimedb/src/letters.ts and game.ts).

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const NUM_LETTERS = 26;
const A_CODE = 65;

/** Standard Scrabble face values, indexed A..Z. */
export const VALUE: readonly number[] = Object.freeze([
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10,
]);

/** Standard 98-tile distribution (no blanks), indexed A..Z. */
export const BAG: readonly number[] = Object.freeze([
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
]);

export const BAG_SIZE = 98;
export const STARTING_BALANCE = 100;
export const DEFAULT_STARTING_RACK = 5;
export const DEFAULT_AUCTION_MS = 1000;
export const DEFAULT_LOBBY_SIZE = 6;
export const AUCTION_RESERVE = 1;
export const SIM_BID_JITTER = 2;
export const MIN_WORD_LENGTH = 2;

/** True for A, E, I, O, U (the module's sim "isVowel"). Y is a consonant. */
export const IS_VOWEL: readonly boolean[] = Object.freeze(
  Array.from(LETTERS, (c) => 'AEIOU'.includes(c)),
);

/** Letter index 0..25 for 'A'..'Z'; -1 for anything else. */
export function idx(ch: string): number {
  const code = ch.charCodeAt(0);
  const i = code - A_CODE;
  return ch.length === 1 && i >= 0 && i < NUM_LETTERS ? i : -1;
}

export function letterAt(i: number): string {
  return LETTERS[i]!;
}

export function letterValue(ch: string): number {
  const i = idx(ch);
  return i < 0 ? 0 : VALUE[i]!;
}

/** Length multiplier as [numerator, denominator] (module lengthMultiplier). */
export function lengthMultiplier(len: number): readonly [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

/** Reward from a face-value sum and length: floor(base * num / den). */
export function rewardFromBase(base: number, len: number): number {
  const [num, den] = lengthMultiplier(len);
  return Math.floor((base * num) / den);
}

/** Sum of face values; letters outside A..Z count 0 (module letterValue default). */
export function wordBase(word: string): number {
  let s = 0;
  for (let k = 0; k < word.length; k++) {
    const i = word.charCodeAt(k) - A_CODE;
    if (i >= 0 && i < NUM_LETTERS) s += VALUE[i]!;
  }
  return s;
}

/** Total reward credited to balance and score for playing `word` (uppercase). */
export function wordReward(word: string): number {
  return rewardFromBase(wordBase(word), word.length);
}

/** Module validation shape: ASCII A-Z only and length >= 2 (dictionary check separate). */
export function isWellFormedWord(word: string): boolean {
  if (word.length < MIN_WORD_LENGTH) return false;
  for (let k = 0; k < word.length; k++) {
    const c = word.charCodeAt(k);
    if (c < 65 || c > 90) return false;
  }
  return true;
}

/** Number of auctions in a match: tiles left in the bag after dealing. */
export function totalAuctions(players: number, startingRackSize: number): number {
  return Math.max(0, BAG_SIZE - players * startingRackSize);
}
