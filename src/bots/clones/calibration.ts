// Calibration harness for the data-fitted clones (COMPETITORS.md §4.9) and metrics per clone from
// match traces. Shared by scripts/zoo-calibrate.ts and test/bots/clones-calibration.test.ts.
//
// Table mix = the NOW block itself (§2.1-2.2: 600 matches; 3 real bots in 415, 2 in 130, 4 in 55;
// Bron in 600, LUCENT in 490, maverick in 473, the dead Afterword seat in 161). Solving those
// counts with "no Bron+Afterword-only tables" and an even LBA/BMA split gives NOW_TABLES (599
// matches: the published counts are inconsistent by one 2-real match). The NOW
// per-bot averages come from this mix: in a pure 3-real table the three targets add up to 71.7
// tiles of 68 auctions, which is infeasible and drove a first tuning run into a bidding arms race.
// Afterword (scored 0, won 0 tiles since ~Oct 31) is a seat that never bids or plays.
import { STARTING_BALANCE } from '../../core/letters.js';
import { Rng, hashSeed } from '../../core/rng.js';
import type { MatchTrace } from '../../sim/match.js';
import { lineupLabels, matchSeed, rosterOrder, runJobs, type Job } from '../../sim/tournament.js';
import { BRON_TARGETS } from './bron.js';
import type { FittedTargets } from './fitted.js';
import { LUCENT_TARGETS } from './lucent.js';
import { MAVERICK_TARGETS } from './maverick.js';

export const FITTED_TARGETS: Readonly<Record<string, FittedTargets>> = {
  'clone:lucent': LUCENT_TARGETS,
  'clone:bron': BRON_TARGETS,
  'clone:maverick': MAVERICK_TARGETS,
};

export const FITTED_NAMES = Object.keys(FITTED_TARGETS);

/** Dead seat (Afterword since ~Oct 31): the greedy baseline with no bids and no playable words. */
export const DEAD_SEAT = 'greedy:{"bidMul":0,"bidAdd":0,"minLen":99}';

/** Module lobby sims (bot ids 1..6); timeout padding seats a uniformly random subset. */
const LOBBY_SIMS = ['sim:Cheapskate', 'sim:ValueBidder', 'sim:Aggressive', 'sim:ValueBidder', 'sim:Aggressive', 'sim:Cheapskate'];

export interface TableType {
  clones: string[];
  dead: number;
  /** NOW matches of this type (599 in total). */
  weight: number;
}

/** NOW table mix (see header). Every table has 6 seats; the rest are lobby sims. */
export const NOW_TABLES: readonly TableType[] = [
  { clones: ['clone:lucent', 'clone:bron', 'clone:maverick'], dead: 0, weight: 309 },
  { clones: ['clone:lucent', 'clone:bron', 'clone:maverick'], dead: 1, weight: 55 },
  { clones: ['clone:lucent', 'clone:bron'], dead: 1, weight: 53 },
  { clones: ['clone:bron', 'clone:maverick'], dead: 1, weight: 53 },
  { clones: ['clone:lucent', 'clone:bron'], dead: 0, weight: 73 },
  { clones: ['clone:bron', 'clone:maverick'], dead: 0, weight: 56 },
];

/** Deterministic interleaved schedule of table types (largest deficit first). */
export function tableSchedule(matches: number, tables: readonly TableType[] = NOW_TABLES): number[] {
  const total = tables.reduce((a, t) => a + t.weight, 0);
  const count = tables.map(() => 0);
  const out: number[] = [];
  for (let k = 0; k < matches; k++) {
    let best = 0;
    let bestDef = -Infinity;
    tables.forEach((t, i) => {
      const def = ((k + 1) * t.weight) / total - count[i]!;
      if (def > bestDef + 1e-12) {
        bestDef = def;
        best = i;
      }
    });
    count[best]!++;
    out.push(best);
  }
  return out;
}

/** n distinct lobby sims chosen uniformly (module timeout padding). */
function padding(n: number, seed: number): string[] {
  const ids = [0, 1, 2, 3, 4, 5];
  new Rng(hashSeed(seed, 'padding')).shuffle(ids);
  return ids.slice(0, n).map((i) => LOBBY_SIMS[i]!);
}

export interface CloneParams {
  kappa: number;
  penFrac: number;
  needW: number;
}

export interface CloneMetrics {
  n: number;
  tiles: number;
  paidPerTile: number;
  endBalance: number;
  words: number;
  score: number;
  firstWordRound: number;
  balR20: number;
  balR45: number;
  balR56: number;
  winRate: number;
  avgRank: number;
}

export interface FittedEvaluation {
  metrics: Record<string, CloneMetrics>;
  /** P(row's score > column's score) over shared matches (ties count half). */
  headToHead: Record<string, Record<string, number>>;
  /** Shared matches per pair. */
  shared: Record<string, Record<string, number>>;
  matches: number;
}

function specFor(name: string, p: CloneParams): string {
  return `${name}:${JSON.stringify({ kappa: p.kappa, penFrac: p.penFrac, needW: p.needW })}`;
}

/** Balance of a seat when auction `index` opens (before that auction's words). */
function balanceAt(trace: MatchTrace, seatId: number, index: number): number {
  let b = STARTING_BALANCE;
  for (const a of trace.auctions) if (a.index < index && a.winnerId === seatId) b -= a.paid;
  for (const w of trace.words) if (w.index < index && w.seatId === seatId) b += w.reward;
  return b;
}

type Acc = { [K in keyof CloneMetrics]: number } & { firstN: number; wins: number; paid: number };

const blank = (): Acc => ({
  n: 0,
  tiles: 0,
  paidPerTile: 0,
  endBalance: 0,
  words: 0,
  score: 0,
  firstWordRound: 0,
  balR20: 0,
  balR45: 0,
  balR56: 0,
  winRate: 0,
  avgRank: 0,
  firstN: 0,
  wins: 0,
  paid: 0,
});

export async function evaluateFitted(
  params: Readonly<Record<string, CloneParams>>,
  matches: number,
  baseSeed = 1,
  workers = 0,
  tables: readonly TableType[] = NOW_TABLES,
): Promise<FittedEvaluation> {
  const schedule = tableSchedule(matches, tables);
  const jobs: Job[] = [];
  for (let k = 0; k < matches; k++) {
    const tt = tables[schedule[k]!]!;
    const seed = matchSeed(baseSeed, k);
    const lineup = [
      ...tt.clones.map((n) => specFor(n, params[n]!)),
      ...Array.from({ length: tt.dead }, () => DEAD_SEAT),
      ...padding(6 - tt.clones.length - tt.dead, seed),
    ];
    jobs.push({
      k,
      lineup,
      labels: lineupLabels(lineup),
      seed,
      order: rosterOrder(seed, lineup.length, true),
      spec: { trace: true, matchId: k + 1 },
    });
  }
  const results = await runJobs(jobs, workers);
  const acc = new Map<string, Acc>();
  const h2h = new Map<string, number>();
  const shared = new Map<string, number>();
  for (const r of results) {
    const tr = r.trace!;
    const job = jobs[r.k]!;
    const tt = tables[schedule[r.k]!]!;
    const scores = new Map<string, number>();
    tt.clones.forEach((name, slot) => {
      const id = slot + 1;
      const seat = r.record.seats.find((s) => s.label === job.labels[slot])!;
      const a = acc.get(name) ?? blank();
      a.n++;
      a.tiles += seat.lettersWon;
      a.paid += seat.totalPaid;
      a.words += seat.wordsPlayed;
      a.score += seat.score;
      a.endBalance += balanceAt(tr, id, Number.MAX_SAFE_INTEGER);
      a.balR20 += balanceAt(tr, id, 19);
      a.balR45 += balanceAt(tr, id, 44);
      a.balR56 += balanceAt(tr, id, 55);
      a.avgRank += seat.rank;
      if (seat.win) a.wins++;
      const first = tr.words.find((w) => w.seatId === id);
      if (first) {
        a.firstWordRound += first.index + 1;
        a.firstN++;
      }
      acc.set(name, a);
      scores.set(name, seat.score);
    });
    for (const [x, sx] of scores)
      for (const [y, sy] of scores) {
        if (x === y) continue;
        const key = `${x}|${y}`;
        h2h.set(key, (h2h.get(key) ?? 0) + (sx > sy ? 1 : sx === sy ? 0.5 : 0));
        shared.set(key, (shared.get(key) ?? 0) + 1);
      }
  }
  const metrics: Record<string, CloneMetrics> = {};
  for (const name of FITTED_NAMES) {
    const a = acc.get(name);
    if (!a) continue;
    const n = a.n;
    metrics[name] = {
      n,
      tiles: a.tiles / n,
      paidPerTile: a.tiles > 0 ? a.paid / a.tiles : 0,
      endBalance: a.endBalance / n,
      words: a.words / n,
      score: a.score / n,
      firstWordRound: a.firstN > 0 ? a.firstWordRound / a.firstN : 0,
      balR20: a.balR20 / n,
      balR45: a.balR45 / n,
      balR56: a.balR56 / n,
      winRate: a.wins / n,
      avgRank: a.avgRank / n,
    };
  }
  const headToHead: Record<string, Record<string, number>> = {};
  const sharedOut: Record<string, Record<string, number>> = {};
  for (const x of FITTED_NAMES) {
    headToHead[x] = {};
    sharedOut[x] = {};
    for (const y of FITTED_NAMES) {
      if (x === y) continue;
      const m = shared.get(`${x}|${y}`) ?? 0;
      sharedOut[x]![y] = m;
      headToHead[x]![y] = m > 0 ? h2h.get(`${x}|${y}`)! / m : Number.NaN;
    }
  }
  return { metrics, headToHead, shared: sharedOut, matches };
}

/** Relative error (achieved - target) / target. */
export function relErr(achieved: number, target: number): number {
  return (achieved - target) / target;
}

export const CALIBRATED_KEYS = ['tiles', 'paidPerTile', 'endBalance', 'words'] as const;

export interface TuneOptions {
  matches: number;
  baseSeed?: number;
  workers?: number;
  passes?: number;
  kappaIters?: number;
  needIters?: number;
  kappaRange?: [number, number];
  needRange?: [number, number];
  onStep?: (step: string, params: Record<string, CloneParams>, ev: FittedEvaluation) => void;
}

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Coordinate-wise (Gauss-Seidel) bisection on common seeds. For one clone at a time, holding the
 * other two fixed:
 *   1. log κ is bisected on that clone's tiles/match (more κ = more tiles; monotone thanks to the
 *      pacing cap, see fitted.ts);
 *   2. optionally (needIters > 0, off by default) needW is bisected on its end balance. Grids
 *      showed it is not monotone and lowers scores, so the shipped clones keep needW = 0.
 * Passes repeat the sweep so cross-effects between the three clones settle. penFrac (B == 1) is
 * kept at the spec's measured median top/balance: in a first tuning run, moving it from 0.98 to
 * 0.32 changed end balances by < 1 coin, so it carries no signal for bisection.
 */
export async function tuneFitted(start: Readonly<Record<string, CloneParams>>, o: TuneOptions): Promise<Record<string, CloneParams>> {
  const params: Record<string, CloneParams> = {};
  for (const n of FITTED_NAMES) params[n] = { ...start[n]! };
  const ev = (): Promise<FittedEvaluation> => evaluateFitted(params, o.matches, o.baseSeed, o.workers);
  const [kLo, kHi] = o.kappaRange ?? [0.25, 2.5];
  const [nLo, nHi] = o.needRange ?? [0, 3];
  for (let pass = 0; pass < (o.passes ?? 3); pass++) {
    for (const n of FITTED_NAMES) {
      const t = FITTED_TARGETS[n]!;
      let lo = Math.log(kLo);
      let hi = Math.log(kHi);
      for (let it = 0; it < (o.kappaIters ?? 7); it++) {
        params[n]!.kappa = r4(Math.exp((lo + hi) / 2));
        const e = await ev();
        o.onStep?.(`pass ${pass} ${n} kappa #${it}`, params, e);
        if (e.metrics[n]!.tiles < t.tiles) lo = Math.log(params[n]!.kappa);
        else hi = Math.log(params[n]!.kappa);
      }
      params[n]!.kappa = r4(Math.exp((lo + hi) / 2));
      if ((o.needIters ?? 0) <= 0) continue;
      let a = nLo;
      let b = nHi;
      for (let it = 0; it < (o.needIters ?? 0); it++) {
        params[n]!.needW = r4((a + b) / 2);
        const e = await ev();
        o.onStep?.(`pass ${pass} ${n} needW #${it}`, params, e);
        if (e.metrics[n]!.endBalance < t.endBalance) a = params[n]!.needW;
        else b = params[n]!.needW;
      }
      params[n]!.needW = r4((a + b) / 2);
    }
  }
  return params;
}
