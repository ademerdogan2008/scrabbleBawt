// Safe word submission helpers (PITFALLS C4, M14):
//   * Reservations: a multiset of letters used by in-flight submit_word calls, so two in-flight
//     words never double-spend a letter. A reservation is released when the word_play echo arrives,
//     when the call is rejected, or (for calls that resolved / timed out) on the next my_rack resync.
//   * Final-auction safety flush: after the policy's words on the LAST auction (bag_total == 0), the
//     leftover rack is packed with getEngine().packer.packExact and submitted too (ARCHITECTURE.md
//     ownership decision 2026-11-07). The policy still owns every other word decision.
import { NUM_LETTERS, VALUE, isWellFormedWord } from '../core/letters.js';
import { emptyRack, rackClone, rackFromWord, rackToString, rackTotal, type Rack } from '../core/rack.js';

export type ReservationState = 'pending' | 'settled';

interface Reservation {
  seq: number;
  word: string;
  letters: Rack;
  state: ReservationState;
}

export class Reservations {
  private items: Reservation[] = [];
  private seq = 0;
  private readonly held = emptyRack();

  /** Letters currently reserved. */
  get reserved(): Rack {
    return this.held;
  }

  get size(): number {
    return this.items.length;
  }

  /** rack - reserved (clamped at 0). */
  available(rack: Rack): Rack {
    const out = rackClone(rack);
    for (let i = 0; i < NUM_LETTERS; i++) out[i] = Math.max(0, out[i]! - this.held[i]!);
    return out;
  }

  /** True when `word` is spellable from rack - reserved. */
  canReserve(rack: Rack, word: string): boolean {
    const need = rackFromWord(word);
    for (let i = 0; i < NUM_LETTERS; i++) if (need[i]! > 0 && rack[i]! - this.held[i]! < need[i]!) return false;
    return true;
  }

  /** Reserve `word` if spellable from rack - reserved; returns a ticket or undefined. */
  reserve(rack: Rack, word: string): number | undefined {
    if (!this.canReserve(rack, word)) return undefined;
    const letters = rackFromWord(word);
    for (let i = 0; i < NUM_LETTERS; i++) this.held[i] = this.held[i]! + letters[i]!;
    const seq = ++this.seq;
    this.items.push({ seq, word, letters, state: 'pending' });
    return seq;
  }

  private drop(idx: number): void {
    const r = this.items[idx]!;
    for (let i = 0; i < NUM_LETTERS; i++) this.held[i] = this.held[i]! - r.letters[i]!;
    this.items.splice(idx, 1);
  }

  /** Release a ticket (rejection). */
  release(seq: number): boolean {
    const i = this.items.findIndex((r) => r.seq === seq);
    if (i < 0) return false;
    this.drop(i);
    return true;
  }

  /** The call settled OK / unknown: keep holding until the echo or the next rack resync. */
  markSettled(seq: number): void {
    const r = this.items.find((x) => x.seq === seq);
    if (r) r.state = 'settled';
  }

  /** Our word_play echo arrived: release the oldest reservation for that word. */
  releaseEcho(word: string): boolean {
    const i = this.items.findIndex((r) => r.word === word);
    if (i < 0) return false;
    this.drop(i);
    return true;
  }

  /** my_rack resync: the server rack is authoritative for every settled call. */
  releaseSettled(): number {
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i]!.state === 'settled') {
        this.drop(i);
        n++;
      }
    }
    return n;
  }

  clear(): void {
    this.items = [];
    this.held.fill(0);
  }

  pendingWords(): string[] {
    return this.items.map((r) => r.word);
  }
}

/** Normalize a policy word: uppercase A-Z, length >= 2 (anything else is dropped). */
export function normalizeWord(word: string): string | undefined {
  const w = word.trim().toUpperCase();
  return isWellFormedWord(w) ? w : undefined;
}

/** Packer surface used for the safety flush (src/engine Packer satisfies it). */
export interface FlushPacker {
  packExact(rack: Rack, opts?: { timeLimitMs?: number }): { score: number; words: string[] };
}

let sharedPacker: FlushPacker | undefined;

/** Lazily loads the shared word engine (src/engine getEngine().packer) on first use. */
export async function loadDefaultFlushPacker(): Promise<FlushPacker> {
  if (!sharedPacker) {
    const { getEngine } = await import('../engine/index.js');
    sharedPacker = getEngine().packer;
  }
  return sharedPacker;
}

/** Synchronous accessor (undefined until loadDefaultFlushPacker() resolved once). */
export function defaultFlushPacker(): FlushPacker | undefined {
  return sharedPacker;
}

export interface FlushPlan {
  words: string[];
  score: number;
  ms: number;
}

/**
 * Safety flush for the final auction: pack the leftover rack (after the policy's words) and return
 * the words to submit. Empty when nothing playable remains.
 */
export function planSafetyFlush(
  packer: FlushPacker,
  leftover: Rack,
  budgetMs: number,
  now: () => number = () => performance.now(),
): FlushPlan {
  if (rackTotal(leftover) < 2) return { words: [], score: 0, ms: 0 };
  const t0 = now();
  const res = packer.packExact(leftover, { timeLimitMs: Math.max(1, budgetMs) });
  const ms = now() - t0;
  if (res.score <= 0) return { words: [], score: 0, ms };
  return { words: res.words.slice(), score: res.score, ms };
}

/** Value of an unplayed rack: letter count, Σ letter values and the sorted letters. */
export function unplayedValue(rack: Rack): { rack: string; letters: number; value: number } {
  let value = 0;
  for (let i = 0; i < NUM_LETTERS; i++) value += rack[i]! * VALUE[i]!;
  return { rack: rackToString(rack), letters: rackTotal(rack), value };
}
