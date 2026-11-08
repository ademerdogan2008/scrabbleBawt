// Live-only loss cycle (default for `npm run learn`): ingest + diagnose exactly like the sim cycle,
// but no simulator gate. At most LIVE.maxNew candidates per cycle go straight into the bandit pool
// as live arms (origin 'cycle', gate stub 'live-only'), clamped by LEARNABLE, deduped against every
// existing arm, parented to the best tested arm. The live Thompson sampler then tests them on real
// matches; weak arms are retired when the pool is full.
//
// Rate limits (so the bandit can actually evaluate what it gets):
//   - at most one cycle per LIVE.minNewMatches new finished live matches (marker file next to the state);
//   - never more than LIVE.maxUntested untested arms (plays < LIVE.testedPlays) at once;
//   - pool cap MAX_ACTIVE_ARMS; when full, retire the lowest posterior mean among non-default arms
//     with plays >= LIVE.retirePlays; if none qualifies, skip adding.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashSeed } from '../../core/rng.js';
import type { MatchConfig } from '../../core/types.js';
import { clampParams, knobSpec, knobValues, withKnobs, type KnobName, type KnobValues } from '../arms.js';
import { armIdFor, incumbentArm, isEligible, MAX_ACTIVE_ARMS, posteriorMean } from '../bandit.js';
import { DEFAULT_ARM_ID, loadStateStrict as loadState, updateState, type Arm, type ArmGate, type LearnState } from '../store.js';
import { categoryWeights, generateCandidates, STEP, type Candidate } from './candidates.js';
import { appendJournal, DEFAULTS, finishedSummaries, type CycleOptions, type CycleReport } from './cycle.js';
import { diagnose, renderDiagnosis } from './diagnose.js';
import { backfill, isLoss } from './ingest.js';

export const LIVE = Object.freeze({
  /** New finished live matches required between two cycles. */
  minNewMatches: 3,
  /** At most this many untested arms in the pool at once. */
  maxUntested: 2,
  /** An arm counts as tested from this many plays on. */
  testedPlays: 5,
  /** Only arms with at least this many plays may be retired to make room. */
  retirePlays: 8,
  /** At most this many new arms per cycle. */
  maxNew: 2,
});

/** Gate stub of a live-only arm: makes it live-eligible (isEligible needs gate.matches > 0). */
export function liveOnlyGate(): ArmGate {
  return { lineups: ['live-only'], matches: 1, meanRankDelta: 0, ciLo: 0, ciHi: 0, lobbySimsWin: 0 };
}

// ------------------------------------------------------------------------------ rate limit

export interface LiveMarker {
  /** Highest recorded matchId when the last live cycle ran. */
  lastMatchId: number;
  at?: string;
}

export const markerPath = (statePath: string) => `${statePath}.live-cycle.json`;

export function readMarker(path: string): LiveMarker | undefined {
  try {
    const m = JSON.parse(readFileSync(path, 'utf8')) as LiveMarker;
    return Number.isFinite(m.lastMatchId) ? m : undefined;
  } catch {
    return undefined;
  }
}

export function writeMarker(path: string, m: LiveMarker): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(m) + '\n');
  renameSync(tmp, path);
}

/** Finished matches recorded after the marker (no marker: all of them). */
export function newMatchesSince(s: LearnState, marker: LiveMarker | undefined): number {
  const last = marker?.lastMatchId ?? -Infinity;
  return s.matches.filter((m) => m.matchId > last).length;
}

export function rateLimitOk(s: LearnState, marker: LiveMarker | undefined, min: number = LIVE.minNewMatches): boolean {
  if (!marker) return s.matches.length > 0;
  return newMatchesSince(s, marker) >= min;
}

// ------------------------------------------------------------------------------ pool rules

const active = (s: LearnState) => s.arms.filter((a) => !a.retired && isEligible(a));

/** Active non-default arms that still need plays. */
export function untestedArms(s: LearnState): Arm[] {
  return active(s).filter((a) => a.id !== DEFAULT_ARM_ID && a.plays < LIVE.testedPlays);
}

/** Retire candidate: lowest posterior mean among active non-default arms with plays >= retirePlays. */
export function retireVictim(s: LearnState, exclude: ReadonlySet<string> = new Set()): Arm | undefined {
  const pool = active(s).filter((a) => a.id !== DEFAULT_ARM_ID && a.plays >= LIVE.retirePlays && !exclude.has(a.id));
  if (pool.length === 0) return undefined;
  return pool.reduce((w, a) => (posteriorMean(a) < posteriorMean(w) || (posteriorMean(a) === posteriorMean(w) && a.plays < w.plays) ? a : w));
}

/** Learnable params equal within tol (missing key = different). */
export function paramsEqual(a: Record<string, unknown>, b: Record<string, unknown>, tol = 1e-9): boolean {
  const x = clampParams(a) as Record<string, number>;
  const y = clampParams(b) as Record<string, number>;
  const kx = Object.keys(x);
  if (kx.length !== Object.keys(y).length) return false;
  return kx.every((k) => k in y && Math.abs(x[k]! - y[k]!) <= tol);
}

export interface LivePoolChange {
  added: string[];
  retired: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Add up to LIVE.maxNew candidate arms under the untested cap and pool cap (mutates s). Duplicates
 * of any existing arm (retired included) or of each other are skipped.
 */
export function addLiveArms(s: LearnState, arms: readonly Arm[], maxActive = MAX_ACTIVE_ARMS): LivePoolChange {
  const out: LivePoolChange = { added: [], retired: [], skipped: [] };
  for (const a of arms) {
    if (a.id === DEFAULT_ARM_ID) {
      out.skipped.push({ id: a.id, reason: 'reserved id' });
      continue;
    }
    const dup = s.arms.find((x) => x.id === a.id || paramsEqual(x.params, a.params));
    if (dup) {
      out.skipped.push({ id: a.id, reason: `duplicate of ${dup.id}${dup.retired ? ' (retired)' : ''}` });
      continue;
    }
    if (out.added.length >= LIVE.maxNew) {
      out.skipped.push({ id: a.id, reason: `max ${LIVE.maxNew} new per cycle` });
      continue;
    }
    if (untestedArms(s).length >= LIVE.maxUntested) {
      out.skipped.push({ id: a.id, reason: `${LIVE.maxUntested} untested arms already` });
      continue;
    }
    if (active(s).length >= maxActive) {
      const victim = retireVictim(s);
      if (!victim) {
        out.skipped.push({ id: a.id, reason: `pool full, no arm with >= ${LIVE.retirePlays} plays to retire` });
        continue;
      }
      victim.retired = true;
      out.retired.push(victim.id);
    }
    s.arms.push(a);
    out.added.push(a.id);
  }
  return out;
}

/** How many arms a cycle could add right now (0 = skip). */
export function liveCapacity(s: LearnState, maxActive = MAX_ACTIVE_ARMS): number {
  const byUntested = Math.max(0, LIVE.maxUntested - untestedArms(s).length);
  const free = Math.max(0, maxActive - active(s).length);
  const retirable = active(s).filter((a) => a.id !== DEFAULT_ARM_ID && a.plays >= LIVE.retirePlays).length;
  return Math.min(LIVE.maxNew, byUntested, free + retirable);
}

/** Parent: best posterior mean among tested eligible arms (plays >= testedPlays), else the incumbent. */
export function parentArm(s: LearnState): Arm {
  const tested = active(s).filter((a) => a.id === DEFAULT_ARM_ID || a.plays >= LIVE.testedPlays);
  if (tested.length === 0) return incumbentArm(s);
  return tested.reduce((b, a) => (posteriorMean(a) > posteriorMean(b) + 1e-12 || (Math.abs(posteriorMean(a) - posteriorMean(b)) <= 1e-12 && a.plays > b.plays) ? a : b));
}

// ------------------------------------------------------------------------------ candidates

/** "Push early, harvest late": less κ early, longer and stronger spend-down at the end. */
export const PHASE_DIR: KnobValues = { earlyScale: -1, endWindow: 1, endKappaLo: 1 };
/** Key-letter edge step (coins) when the diagnosis is lost-key-letters. */
export const KEY_EDGE_STEP = 1;

function stepped(base: Record<KnobName, number>, dir: KnobValues, scale: number): KnobValues {
  const out: KnobValues = {};
  for (const [k, d] of Object.entries(dir) as Array<[KnobName, number]>) {
    const spec = knobSpec(k);
    out[k] = base[k] + d * scale * STEP * (spec.hi - spec.lo);
  }
  return out;
}

function delta(base: Record<KnobName, number>, params: Record<string, unknown>, keys: readonly KnobName[]): KnobValues {
  const after = knobValues(params);
  const d: KnobValues = {};
  for (const k of keys) {
    const v = (after[k] ?? 0) - base[k];
    if (Math.abs(v) > 1e-9) d[k] = Math.round(v * 1000) / 1000;
  }
  return d;
}

/**
 * Ordered live candidates from the parent: keyEdge (when lost-key-letters fired), phase, then the
 * standard diagnosed/primary/x2/random steps. No-ops (equal to the parent) are dropped.
 */
export function liveCandidates(parentParams: Record<string, unknown>, diags: Parameters<typeof generateCandidates>[1], opts: { config?: MatchConfig; seed?: number } = {}): Candidate[] {
  const base = knobValues(parentParams, opts.config);
  const weights = categoryWeights(diags);
  const out: Candidate[] = [];
  const mk = (label: string, hypothesis: string, values: KnobValues) => {
    const params = withKnobs(parentParams, values);
    out.push({ label, hypothesis, params, delta: delta(base, params, Object.keys(values) as KnobName[]) });
  };
  const key = weights.get('lost-key-letters-to-X') ?? 0;
  if (key > 0) mk('keyEdge', `lost-key-letters-to-X ${key.toFixed(2)}: bid +${KEY_EDGE_STEP} on key letters (ties / <=2-coin losses)`, { keyEdge: base.keyEdge + KEY_EDGE_STEP });
  mk('phase', 'live field pushes early, harvests late: earlyScale down, endWindow/endKappaLo up', stepped(base, PHASE_DIR, 1));
  out.push(...generateCandidates(parentParams, diags, opts));
  return out.filter((c) => !paramsEqual(c.params, withKnobs(parentParams, {})));
}

// ------------------------------------------------------------------------------ cycle

const fmt = (v: unknown) => '`' + JSON.stringify(v) + '`';

export async function runLiveCycle(o: CycleOptions): Promise<CycleReport> {
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

  // 2. rate limit
  const mPath = markerPath(o.statePath);
  const marker = readMarker(mPath);
  if (!rateLimitOk(state, marker)) return done();
  const pending = state.matches.filter((m) => isLoss(m) && !m.analyzed).sort((a, b) => a.matchId - b.matchId);
  if (pending.length === 0) return done();
  const lastMatchId = Math.max(...state.matches.map((m) => m.matchId));

  const maxLosses = o.maxLosses ?? DEFAULTS.maxLosses;
  const focus = pending.slice(-maxLosses);
  const backlog = pending.slice(0, Math.max(0, pending.length - maxLosses)).map((m) => m.matchId);

  // 3. diagnose (journal)
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
  if (report.diagnoses.length) appendJournal(o.journalPath, [`### Losses diagnosed ${stamp} (live-only)`, '', ...report.diagnoses.map(renderDiagnosis)].join('\n'));

  // 4. candidates from the best tested arm (only when there is room)
  const parent = parentArm(state);
  report.incumbent = parent.id;
  let candidates: Candidate[] = [];
  const cap = liveCapacity(state);
  if (report.diagnoses.length && cap > 0) {
    const latestCfg = byId.get(report.diagnoses[report.diagnoses.length - 1]!.matchId)?.config;
    const seed = hashSeed('learn-live', ...report.diagnoses.map((d) => d.matchId));
    candidates = liveCandidates(parent.params, report.diagnoses, { ...(latestCfg ? { config: latestCfg } : {}), seed });
  }
  const created = new Date(now()).toISOString();
  const newArms: Arm[] = candidates.map((c) => ({
    id: armIdFor(c.params),
    params: c.params,
    origin: 'cycle' as const,
    createdAt: created,
    parent: parent.id,
    alpha: 1,
    beta: 1,
    plays: 0,
    gate: liveOnlyGate(),
  }));

  // 5. pool update under the state lock (fresh state; the live client may have written meanwhile)
  const analyzed = new Set(report.analyzed);
  let pool: LivePoolChange = { added: [], retired: [], skipped: [] };
  updateState(o.statePath, (s) => {
    for (const m of s.matches) if (analyzed.has(m.matchId)) m.analyzed = true;
    pool = addLiveArms(s, newArms);
  });
  report.pool = pool;
  writeMarker(mPath, { lastMatchId, at: created });

  // 6. journal
  const byArm = new Map(newArms.map((a, i) => [a.id, candidates[i]!]));
  const lines: string[] = [
    `### Live cycle ${stamp}: parent \`${parent.id}\` (posterior ${posteriorMean(parent).toFixed(3)}, ${parent.plays} plays)`,
    '',
    `- losses analysed: ${focus.map((m) => m.matchId).join(', ')}${backlog.length ? ` (+${backlog.length} older backlog marked)` : ''}${noLog.length ? `; no log: ${noLog.join(', ')}` : ''}`,
    `- mode: live-only (no sim gate); capacity ${cap} (untested cap ${LIVE.maxUntested}, pool cap ${MAX_ACTIVE_ARMS}, retire at >= ${LIVE.retirePlays} plays)`,
  ];
  if (cap === 0) lines.push('- no room for new arms: skipped adding');
  for (const id of pool.added) {
    const c = byArm.get(id)!;
    lines.push(`- added \`${id}\` (${c.label}): ${c.hypothesis}; params ${fmt(c.params)}; delta ${fmt(c.delta)}`);
  }
  if (pool.retired.length) lines.push(`- retired ${fmt(pool.retired)}`);
  const skipped = pool.skipped.filter((x) => !/max \d+ new/.test(x.reason));
  if (skipped.length) lines.push(`- skipped ${fmt(skipped)}`);
  lines.push(`- cycle ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  appendJournal(o.journalPath, lines.join('\n'));
  report.status = 'done';
  log(`live cycle: diagnosed ${report.diagnoses.length}, added ${pool.added.join(', ') || '-'}, retired ${pool.retired.join(', ') || '-'}${cap === 0 ? ' (no room)' : ''}`);
  return done();
}

/** True when the marker file exists (for logs/tests). */
export const hasMarker = (statePath: string) => existsSync(markerPath(statePath));
