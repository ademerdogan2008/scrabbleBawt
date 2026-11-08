// Live-field clone family `live:<BotName>`: the profile clone (src/bots/clones/profile.ts) driven by
// data/profiles-live.json (today's lobby, fitted with
//   npx tsx scripts/history-profiles.ts --data .cache/hist-live --out data/profiles-live.json \
//       --min-matches 25 --active-window 1000 --finalists none)
// plus a per-bot calibration (src/bots/clones/live-calib.ts) fitted by scripts/live-calibrate.ts:
//   bid = profile bid (KM inverse-CDF x rack-need factor) x qScale[quarter] x scale, capped at balance.
// spread < 1 narrows the KM quantile draw toward the median: real bots bid steadily given their state,
// an i.i.d. full-range draw lets a focal bot pick off letters whenever every clone draws low.
// The phase-specific KM curves carry the push-early / harvest-late shape; qScale corrects the
// residual per-quarter price level so sim paid/letter per quarter matches the live history.
import { readFileSync } from 'node:fs';
import type { Policy, PolicyFactory } from '../../core/types.js';
import type { BidCurve, BotProfile, Phase, ProfilesFile } from '../../history/profiles.js';
import { Turn, cashGreedy, clamp, letterOf, partition, rackPlus } from './common.js';
import { LIVE_CALIB, type LiveCalib } from './live-calib.js';
import { PROFILE_DEFAULTS, profilePhase, profileWordPolicy, sampleCurve, type ProfileParams } from './profile.js';
import { sookraPackValue } from './sookra.js';

const GROUP_OF: string[] = (() => {
  const g: string[] = new Array(26);
  const groups: Record<string, string> = {
    vowel: 'AEIOU',
    LNSTR: 'LNSTR',
    DG: 'DG',
    BCMP: 'BCMP',
    FHVWY: 'FHVWY',
    K: 'K',
    JX: 'JX',
    QZ: 'QZ',
  };
  for (const [name, letters] of Object.entries(groups)) for (const c of letters) g[c.charCodeAt(0) - 65] = name;
  return g;
})();

let cache: ProfilesFile | undefined;

export function loadLiveProfiles(): ProfilesFile {
  if (!cache) {
    const path = new URL('../../../data/profiles-live.json', import.meta.url);
    cache = JSON.parse(readFileSync(path, 'utf8')) as ProfilesFile;
  }
  return cache;
}

export function findLiveProfile(name: string): BotProfile {
  const bots = loadLiveProfiles().bots;
  const lower = name.toLowerCase();
  const b = bots.find((x) => x.name === name) ?? bots.find((x) => x.name.toLowerCase() === lower);
  if (!b) throw new Error(`live: no bot '${name}' in data/profiles-live.json (${bots.length} profiled bots)`);
  return b;
}

export const DEFAULT_LIVE_CALIB: Readonly<LiveCalib> = Object.freeze({ scale: 1, qScale: [1, 1, 1, 1] });

export function liveCalibFor(name: string): LiveCalib {
  return LIVE_CALIB[name] ?? DEFAULT_LIVE_CALIB;
}

/** Quarter (0..3) of auction k in a match of T auctions. */
export function quarterOf(k: number, T: number): number {
  return Math.min(3, Math.floor((4 * k) / T));
}

export interface LiveParams extends ProfileParams {
  /** Override the calibration (tests / calibration runs): overall scale and per-quarter scales. */
  scale?: number;
  qScale?: number[];
  /** Quantile spread: u' = 0.5 + (u - 0.5) * spread (1 = raw KM draw, < 1 = steadier bids). */
  spread?: number;
  /** Need-to-quantile shift: u -= needQ * (s - 0.5), s = rack need in [0,1] (0 = off). */
  needQ?: number;
}

export const createLiveClone: PolicyFactory = (_seed, opts) => {
  const p: LiveParams = { ...PROFILE_DEFAULTS, ...(opts as Partial<LiveParams> | undefined) };
  if (!p.arg) throw new Error("live: use 'live:<BotName>'");
  const bot = findLiveProfile(p.arg);
  const cal = liveCalibFor(bot.name);
  const scale = p.scale ?? cal.scale;
  const qScale = p.qScale ?? cal.qScale;
  const spread = p.spread ?? cal.spread ?? 1;
  const needQ = p.needQ ?? cal.needQ ?? 0;
  const wp = profileWordPolicy(bot, p.midShareMin);
  const penAllIn = (bot.penultimate.allInRateOfWins ?? 0) >= 0.5;
  const curveFor = (li: number, phase: Phase): BidCurve => {
    const g = GROUP_OF[li] as keyof BotProfile['bidCurves'];
    const c = bot.bidCurves[g][phase];
    return c.n >= p.minCurveN ? c : bot.bidCurvesAllPhases[g];
  };
  const policy: Policy = {
    name: `live:${bot.name}`,
    onMatchStart() {},
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const B = auction.remainingAfter;
      const T = B + 1;
      const t = new Turn(view);
      const r = ctx.rng.float();
      if (T <= wp.flushT) t.dump();
      else if (wp.cashMid) t.playAll(cashGreedy(t.rack, wp.midMinLen, 4));
      const total = view.config.totalAuctions;
      const phase = profilePhase(auction.index, total);
      if (phase === 'penultimate' && penAllIn) {
        const gain = partition(rackPlus(t.rack, li)).score - partition(t.rack).score;
        if (gain > 0) return t.decision(t.balance);
      }
      const delta =
        phase === 'final' ? 0 : sookraPackValue(rackPlus(t.rack, li), 0.35) - sookraPackValue(t.rack, 0.35);
      const s = clamp(delta / p.needScale, 0, 1);
      const u = clamp(0.5 + (r - 0.5) * spread - (phase === 'final' ? 0 : needQ * (s - 0.5)), 0, 0.999);
      const b0 = sampleCurve(curveFor(li, phase), u);
      if (b0 <= 0) return t.decision(0);
      if (phase === 'final') return t.decision(b0);
      const factor = (p.needLo + (p.needHi - p.needLo) * s) / p.needMean;
      const q = qScale[quarterOf(auction.index, total)] ?? 1;
      return t.decision(Math.max(1, Math.round(b0 * factor * scale * q)));
    },
  };
  return policy;
};
