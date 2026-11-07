// Sim gate ("no regression" rule): paired-seed comparison of each candidate against the incumbent
// on the standard lineups plus the live-mirror lineup.
//
// Pass when ALL of:
//   1. pooled rank delta (candidate - incumbent, all lineups) has ciHi <= GATE.maxCiHi (0.05):
//      not worse beyond a twentieth of a place at 95% confidence;
//   2. no single lineup is significantly worse (per-lineup ciLo <= 0);
//   3. the live-mirror lineup's mean rank delta is < 0 (strict improvement where we lost);
//   4. the candidate's lobbySims win rate >= GATE.minLobbySimsWin (0.98).
// The incumbent is simulated once per seed and shared by all candidates (same seeds, same roster
// order, same letters: the simulator's independent seeded streams make the comparison paired).
import { parseSeat } from '../../bots/registry.js';
import { getLineup } from '../../bots/lineups.js';
import type { MatchSpec } from '../../sim/match.js';
import { pairedT, type PairedTest } from '../../sim/stats.js';
import { lineupLabels, matchSeed, rosterOrder, runJobs, type Job } from '../../sim/tournament.js';
import type { ArmGate } from './pool.js';

export const GATE = Object.freeze({
  maxCiHi: 0.05,
  maxLineupCiLo: 0,
  minLobbySimsWin: 0.98,
  mirrorMustImprove: true,
});

export const STANDARD_LINEUPS = ['lobbyNow', 'lobbySims', 'fullTable', 'tricks'] as const;
export const MIRROR = 'liveMirror';
/** Same decision budget as scripts/bawt-bench.ts. */
export const GATE_BUDGET_MS = 200;

export interface GateLineup {
  name: string;
  /** Seat specs with exactly one '*' (the focal seat). */
  template: string[];
  spec?: Partial<MatchSpec>;
}

export interface FocalOutcome {
  rank: number;
  win: boolean;
  score: number;
}

/** results[focal][lineup][seed] for focals = [incumbent, ...candidates]. */
export type EvalResults = FocalOutcome[][][];

export interface EvalOptions {
  matches: number;
  workers: number;
  baseSeed: number;
  budgetMs: number;
  onProgress?: (done: number, total: number) => void;
}

export type Evaluator = (focals: readonly string[], lineups: readonly GateLineup[], opts: EvalOptions) => Promise<EvalResults>;

export function gateLineups(mirror: string[] | undefined): GateLineup[] {
  const out: GateLineup[] = STANDARD_LINEUPS.map((name) => {
    const l = getLineup(name);
    return { name, template: [...l.seats], ...(l.spec ? { spec: { ...l.spec } } : {}) };
  });
  if (mirror) out.push({ name: MIRROR, template: [...mirror] });
  return out;
}

/** Registry spec of a bawt arm: 'bawt' or 'bawt:{json}'. */
export function focalSpec(params: Record<string, unknown>): string {
  return Object.keys(params).length === 0 ? 'bawt' : `bawt:${JSON.stringify(params)}`;
}

const FOCAL_LABEL = '__focal__';

/** Simulator evaluator over the tournament worker pool (one pool for every focal x lineup x seed). */
export const simEvaluator: Evaluator = async (focals, lineups, o) => {
  for (const f of focals) parseSeat(f, 0); // fail fast on a bad spec, before spawning workers
  const jobs: Job[] = [];
  const where: Array<[number, number, number]> = [];
  for (let li = 0; li < lineups.length; li++) {
    const L = lineups[li]!;
    const slot = L.template.findIndex((s) => s.trim() === '*');
    if (slot < 0 || L.template.filter((s) => s.trim() === '*').length !== 1) throw new Error(`gate: lineup ${L.name} needs exactly one '*'`);
    const labels = lineupLabels(L.template.map((s, i) => (i === slot ? FOCAL_LABEL : s)));
    labels[slot] = FOCAL_LABEL;
    for (let k = 0; k < o.matches; k++) {
      const seed = matchSeed(o.baseSeed, k);
      const order = rosterOrder(seed, L.template.length, true);
      const spec: Partial<MatchSpec> = { ...L.spec, decisionBudgetMs: o.budgetMs, matchId: k + 1, trace: false };
      for (let fi = 0; fi < focals.length; fi++) {
        const lineup = L.template.map((s, i) => (i === slot ? focals[fi]! : s.trim()));
        jobs.push({ k: jobs.length, lineup, labels, seed, order, spec });
        where.push([fi, li, k]);
      }
    }
  }
  const results = await runJobs(jobs, o.workers, (d) => o.onProgress?.(d, jobs.length));
  const out: EvalResults = focals.map(() => lineups.map(() => new Array<FocalOutcome>(o.matches)));
  results.forEach((r, i) => {
    const [fi, li, k] = where[i]!;
    const s = r.record.seats.find((x) => x.label === FOCAL_LABEL)!;
    out[fi]![li]![k] = { rank: s.rank, win: s.win, score: s.score };
  });
  return out;
};

export interface LineupDelta {
  name: string;
  n: number;
  rank: PairedTest;
  candWin: number;
  incWin: number;
  candRank: number;
  incRank: number;
}

export interface GateResult {
  pass: boolean;
  reasons: string[];
  perLineup: LineupDelta[];
  pooled: PairedTest;
  lobbySimsWin: number;
  gate: ArmGate;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Pure gate decision from per-seed focal outcomes (incumbent vs one candidate). */
export function decideGate(inc: readonly FocalOutcome[][], cand: readonly FocalOutcome[][], lineups: readonly GateLineup[], th = GATE): GateResult {
  const perLineup: LineupDelta[] = [];
  const all: number[] = [];
  lineups.forEach((L, li) => {
    const a = cand[li] ?? [];
    const b = inc[li] ?? [];
    const n = Math.min(a.length, b.length);
    const d: number[] = [];
    for (let k = 0; k < n; k++) d.push(a[k]!.rank - b[k]!.rank);
    all.push(...d);
    perLineup.push({
      name: L.name,
      n,
      rank: pairedT(d),
      candWin: mean(a.slice(0, n).map((x) => (x.win ? 1 : 0))),
      incWin: mean(b.slice(0, n).map((x) => (x.win ? 1 : 0))),
      candRank: mean(a.slice(0, n).map((x) => x.rank)),
      incRank: mean(b.slice(0, n).map((x) => x.rank)),
    });
  });
  const pooled = pairedT(all);
  const reasons: string[] = [];
  if (all.length === 0) reasons.push('no paired matches');
  if (pooled.hi > th.maxCiHi) reasons.push(`pooled rank delta ciHi ${pooled.hi.toFixed(3)} > ${th.maxCiHi}`);
  for (const l of perLineup) if (l.n > 1 && l.rank.lo > th.maxLineupCiLo) reasons.push(`${l.name} significantly worse (rank delta ${l.rank.mean.toFixed(3)} [${l.rank.lo.toFixed(3)}, ${l.rank.hi.toFixed(3)}])`);
  const mirror = perLineup.find((l) => l.name === MIRROR);
  if (th.mirrorMustImprove) {
    if (!mirror) reasons.push('no live-mirror lineup');
    else if (!(mirror.rank.mean < 0)) reasons.push(`live mirror not improved (rank delta ${mirror.rank.mean.toFixed(3)})`);
  }
  const sims = perLineup.find((l) => l.name === 'lobbySims');
  const lobbySimsWin = sims ? sims.candWin : 0;
  if (!sims) reasons.push('no lobbySims lineup');
  else if (lobbySimsWin < th.minLobbySimsWin) reasons.push(`lobbySims win ${(100 * lobbySimsWin).toFixed(1)}% < ${100 * th.minLobbySimsWin}%`);
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    pass: reasons.length === 0,
    reasons,
    perLineup,
    pooled,
    lobbySimsWin,
    gate: {
      lineups: lineups.map((l) => l.name),
      matches: perLineup.length ? Math.min(...perLineup.map((l) => l.n)) : 0,
      meanRankDelta: r3(pooled.mean),
      ciLo: r3(pooled.lo),
      ciHi: r3(pooled.hi),
      lobbySimsWin: r3(lobbySimsWin),
    },
  };
}

/** Markdown table rows of a gate result. */
export function renderGate(g: GateResult): string {
  const rows = g.perLineup.map(
    (l) =>
      `| ${l.name} | ${l.n} | ${l.rank.mean.toFixed(3)} [${l.rank.lo.toFixed(3)}, ${l.rank.hi.toFixed(3)}] | ${l.candRank.toFixed(2)} vs ${l.incRank.toFixed(2)} | ${(100 * l.candWin).toFixed(1)} vs ${(100 * l.incWin).toFixed(1)} |`,
  );
  return [
    '| lineup | n | Δrank cand-inc [95% CI] | rank cand vs inc | win% cand vs inc |',
    '|---|---|---|---|---|',
    ...rows,
    `| **pooled** | ${g.pooled.n} | ${g.pooled.mean.toFixed(3)} [${g.pooled.lo.toFixed(3)}, ${g.pooled.hi.toFixed(3)}] | | |`,
  ].join('\n');
}
