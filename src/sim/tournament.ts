// Tournament runner: many seeded matches over a worker_threads pool, aggregated in seed order so
// the result is identical for any worker count. Also paired A/B comparisons on identical seeds.
//
// Determinism contract: everything in TournamentResult except `timing` (wall clock and decide()
// durations) is a pure function of (lineups, matches, baseSeed, spec, rotateSeats).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Rng, hashSeed } from '../core/rng.js';
import { parseSeat } from '../bots/registry.js';
import { runMatch, type MatchSpec, type MatchTrace, type SeatSpec } from './match.js';
import {
  pairedT,
  percentiles,
  signTest,
  summarize,
  type LabelStats,
  type MatchRecord,
  type PairedTest,
  type SignTest,
} from './stats.js';

// ------------------------------------------------------------------------------------- jobs

export interface Job {
  k: number;
  lineup: string[];
  /** Label per lineup slot (name, or name#j for duplicates). */
  labels: string[];
  seed: number;
  /** Roster order: order[pos] = lineup slot sitting at roster position pos. */
  order: number[];
  spec: Partial<MatchSpec>;
}

export interface JobResult {
  k: number;
  record: MatchRecord;
  /** Raw decide() durations per seat record (same order as record.seats). */
  decideSamples: number[][];
  trace?: MatchTrace;
}

/** Labels for a lineup: unique entries keep their name, duplicates become name#1, name#2, ... */
export function lineupLabels(lineup: readonly string[]): string[] {
  const count = new Map<string, number>();
  for (const s of lineup) count.set(s, (count.get(s) ?? 0) + 1);
  const seen = new Map<string, number>();
  return lineup.map((s) => {
    if (count.get(s)! === 1) return s;
    const j = (seen.get(s) ?? 0) + 1;
    seen.set(s, j);
    return `${s}#${j}`;
  });
}

/** Run one job in the current thread (also the worker's entry point). */
export function runJob(job: Job): JobResult {
  const seats: SeatSpec[] = job.order.map((slot) => {
    const t = parseSeat(job.lineup[slot]!, hashSeed(job.seed, 'policy', slot));
    return { ...t, id: slot + 1 } as SeatSpec;
  });
  const r = runMatch({ ...job.spec, keepDecideSamples: true }, seats, job.seed);
  const record: MatchRecord = {
    seed: job.seed,
    seats: r.seats.map((s) => ({
      label: job.labels[s.id - 1]!,
      score: s.score,
      rank: s.rank,
      win: s.win,
      lettersWon: s.lettersWon,
      totalPaid: s.totalPaid,
      wordsPlayed: s.wordsPlayed,
      unplayedTiles: s.unplayedTiles,
      unplayedValue: s.unplayedValue,
      rejectedWords: s.rejectedWords,
      rejectedBids: s.rejectedBids,
      voidedDecisions: s.voidedDecisions,
    })),
  };
  const out: JobResult = { k: job.k, record, decideSamples: r.seats.map((s) => s.decideSamples ?? []) };
  if (r.trace) out.trace = r.trace;
  return out;
}

/**
 * Execute jobs: workers = 0 runs in-process (same code path minus the thread); otherwise a pool
 * of min(workers, jobs) threads pulls jobs one at a time. Results are returned in job order.
 */
export async function runJobs(jobs: readonly Job[], workers: number, onDone?: (done: number) => void): Promise<JobResult[]> {
  const results: JobResult[] = new Array(jobs.length);
  if (workers <= 0 || jobs.length === 0) {
    jobs.forEach((j, i) => {
      results[i] = runJob(j);
      onDone?.(i + 1);
    });
    return results;
  }
  const n = Math.min(workers, jobs.length);
  let next = 0;
  let done = 0;
  const pos = new Map<number, number>(jobs.map((j, i) => [j.k, i]));
  await new Promise<void>((resolve, reject) => {
    const pool: Worker[] = [];
    let failed = false;
    const finish = (err?: unknown) => {
      if (failed) return;
      if (err) failed = true;
      for (const w of pool) void w.terminate();
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    };
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), {
        execArgv: [...process.execArgv, '--import', 'tsx'],
      });
      pool.push(w);
      const feed = () => {
        if (next < jobs.length) w.postMessage(jobs[next++]);
      };
      w.on('message', (msg: { ready?: true; result?: JobResult; error?: string }) => {
        if (msg.error) return finish(new Error(`worker job failed: ${msg.error}`));
        if (msg.result) {
          results[pos.get(msg.result.k)!] = msg.result;
          done++;
          onDone?.(done);
          if (done === jobs.length) return finish();
        }
        feed();
      });
      w.on('error', (e) => finish(e));
      w.on('exit', (code) => {
        if (code !== 0 && done < jobs.length) finish(new Error(`worker exited with code ${code}`));
      });
    }
  });
  return results;
}

// ------------------------------------------------------------------------------ tournament

export interface TournamentOptions {
  lineups: string[][];
  matches: number;
  workers?: number;
  baseSeed?: number;
  spec?: Partial<MatchSpec>;
  /** Shuffle the roster order per seed so no lineup slot keeps a fixed seat (default true). */
  rotateSeats?: boolean;
  /** Write the traces of the first `traceLimit` matches here (one JSON file per match). */
  traceDir?: string;
  traceLimit?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface TimingStats {
  wallMs: number;
  decideMs: Record<string, { n: number; mean: number; p50: number; p99: number; max: number }>;
}

export interface TournamentResult {
  matches: number;
  baseSeed: number;
  lineups: string[][];
  spec: Partial<MatchSpec>;
  rotateSeats: boolean;
  stats: LabelStats[];
  /** FNV digest over every match's (seed, label, score) in seed order. */
  digest: string;
  /** Non-deterministic part (excluded from determinism checks). */
  timing: TimingStats;
}

/** Seed of match k. */
export function matchSeed(baseSeed: number, k: number): number {
  return hashSeed(baseSeed, 'match', k);
}

/** Roster order for a seed (identity when rotation is off). */
export function rosterOrder(seed: number, n: number, rotate: boolean): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  if (rotate) new Rng(hashSeed(seed, 'roster')).shuffle(order);
  return order;
}

function digestOf(records: readonly MatchRecord[]): string {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  for (const r of records) {
    mix(`|${r.seed}`);
    for (const s of r.seats) mix(`,${s.label}=${s.score}`);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function decideTiming(results: readonly JobResult[]): TimingStats['decideMs'] {
  const by = new Map<string, number[]>();
  for (const r of results) {
    r.record.seats.forEach((s, i) => {
      const xs = r.decideSamples[i]!;
      if (xs.length === 0) return;
      let arr = by.get(s.label);
      if (!arr) by.set(s.label, (arr = []));
      for (const x of xs) arr.push(x);
    });
  }
  const out: TimingStats['decideMs'] = {};
  for (const [label, xs] of by) out[label] = percentiles(xs);
  return out;
}

function writeTraces(dir: string, jobs: readonly Job[], results: readonly JobResult[], prefix: string): void {
  mkdirSync(dir, { recursive: true });
  results.forEach((r, i) => {
    if (!r.trace) return;
    const j = jobs[i]!;
    const body = { seed: j.seed, lineup: j.lineup, labels: j.labels, order: j.order, record: r.record, trace: r.trace };
    writeFileSync(join(dir, `${prefix}match-${j.k}-seed-${j.seed}.json`), JSON.stringify(body));
  });
}

export async function runTournament(opts: TournamentOptions): Promise<TournamentResult> {
  const t0 = performance.now();
  const { lineups, matches } = opts;
  if (lineups.length === 0) throw new Error('runTournament: no lineups');
  const baseSeed = opts.baseSeed ?? 1;
  const spec = opts.spec ?? {};
  const rotate = opts.rotateSeats ?? true;
  const traceLimit = opts.traceDir ? (opts.traceLimit ?? 20) : 0;
  const jobs: Job[] = [];
  for (let k = 0; k < matches; k++) {
    const lineup = lineups[k % lineups.length]!;
    const seed = matchSeed(baseSeed, k);
    jobs.push({
      k,
      lineup,
      labels: lineupLabels(lineup),
      seed,
      order: rosterOrder(seed, lineup.length, rotate),
      spec: { ...spec, trace: k < traceLimit, matchId: k + 1 },
    });
  }
  const results = await runJobs(jobs, opts.workers ?? 0, (d) => opts.onProgress?.(d, jobs.length));
  if (opts.traceDir) writeTraces(opts.traceDir, jobs, results, '');
  const records = results.map((r) => r.record);
  return {
    matches,
    baseSeed,
    lineups,
    spec,
    rotateSeats: rotate,
    stats: summarize(records, lineups.flatMap((l) => lineupLabels(l))),
    digest: digestOf(records),
    timing: { wallMs: Math.round(performance.now() - t0), decideMs: decideTiming(results) },
  };
}

/** The deterministic part of a tournament result (everything except timing). */
export function deterministicPart<T extends { timing: unknown }>(r: T): Omit<T, 'timing'> {
  const { timing: _t, ...rest } = r;
  return rest;
}

// --------------------------------------------------------------------------- paired compare

export interface CompareOptions {
  focalA: string;
  focalB: string;
  /** Lineup with exactly one '*' marking the focal seat. */
  template: string[];
  matches: number;
  workers?: number;
  baseSeed?: number;
  spec?: Partial<MatchSpec>;
  rotateSeats?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface CompareResult {
  focalA: string;
  focalB: string;
  template: string[];
  matches: number;
  baseSeed: number;
  spec: Partial<MatchSpec>;
  /** Paired deltas A - B of the focal seat (score, rank: negative = A places better, win 0/1). */
  score: PairedTest;
  rank: PairedTest;
  win: PairedTest;
  scoreSign: SignTest;
  a: LabelStats[];
  b: LabelStats[];
  digest: string;
  timing: TimingStats;
}

const FOCAL = '__focal__';

export async function comparePaired(opts: CompareOptions): Promise<CompareResult> {
  const t0 = performance.now();
  const stars = opts.template.filter((s) => s.trim() === '*').length;
  if (stars !== 1) throw new Error(`comparePaired: template needs exactly one '*', got ${stars}`);
  const baseSeed = opts.baseSeed ?? 1;
  const spec = opts.spec ?? {};
  const rotate = opts.rotateSeats ?? true;
  const fill = (focal: string) => opts.template.map((s) => (s.trim() === '*' ? focal : s.trim()));
  const lineupA = fill(opts.focalA);
  const lineupB = fill(opts.focalB);
  const focalSlot = opts.template.findIndex((s) => s.trim() === '*');
  const labelsFor = (lineup: string[]) => {
    const l = lineupLabels(lineup.map((s, i) => (i === focalSlot ? FOCAL : s)));
    l[focalSlot] = FOCAL;
    return l;
  };
  const labels = labelsFor(lineupA);
  const labelsOrder = (focal: string) => labels.map((l) => (l === FOCAL ? focal : l));
  const jobs: Job[] = [];
  for (let k = 0; k < opts.matches; k++) {
    const seed = matchSeed(baseSeed, k);
    const order = rosterOrder(seed, lineupA.length, rotate);
    const s = { ...spec, matchId: k + 1, trace: false };
    jobs.push({ k: 2 * k, lineup: lineupA, labels, seed, order, spec: s });
    jobs.push({ k: 2 * k + 1, lineup: lineupB, labels, seed, order, spec: s });
  }
  const results = await runJobs(jobs, opts.workers ?? 0, (d) => opts.onProgress?.(d, jobs.length));
  const dScore: number[] = [];
  const dRank: number[] = [];
  const dWin: number[] = [];
  const recA: MatchRecord[] = [];
  const recB: MatchRecord[] = [];
  const rename = (r: MatchRecord, focal: string): MatchRecord => ({
    seed: r.seed,
    seats: r.seats.map((s) => (s.label === FOCAL ? { ...s, label: focal } : s)),
  });
  for (let k = 0; k < opts.matches; k++) {
    const a = results[2 * k]!.record;
    const b = results[2 * k + 1]!.record;
    const fa = a.seats.find((s) => s.label === FOCAL)!;
    const fb = b.seats.find((s) => s.label === FOCAL)!;
    dScore.push(fa.score - fb.score);
    dRank.push(fa.rank - fb.rank);
    dWin.push((fa.win ? 1 : 0) - (fb.win ? 1 : 0));
    recA.push(rename(a, `A:${opts.focalA}`));
    recB.push(rename(b, `B:${opts.focalB}`));
  }
  const timingResults = results.map((r) => ({
    ...r,
    record: rename(r.record, r.k % 2 === 0 ? `A:${opts.focalA}` : `B:${opts.focalB}`),
  }));
  return {
    focalA: opts.focalA,
    focalB: opts.focalB,
    template: opts.template,
    matches: opts.matches,
    baseSeed,
    spec,
    score: pairedT(dScore),
    rank: pairedT(dRank),
    win: pairedT(dWin),
    scoreSign: signTest(dScore),
    a: summarize(recA, labelsOrder(`A:${opts.focalA}`)),
    b: summarize(recB, labelsOrder(`B:${opts.focalB}`)),
    digest: digestOf([...recA, ...recB]),
    timing: { wallMs: Math.round(performance.now() - t0), decideMs: decideTiming(timingResults) },
  };
}
