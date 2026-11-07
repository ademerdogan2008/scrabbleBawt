// Minimal LearnState reader/writer for the offline loss-learning cycle (builder B).
//
// Implements the shared contract (.cache/learn/state.json, see .planning/LEARNING.md):
//   - atomic writes (tmp file + rename), env LEARN_STATE overrides the path;
//   - arm 'default' (params {}) always exists and is never retired;
//   - discounted Beta-Bernoulli bandit (gamma = 0.97) over non-retired arms, Thompson selection;
//   - at most MAX_ACTIVE active arms; only arms with a passing gate (or 'default') are eligible.
// The merge step replaces this module with builder A's store (src/learn/*); keep the exports small.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hashSeed } from '../../core/rng.js';

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

export interface MatchRec {
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

export interface BookEntry {
  matches: number;
  wins: number;
  avgScore: number;
  avgPricePaid: number;
  lettersWon: number;
  pricesByLetter: Record<string, { n: number; mean: number }>;
  updatedAt: string;
}

export interface LearnState {
  version: 1;
  arms: Arm[];
  matches: MatchRec[];
  book: Record<string, BookEntry>;
}

export const DEFAULT_ARM_ID = 'default';
export const MAX_ACTIVE = 6;
export const GAMMA = 0.97;
/** An arm's recorded gate is eligible for live play when it meets both thresholds. */
export const ELIGIBLE_MAX_CI_HI = 0.05;
export const ELIGIBLE_MIN_LOBBY_SIMS_WIN = 0.98;

export function defaultStatePath(env: Record<string, string | undefined> = process.env): string {
  const p = env.LEARN_STATE?.trim();
  return resolve(p && p.length > 0 ? p : '.cache/learn/state.json');
}

export function defaultArm(now: string): Arm {
  return { id: DEFAULT_ARM_ID, params: {}, origin: 'default', createdAt: now, alpha: 1, beta: 1, plays: 0 };
}

export function emptyState(now = new Date().toISOString()): LearnState {
  return { version: 1, arms: [defaultArm(now)], matches: [], book: {} };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Loose validation: drops malformed rows, ensures the default arm, keeps unknown extra fields. */
export function normalizeState(raw: unknown, now = new Date().toISOString()): LearnState {
  if (!isObj(raw)) throw new Error('learn state: not an object');
  const arms: Arm[] = [];
  const seen = new Set<string>();
  for (const a of Array.isArray(raw.arms) ? raw.arms : []) {
    if (!isObj(a) || typeof a.id !== 'string' || seen.has(a.id)) continue;
    seen.add(a.id);
    arms.push({
      ...(a as unknown as Arm),
      params: isObj(a.params) ? a.params : {},
      alpha: Math.max(1e-6, num(a.alpha, 1)),
      beta: Math.max(1e-6, num(a.beta, 1)),
      plays: num(a.plays, 0),
    });
  }
  const def = arms.find((a) => a.id === DEFAULT_ARM_ID);
  if (!def) arms.unshift(defaultArm(now));
  else {
    def.retired = false;
    def.params = {};
  }
  const matches: MatchRec[] = [];
  for (const m of Array.isArray(raw.matches) ? raw.matches : []) {
    if (isObj(m) && typeof m.matchId === 'number' && typeof m.armId === 'string') matches.push(m as unknown as MatchRec);
  }
  const book = isObj(raw.book) ? (raw.book as Record<string, BookEntry>) : {};
  return { version: 1, arms, matches, book };
}

/** Read the state; a missing file yields a fresh state. Throws on unreadable / corrupt JSON. */
export function loadState(path: string): LearnState {
  if (!existsSync(path)) return emptyState();
  const text = readFileSync(path, 'utf8');
  if (text.trim().length === 0) return emptyState();
  return normalizeState(JSON.parse(text));
}

/** Atomic write: tmp file in the same directory, then rename over the target. */
export function saveState(path: string, state: LearnState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1) + '\n');
  renameSync(tmp, path);
}

/**
 * Read-modify-write without awaiting in between (keeps the window against the live client's own
 * writes as small as possible). `fn` mutates the freshly loaded state.
 */
export function updateState(path: string, fn: (s: LearnState) => void): LearnState {
  const s = loadState(path);
  fn(s);
  saveState(path, s);
  return s;
}

// ----------------------------------------------------------------------------------- bandit

export function posteriorMean(a: Pick<Arm, 'alpha' | 'beta'>): number {
  return a.alpha / (a.alpha + a.beta);
}

export function activeArms(s: LearnState): Arm[] {
  return s.arms.filter((a) => !a.retired);
}

export function gatePasses(g: ArmGate | undefined): boolean {
  return !!g && g.ciHi <= ELIGIBLE_MAX_CI_HI && g.lobbySimsWin >= ELIGIBLE_MIN_LOBBY_SIMS_WIN;
}

export function isEligible(a: Arm): boolean {
  return !a.retired && (a.id === DEFAULT_ARM_ID || gatePasses(a.gate));
}

/** Highest posterior mean eligible arm (ties: more plays, then 'default', then id order). */
export function incumbentArm(s: LearnState): Arm {
  let best: Arm | undefined;
  for (const a of s.arms) {
    if (!isEligible(a)) continue;
    if (!best) {
      best = a;
      continue;
    }
    const d = posteriorMean(a) - posteriorMean(best);
    if (d > 1e-12 || (Math.abs(d) <= 1e-12 && (a.plays > best.plays || (a.plays === best.plays && a.id === DEFAULT_ARM_ID)))) best = a;
  }
  return best ?? s.arms.find((a) => a.id === DEFAULT_ARM_ID)!;
}

/** Reward in [0,1] from an (average, ties-shared) rank: (players - rank) / (players - 1). */
export function rewardOf(players: number, rank: number): number {
  if (players <= 1) return 1;
  return Math.min(1, Math.max(0, (players - rank) / (players - 1)));
}

/**
 * Discounted update: every non-retired arm decays toward the Beta(1,1) prior by gamma, then the
 * played arm gets r / 1 - r. Returns false (no change) for an unknown or retired arm.
 */
export function banditUpdate(s: LearnState, armId: string, reward: number, gamma = GAMMA): boolean {
  const arm = s.arms.find((a) => a.id === armId && !a.retired);
  if (!arm) return false;
  const r = Math.min(1, Math.max(0, reward));
  for (const a of s.arms) {
    if (a.retired) continue;
    a.alpha = 1 + gamma * (a.alpha - 1);
    a.beta = 1 + gamma * (a.beta - 1);
  }
  arm.alpha += r;
  arm.beta += 1 - r;
  arm.plays += 1;
  return true;
}

// ------------------------------------------------------------------------------------- pool

/** Key-sorted JSON (stable identity of a params object). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function armIdFor(params: Record<string, unknown>): string {
  return `cyc-${hashSeed('arm', canonicalJson(params)).toString(16).padStart(8, '0')}`;
}

export function findArmByParams(s: LearnState, params: Record<string, unknown>): Arm | undefined {
  const key = canonicalJson(params);
  return s.arms.find((a) => canonicalJson(a.params) === key);
}

export interface PoolChange {
  added: string[];
  retired: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Add new arms (skipping params that already exist, active or retired), then retire while more than
 * maxActive arms are active: the lowest posterior mean among old non-default arms goes first; if
 * only 'default' and this round's arms remain, the newcomer with the worst gate goes.
 */
export function addArms(s: LearnState, arms: readonly Arm[], maxActive = MAX_ACTIVE): PoolChange {
  const out: PoolChange = { added: [], retired: [], skipped: [] };
  const fresh = new Set<string>();
  for (const a of arms) {
    if (a.id === DEFAULT_ARM_ID) {
      out.skipped.push({ id: a.id, reason: 'reserved id' });
      continue;
    }
    const dup = s.arms.find((x) => x.id === a.id) ?? findArmByParams(s, a.params);
    if (dup) {
      out.skipped.push({ id: a.id, reason: `duplicate of ${dup.id}${dup.retired ? ' (retired)' : ''}` });
      continue;
    }
    s.arms.push(a);
    fresh.add(a.id);
    out.added.push(a.id);
  }
  while (activeArms(s).length > maxActive) {
    const old = activeArms(s).filter((a) => a.id !== DEFAULT_ARM_ID && !fresh.has(a.id));
    let victim: Arm | undefined;
    if (old.length > 0) {
      victim = old.reduce((w, a) => (posteriorMean(a) < posteriorMean(w) || (posteriorMean(a) === posteriorMean(w) && a.plays < w.plays) ? a : w));
    } else {
      const news = activeArms(s).filter((a) => fresh.has(a.id));
      if (news.length === 0) break;
      victim = news.reduce((w, a) => ((a.gate?.meanRankDelta ?? 0) > (w.gate?.meanRankDelta ?? 0) ? a : w));
    }
    victim.retired = true;
    out.retired.push(victim.id);
    if (fresh.has(victim.id)) {
      out.added = out.added.filter((x) => x !== victim!.id);
      out.skipped.push({ id: victim.id, reason: 'pool full (worst newcomer)' });
    }
  }
  return out;
}
