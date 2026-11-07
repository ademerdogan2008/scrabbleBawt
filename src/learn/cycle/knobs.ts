// Learnable bawt knobs for the offline cycle: whitelist, bounded ranges, read/write against an arm's
// params (BawtParams overrides). Ranges are roughly ±30% around DEFAULT_PARAMS, widened where a
// built-in profile already uses a value outside that band (kappaHi 3 in 'lobby', reserve 10 in
// 'fullTable', floorB 3 in 'fullTable'). The merge step dedupes this list with src/learn/arms.ts.
//
// 'denyScale' is virtual: it scales the default denyWeights map ({'2':1,'3':0.4,'4':0.2}) and is
// written as a concrete `denyWeights` override, so arm params stay valid BawtParams overrides.
import { DEFAULT_PARAMS, PROFILES, resolveParams, type BawtParams } from '../../bots/bawt/params.js';
import type { MatchConfig } from '../../core/types.js';

export type KnobName =
  | 'tableScale'
  | 'lambdaScale'
  | 'kappaLo'
  | 'kappaHi'
  | 'incomeShare'
  | 'reserve'
  | 'floorA'
  | 'floorB'
  | 'maxWinShare'
  | 'denyScale';

export interface KnobSpec {
  name: KnobName;
  lo: number;
  hi: number;
  /** Value at DEFAULT_PARAMS (denyScale: 1). */
  base: number;
  /** Decimal places kept when writing (keeps arm params readable and ids stable). */
  digits: number;
}

export const KNOBS: readonly KnobSpec[] = Object.freeze([
  { name: 'tableScale', lo: 0.7, hi: 1.3, base: 1, digits: 3 },
  { name: 'lambdaScale', lo: 0.7, hi: 1.3, base: 1, digits: 3 },
  { name: 'kappaLo', lo: 0.42, hi: 0.78, base: 0.6, digits: 3 },
  { name: 'kappaHi', lo: 1.75, hi: 3.25, base: 2.5, digits: 3 },
  { name: 'incomeShare', lo: 0.245, hi: 0.455, base: 0.35, digits: 3 },
  { name: 'reserve', lo: 10, hi: 20, base: 15, digits: 1 },
  { name: 'floorA', lo: 1.75, hi: 3.25, base: 2.5, digits: 3 },
  { name: 'floorB', lo: 2.45, hi: 4.55, base: 3.5, digits: 3 },
  { name: 'maxWinShare', lo: 0.63, hi: 1, base: 0.9, digits: 3 },
  { name: 'denyScale', lo: 0.7, hi: 1.3, base: 1, digits: 3 },
] satisfies KnobSpec[]);

export const KNOB_NAMES: readonly KnobName[] = KNOBS.map((k) => k.name);

/**
 * Knobs some built-in profile overrides (kappaHi, reserve, floorA, floorB). An arm param is an
 * absolute override that beats every profile, so moving one of these from a single loss would
 * also move every other profile's tuned value. The cycle only steps them when the incumbent
 * already pins them; otherwise their direction is redirected to a relative knob (candidates.ts).
 * denyScale is exempt: the scaled default map is a no-op where profiles differ (5+ real seats
 * have no key) and equals headsUp's own {'2': 1} at scale 1.
 */
export const PINNED_KNOBS: ReadonlySet<KnobName> = new Set(
  KNOBS.map((k) => k.name).filter((n) => n !== 'denyScale' && Object.values(PROFILES).some((p) => n in p)),
);

export function knobSpec(name: KnobName): KnobSpec {
  return KNOBS.find((k) => k.name === name)!;
}

export type KnobValues = Partial<Record<KnobName, number>>;

const DEFAULT_DENY = DEFAULT_PARAMS.denyWeights;

function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function clampKnob(name: KnobName, v: number): number {
  const k = knobSpec(name);
  if (!Number.isFinite(v)) return k.base;
  return round(Math.min(k.hi, Math.max(k.lo, v)), k.digits);
}

/** denyScale implied by a denyWeights map (ratio on the '2' key, falling back to 1). */
export function denyScaleOf(w: Record<string, number> | undefined): number {
  if (!w) return 1;
  const d2 = DEFAULT_DENY['2'] ?? 1;
  const v = w['2'];
  return typeof v === 'number' && d2 > 0 ? v / d2 : 1;
}

export function denyWeightsFor(scale: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(DEFAULT_DENY)) out[k] = round(v * scale, 4);
  return out;
}

/**
 * Effective knob values an arm plays with: explicit arm params win; otherwise the value the bot
 * resolved for `config` (profile-aware) when given, else DEFAULT_PARAMS.
 */
export function knobValues(params: Record<string, unknown>, config?: MatchConfig): Record<KnobName, number> {
  let resolved: BawtParams = DEFAULT_PARAMS;
  if (config) {
    try {
      resolved = resolveParams(config, params as Partial<BawtParams>);
    } catch {
      resolved = DEFAULT_PARAMS;
    }
  }
  const out = {} as Record<KnobName, number>;
  for (const k of KNOBS) {
    if (k.name === 'denyScale') {
      const w = (params.denyWeights as Record<string, number> | undefined) ?? undefined;
      out.denyScale = w ? denyScaleOf(w) : 1;
      continue;
    }
    const v = params[k.name];
    out[k.name] = typeof v === 'number' ? v : (resolved[k.name] as number);
  }
  return out;
}

/** True when a params object only touches whitelisted keys with in-range values. */
export function paramsInBounds(params: Record<string, unknown>): boolean {
  for (const [key, v] of Object.entries(params)) {
    if (key === 'denyWeights') {
      if (typeof v !== 'object' || v === null) return false;
      const s = denyScaleOf(v as Record<string, number>);
      const k = knobSpec('denyScale');
      if (s < k.lo - 1e-9 || s > k.hi + 1e-9) return false;
      continue;
    }
    if (!KNOB_NAMES.includes(key as KnobName) || key === 'denyScale') return false;
    const k = knobSpec(key as KnobName);
    if (typeof v !== 'number' || v < k.lo - 1e-9 || v > k.hi + 1e-9) return false;
  }
  return true;
}

/**
 * Apply knob values on top of `parent` params: every value is clamped to its range; values equal to
 * the DEFAULT_PARAMS value are still written (explicit beats profile). denyScale becomes denyWeights.
 */
export function withKnobs(parent: Record<string, unknown>, values: KnobValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (k === 'denyWeights' && typeof v === 'object' && v !== null) {
      out.denyWeights = denyWeightsFor(clampKnob('denyScale', denyScaleOf(v as Record<string, number>)));
    } else if (k !== 'denyScale' && KNOB_NAMES.includes(k as KnobName) && typeof v === 'number') {
      out[k] = clampKnob(k as KnobName, v);
    }
  }
  for (const [name, v] of Object.entries(values) as Array<[KnobName, number]>) {
    if (v === undefined) continue;
    const c = clampKnob(name, v);
    if (name === 'denyScale') out.denyWeights = denyWeightsFor(c);
    else out[name] = c;
  }
  return out;
}
