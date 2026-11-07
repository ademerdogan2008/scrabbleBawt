// Karthik FieldBot presets (COMPETITORS.md §4.10; Karthik's repo is MIT, re-implemented from the
// published formula):
//   bid = median_L x phase(progress) x 0.95 x aggression x (bal/100)^wealthExp x e^(noise z) x fit(rack)
//
// fit(rack) is not specified beyond its name; approximation: 1.15 when the letter raises the fast
// best-packing score of the rack, 0.9 when it does not but the rack is still small (<= 6 tiles),
// else 0.55. Words: cash words of length >= minLen on sight; in the last 2 auctions "smart dump"
// (shark) plays the exact best partition, the other presets cash greedily (length >= 2).
// volume ("postturing") scales premium letters (face >= 5) by 0.55. Final tile: bid 0.
import { VALUE } from '../../core/letters.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import {
  FIELD_MEDIAN,
  Turn,
  cashGreedy,
  fieldPhaseMult,
  gauss,
  letterOf,
  partitionFast,
  progressOf,
  rackPlus,
  rackSize,
} from './common.js';

export interface FieldBotParams {
  aggression: number;
  noise: number;
  wealthExp: number;
  minLen: number;
  smartDump: boolean;
  premiumMul: number;
}

export const FIELDBOT_PRESETS: Readonly<Record<string, FieldBotParams>> = Object.freeze({
  shark: { aggression: 1.05, noise: 0.25, wealthExp: 0.5, minLen: 7, smartDump: true, premiumMul: 1 },
  volume: { aggression: 1.0, noise: 0.25, wealthExp: 0.5, minLen: 5, smartDump: false, premiumMul: 0.55 },
  grinder: { aggression: 0.95, noise: 0.3, wealthExp: 0.4, minLen: 5, smartDump: false, premiumMul: 1 },
  spender: { aggression: 1.35, noise: 0.35, wealthExp: 0.8, minLen: 6, smartDump: false, premiumMul: 1 },
  nibbler: { aggression: 0.75, noise: 0.3, wealthExp: 0.3, minLen: 4, smartDump: false, premiumMul: 1 },
});

export function fieldBotFactory(preset: string): PolicyFactory {
  const base = FIELDBOT_PRESETS[preset];
  if (!base) throw new Error(`fieldbot: unknown preset '${preset}'`);
  const name = `clone:field${preset[0]!.toUpperCase()}${preset.slice(1)}`;
  return (_seed, opts) => {
    const p: FieldBotParams = { ...base, ...(opts as Partial<FieldBotParams> | undefined) };
    const policy: Policy = {
      name,
      onMatchStart() {},
      decide(view, auction, ctx) {
        const li = letterOf(auction);
        const T = auction.remainingAfter + 1;
        const t = new Turn(view);
        const z = gauss(ctx.rng);
        if (T <= 2) {
          if (p.smartDump) t.dump();
          else t.playAll(cashGreedy(t.rack, 2, 8));
        } else t.playAll(cashGreedy(t.rack, p.minLen, 4));
        if (T <= 1) return t.decision(0);
        const gain = partitionFast(rackPlus(t.rack, li)).score - partitionFast(t.rack).score;
        const fit = gain > 0 ? 1.15 : rackSize(t.rack) <= 6 ? 0.9 : 0.55;
        let bid =
          FIELD_MEDIAN[li]! *
          fieldPhaseMult(progressOf(view, auction)) *
          0.95 *
          p.aggression *
          Math.max(0, t.balance / 100) ** p.wealthExp *
          Math.exp(p.noise * z) *
          fit;
        if (VALUE[li]! >= 5) bid *= p.premiumMul;
        return t.decision(bid);
      },
    };
    return policy;
  };
}
