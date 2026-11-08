// Per-bot calibration of the live-field clones (src/bots/clones/live.ts), fitted by
// scripts/live-calibrate.ts against data/profiles-live.json's history window. Bots not listed
// play the raw profile (scale 1, qScale all 1, spread 1).
export interface LiveCalib {
  /** Overall bid multiplier. */
  scale: number;
  /** Bid multiplier per quarter of the match (Q1..Q4). */
  qScale: number[];
  /** KM quantile spread (default 1). */
  spread?: number;
  /** Need-to-quantile shift (default 0). */
  needQ?: number;
}

// Iteration 1 (global): raw profiles let plain bawt win 52% in liveField (live ~18-21%); clones bid
// too low when they lose, so bawt bought 16 letters at ~10.5. spread 0.5 + scale 1.2 -> ~39-42%.
// Iteration 2 (per-bot qScale = live / sim paid per letter per quarter, at spread 0.25) distorted the
// quarter shape (deterministic median bids collide) and did not lower bawt's win rate, so it is
// recorded in QSCALE_ITER2 but not applied.
const G = { scale: 1.2, spread: 0.5, qScale: [1, 1, 1, 1] } as const;

export const LIVE_FIELD_BOTS: readonly string[] = [
  'LexiconWarrior',
  "Odysseus's Voyage",
  'RackMaw',
  'cosine',
  'Primey',
  'peanuts',
  'Lucy',
  'GodOfThudner',
  'aipom',
  'Lbender',
];

export const LIVE_CALIB: Readonly<Record<string, LiveCalib>> = Object.fromEntries(
  LIVE_FIELD_BOTS.map((b) => [b, { scale: G.scale, spread: G.spread, qScale: [...G.qScale] }]),
);

export const QSCALE_ITER2: Readonly<Record<string, readonly number[]>> = {
  LexiconWarrior: [1.0, 1.08, 1.26, 1.28],
  "Odysseus's Voyage": [0.86, 0.97, 0.99, 0.68],
  RackMaw: [0.94, 1.02, 1.06, 1.01],
  cosine: [1.16, 1.01, 1.04, 1.33],
  Primey: [0.94, 0.96, 0.93, 1.29],
  peanuts: [1.36, 1.27, 1.34, 0.69],
  Lucy: [1.08, 1.04, 1.15, 1.42],
  GodOfThudner: [0.97, 1.06, 1.09, 1.21],
  aipom: [0.92, 0.92, 1.01, 1.25],
  Lbender: [1.03, 0.93, 1.12, 1.72],
};
