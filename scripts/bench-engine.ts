// Word-engine benchmark: npx tsx scripts/bench-engine.ts [--racks N] [--seed S]
// Seeded random racks drawn from the 98-tile bag. Reports dictionary/index build cost, sub-class
// enumeration latency, packExact latency/exact-rate and packFast latency + gap vs exact.
import { BAG, NUM_LETTERS } from '../src/core/letters.js';
import { emptyRack, type Rack } from '../src/core/rack.js';
import { Rng } from '../src/core/rng.js';
import { AnagramIndex, IntBuffer, Packer, loadDictionary } from '../src/engine/index.js';

const args = process.argv.slice(2);
const opt = (name: string, def: number): number => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const RACKS = opt('racks', 200);
const SEED = opt('seed', 1);
const SIZES = [12, 20, 25, 30, 35];
const EXACT_LIMIT_MS = 300;

const BAG_TILES: number[] = [];
for (let i = 0; i < NUM_LETTERS; i++) for (let k = 0; k < BAG[i]!; k++) BAG_TILES.push(i);
function randomBagRack(rng: Rng, n: number): Rack {
  const tiles = rng.shuffle([...BAG_TILES]);
  const r = emptyRack();
  for (let k = 0; k < n; k++) r[tiles[k]!]!++;
  return r;
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
};
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const f = (x: number, d = 3): string => x.toFixed(d);
const mb = (b: number): string => `${(b / 1048576).toFixed(1)} MB`;

const mem0 = process.memoryUsage();
let t0 = performance.now();
const dict = loadDictionary();
const tDict = performance.now() - t0;
t0 = performance.now();
const index = new AnagramIndex(dict);
const tIndex = performance.now() - t0;
t0 = performance.now();
const warmPacker = new Packer(index);
const tPacker = performance.now() - t0;
globalThis.gc?.();
const mem1 = process.memoryUsage();
console.log(`dictionary: ${dict.size} words, ${dict.classes.count} classes, ${f(tDict, 1)} ms`);
console.log(`anagram index: ${index.nodeCount} trie nodes, ${f(tIndex, 1)} ms; packer tables ${f(tPacker, 1)} ms`);
console.log(
  `memory delta: heap ${mb(mem1.heapUsed - mem0.heapUsed)}, arrayBuffers ${mb(mem1.arrayBuffers - mem0.arrayBuffers)}, rss ${mb(mem1.rss - mem0.rss)}`,
);
console.log(`racks per size: ${RACKS}, seed ${SEED}\n`);

console.log('size | enum p50 / p99 ms (classes avg) | exact p50 / p99 ms, exact-rate @300ms, nodes p50 | fast mean / p99 ms, gap mean / max');
for (const size of SIZES) {
  const rng = new Rng(SEED * 1000 + size);
  const racks = Array.from({ length: RACKS }, () => randomBagRack(rng, size));
  // warm-up JIT on unrelated racks
  const wrng = new Rng(SEED * 7 + size);
  for (let k = 0; k < 20; k++) {
    const r = randomBagRack(wrng, size);
    index.countSubClasses(r);
    warmPacker.packFast(r);
  }

  const buf = new IntBuffer(1 << 16);
  const tEnum: number[] = [];
  let nClasses = 0;
  for (const r of racks) {
    buf.length = 0;
    const s = performance.now();
    nClasses += index.collect(r, 2, buf);
    tEnum.push(performance.now() - s);
  }

  const tFast: number[] = [];
  const fastScores: number[] = [];
  for (const r of racks) {
    const s = performance.now();
    const res = warmPacker.packFast(r);
    tFast.push(performance.now() - s);
    fastScores.push(res.score);
  }

  // Exact: a cold packer per rack (no memo carry-over) so latency is the single-call cost.
  const tExact: number[] = [];
  const nodes: number[] = [];
  const gaps: number[] = [];
  let exactCount = 0;
  for (let k = 0; k < racks.length; k++) {
    const p = new Packer(index);
    const s = performance.now();
    const res = p.packExact(racks[k]!, { timeLimitMs: EXACT_LIMIT_MS });
    tExact.push(performance.now() - s);
    nodes.push(res.nodes);
    if (res.exact) {
      exactCount++;
      gaps.push(res.score > 0 ? (res.score - fastScores[k]!) / res.score : 0);
    }
  }
  console.log(
    `${String(size).padStart(4)} | ${f(pct(tEnum, 0.5))} / ${f(pct(tEnum, 0.99))} (${Math.round(nClasses / racks.length)})` +
      ` | ${f(pct(tExact, 0.5), 2)} / ${f(pct(tExact, 0.99), 2)}, ${f((100 * exactCount) / racks.length, 1)}%, ${pct(nodes, 0.5)}` +
      ` | ${f(mean(tFast))} / ${f(pct(tFast, 0.99))}, ${f(100 * mean(gaps), 2)}% / ${f(100 * Math.max(0, ...gaps), 1)}%`,
  );
}

// Warm-cache throughput: Monte-Carlo-like workload (many racks sharing a common core).
{
  const rng = new Rng(SEED * 99);
  const p = new Packer(index);
  const core = randomBagRack(rng, 14);
  const times: number[] = [];
  for (let k = 0; k < 500; k++) {
    const r = new Uint8Array(core);
    const extra = randomBagRack(rng, 6);
    for (let i = 0; i < NUM_LETTERS; i++) r[i] = r[i]! + extra[i]!;
    const s = performance.now();
    p.packExact(r, { timeLimitMs: EXACT_LIMIT_MS });
    times.push(performance.now() - s);
  }
  console.log(`\nwarm memo, 14 shared + 6 random tiles: packExact mean ${f(mean(times), 2)} ms, p99 ${f(pct(times, 0.99), 2)} ms`);
}
