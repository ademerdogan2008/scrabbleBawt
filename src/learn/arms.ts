// Learnable parameter whitelist. An arm may only set these knobs, each clamped to its range
// (roughly ±30% around the defaults, widened just enough to include the profile values). Anything
// else in an arm's params is dropped, so a bad or hand-edited state file cannot push the live bot
// outside a bounded region of parameter space.
import type { MatchConfig } from '../core/types.js';
import { DEFAULT_PARAMS, PROFILES, resolveParams, type BawtParams } from '../bots/bawt/params.js';

export interface Knob {
  lo: number;
  hi: number;
  /** Current default (DEFAULT_PARAMS), for documentation and arm generation. */
  def: number;
}

/**
 * Whitelist. All map 1:1 onto BawtParams keys except `denyScale`, a multiplier on the resolved
 * profile's denyWeights (so it keeps the per-seat-count shape of the profile).
 */
export const LEARNABLE = Object.freeze({
  tableScale: { lo: 0.7, hi: 1.3, def: 1 },
  lambdaScale: { lo: 0.7, hi: 1.3, def: 1 },
  kappaLo: { lo: 0.42, hi: 1.0, def: 0.6 },
  kappaHi: { lo: 1.75, hi: 3.9, def: 2.5 },
  incomeShare: { lo: 0.25, hi: 0.75, def: 0.35 },
  reserve: { lo: 0, hi: 25, def: 15 },
  floorA: { lo: 1.75, hi: 3.25, def: 2.5 },
  floorB: { lo: 2, hi: 4.55, def: 3.5 },
  maxWinShare: { lo: 0.63, hi: 1, def: 0.9 },
  denyScale: { lo: 0.7, hi: 1.3, def: 1 },
  // spend-down / anti-bait phase pacing / greedybot-bait guard (src/bots/bawt/params.ts)
  endWindow: { lo: 0, hi: 30, def: 0 },
  endKappaLo: { lo: 0.6, hi: 2, def: 1 },
  earlyScale: { lo: 0.6, hi: 1, def: 1 },
  greedMinSeats: { lo: 0, hi: 6, def: 0 },
  baitRatio: { lo: 0.8, hi: 2, def: 2 },
  baitShade: { lo: 0.6, hi: 1, def: 1 },
  keyEdge: { lo: 0, hi: 3, def: 0 },
  keyMinFace: { lo: 3, hi: 8, def: 4 },
  dumpWindow: { lo: 0, hi: 20, def: 0 },
  dumpMult: { lo: 0.5, hi: 2, def: 1 },
  paceReserve: { lo: 0, hi: 140, def: 0 },
  q2Scale: { lo: 0.5, hi: 1.2, def: 1 },
  q2From: { lo: 0, hi: 0.6, def: 0.25 },
  q2To: { lo: 0.2, hi: 0.8, def: 0.5 },
  paceLetters: { lo: 0, hi: 22, def: 0 },
  paceGain: { lo: 0, hi: 0.3, def: 0.12 },
  hoardGuard: { lo: 0, hi: 1, def: 0 },
  hoardMinBal: { lo: 40, hi: 90, def: 60 },
  hoardShare: { lo: 0.2, hi: 0.8, def: 0.5 },
  hoardBoost: { lo: 1, hi: 1.4, def: 1.15 },
} satisfies Record<string, Knob>);

export type LearnableKey = keyof typeof LEARNABLE;
export type LearnableParams = Partial<Record<LearnableKey, number>>;

export const LEARNABLE_KEYS = Object.keys(LEARNABLE) as LearnableKey[];

export function isLearnable(k: string): k is LearnableKey {
  return Object.prototype.hasOwnProperty.call(LEARNABLE, k);
}

/** Drop non-whitelisted keys and non-finite values; clamp the rest into their ranges. */
export function clampParams(params: Record<string, unknown> | undefined | null): LearnableParams {
  const out: LearnableParams = {};
  if (!params || typeof params !== 'object') return out;
  for (const [k, v] of Object.entries(params)) {
    if (!isLearnable(k) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    const { lo, hi } = LEARNABLE[k];
    out[k] = Math.max(lo, Math.min(hi, v));
  }
  return out;
}

/**
 * BawtParams overrides of an arm for a match: the clamped knobs, with denyScale turned into scaled
 * denyWeights of the profile that `base` (the spec params) resolves to for this config. An empty
 * arm yields {} (bit-identical to the plain policy).
 */
export function armOverrides(
  armParams: Record<string, unknown> | undefined,
  config: MatchConfig,
  base: Partial<BawtParams> = {},
): Partial<BawtParams> {
  const c = clampParams(armParams);
  const { denyScale, ...rest } = c;
  const out: Partial<BawtParams> = { ...rest };
  const needResolve = denyScale !== undefined || out.kappaLo !== undefined || out.kappaHi !== undefined;
  if (!needResolve) return out;
  const eff = resolveParams(config, { ...base, ...out });
  if (eff.kappaLo > eff.kappaHi) out.kappaLo = eff.kappaHi;
  if (denyScale !== undefined && denyScale !== 1) {
    const dw: Record<string, number> = {};
    for (const [k, w] of Object.entries(eff.denyWeights)) dw[k] = w * denyScale;
    out.denyWeights = dw;
  }
  return out;
}

// ---------------------------------------------------------------------- knob helpers (cycle)
// Used by the offline cycle (src/learn/cycle) to step arms through the whitelist. Arm params are
// always written in the LEARNABLE vocabulary (denyScale stays a multiplier, see armOverrides), so
// the live client and the sim gate (policy 'bawt-arm') apply them identically.

export type KnobName = LearnableKey;

export interface KnobSpec {
  name: KnobName;
  lo: number;
  hi: number;
  /** Value at DEFAULT_PARAMS (denyScale: 1). */
  base: number;
  /** Decimal places kept when writing (keeps arm params readable and ids stable). */
  digits: number;
}

/** Count-valued knobs are written as integers. */
const INTEGER_KNOBS: ReadonlySet<string> = new Set(['endWindow', 'greedMinSeats']);

export const KNOBS: readonly KnobSpec[] = Object.freeze(
  LEARNABLE_KEYS.map((name): KnobSpec => {
    const k = LEARNABLE[name];
    const dp = (DEFAULT_PARAMS as unknown as Record<string, unknown>)[name];
    const base = typeof dp === 'number' ? dp : k.def;
    return { name, lo: k.lo, hi: k.hi, base, digits: INTEGER_KNOBS.has(name) ? 0 : name === 'reserve' ? 1 : 3 };
  }),
);

export const KNOB_NAMES: readonly KnobName[] = KNOBS.map((k) => k.name);

/**
 * Knobs some built-in profile overrides (e.g. kappaHi, reserve, floorA, floorB). An arm param is
 * an absolute override that beats every profile, so moving one of these from a single loss would
 * also move every other profile's tuned value. The cycle only steps them when the incumbent
 * already pins them. denyScale is exempt: it scales whatever map the profile resolves to.
 */
export const PINNED_KNOBS: ReadonlySet<KnobName> = new Set(
  KNOB_NAMES.filter((n) => n !== 'denyScale' && Object.values(PROFILES).some((p) => n in p)),
);

export function knobSpec(name: KnobName): KnobSpec {
  return KNOBS.find((k) => k.name === name)!;
}

export type KnobValues = Partial<Record<KnobName, number>>;

function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

/** Clamp into the knob's range and round to its digits (non-finite: the base value). */
export function clampKnob(name: KnobName, v: number): number {
  const k = knobSpec(name);
  if (!Number.isFinite(v)) return k.base;
  return Math.min(k.hi, Math.max(k.lo, roundTo(v, k.digits)));
}

/**
 * Effective knob values an arm plays with: explicit (clamped) arm params win; otherwise the value
 * the bot resolves for `config` (profile-aware) when given, else DEFAULT_PARAMS. denyScale: 1.
 */
export function knobValues(params: Record<string, unknown>, config?: MatchConfig): Record<KnobName, number> {
  const c = clampParams(params);
  let resolved: BawtParams = DEFAULT_PARAMS;
  if (config) {
    try {
      const { denyScale: _d, ...rest } = c;
      resolved = resolveParams(config, rest);
    } catch {
      resolved = DEFAULT_PARAMS;
    }
  }
  const out = {} as Record<KnobName, number>;
  for (const k of KNOBS) {
    const v = c[k.name];
    if (v !== undefined) out[k.name] = v;
    else if (k.name === 'denyScale') out.denyScale = 1;
    else out[k.name] = (resolved as unknown as Record<string, number>)[k.name] ?? k.base;
  }
  return out;
}

/** True when a params object only touches whitelisted keys with finite in-range values. */
export function paramsInBounds(params: Record<string, unknown>): boolean {
  for (const [key, v] of Object.entries(params)) {
    if (!isLearnable(key) || typeof v !== 'number' || !Number.isFinite(v)) return false;
    const k = LEARNABLE[key];
    if (v < k.lo - 1e-9 || v > k.hi + 1e-9) return false;
  }
  return true;
}

/**
 * Apply knob values on top of `parent` params: only whitelisted keys survive, every value is
 * clamped and rounded; values equal to the default are still written (explicit beats profile).
 */
export function withKnobs(parent: Record<string, unknown>, values: KnobValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(clampParams(parent)) as Array<[KnobName, number]>) out[k] = clampKnob(k, v);
  for (const [name, v] of Object.entries(values) as Array<[KnobName, number | undefined]>) {
    if (v === undefined || !isLearnable(name)) continue;
    out[name] = clampKnob(name, v);
  }
  return out;
}
