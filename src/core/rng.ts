// Seeded PRNG: xoshiro128** seeded via splitmix32. Deterministic, fast, no Math.random().

function splitmix32(state: { a: number }): number {
  state.a = (state.a + 0x9e3779b9) | 0;
  let t = state.a ^ (state.a >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t ^= t >>> 15;
  t = Math.imul(t, 0x735a2d97);
  t ^= t >>> 15;
  return t >>> 0;
}

function rotl(x: number, k: number): number {
  return (x << k) | (x >>> (32 - k));
}

/** FNV-1a style hash of mixed parts into a 32-bit seed. */
export function hashSeed(...parts: Array<number | string>): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    const s = typeof p === 'number' ? `n${p}` : `s${p}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x7c;
  }
  return h >>> 0;
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number) {
    const st = { a: seed | 0 };
    this.s0 = splitmix32(st);
    this.s1 = splitmix32(st);
    this.s2 = splitmix32(st);
    this.s3 = splitmix32(st);
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Uniform uint32. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
    const t = this.s1 << 9;
    this.s2 ^= this.s0;
    this.s3 ^= this.s1;
    this.s1 ^= this.s2;
    this.s0 ^= this.s3;
    this.s2 ^= t;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform float in [0, 1). */
  float(): number {
    return this.nextU32() / 4294967296;
  }

  /** Uniform integer in [lo, hi], both inclusive (module integerInRange semantics). */
  int(lo: number, hi: number): number {
    if (hi < lo) throw new Error(`Rng.int: hi (${hi}) < lo (${lo})`);
    const range = hi - lo + 1;
    if (range > 4294967296) throw new Error('Rng.int: range too large');
    if (range === 1) return lo;
    const limit = Math.floor(4294967296 / range) * range;
    let x = this.nextU32();
    while (x >= limit) x = this.nextU32();
    return lo + (x % range);
  }

  /** Fisher-Yates in place, same loop shape as the module's shuffle(). */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i >= 1; i--) {
      const j = this.int(0, i);
      const tmp = items[i]!;
      items[i] = items[j]!;
      items[j] = tmp;
    }
    return items;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty');
    return items[this.int(0, items.length - 1)]!;
  }

  /** Independent child stream derived from this stream's next output and a label. */
  fork(label: number | string = 0): Rng {
    return new Rng(hashSeed(this.nextU32(), label));
  }
}
