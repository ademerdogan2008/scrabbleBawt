// maverick-bot (bot 62) data-fitted clone (COMPETITORS.md §4.9; no public code). Log-bid
// coefficients from the §2.4 fit of its winning bids (NOW block, n = 9,240): steepest late ramp
// (x2.8), all-in at the penultimate auction (~0.99 x balance). κ is calibrated by
// scripts/zoo-calibrate.ts (MAVERICK_CALIBRATION); penFrac = the spec's median top/balance at B == 1.
// Words: 7+ preferred (71-84% of mid-match words) but also cashes some 5-6 letter words (altProb);
// first word ~r17.8; dumps in the last 3 auctions.
import { FITTED_EXTRAS, fittedFactory, type FittedParams, type FittedTargets } from './fitted.js';

export const MAVERICK_TARGETS: Readonly<FittedTargets> = Object.freeze({
  tiles: 19.7,
  paidPerTile: 10.32,
  endBalance: 24.8,
  words: 4.0,
  score: 128.1,
  firstWordRound: 17.8,
  balR20: 85,
  balR45: 62,
  balR56: 40,
});

/** Calibrated constants (written by scripts/zoo-calibrate.ts --write). */
export const MAVERICK_CALIBRATION = { kappa: 0.6201, penFrac: 0.99, needW: 0 };

export const MAVERICK_DEFAULTS: Readonly<FittedParams> = Object.freeze({
  c0: 2.07,
  cFace: 0.163,
  cPhase: 1.017,
  cBal: -0.172,
  cRack: -0.045,
  cVowel: 0.009,
  cSims: 0.009,
  sd: 0.444,
  kappa: MAVERICK_CALIBRATION.kappa,
  penFrac: MAVERICK_CALIBRATION.penFrac,
  minLen: 7,
  altMinLen: 5,
  altProb: 0.05,
  dumpT: 3,
  premiumCap: 0,
  ...FITTED_EXTRAS,
  needW: MAVERICK_CALIBRATION.needW,
});

export const createMaverick = fittedFactory('clone:maverick', MAVERICK_DEFAULTS);
