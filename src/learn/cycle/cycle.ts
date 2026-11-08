// The offline loss-learning cycle (reinforcement from live losses):
//
//   ingest -> diagnose each new loss -> propose candidates from the incumbent arm -> sim gate
//   (paired seeds, no regression) -> add passing arms to the bandit pool -> journal everything.
//
// Runs outside the live client (scripts/learn-cycle.ts). It never touches the network; it only
// reads runs/live/*.jsonl and read-modify-writes the LearnState file atomically. The live client's
// Thompson sampler then decides, from real results, which gated arm actually plays.
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { setPriority } from 'node:os';
import { dirname } from 'node:path';
import { hashSeed } from '../../core/rng.js';
import { generateCandidates, type Candidate } from './candidates.js';
import { diagnose, renderDiagnosis, type Diagnosis } from './diagnose.js';
import { decideGate, focalSpec, gateLineups, GATE, GATE_BUDGET_MS, renderGate, simEvaluator, type Evaluator, type GateResult } from './gate.js';
import { backfill, isLoss, readFinishedMatch, scanLogs, type MatchSummary } from './ingest.js';
import { mirrorLineup, type MirrorInput } from './mirror.js';
import { addArms, armIdFor, incumbentArm, posteriorMean, type PoolChange } from '../bandit.js';
import { loadStateStrict as loadState, updateState, type Arm, type MatchRecord as MatchRec } from '../store.js';

export interface CycleOptions {
  statePath: string;
  logsDir: string;
  /** Iteration log (markdown, append-only). */
  journalPath: string;
  matches: number;
  workers: number;
  budgetMs?: number;
  /** Backfill only logs older than this (the live client records its own matches first). */
  graceMs?: number;
  /** Recent finished matches used for the live-mirror lineup. */
  mirrorRecent?: number;
  /** At most this many (most recent) losses are diagnosed per cycle; older backlog is marked. */
  maxLosses?: number;
  evaluator?: Evaluator;
  now?: () => number;
  log?: (msg: string) => void;
  onProgress?: (done: number, total: number) => void;
}

export interface CandidateOutcome {
  candidate: Candidate;
  armId: string;
  gate: GateResult;
}

export interface CycleReport {
  status: 'idle' | 'done' | 'busy';
  backfilled: number[];
  analyzed: number[];
  diagnoses: Diagnosis[];
  incumbent?: string;
  mirror?: string[];
  outcomes: CandidateOutcome[];
  pool?: PoolChange;
  ms: number;
}

export const DEFAULTS = Object.freeze({ matches: 200, workers: 4, graceMs: 120_000, mirrorRecent: 20, maxLosses: 12, pollMs: 30_000 });

// ---------------------------------------------------------------------------------- helpers

/** Lower our CPU priority (inherited by worker threads spawned afterwards). Best effort. */
export function lowerPriority(): boolean {
  try {
    setPriority(19);
    return true;
  } catch {
    return false;
  }
}

/** Exclusive cycle lock next to the state file; a lock held by a dead pid is taken over. */
export function acquireLock(path: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      let pid = NaN;
      try {
        pid = Number(readFileSync(path, 'utf8').trim());
      } catch {
        /* vanished */
      }
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
      if (alive) return false;
      try {
        unlinkSync(path);
      } catch {
        /* raced */
      }
    }
  }
  return false;
}

export function releaseLock(path: string): void {
  try {
    if (readFileSync(path, 'utf8').trim() === String(process.pid)) unlinkSync(path);
  } catch {
    /* already gone */
  }
}

const JOURNAL_HEADER = `# Learning journal\n\nAppend-only iteration log of the loss-learning cycle (\`npx tsx scripts/learn-cycle.ts\`).\n`;

export function appendJournal(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, JOURNAL_HEADER);
  appendFileSync(path, `\n${text.trimEnd()}\n`);
}

/** Parsed finished-match summaries, cached by (file, mtime) across watch iterations. */
const summaryCache = new Map<string, { mtimeMs: number; summary: MatchSummary | undefined }>();

export function finishedSummaries(dir: string): { summaries: MatchSummary[]; mtimes: Map<number, number> } {
  const summaries: MatchSummary[] = [];
  const mtimes = new Map<number, number>();
  for (const f of scanLogs(dir)) {
    let c = summaryCache.get(f.file);
    if (!c || c.mtimeMs !== f.mtimeMs) {
      c = { mtimeMs: f.mtimeMs, summary: readFinishedMatch(f.file) };
      summaryCache.set(f.file, c);
    }
    if (c.summary) {
      summaries.push(c.summary);
      mtimes.set(c.summary.matchId, f.mtimeMs);
    }
  }
  return { summaries, mtimes };
}

function mirrorInputs(recs: readonly MatchRec[], byId: ReadonlyMap<number, MatchSummary>): MirrorInput[] {
  return recs.map((m) => {
    const s = byId.get(m.matchId);
    if (s) return { players: s.config.players, myId: s.config.myId };
    // state-only record: names only; '-sim' suffix marks sims
    return { myId: -1, players: [{ id: -1, name: 'me', isSim: false }, ...m.opponents.map((name, i) => ({ id: i + 1, name, isSim: /-sim$/i.test(name) }))] };
  });
}

const fmt = (v: unknown) => '`' + JSON.stringify(v) + '`';

// ------------------------------------------------------------------------------------ cycle

export async function runCycle(o: CycleOptions): Promise<CycleReport> {
  const t0 = performance.now();
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});
  const report: CycleReport = { status: 'idle', backfilled: [], analyzed: [], diagnoses: [], outcomes: [], ms: 0 };
  const done = () => {
    report.ms = Math.round(performance.now() - t0);
    return report;
  };

  // 1. ingest
  const { summaries, mtimes } = finishedSummaries(o.logsDir);
  const byId = new Map(summaries.map((s) => [s.matchId, s]));
  let state = loadState(o.statePath);
  const known = new Set(state.matches.map((m) => m.matchId));
  const trimmed = state.trimmedThrough ?? -Infinity;
  if (summaries.some((s) => !known.has(s.matchId) && s.matchId > trimmed)) {
    state = updateState(o.statePath, (s) => {
      report.backfilled = backfill(s, summaries, mtimes, now(), o.graceMs ?? DEFAULTS.graceMs);
    });
    if (report.backfilled.length) log(`backfilled ${report.backfilled.length} match(es): ${report.backfilled.join(', ')}`);
  }
  const pending = state.matches.filter((m) => isLoss(m) && !m.analyzed).sort((a, b) => a.matchId - b.matchId);
  if (pending.length === 0) return done();

  const maxLosses = o.maxLosses ?? DEFAULTS.maxLosses;
  const focus = pending.slice(-maxLosses);
  const backlog = pending.slice(0, Math.max(0, pending.length - maxLosses)).map((m) => m.matchId);

  // 2. diagnose
  const noLog: number[] = [];
  for (const m of focus) {
    const s = byId.get(m.matchId);
    if (!s) {
      noLog.push(m.matchId);
      continue;
    }
    const d = diagnose(s, state.book);
    d.armId = m.armId;
    report.diagnoses.push(d);
  }
  report.analyzed = [...backlog, ...focus.map((m) => m.matchId)];
  const stamp = new Date(now()).toISOString();
  if (report.diagnoses.length) {
    appendJournal(o.journalPath, [`### Losses diagnosed ${stamp}`, '', ...report.diagnoses.map(renderDiagnosis)].join('\n'));
  }
  if (report.diagnoses.length === 0) {
    updateState(o.statePath, (s) => {
      for (const m of s.matches) if (report.analyzed.includes(m.matchId)) m.analyzed = true;
    });
    appendJournal(o.journalPath, `### Cycle ${stamp}\n\n- losses ${report.analyzed.join(', ')} have no readable log; marked analyzed, no candidates.`);
    report.status = 'done';
    return done();
  }

  // 3. candidates from the incumbent
  const inc = incumbentArm(state);
  report.incumbent = inc.id;
  const latest = report.diagnoses[report.diagnoses.length - 1]!;
  const latestCfg = byId.get(latest.matchId)?.config;
  const seed = hashSeed('learn-cycle', ...report.diagnoses.map((d) => d.matchId));
  const candidates = generateCandidates(inc.params, report.diagnoses, { ...(latestCfg ? { config: latestCfg } : {}), seed });

  // 4. sim gate
  const recent = [...state.matches].sort((a, b) => b.matchId - a.matchId).slice(0, o.mirrorRecent ?? DEFAULTS.mirrorRecent);
  const mirror = mirrorLineup(mirrorInputs(recent, byId));
  report.mirror = mirror;
  const lineups = gateLineups(mirror);
  const budgetMs = o.budgetMs ?? GATE_BUDGET_MS;
  const focals = [focalSpec(inc.params), ...candidates.map((c) => focalSpec(c.params))];
  log(`gate: ${candidates.length} candidate(s) vs ${inc.id} on ${lineups.map((l) => l.name).join(', ')} x ${o.matches} seeds`);
  const results = await (o.evaluator ?? simEvaluator)(focals, lineups, {
    matches: o.matches,
    workers: o.workers,
    baseSeed: seed,
    budgetMs,
    ...(o.onProgress ? { onProgress: o.onProgress } : {}),
  });
  const incRes = results[0]!;
  report.outcomes = candidates.map((c, i) => ({ candidate: c, armId: armIdFor(c.params), gate: decideGate(incRes, results[i + 1]!, lineups) }));

  // 5. pool update (fresh read-modify-write; the live client may have written meanwhile)
  const created = new Date(now()).toISOString();
  const newArms: Arm[] = report.outcomes
    .filter((x) => x.gate.pass)
    .map((x) => ({
      id: x.armId,
      params: x.candidate.params,
      origin: 'cycle' as const,
      createdAt: created,
      parent: inc.id,
      // mild optimistic prior from the gate: up to +0.5 pseudo-wins for a sim improvement
      alpha: 1 + Math.min(0.5, Math.max(0, -2 * x.gate.gate.meanRankDelta)),
      beta: 1,
      plays: 0,
      gate: x.gate.gate,
    }));
  const analyzed = new Set(report.analyzed);
  updateState(o.statePath, (s) => {
    for (const m of s.matches) if (analyzed.has(m.matchId)) m.analyzed = true;
    report.pool = addArms(s, newArms);
  });

  // 6. journal
  const lines: string[] = [
    `### Cycle ${stamp}: incumbent \`${inc.id}\` (posterior ${posteriorMean(inc).toFixed(3)}, ${inc.plays} plays)`,
    '',
    `- losses analysed: ${focus.map((m) => m.matchId).join(', ')}${backlog.length ? ` (+${backlog.length} older backlog marked)` : ''}${noLog.length ? `; no log: ${noLog.join(', ')}` : ''}`,
    `- hypothesis: ${candidates[0]?.hypothesis ?? 'none'}`,
    `- live mirror: ${fmt(mirror ?? [])}`,
    `- gate: ${o.matches} paired seeds per lineup, budget ${budgetMs} ms, base seed ${seed}; pass = pooled ciHi <= ${GATE.maxCiHi}, no lineup significantly worse, live mirror improves, lobbySims win >= ${GATE.minLobbySimsWin}`,
  ];
  if (candidates.length === 0) lines.push('- no candidates (all steps clamped to the incumbent)');
  for (const x of report.outcomes) {
    lines.push(
      '',
      `#### ${x.candidate.label} \`${x.armId}\`: ${x.gate.pass ? '**accepted**' : '**rejected**'}`,
      '',
      `- hypothesis: ${x.candidate.hypothesis}`,
      `- params ${fmt(x.candidate.params)}; delta vs incumbent ${fmt(x.candidate.delta)}`,
      '',
      renderGate(x.gate),
      '',
      x.gate.pass ? `- accepted: pooled Δrank ${x.gate.gate.meanRankDelta} [${x.gate.gate.ciLo}, ${x.gate.gate.ciHi}], lobbySims win ${x.gate.gate.lobbySimsWin}` : `- rejected: ${x.gate.reasons.join('; ')}`,
    );
  }
  const p = report.pool!;
  lines.push('', `- pool: added ${fmt(p.added)}, retired ${fmt(p.retired)}${p.skipped.length ? `, skipped ${fmt(p.skipped)}` : ''}; cycle ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  appendJournal(o.journalPath, lines.join('\n'));
  report.status = 'done';
  log(`cycle done: ${report.outcomes.filter((x) => x.gate.pass).length}/${report.outcomes.length} accepted, added ${p.added.join(', ') || '-'}, retired ${p.retired.join(', ') || '-'}`);
  return done();
}

/** runCycle under the exclusive lock (status 'busy' when another cycle holds it). */
export async function runCycleLocked(o: CycleOptions): Promise<CycleReport> {
  const lock = `${o.statePath}.cycle.lock`;
  if (!acquireLock(lock)) return { status: 'busy', backfilled: [], analyzed: [], diagnoses: [], outcomes: [], ms: 0 };
  try {
    return await runCycle(o);
  } finally {
    releaseLock(lock);
  }
}

export interface WatchHandle {
  stop(): void;
  done: Promise<void>;
}

/**
 * Poll every pollMs; cycles never overlap (sequential loop + the file lock). Errors are logged and
 * the loop keeps going with exponential backoff (skip 2^failures polls, at most 32).
 */
export function watch(o: CycleOptions, pollMs: number = DEFAULTS.pollMs): WatchHandle {
  let stopped = false;
  let wake: (() => void) | undefined;
  const log = o.log ?? (() => {});
  let failures = 0;
  let skip = 0;
  const done = (async () => {
    while (!stopped) {
      if (skip > 0) skip--;
      else {
        try {
          const r = await runCycleLocked(o);
          failures = 0;
          if (r.status === 'busy') log('another cycle holds the lock; waiting');
        } catch (e) {
          failures++;
          skip = Math.min(32, 2 ** failures);
          log(`cycle failed (#${failures}, retry in ${skip} polls): ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (stopped) break;
      await new Promise<void>((res) => {
        const t = setTimeout(res, pollMs);
        wake = () => {
          clearTimeout(t);
          res();
        };
      });
    }
  })();
  return {
    stop() {
      stopped = true;
      wake?.();
    },
    done,
  };
}
