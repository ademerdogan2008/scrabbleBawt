// Candidate generation: from the incumbent arm, step along the knob directions implied by the
// diagnosed loss categories (plus one small seeded random perturbation), clamped to KNOBS ranges.
import { hashSeed, Rng } from '../../core/rng.js';
import type { MatchConfig } from '../../core/types.js';
import type { Category, Diagnosis } from './diagnose.js';
import { KNOBS, knobSpec, knobValues, PINNED_KNOBS, withKnobs, type KnobName, type KnobValues } from './knobs.js';
import { canonicalJson } from './pool.js';

/**
 * Unit direction per category (sign = which way the knob moves; magnitude = relative weight).
 * Semantics (src/bots/bawt): higher tableScale / floorA / floorB / kappaHi / kappaLo / incomeShare
 * / maxWinShare => bid more; higher reserve / lambdaScale => bid less; denyScale => denial weight.
 */
export const DIRECTIONS: Readonly<Record<Category, KnobValues>> = Object.freeze({
  'overspent-early': { kappaHi: -1, kappaLo: -0.5, reserve: 1, incomeShare: -1, floorB: -0.5 },
  'underspent-hoarded-cash': { kappaHi: 1, kappaLo: 0.5, reserve: -1, incomeShare: 1, tableScale: 0.5 },
  'lost-key-letters-to-X': { tableScale: 1, floorA: 0.5, floorB: 0.5, lambdaScale: -0.5, maxWinShare: 0.5 },
  'words-not-cashed': { tableScale: -0.5, maxWinShare: -1, floorA: -0.5 },
  'denial-missing': { denyScale: 1 },
  'opponent-mispriced': { lambdaScale: 1, tableScale: -0.5, kappaLo: -0.5 },
});

/** One step = this fraction of the knob's range width per unit of direction. */
export const STEP = 0.15;
/** Random perturbation: up to this fraction of the width on PERTURB_KNOBS random knobs. */
export const PERTURB = 0.08;
export const PERTURB_KNOBS = 3;
export const MAX_CANDIDATES = 4;
/** Drop candidates whose largest knob move is below this fraction of its range (near no-ops). */
export const MIN_CHANGE = 0.03;

export interface Candidate {
  label: string;
  /** Hypothesis behind the step (categories with weights, or 'random'). */
  hypothesis: string;
  params: Record<string, unknown>;
  /** Knob deltas actually applied (after clamping), for the iteration log. */
  delta: KnobValues;
}

/** Aggregate category weights over diagnoses (sum of finding strengths). */
export function categoryWeights(diags: readonly Diagnosis[]): Map<Category, number> {
  const w = new Map<Category, number>();
  for (const d of diags) for (const f of d.findings) w.set(f.category, (w.get(f.category) ?? 0) + f.strength);
  return w;
}

/** Relative stand-ins for profile-pinned knobs: [knob, factor] (see PINNED_KNOBS). */
export const REDIRECT: Readonly<Partial<Record<KnobName, readonly [KnobName, number]>>> = Object.freeze({
  kappaHi: ['lambdaScale', -1] as const, // lambdaScale divides κ in every profile
  reserve: ['incomeShare', -1] as const, // both set the spendable budget
  floorA: ['tableScale', 0.5] as const,
  floorB: ['tableScale', 0.5] as const,
});

/** Knobs the cycle may move from `incumbent`: unpinned ones, plus pinned ones it already sets. */
export function steppable(incumbent: Record<string, unknown>): Set<KnobName> {
  return new Set(KNOBS.map((k) => k.name).filter((n) => !PINNED_KNOBS.has(n) || n in incumbent));
}

function combine(weights: ReadonlyMap<Category, number>, allowed: ReadonlySet<KnobName>): KnobValues {
  const out: KnobValues = {};
  for (const [cat, wt] of weights) {
    for (const [k0, v0] of Object.entries(DIRECTIONS[cat]) as Array<[KnobName, number]>) {
      let k = k0;
      let v = v0;
      if (!allowed.has(k)) {
        const r = REDIRECT[k];
        if (!r || !allowed.has(r[0])) continue;
        k = r[0];
        v = v0 * r[1];
      }
      out[k] = (out[k] ?? 0) + wt * v;
    }
  }
  // normalize so the largest component is 1 (direction only; step size set by the caller)
  const m = Math.max(0, ...Object.values(out).map((v) => Math.abs(v ?? 0)));
  if (m > 0) for (const k of Object.keys(out) as KnobName[]) out[k] = out[k]! / m;
  return out;
}

function step(base: Record<KnobName, number>, dir: KnobValues, scale: number): KnobValues {
  const out: KnobValues = {};
  for (const [k, d] of Object.entries(dir) as Array<[KnobName, number]>) {
    if (!d) continue;
    const spec = knobSpec(k);
    out[k] = base[k] + d * scale * STEP * (spec.hi - spec.lo);
  }
  return out;
}

function make(label: string, hypothesis: string, parent: Record<string, unknown>, base: Record<KnobName, number>, values: KnobValues): Candidate {
  const params = withKnobs(parent, values);
  const after = knobValues(params);
  const delta: KnobValues = {};
  for (const k of Object.keys(values) as KnobName[]) {
    const d = (after[k] ?? 0) - base[k];
    if (Math.abs(d) > 1e-9) delta[k] = Math.round(d * 1000) / 1000;
  }
  return { label, hypothesis, params, delta };
}

export interface GenerateOptions {
  /** Config of the most recent analysed loss: knob bases are the values the arm played there. */
  config?: MatchConfig;
  /** Seed for the random perturbation (default: hash of the diagnosed match ids). */
  seed?: number;
  max?: number;
}

/**
 * 2-4 candidates: combined diagnosed direction (1 step), the primary category alone (1 step), the
 * combined direction at 2 steps (when any category fired), and one random perturbation. Candidates
 * that equal the incumbent or each other (after clamping) are dropped.
 */
export function generateCandidates(incumbentParams: Record<string, unknown>, diags: readonly Diagnosis[], opts: GenerateOptions = {}): Candidate[] {
  const base = knobValues(incumbentParams, opts.config);
  const weights = categoryWeights(diags);
  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  const hyp = ranked.map(([c, w]) => `${c} ${w.toFixed(2)}`).join(' + ');
  const allowed = steppable(incumbentParams);
  const out: Candidate[] = [];
  if (ranked.length > 0) {
    const dir = combine(weights, allowed);
    out.push(make('diagnosed', hyp, incumbentParams, base, step(base, dir, 1)));
    const [primary] = ranked[0]!;
    out.push(make(`primary:${primary}`, primary, incumbentParams, base, step(base, combine(new Map([[primary, 1]]), allowed), 1)));
    out.push(make('diagnosed-x2', hyp, incumbentParams, base, step(base, dir, 2)));
  }
  const seed = opts.seed ?? hashSeed('learn-cycle', ...diags.map((d) => d.matchId).sort((a, b) => a - b));
  const rng = new Rng(seed);
  const knobs = rng.shuffle(KNOBS.map((k) => k.name).filter((k) => allowed.has(k))).slice(0, PERTURB_KNOBS);
  const pert: KnobValues = {};
  for (const k of knobs) {
    const spec = knobSpec(k);
    pert[k] = base[k] + (2 * rng.float() - 1) * PERTURB * (spec.hi - spec.lo);
  }
  out.push(make('random', `random perturbation (seed ${seed})`, incumbentParams, base, pert));

  const seen = new Set<string>([canonicalJson(withKnobs(incumbentParams, {}))]);
  const unique: Candidate[] = [];
  for (const c of out) {
    const key = canonicalJson(c.params);
    const size = Math.max(0, ...(Object.entries(c.delta) as Array<[KnobName, number]>).map(([k, d]) => Math.abs(d) / (knobSpec(k).hi - knobSpec(k).lo)));
    if (seen.has(key) || size < MIN_CHANGE) continue;
    seen.add(key);
    unique.push(c);
  }
  return unique.slice(0, opts.max ?? MAX_CANDIDATES);
}
