// Generic profile-driven clone `profile:<BotName>` for any bot in data/profiles.json (02-02).
//
// Bid: inverse-CDF sample from the bot's reverse-KM survival curve P(bid >= x) for (letter group,
// disjoint phase), scaled by a rack-need factor, capped at balance:
//   u ~ U(0,1);  b0 = #{x : P(bid >= x) > u}           (0 when u exceeds P(bid >= 1))
//   need s = clamp(Δ / needScale, 0, 1), Δ = SookraBot pack value gain of the letter (fast packing
//            + 0.35 · leave), a cheap marginal value for the clone's own rack
//   bid = b0 · (needLo + (needHi - needLo) · s) / needMean        needMean = E[factor] ≈ 1 overall
// Curves with fewer than minCurveN observations fall back to the all-phases curve of the group.
// Penultimate auction: when the bot goes all-in on most of its penultimate wins
// (allInRateOfWins >= 0.5) and the letter raises the exact best partition, bid the balance;
// otherwise sample the penultimate curve. Final auction: sample the final curve (the letter is
// unusable, but some bots, e.g. "bro", do bid on it).
// Words: mid-match the clone cashes words of length >= midMinLen, where midMinLen is the largest
// L with P(word length >= L) >= 0.5 in the bot's lenDist, but only if the bot plays a material
// share (>= 25%) of its words before the last tenth of the match; it flushes the exact best
// partition when B + 1 <= lastWordAuctionsLeft.p50 (at least at the final auction).
//
// KM mass below ~3-5 is not identified (HISTORICAL §E2), so low bids are approximate.
import { readFileSync } from 'node:fs';
import { idx } from '../../core/letters.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import type { BidCurve, BotProfile, LetterGroup, Phase, ProfilesFile } from '../../history/profiles.js';
import { Turn, cashGreedy, clamp, letterOf, partition, rackPlus } from './common.js';
import { sookraPackValue } from './sookra.js';

const GROUPS: Readonly<Record<LetterGroup, string>> = {
  vowel: 'AEIOU',
  LNSTR: 'LNSTR',
  DG: 'DG',
  BCMP: 'BCMP',
  FHVWY: 'FHVWY',
  K: 'K',
  JX: 'JX',
  QZ: 'QZ',
};
const GROUP_OF: LetterGroup[] = (() => {
  const g = new Array<LetterGroup>(26);
  for (const [name, letters] of Object.entries(GROUPS) as Array<[LetterGroup, string]>) for (const c of letters) g[idx(c)] = name;
  return g;
})();

/** Disjoint phase of auction k (0-based) in a match of T auctions (src/history/profiles.ts). */
export function profilePhase(k: number, T: number): Phase {
  if (k === T - 1) return 'final';
  if (k === T - 2) return 'penultimate';
  if (3 * k >= 2 * T) return 'late';
  if (3 * k >= T) return 'mid';
  return 'early';
}

let cache: ProfilesFile | undefined;

export function loadProfiles(): ProfilesFile {
  if (!cache) {
    const path = new URL('../../../data/profiles.json', import.meta.url);
    cache = JSON.parse(readFileSync(path, 'utf8')) as ProfilesFile;
  }
  return cache;
}

export function findProfile(name: string): BotProfile {
  const bots = loadProfiles().bots;
  const exact = bots.find((b) => b.name === name);
  if (exact) return exact;
  const lower = name.toLowerCase();
  const ci = bots.find((b) => b.name.toLowerCase() === lower);
  if (ci) return ci;
  throw new Error(`profile: no bot '${name}' in data/profiles.json (${bots.length} profiled bots)`);
}

/** Inverse-CDF draw from a survival curve P(bid >= x), x = 1..maxX. */
export function sampleCurve(curve: BidCurve, u: number): number {
  let b = 0;
  for (let x = 0; x < curve.pGe.length; x++) {
    if (curve.pGe[x]! > u) b = x + 1;
    else break;
  }
  return b;
}

export interface ProfileParams {
  arg?: string;
  needScale: number;
  needLo: number;
  needHi: number;
  needMean: number;
  minCurveN: number;
  midShareMin: number;
}

export const PROFILE_DEFAULTS: Readonly<ProfileParams> = Object.freeze({
  needScale: 8,
  needLo: 0.7,
  needHi: 1.3,
  needMean: 0.9,
  minCurveN: 30,
  midShareMin: 0.25,
});

export interface ProfileWordPolicy {
  midMinLen: number;
  cashMid: boolean;
  flushT: number;
}

export function profileWordPolicy(bot: BotProfile, midShareMin = PROFILE_DEFAULTS.midShareMin): ProfileWordPolicy {
  const dist = bot.words.lenDist;
  let midMinLen = 7;
  for (let L = 8; L >= 2; L--) {
    let tail = 0;
    for (let j = L - 2; j < dist.length; j++) tail += dist[j] ?? 0;
    if (tail >= 0.5) {
      midMinLen = L;
      break;
    }
  }
  const tenths = bot.timing.tenths;
  const midShare = tenths.slice(0, 9).reduce((a, b) => a + b, 0);
  const p50 = bot.timing.lastWordAuctionsLeft.p50;
  return { midMinLen, cashMid: midShare >= midShareMin, flushT: Math.max(1, Math.round(p50 ?? 1)) };
}

export const createProfileClone: PolicyFactory = (_seed, opts) => {
  const p: ProfileParams = { ...PROFILE_DEFAULTS, ...(opts as Partial<ProfileParams> | undefined) };
  if (!p.arg) throw new Error("profile: use 'profile:<BotName>'");
  const bot = findProfile(p.arg);
  const wp = profileWordPolicy(bot, p.midShareMin);
  const penAllIn = (bot.penultimate.allInRateOfWins ?? 0) >= 0.5;
  const curveFor = (li: number, phase: Phase): BidCurve => {
    const g = GROUP_OF[li]!;
    const c = bot.bidCurves[g][phase];
    return c.n >= p.minCurveN ? c : bot.bidCurvesAllPhases[g];
  };
  const policy: Policy = {
    name: `profile:${bot.name}`,
    onMatchStart() {},
    decide(view, auction, ctx) {
      const li = letterOf(auction);
      const B = auction.remainingAfter;
      const T = B + 1;
      const t = new Turn(view);
      const u = ctx.rng.float();
      if (T <= wp.flushT) t.dump();
      else if (wp.cashMid) t.playAll(cashGreedy(t.rack, wp.midMinLen, 4));
      const phase = profilePhase(auction.index, view.config.totalAuctions);
      if (phase === 'penultimate' && penAllIn) {
        const gain = partition(rackPlus(t.rack, li)).score - partition(t.rack).score;
        if (gain > 0) return t.decision(t.balance);
      }
      const b0 = sampleCurve(curveFor(li, phase), u);
      if (b0 <= 0) return t.decision(0);
      if (phase === 'final') return t.decision(b0);
      const delta = sookraPackValue(rackPlus(t.rack, li), 0.35) - sookraPackValue(t.rack, 0.35);
      const s = clamp(delta / p.needScale, 0, 1);
      const factor = (p.needLo + (p.needHi - p.needLo) * s) / p.needMean;
      return t.decision(Math.max(1, Math.round(b0 * factor)));
    },
  };
  return policy;
};
