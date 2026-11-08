// Bawt tunables: one JSON-serializable parameter object plus named profiles.
//
// Numbers come from .planning/research/STRATEGY.md (section in brackets). The profile is chosen
// from the MatchConfig (seat count, number of sims, auction type, match kind) unless the caller
// pins one with `profile` (or overrides single fields; overrides always win).
import type { MatchConfig } from '../../core/types.js';

/** Valuation / policy mode (ablations). */
export type BawtMode =
  | 'hyb' // HYB-κ (STRATEGY §11): table/MC blend × κ pacing + floor (default)
  | 'quick' // table only, no Monte Carlo (anytime first stage)
  | 'rollout' // budget-aware rollout valuation: break-even price by bisection on V(R+L, B-p) - V(R, B)
  | 'static' // PUSH control: 2.5·face + 4 on every letter, cash 7+, final flush
  | 'k13'; // K-13 style: MC value / λ from the clearing-price model, no floor

export type ProfileName = 'default' | 'lobby' | 'fullTable' | 'bigTable' | 'headsUp' | 'firstPrice';

export interface BawtParams {
  profile: ProfileName;
  mode: BawtMode;

  // ---------------------------------------------------------------- valuation (§4, §7.3)
  /** Multiplier on the end-game marginal table. */
  tableScale: number;
  /** Monte Carlo scenarios per decision (common random numbers across the letter's with/without). */
  mcSamples: number;
  /** Max future acquisitions per scenario (horizon H). */
  mcHorizon: number;
  /** Cap on rack + future letters packed inside the MC (larger racks shorten H). */
  mcMaxLetters: number;
  /** Skip the MC (table only) when its blend weight cover = H / (f·share) is below this. */
  mcMinCover: number;
  /**
   * Max MC blend weight while the expected future wins exceed mcFullBelow (then cover may reach 1),
   * applied only in fields with >= mcCoverCapMinReal real seats (measured: +19.0 pts [15.7, 22.2]
   * in 6-real tables; −8.5 in sim-padded lobbies, where the uncapped blend wins).
   */
  mcCoverCap: number;
  mcCoverCapMinReal: number;
  mcFullBelow: number;
  /** packExact node limit inside the MC (deterministic); packTimeMs is only a safety net. */
  mcNodeLimit: number;
  /** Deterministic work cap per decision: stop sampling after this many search nodes (>= 4 samples). */
  mcNodeBudget: number;
  packTimeMs: number;
  /** Max share of the future auctions we assume we can win. */
  maxWinShare: number;
  /** Min share (price-model share is floored here so values never spiral down, §9.3). */
  minWinShare: number;

  // ---------------------------------------------------------------- pacing κ (§3.3)
  kappaLo: number;
  kappaHi: number;
  /** κ upper bound when every competitor is a sim (buy nearly everything, §3.2). */
  kappaHiSims: number;
  /** Coins kept back from the spend constraint. */
  reserve: number;
  /** Share of expected future word rewards counted as spendable income. */
  incomeShare: number;
  /** incomeShare when every competitor is a sim (we cash nearly every letter we buy). */
  incomeShareSims: number;
  /** Scale on 1/κ (λ) for the K-13 style path. */
  lambdaScale: number;
  /** Spend-down window: over the last `endWindow` useful auctions the reserve tapers to 0 and κ_lo
   *  ramps linearly up to `endKappaLo` (coins are worth nothing once the bag is empty). 0 = off. */
  endWindow: number;
  endKappaLo: number;
  /** Anti-bait phase pacing ("push early, harvest late" field): κ is scaled by earlyScale until
   *  earlyUntil·T auctions, then ramps linearly to 1 at rampEnd·T. Saves coins from the pushed
   *  early market for the cheap late harvest. 1 = off. */
  earlyScale: number;
  earlyUntil: number;
  rampEnd: number;
  /** Greedybot-bait guard. Greedy pacing (reserve, incomeShare, kappaLo, endWindow, earlyScale above) is used
   *  only with >= greedMinSeats players and while not baited. Baited (Vickrey only) = EWMA of
   *  paid/ourBid over our wins >= baitRatio after baitMinWins wins (a shadow is pricing us at our
   *  own bid); released below baitRatio - baitHyst. Greed off -> calm* pacing, and while baited
   *  κ is also scaled by baitShade so the pusher overshoots onto letters it does not want. */
  greedMinSeats: number;
  /** Key-letter edge (Vickrey): +keyEdge coins on a positive bid for a useful letter with face
   *  value >= keyMinFace. Live losses show many high-value letters lost by ties or <= 2 coins;
   *  in Vickrey the extra coins are paid only when a rival bid lands inside the edge. 0 = off. */
  keyEdge: number;
  keyMinFace: number;
  /** Coin dump (Vickrey): over the last dumpWindow useful auctions, a useful letter is bid at least
   *  dumpMult * balance / (useful auctions left): unspent coins score nothing, so the balance is
   *  spread over the final letters instead of being kept. 0 = off. */
  dumpWindow: number;
  dumpMult: number;
  /** Spending plan: the pacing reserve is at least paceReserve * (useful auctions left / total),
   *  so money is saved for the second half (live winners hold ~56 coins at half-time; v1 ~44 and
   *  starves in Q3-Q4). 0 = off. */
  paceReserve: number;
  baitRatio: number;
  baitHyst: number;
  baitMinWins: number;
  baitAlpha: number;
  baitShade: number;
  calmReserve: number;
  calmIncomeShare: number;
  calmKappaLo: number;

  // ---------------------------------------------------------------- floor (§11 HYB)
  floorA: number;
  floorB: number;
  /** Floor applies only while vowels(rack+L) <= vowelCap·(|rack|+1) + 1. */
  vowelCap: number;
  /** Floor applies only while copies held < dupCap. */
  dupCap: number;
  /** Shrink the floor by min(1, κ) when money is tight. */
  floorKappaScale: boolean;

  // ---------------------------------------------------------------- denial / rank (§6)
  /** Denial weight by number of real (non-sim) seats incl. us; missing keys = 0. */
  denyWeights: Record<string, number>;
  /** Max coins the denial term may add over the selfish bid. */
  maxOverbid: number;
  /** Vickrey: use the price-driving utility (selfish surplus - w·rival surplus) when w > 0. */
  drive: boolean;

  // ---------------------------------------------------------------- bid shaping (§3.4, §10)
  /** +1 when the predicted tie mass at our bid is at least this. 0 disables. */
  tieNudgeMinP: number;
  /** ±jitter coins on letters valued below jitterBelow. */
  jitter: number;
  jitterBelow: number;
  /** Symmetric multiplicative noise on bids (anti-snooping). */
  bidNoise: number;
  /** Bid focal cap + 1 when a rival's modal cap (e.g. Bron 30 on JXQZ) is below our value. */
  focalCaps: boolean;
  /** When only sims (or broke seats) can bid: bid their max + 1 instead of the value bid. */
  sureWinCap: boolean;

  // ---------------------------------------------------------------- words (§5)
  /** Cash 7+ words as soon as they exist. */
  minCashLen: number;
  /** Liquidity cash of a 5-6 letter word when balance < poorBelow and > poorMinAuctions remain. */
  poorBelow: number;
  poorMinLen: number;
  poorMinAuctions: number;
  /** Hold a 7+ word when the open letter makes a strictly better partition (gain >= holdGain). */
  holdGain: number;
  /** Scenario word policy (K-13 play-vs-hold): coin bonus on reward and margin. */
  wordPolicy: 'rules' | 'scenario';
  coinBonus: number;
  playMargin: number;
  maxPlays: number;

  // ---------------------------------------------------------------- endgame (§5.4)
  /** Final auction: bid the whole balance when a sim is seated (free denial). */
  finalSimDeny: boolean;
  /** Penultimate auction: all-in. */
  penultimateAllIn: boolean;
  /** Penultimate: pre-play the words of pack(R+L) that do not need L when a rival could outbid us. */
  penultimatePrePlay: boolean;
  /** Flush at the penultimate auction when the round trip is slower than this. */
  preFlushRttMs: number;
  /** Final flush packing limits. */
  flushNodeLimit: number;
  flushTimeMs: number;

  // ---------------------------------------------------------------- first price (§3.6)
  /** Search FirstPrice bids by expected utility; false = bid the Vickrey value. */
  firstPriceShade: boolean;

  // ---------------------------------------------------------------- opponents (§8)
  /** Likelihood exponent of each censored price observation in the per-opponent scale posterior. */
  calibTemper: number;
  /** Prior sd of the per-opponent log-scale (centred on the profile / market prior). */
  calibPriorSd: number;
  /** Scale grid bounds. */
  calibMin: number;
  calibMax: number;
  /** Auctions without a win after which a real seat starts to be treated as dead. */
  deadAfter: number;

  // ---------------------------------------------------------------- timing
  /** Stop refining when less than this many ms of the budget remain. */
  safetyMs: number;
}

export const DEFAULT_PARAMS: Readonly<BawtParams> = Object.freeze({
  profile: 'default',
  mode: 'hyb',
  tableScale: 1,
  mcSamples: 16,
  mcHorizon: 12,
  mcMaxLetters: 16,
  mcMinCover: 0.35,
  mcCoverCap: 0.25,
  mcCoverCapMinReal: 5,
  mcFullBelow: 6,
  mcNodeLimit: 3000,
  mcNodeBudget: 30000,
  packTimeMs: 15,
  maxWinShare: 0.9,
  minWinShare: 0.12,
  kappaLo: 0.6,
  kappaHi: 2.5,
  kappaHiSims: 12,
  reserve: 15,
  incomeShare: 0.35,
  incomeShareSims: 0.8,
  lambdaScale: 1,
  endWindow: 0,
  endKappaLo: 1,
  earlyScale: 1,
  earlyUntil: 0.5,
  rampEnd: 0.75,
  greedMinSeats: 0,
  keyEdge: 0,
  keyMinFace: 4,
  dumpWindow: 0,
  dumpMult: 1,
  paceReserve: 0,
  baitRatio: 2,
  baitHyst: 0.1,
  baitMinWins: 4,
  baitAlpha: 0.3,
  baitShade: 1,
  calmReserve: 15,
  calmIncomeShare: 0.35,
  calmKappaLo: 0.6,
  floorA: 2.5,
  floorB: 3.5,
  vowelCap: 0.4,
  dupCap: 2,
  floorKappaScale: true,
  denyWeights: { '2': 1, '3': 0.4, '4': 0.2 },
  maxOverbid: 4,
  drive: true,
  tieNudgeMinP: 0.05,
  jitter: 1,
  jitterBelow: 6,
  bidNoise: 0.05,
  focalCaps: true,
  sureWinCap: true,
  minCashLen: 7,
  poorBelow: 20,
  poorMinLen: 5,
  poorMinAuctions: 8,
  holdGain: 3,
  wordPolicy: 'rules',
  coinBonus: 0.32,
  playMargin: 2.7,
  maxPlays: 3,
  finalSimDeny: true,
  penultimateAllIn: true,
  penultimatePrePlay: true,
  preFlushRttMs: 400,
  flushNodeLimit: 2_000_000,
  flushTimeMs: 120,
  firstPriceShade: true,
  calibTemper: 0.7,
  calibPriorSd: 0.5,
  calibMin: 0.3,
  calibMax: 3,
  deadAfter: 25,
  safetyMs: 3,
}) as BawtParams;

/** Profile deltas over DEFAULT_PARAMS. */
export const PROFILES: Readonly<Record<ProfileName, Partial<BawtParams>>> = Object.freeze({
  default: {},
  // Sims present (1-3 real seats + sims): the live lobby. Buy cheap letters aggressively.
  lobby: { kappaHi: 3 },
  // 6 real seats: prices clear high, no denial, thrifty floor (§9.1: static bidders starve here).
  fullTable: { reserve: 10, denyWeights: {}, floorB: 3 },
  // >= 7 seats: K-13 found 25-40 per tile; loosen pacing.
  bigTable: { reserve: 8, denyWeights: {}, kappaHi: 3, floorB: 3 },
  // Heads-up: money discipline, full denial when cheap (§6.2, §6.3 final).
  headsUp: { reserve: 25, maxOverbid: 12, denyWeights: { '2': 1 } },
  // FirstPrice: expected-utility shading, no floor-driven overpay.
  firstPrice: { floorA: 2.2, floorB: 2, tieNudgeMinP: 0, jitter: 0 },
});

export interface FieldShape {
  seats: number;
  sims: number;
  real: number; // incl. us
}

export function fieldShape(config: MatchConfig): FieldShape {
  let sims = 0;
  for (const p of config.players) if (p.isSim) sims++;
  const seats = config.players.length;
  return { seats, sims, real: seats - sims };
}

/** Profile for a match: FirstPrice > heads-up > big table > full table > lobby > default. */
export function selectProfile(config: MatchConfig): ProfileName {
  const f = fieldShape(config);
  if (config.auctionType === 'FirstPrice') return 'firstPrice';
  if (f.real <= 2 && f.sims === 0) return 'headsUp';
  if (config.kind === 'final' && f.real === 2) return 'headsUp';
  if (f.seats >= 7 && f.sims === 0) return 'bigTable';
  if (f.sims === 0 && f.real >= 5) return 'fullTable';
  if (f.sims > 0) return 'lobby';
  return 'default';
}

/**
 * Resolve the parameters for a match: DEFAULT_PARAMS < PROFILES[profile] < overrides, where
 * profile = overrides.profile ?? selectProfile(config).
 */
export function resolveParams(config: MatchConfig, overrides: Partial<BawtParams> = {}): BawtParams {
  const profile = overrides.profile ?? selectProfile(config);
  const p: BawtParams = { ...DEFAULT_PARAMS, ...PROFILES[profile], ...overrides, profile };
  return p;
}

/** Validate user-supplied overrides (registry JSON); throws on unknown keys or wrong types. */
export function checkOverrides(opts: Record<string, unknown> | undefined): Partial<BawtParams> {
  if (!opts) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (!(k in DEFAULT_PARAMS)) throw new Error(`bawt: unknown parameter '${k}'`);
    const want = typeof (DEFAULT_PARAMS as unknown as Record<string, unknown>)[k];
    if (typeof v !== want) throw new Error(`bawt: parameter '${k}' must be ${want}, got ${typeof v}`);
    out[k] = v;
  }
  if (out.profile !== undefined && !(String(out.profile) in PROFILES)) {
    throw new Error(`bawt: unknown profile '${String(out.profile)}'`);
  }
  return out as Partial<BawtParams>;
}
