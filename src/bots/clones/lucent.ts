// LUCENT (bot 18) data-fitted clone (COMPETITORS.md §4.9; no public code). Log-bid coefficients
// from the §2.4 least-squares fit of its winning bids (NOW block, n = 12,476); κ is calibrated by
// scripts/zoo-calibrate.ts (LUCENT_CALIBRATION); penFrac = the spec's median top/balance at B == 1.
// Words: 7+ only mid-match (97-99%), first word ~r17.5; dumps in the last 3 auctions (B = 2..1).
import { FITTED_EXTRAS, fittedFactory, type FittedParams, type FittedTargets } from './fitted.js';

export const LUCENT_TARGETS: Readonly<FittedTargets> = Object.freeze({
  tiles: 25.6,
  paidPerTile: 9.3,
  endBalance: 27.5,
  words: 4.69,
  score: 165.5,
  firstWordRound: 17.5,
  balR20: 66,
  balR45: 50,
  balR56: 44,
});

/** Calibrated constants (written by scripts/zoo-calibrate.ts --write). */
export const LUCENT_CALIBRATION = { kappa: 0.7034, penFrac: 0.82, needW: 0 };

export const LUCENT_DEFAULTS: Readonly<FittedParams> = Object.freeze({
  c0: 2.454,
  cFace: 0.175,
  cPhase: 0.265,
  cBal: -0.125,
  cRack: -0.037,
  cVowel: -0.013,
  cSims: -0.029,
  sd: 0.414,
  kappa: LUCENT_CALIBRATION.kappa,
  penFrac: LUCENT_CALIBRATION.penFrac,
  minLen: 7,
  altMinLen: 7,
  altProb: 0,
  dumpT: 3,
  premiumCap: 0,
  ...FITTED_EXTRAS,
  needW: LUCENT_CALIBRATION.needW,
});

export const createLucent = fittedFactory('clone:lucent', LUCENT_DEFAULTS);
