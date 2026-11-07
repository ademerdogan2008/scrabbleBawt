// Learnable parameter whitelist. An arm may only set these knobs, each clamped to its range
// (roughly ±30% around the defaults, widened just enough to include the profile values). Anything
// else in an arm's params is dropped, so a bad or hand-edited state file cannot push the live bot
// outside a bounded region of parameter space.
import type { MatchConfig } from '../core/types.js';
import { resolveParams, type BawtParams } from '../bots/bawt/params.js';

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
  kappaLo: { lo: 0.42, hi: 0.78, def: 0.6 },
  kappaHi: { lo: 1.75, hi: 3.9, def: 2.5 },
  incomeShare: { lo: 0.25, hi: 0.45, def: 0.35 },
  reserve: { lo: 8, hi: 25, def: 15 },
  floorA: { lo: 1.75, hi: 3.25, def: 2.5 },
  floorB: { lo: 2, hi: 4.55, def: 3.5 },
  maxWinShare: { lo: 0.63, hi: 1, def: 0.9 },
  denyScale: { lo: 0.7, hi: 1.3, def: 1 },
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
