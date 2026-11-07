// Discounted Thompson-sampling bandit over the arms of the learning state.
//
// Each arm carries a Beta(alpha, beta) posterior on its expected reward (reward in [0, 1], see
// reward.ts; priors alpha = beta = 1). Non-stationarity (rivals change versions, the lobby
// changes) is handled by discounting: before each update every non-retired arm's evidence
// (alpha - 1, beta - 1) is multiplied by gamma, so old matches fade with half-life
// ln 2 / -ln gamma ≈ 23 matches at gamma = 0.97.
// Selection draws one sample per active arm from its Beta posterior on a seeded Rng (seeded from
// the match id by the caller) and plays the argmax, so every choice is reproducible from logs.
import { hashSeed, type Rng } from '../core/rng.js';
import { DEFAULT_ARM_ID, type Arm, type LearnState } from './store.js';

export const GAMMA = 0.97;
export const MAX_ACTIVE_ARMS = 6;

/** Standard normal via Box-Muller (u in (0, 1]). */
export function normalSample(rng: Rng): number {
  const u1 = 1 - rng.float();
  const u2 = rng.float();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Gamma(shape, 1) by Marsaglia-Tsang (shape < 1 via the U^(1/shape) boost). */
export function gammaSample(rng: Rng, shape: number): number {
  if (!(shape > 0)) throw new Error(`gammaSample: shape must be > 0, got ${shape}`);
  if (shape < 1) {
    const u = 1 - rng.float();
    return gammaSample(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normalSample(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = 1 - rng.float();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(a, b) = X / (X + Y), X ~ Gamma(a), Y ~ Gamma(b). */
export function betaSample(rng: Rng, a: number, b: number): number {
  const x = gammaSample(rng, a);
  const y = gammaSample(rng, b);
  const s = x + y;
  return s > 0 ? x / s : 0.5;
}

export function posteriorMean(arm: Pick<Arm, 'alpha' | 'beta'>): number {
  return arm.alpha / (arm.alpha + arm.beta);
}

/**
 * Live-eligible: 'default' always; any other arm only while not retired and carrying a gate (the
 * offline cycle attaches a gate only after the arm passed its paired-seed simulator gate).
 */
export function isEligible(arm: Arm): boolean {
  if (arm.id === DEFAULT_ARM_ID) return true;
  if (arm.retired) return false;
  const g = arm.gate;
  return !!g && typeof g === 'object' && Number(g.matches) > 0;
}

/**
 * Arms that may be played: eligible arms, at most MAX_ACTIVE_ARMS, 'default' always included,
 * the rest by posterior mean (ties: older first, then id).
 */
export function activeArms(state: LearnState): Arm[] {
  const def = state.arms.find((a) => a.id === DEFAULT_ARM_ID);
  const others = state.arms
    .filter((a) => a.id !== DEFAULT_ARM_ID && isEligible(a))
    .sort((a, b) => posteriorMean(b) - posteriorMean(a) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const out = def ? [def] : [];
  for (const a of others) {
    if (out.length >= MAX_ACTIVE_ARMS) break;
    out.push(a);
  }
  return out;
}

export interface Selection {
  arm: Arm;
  /** Thompson draw per active arm id. */
  draws: Record<string, number>;
}

/** Thompson sampling over the active arms. Falls back to 'default' when nothing is active. */
export function selectArm(state: LearnState, rng: Rng): Selection {
  const arms = activeArms(state);
  const draws: Record<string, number> = {};
  let best: Arm | undefined;
  let bestDraw = -Infinity;
  for (const a of arms) {
    const d = betaSample(rng, a.alpha, a.beta);
    draws[a.id] = d;
    if (d > bestDraw) {
      bestDraw = d;
      best = a;
    }
  }
  if (!best) {
    best = state.arms.find((a) => a.id === DEFAULT_ARM_ID) ?? state.arms[0]!;
  }
  return { arm: best, draws };
}

/**
 * Discounted update: (alpha-1, beta-1) *= gamma for every non-retired arm, then the played arm
 * gains alpha += r, beta += 1 - r, plays += 1. Returns false (no change) for an unknown arm.
 */
export function updateArm(state: LearnState, armId: string, reward: number, gamma: number = GAMMA): boolean {
  const played = state.arms.find((a) => a.id === armId);
  if (!played) return false;
  const r = Math.max(0, Math.min(1, Number.isFinite(reward) ? reward : 0));
  for (const a of state.arms) {
    if (a.retired) continue;
    a.alpha = 1 + gamma * (a.alpha - 1);
    a.beta = 1 + gamma * (a.beta - 1);
  }
  played.alpha += r;
  played.beta += 1 - r;
  played.plays += 1;
  return true;
}

/** Posterior means of the non-retired arms (rounded for logs). */
export function posteriorMeans(state: LearnState, digits = 4): Record<string, number> {
  const out: Record<string, number> = {};
  const f = 10 ** digits;
  for (const a of state.arms) if (!a.retired) out[a.id] = Math.round(posteriorMean(a) * f) / f;
  return out;
}

// ------------------------------------------------------------------------------------- pool
// Pool management used by the offline cycle (src/learn/cycle): incumbent choice, stable arm ids,
// adding gated arms and retiring the weakest while more than MAX_ACTIVE_ARMS are active.

/** Highest posterior mean eligible arm (ties: more plays, then 'default', then pool order). */
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

const isPlainObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Key-sorted JSON (stable identity of a params object). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (isPlainObj(v)) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Stable id of a cycle-generated arm from its params. */
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

const notRetired = (s: LearnState) => s.arms.filter((a) => !a.retired);

/**
 * Add new arms (skipping params that already exist, active or retired), then retire while more
 * than maxActive arms are not retired: the lowest posterior mean among old non-default arms goes
 * first; if only 'default' and this round's arms remain, the newcomer with the worst gate goes.
 */
export function addArms(s: LearnState, arms: readonly Arm[], maxActive = MAX_ACTIVE_ARMS): PoolChange {
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
  while (notRetired(s).length > maxActive) {
    const old = notRetired(s).filter((a) => a.id !== DEFAULT_ARM_ID && !fresh.has(a.id));
    let victim: Arm | undefined;
    if (old.length > 0) {
      victim = old.reduce((w, a) => (posteriorMean(a) < posteriorMean(w) || (posteriorMean(a) === posteriorMean(w) && a.plays < w.plays) ? a : w));
    } else {
      const news = notRetired(s).filter((a) => fresh.has(a.id));
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
