// Persistent learning state (.cache/learn/state.json, override with LEARN_STATE).
//
// Shared contract with the offline improvement cycle (src/learn/cycle/*): one JSON file holding
// the arms (parameter variants with Beta posteriors), the per-match records and the opponent book.
// Writes are atomic (tmp file + rename). A missing file yields a fresh default state; a corrupt
// file is moved aside to <path>.bak and replaced by a fresh default state on the next save.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LEARN_VERSION = 1 as const;
export const DEFAULT_ARM_ID = 'default';
/** Match records kept in the state file (oldest dropped first). */
export const MAX_MATCH_RECORDS = 20_000;

export type ArmOrigin = 'default' | 'cycle' | 'manual';

export interface ArmGate {
  lineups: string[];
  matches: number;
  meanRankDelta: number;
  ciLo: number;
  ciHi: number;
  lobbySimsWin: number;
}

export interface Arm {
  id: string;
  params: Record<string, unknown>;
  origin: ArmOrigin;
  createdAt: string;
  parent?: string;
  alpha: number;
  beta: number;
  plays: number;
  retired?: boolean;
  gate?: ArmGate;
}

export interface MatchRecord {
  matchId: number;
  armId: string;
  endedAt: string;
  players: number;
  realPlayers: number;
  rank: number;
  score: number;
  bestOtherScore: number;
  won: boolean;
  reward: number;
  opponents: string[];
  analyzed?: boolean;
}

/**
 * Learned calibration of a rival (additive, optional extension of the contract's book entry):
 * running mean of the field model's posterior log-scale at match end, over n matches, relative to
 * the prior kind it was measured against ('profiled' = data/profiles.json curves, 'market').
 */
export interface BookScale {
  n: number;
  meanLog: number;
  kind: 'profiled' | 'market';
}

export interface BookEntry {
  matches: number;
  wins: number;
  avgScore: number;
  avgPricePaid: number;
  lettersWon: number;
  pricesByLetter: Record<string, { n: number; mean: number }>;
  updatedAt: string;
  scale?: BookScale;
}

export interface LearnState {
  version: 1;
  arms: Arm[];
  matches: MatchRecord[];
  book: Record<string, BookEntry>;
}

export function defaultArm(now: Date = new Date()): Arm {
  return { id: DEFAULT_ARM_ID, params: {}, origin: 'default', createdAt: now.toISOString(), alpha: 1, beta: 1, plays: 0 };
}

export function emptyState(now: Date = new Date()): LearnState {
  return { version: LEARN_VERSION, arms: [defaultArm(now)], matches: [], book: {} };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** State file path: LEARN_STATE (absolute, or relative to the repo root) or .cache/learn/state.json. */
export function defaultStatePath(env: Record<string, string | undefined> = process.env): string {
  const p = env.LEARN_STATE?.trim();
  if (p) return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
  return resolve(REPO_ROOT, '.cache/learn/state.json');
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function normalizeArm(x: unknown): Arm | undefined {
  if (!isObj(x) || typeof x.id !== 'string' || x.id.length === 0) return undefined;
  const alpha = fin(x.alpha) && x.alpha > 0 ? x.alpha : 1;
  const beta = fin(x.beta) && x.beta > 0 ? x.beta : 1;
  const origin: ArmOrigin = x.origin === 'cycle' || x.origin === 'manual' || x.origin === 'default' ? x.origin : 'manual';
  const arm: Arm = {
    ...(x as unknown as Arm),
    params: isObj(x.params) ? x.params : {},
    origin,
    createdAt: typeof x.createdAt === 'string' ? x.createdAt : new Date(0).toISOString(),
    alpha,
    beta,
    plays: fin(x.plays) && x.plays >= 0 ? x.plays : 0,
  };
  if (x.gate !== undefined && !isObj(x.gate)) delete arm.gate;
  return arm;
}

/**
 * Validate a parsed state file. Returns undefined when the top-level shape is wrong; otherwise
 * drops malformed arms / match records / book entries and guarantees a non-retired 'default' arm.
 */
export function normalizeState(raw: unknown): LearnState | undefined {
  if (!isObj(raw) || raw.version !== LEARN_VERSION || !Array.isArray(raw.arms)) return undefined;
  if (raw.matches !== undefined && !Array.isArray(raw.matches)) return undefined;
  if (raw.book !== undefined && !isObj(raw.book)) return undefined;
  const arms: Arm[] = [];
  const seen = new Set<string>();
  for (const a of raw.arms) {
    const arm = normalizeArm(a);
    if (!arm || seen.has(arm.id)) continue;
    seen.add(arm.id);
    arms.push(arm);
  }
  const def = arms.find((a) => a.id === DEFAULT_ARM_ID);
  if (!def) arms.unshift(defaultArm());
  else {
    def.params = {};
    def.origin = 'default';
    delete def.retired;
  }
  const matches: MatchRecord[] = [];
  for (const m of (raw.matches as unknown[] | undefined) ?? []) {
    if (isObj(m) && fin(m.matchId) && typeof m.armId === 'string' && fin(m.reward)) matches.push(m as unknown as MatchRecord);
  }
  const book: Record<string, BookEntry> = {};
  for (const [name, e] of Object.entries((raw.book as Record<string, unknown> | undefined) ?? {})) {
    if (!isObj(e) || !fin(e.matches)) continue;
    book[name] = {
      ...(e as unknown as BookEntry),
      wins: fin(e.wins) ? e.wins : 0,
      avgScore: fin(e.avgScore) ? e.avgScore : 0,
      avgPricePaid: fin(e.avgPricePaid) ? e.avgPricePaid : 0,
      lettersWon: fin(e.lettersWon) ? e.lettersWon : 0,
      pricesByLetter: isObj(e.pricesByLetter) ? (e.pricesByLetter as BookEntry['pricesByLetter']) : {},
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : new Date(0).toISOString(),
    };
  }
  return { version: LEARN_VERSION, arms, matches, book };
}

export interface LoadResult {
  state: LearnState;
  status: 'ok' | 'missing' | 'corrupt';
  /** Where a corrupt file was moved to. */
  backup?: string;
}

/** Load the state; never throws on a missing or corrupt file (I/O errors other than ENOENT do). */
export function loadState(path: string = defaultStatePath()): LoadResult {
  if (!existsSync(path)) return { state: emptyState(), status: 'missing' };
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const state = normalizeState(parsed);
  if (state) return { state, status: 'ok' };
  const backup = `${path}.bak`;
  try {
    renameSync(path, backup);
  } catch {
    return { state: emptyState(), status: 'corrupt' };
  }
  return { state: emptyState(), status: 'corrupt', backup };
}

/** Atomic save: write <path>.tmp-<pid> then rename over the target. Throws on I/O errors. */
export function saveState(state: LearnState, path: string = defaultStatePath()): void {
  if (state.matches.length > MAX_MATCH_RECORDS) state.matches.splice(0, state.matches.length - MAX_MATCH_RECORDS);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(tmp, path);
}
