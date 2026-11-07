// Bron (bot 114) data-fitted clone (COMPETITORS.md §4.9; no public code). Log-bid coefficients
// from the §2.4 fit of its winning bids (NOW block, n = 15,427): thrifty phase ramp (x2.2 from
// start to end). J/X/Q/Z bids stop at exactly 30 (HISTORICAL.md §E3). κ is calibrated by
// scripts/zoo-calibrate.ts (BRON_CALIBRATION); penFrac = the spec's median top/balance at B == 1.
// Words: 7+ only mid-match (98-100%), first word ~r13.8; dumps at the final auction (B == 0).
import { FITTED_EXTRAS, fittedFactory, type FittedParams, type FittedTargets } from './fitted.js';

export const BRON_TARGETS: Readonly<FittedTargets> = Object.freeze({
  tiles: 26.4,
  paidPerTile: 7.53,
  endBalance: 58.9,
  words: 4.83,
  score: 157.8,
  firstWordRound: 13.8,
  balR20: 88,
  balR45: 71,
  balR56: 62,
});

/** Calibrated constants (written by scripts/zoo-calibrate.ts --write). */
export const BRON_CALIBRATION = { kappa: 0.8728, penFrac: 0.68, needW: 0 };

export const BRON_DEFAULTS: Readonly<FittedParams> = Object.freeze({
  c0: 1.986,
  cFace: 0.169,
  cPhase: 0.791,
  cBal: -0.226,
  cRack: -0.033,
  cVowel: 0.018,
  cSims: -0.013,
  sd: 0.335,
  kappa: BRON_CALIBRATION.kappa,
  penFrac: BRON_CALIBRATION.penFrac,
  minLen: 7,
  altMinLen: 7,
  altProb: 0,
  dumpT: 1,
  premiumCap: 30,
  ...FITTED_EXTRAS,
  needW: BRON_CALIBRATION.needW,
});

export const createBron = fittedFactory('clone:bron', BRON_DEFAULTS);
