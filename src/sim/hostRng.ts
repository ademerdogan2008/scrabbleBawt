// SIMULATOR VERIFICATION ONLY. Do not import from src/bots or src/client (fair-play guard:
// test/sim/fairplayGuard.test.ts). Not re-exported from src/sim/index.ts.
//
// Re-implementation (our own code) of the SpacetimeDB TS SDK 2.12.0 reducer RNG, RULES.md §4.1:
// ctx.random = pure-rand 7.0.1 xoroshiro128plus seeded with pcg32(transaction timestamp µs);
// integerInRange uses pure-rand's uniform distribution with rejection sampling.

/** pcg32 output for a 64-bit state (BigInt µs). JS int32 ops reproduce the SDK's sign quirk. */
export function pcg32(state: bigint): number {
  const s = BigInt.asUintN(64, state * 6364136223846793005n + 11634580027462260723n);
  const xorshifted = Number(BigInt.asUintN(32, ((s >> 18n) ^ s) >> 27n));
  const rot = Number(BigInt.asUintN(32, s >> 59n));
  return (xorshifted >> rot) | (xorshifted << (32 - rot));
}

/** pure-rand XoroShiro128Plus (32-bit lane arithmetic). */
export class XoroShiro128Plus {
  private s01: number;
  private s00: number;
  private s11: number;
  private s10: number;
  /** Number of unsafeNext() calls so far (diagnostics). */
  calls = 0;

  constructor(s01: number, s00: number, s11: number, s10: number) {
    this.s01 = s01;
    this.s00 = s00;
    this.s11 = s11;
    this.s10 = s10;
  }

  /** pure-rand xoroshiro128plus(seed). */
  static fromSeed(seed: number): XoroShiro128Plus {
    return new XoroShiro128Plus(-1, ~seed, seed | 0, 0);
  }

  unsafeNext(): number {
    this.calls++;
    const out = (this.s00 + this.s10) | 0;
    const a0 = this.s10 ^ this.s00;
    const a1 = this.s11 ^ this.s01;
    const s00 = this.s00;
    const s01 = this.s01;
    this.s00 = (s00 << 24) ^ (s01 >>> 8) ^ a0 ^ (a0 << 16);
    this.s01 = (s01 << 24) ^ (s00 >>> 8) ^ a1 ^ ((a1 << 16) | (a0 >>> 16));
    this.s10 = (a1 << 5) ^ (a0 >>> 27);
    this.s11 = (a0 << 5) ^ (a1 >>> 27);
    return out;
  }
}

/** ctx.random of one reducer transaction. */
export class HostRandom {
  readonly gen: XoroShiro128Plus;

  constructor(timestampMicros: bigint | number) {
    this.gen = XoroShiro128Plus.fromSeed(pcg32(BigInt(timestampMicros)));
  }

  /** SDK integerInRange(min, max), both inclusive; always consumes at least one unsafeNext(). */
  integerInRange(min: number, max: number): number {
    const n = max - min + 1;
    const maxAllowed = n > 2 ? Math.floor(0x100000000 / n) * n : 0x100000000;
    let d = this.gen.unsafeNext() + 0x80000000;
    while (d >= maxAllowed) d = this.gen.unsafeNext() + 0x80000000;
    return (d % n) + min;
  }
}

/** The module's own shuffle (game.ts): for i = len-1 down to 1, swap(i, integerInRange(0, i)). */
export function hostShuffle<T>(r: HostRandom, items: T[]): T[] {
  for (let i = items.length - 1; i >= 1; i--) {
    const j = r.integerInRange(0, i);
    const t = items[i]!;
    items[i] = items[j]!;
    items[j] = t;
  }
  return items;
}
