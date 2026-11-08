// Bawt v1: Monte-Carlo, budget-paced, opponent-modelling letter-auction policy (STRATEGY §11 HYB-κ).
//
// Per auction (letter L, rack R, balance B, f = useful future auctions = remainingAfter - 1):
//   remainingAfter == 0  -> exact flush, bid 0 (whole balance when a sim is seated)      endgame.ts
//   remainingAfter == 1  -> all-in (coins are worthless afterwards)                       endgame.ts
//   otherwise:
//     values_ℓ   = MARG(n_proj)[ℓ] × rack factors              (heuristic.ts, quick path, < 5 ms)
//     κ          = clearing-price pacing on the field model     (lambda.ts + opponents.ts)
//     words      = cash 7+ now (Nijello hold), liquidity 5-6    (words.ts)
//     V_mc       = E_F[Pack(R+L+F) - Pack(R+F)], CRN, exact packer, F from the price model (valuation.ts)
//     V̂          = cover·V_mc + (1 - cover)·V_table, cover = min(1, H / (f·share))
//     bid        = clamp(⌊max(V̂·κ, floor) + denial⌋ ± noise/jitter + tie nudge, 0, B)  (bidding.ts)
//     FirstPrice = argmax_b (v - b)·P(win | b)
// Anytime: the table decision is built first; Monte Carlo refines it while
// ctx.now() < start + budgetMs - safetyMs. Determinism: one ctx.rng draw per decide seeds every
// random stream of the decision; packing uses node limits (time limits are safety nets only),
// and the packer is private to the instance, so a decision depends only on (seed, params, events).
import { NUM_LETTERS, VALUE, idx, wordReward } from '../../core/letters.js';
import { rackClone, rackFromWord, rackSub, rackTotal, type Rack } from '../../core/rack.js';
import { Rng, hashSeed } from '../../core/rng.js';
import type {
  AuctionInfo,
  AuctionOutcome,
  DecideContext,
  Decision,
  MatchView,
  Policy,
  PolicyFactory,
  PlayerId,
} from '../../core/types.js';
import { getEngine } from '../../engine/index.js';
import { Packer } from '../../engine/packer.js';
import { makeBid } from './bidding.js';
import { finalDecision, penultimateDecision } from './endgame.js';
import { floorBid, isUseful, probGetU, tableValue, tableVector } from './heuristic.js';
import { solveKappa, type PacingResult } from './lambda.js';
import { denialWeights } from './objective.js';
import { FieldModel, winProb } from './opponents.js';
import { checkOverrides, resolveParams, type BawtMode, type BawtParams } from './params.js';
import { armOverrides, isLearnable } from '../../learn/arms.js';
import {
  acquisitions,
  mcMarginal,
  packOpts,
  rolloutBreakEven,
  sampleScenarios,
  type PackLimits,
  type Scenario,
} from './valuation.js';
import { chooseWordsRules, chooseWordsScenario, type WordChoice } from './words.js';

export * from './params.js';

/** Budget below which decide() only runs the quick (table) path, e.g. the live anchor pass. */
export const QUICK_BUDGET_MS = 25;

export interface BawtDiagnostics {
  decisions: number;
  quickOnly: number;
  mcSamples: number;
  kappaSum: number;
  /** Σ V_mc and Σ V_table over MC decisions (bias check), and their count. */
  mcValueSum: number;
  tableValueSum: number;
  mcDecisions: number;
  reasons: Record<string, number>;
  wordReasons: Record<string, number>;
}

export interface BawtPolicy extends Policy {
  /** Resolved parameters of the current match (undefined before onMatchStart). */
  readonly params: BawtParams | undefined;
  readonly diagnostics: BawtDiagnostics;
  /** Table-only decision (anchor pass); always valid, < 5 ms. */
  decideQuick(view: MatchView, auction: AuctionInfo, ctx: DecideContext): Decision;
}

interface Prep {
  rack: Rack;
  balance: number;
  values: Float64Array;
  floors: Float64Array;
  pacing: PacingResult;
  nProj: number;
  pU: number;
  useful: boolean;
}

const bump = (r: Record<string, number>, k: string) => {
  r[k] = (r[k] ?? 0) + 1;
};

function removeWords(rack: Rack, words: readonly string[]): Rack {
  const r = rackClone(rack);
  for (const w of words) rackSub(r, rackFromWord(w));
  return r;
}

export function createBawt(seed: number, overrides: Partial<BawtParams> = {}, name = 'bawt'): BawtPolicy {
  const engine = getEngine();
  const packer = new Packer(engine.index, { cacheSize: 60_000 });
  let params: BawtParams | undefined;
  let field: FieldModel | undefined;
  let share = 0.3;
  let lastBid = 0;
  // greedybot-bait detector: EWMA of paid / our bid over our Vickrey wins
  let baitEwma = 0;
  let baitWins = 0;
  let baited = false;
  let myId: PlayerId = -1;
  let matchId = -1;
  const preBalances = new Map<PlayerId, number>();
  const diagnostics: BawtDiagnostics = { decisions: 0, quickOnly: 0, mcSamples: 0, kappaSum: 0, mcValueSum: 0, tableValueSum: 0, mcDecisions: 0, reasons: {}, wordReasons: {} };

  const start = (view: MatchView) => {
    params = resolveParams(view.config, overrides);
    field = new FieldModel(view.config, params);
    myId = view.config.myId;
    matchId = view.config.matchId;
    const nReal = view.config.players.filter((p) => !p.isSim).length;
    share = Math.max(params.minWinShare, Math.min(params.maxWinShare, nReal <= 1 ? 0.8 : 1 / nReal));
    lastBid = 0;
    baitEwma = 0;
    baitWins = 0;
    baited = false;
    packer.clearCache();
  };

  /** True when a real rival hoards coins: rich but buying far below a fair share (hoardGuard). */
  const hoardersSeated = (view: MatchView, index: number): boolean => {
    const p = params!;
    const T = view.config.totalAuctions;
    if (index < p.hoardFrom * T) return false;
    const seats = view.config.players.length;
    const fair = index / Math.max(1, seats);
    for (const info of view.config.players) {
      if (info.isSim || info.id === view.config.myId) continue;
      const r = view.players.get(info.id);
      if (r && r.balance >= p.hoardMinBal && r.lettersWon < p.hoardShare * fair) return true;
    }
    return false;
  };

  /** Table values, floors and pacing for a rack/balance. */
  const prepare = (view: MatchView, auction: AuctionInfo, rack: Rack, balance: number): Prep => {
    const p = params!;
    const f = field!;
    const futureUseful = Math.max(0, auction.remainingAfter - 1);
    const unseen = view.unseen;
    const unseenTotal = rackTotal(unseen);
    const nProj = view.config.startingRackSize + view.me.lettersWon + futureUseful * share;
    const pU = probGetU(unseen, unseenTotal, futureUseful * share);
    const values = tableVector(rack, nProj, pU, p.tableScale);
    const floors = new Float64Array(NUM_LETTERS);
    const useFloor = p.mode !== 'k13' && p.floorA > 0;
    if (useFloor) {
      for (let l = 0; l < NUM_LETTERS; l++) {
        if (isUseful(rack, l, p.vowelCap, p.dupCap, pU)) floors[l] = floorBid(l, p.floorA, p.floorB);
      }
    }
    // future phase: middle of the remaining auctions
    const T = view.config.totalAuctions;
    const futIndex = Math.min(T - 3, Math.max(auction.index + 1, Math.floor((auction.index + T) / 2)));
    const counts = new Float64Array(NUM_LETTERS);
    const cdfs: Float64Array[] = [];
    for (let l = 0; l < NUM_LETTERS; l++) {
      counts[l] = unseenTotal > 0 ? (futureUseful * unseen[l]!) / unseenTotal : 0;
      cdfs.push(f.fieldCdf(view, l, Math.max(0, futIndex)));
    }
    const allSims = f.realOpponents === 0;
    // spend-down: inside the last endWindow useful auctions taper the reserve to 0 and raise κ_lo
    const greedy = !baited && view.config.players.length >= p.greedMinSeats;
    const hoarding = p.hoardGuard > 0 && hoardersSeated(view, auction.index);
    const endT = greedy && !hoarding && p.endWindow > 0 ? Math.max(0, Math.min(1, 1 - futureUseful / p.endWindow)) : 0;
    const kappaHi = allSims ? Math.max(p.kappaHi, p.kappaHiSims) : p.kappaHi;
    const kLo = greedy ? p.kappaLo : p.calmKappaLo;
    const pacing = solveKappa({
      values,
      floors,
      counts,
      fieldCdf: cdfs,
      balance,
      reserve: Math.max((greedy ? p.reserve : p.calmReserve) * (1 - endT), p.paceReserve > 0 ? (p.paceReserve * futureUseful) / Math.max(1, T) : 0),
      incomeShare: allSims ? p.incomeShareSims : greedy ? p.incomeShare : p.calmIncomeShare,
      auctionType: view.config.auctionType,
      kappaLo: Math.min(kappaHi, kLo + endT * Math.max(0, p.endKappaLo - kLo)),
      kappaHi,
    });
    if (p.lambdaScale !== 1) pacing.kappa /= p.lambdaScale;
    if (baited && !allSims) pacing.kappa *= p.baitShade;
    if (hoarding && !allSims && auction.index < p.hoardBoostUntil * T) pacing.kappa *= p.hoardBoost;
    if (greedy && !hoarding && p.earlyScale !== 1 && !allSims) {
      const prog = auction.index / Math.max(1, T);
      const ramp = prog <= p.earlyUntil ? 0 : Math.min(1, (prog - p.earlyUntil) / Math.max(1e-6, p.rampEnd - p.earlyUntil));
      pacing.kappa *= p.earlyScale + (1 - p.earlyScale) * ramp;
    }
    const li = idx(auction.letter);
    return {
      rack,
      balance,
      values,
      floors,
      pacing,
      nProj,
      pU,
      useful: li >= 0 && floors[li]! > 0,
    };
  };

  const floorFor = (prep: Prep, li: number): number => {
    const p = params!;
    const fl = prep.floors[li]!;
    if (fl <= 0) return 0;
    return p.floorKappaScale ? Math.floor(fl * Math.min(1, prep.pacing.kappa)) : fl;
  };

  /** Rival denial: best w·V_rival over real rivals (points) and its weight. */
  const denial = (view: MatchView, auction: AuctionInfo, li: number, prep: Prep): { value: number; weight: number } => {
    const p = params!;
    const T = view.config.totalAuctions;
    const ws = denialWeights(view, p.denyWeights, 1 / Math.max(0.05, prep.pacing.kappa), auction.remainingAfter / Math.max(1, T));
    let best = { value: 0, weight: 0 };
    const seats = view.config.players.length;
    for (const { id, weight } of ws) {
      if (weight <= 0.01) continue;
      const r = view.players.get(id);
      if (!r) continue;
      const nProj = view.config.startingRackSize + r.lettersWon + Math.max(0, auction.remainingAfter - 1) / seats;
      const v = tableValue(r.knownHeld, li, nProj, prep.pU, p.tableScale);
      if (weight * v > best.weight * best.value || (best.value === 0 && weight > best.weight)) best = { value: v, weight };
    }
    return best;
  };

  const bidFor = (
    view: MatchView,
    auction: AuctionInfo,
    li: number,
    prep: Prep,
    value: number,
    rng: Rng,
    kappaOverride?: number,
  ): { bid: number; reason: string } => {
    const p = params!;
    const f = field!;
    const G = f.fieldCdf(view, li, auction.index);
    const den = denial(view, auction, li, prep);
    const drive = p.drive && den.weight > 0 && view.config.auctionType === 'Vickrey';
    const Greal = drive ? f.fieldCdf(view, li, auction.index, { only: 'real' }) : undefined;
    const Gsim = drive ? f.fieldCdf(view, li, auction.index, { only: 'sim', minLen: Greal!.length }) : undefined;
    const r = makeBid({
      auctionType: view.config.auctionType,
      value,
      kappa: kappaOverride ?? prep.pacing.kappa,
      floor: floorFor(prep, li),
      rivalValue: den.value,
      denyWeight: den.weight,
      maxOverbid: p.maxOverbid,
      G,
      Greal,
      Gsim,
      balance: prep.balance,
      knownMax: f.knownFieldMax(view, li),
      focalCap: p.focalCaps ? f.focalCap(li) : undefined,
      tieNudgeMinP: p.tieNudgeMinP,
      jitter: p.jitter,
      jitterBelow: p.jitterBelow,
      bidNoise: p.bidNoise,
      sureWinCap: p.sureWinCap,
      rng,
    });
    let bid = r.bid;
    let reason = r.reason;
    const vickrey = view.config.auctionType !== 'FirstPrice';
    if (p.keyEdge > 0 && bid > 0 && prep.useful && reason !== 'sureWin' && vickrey && VALUE[li]! >= p.keyMinFace) {
      bid += Math.round(p.keyEdge);
      reason = `${reason}+key`;
    }
    const usefulLeft = Math.max(0, auction.remainingAfter - 1); // useful auctions after this one
    if (p.dumpWindow > 0 && vickrey && prep.useful && reason !== 'sureWin' && usefulLeft < p.dumpWindow) {
      const dump = Math.floor((p.dumpMult * prep.balance) / (usefulLeft + 1));
      if (dump > bid) {
        bid = dump;
        reason = `${reason}+dump`;
      }
    }
    return { bid: Math.max(0, Math.min(Math.floor(prep.balance), bid)), reason };
  };

  const staticDecision = (view: MatchView, auction: AuctionInfo, li: number): Decision => {
    const p = params!;
    const lim: PackLimits = { nodeLimit: p.mcNodeLimit, timeLimitMs: p.packTimeMs, minLen: p.minCashLen };
    const words = packer.packExact(view.me.rack, packOpts(lim)).words;
    const reward = words.reduce((s, w) => s + wordReward(w), 0);
    const bal = Math.max(0, Math.floor(view.me.balance + reward));
    return { words, bid: Math.max(0, Math.min(bal, Math.floor(2.5 * VALUE[li]! + 4))) };
  };

  const decideImpl = (view: MatchView, auction: AuctionInfo, ctx: DecideContext, quickOnly: boolean): Decision => {
    if (!params || view.config.myId !== myId || view.config.matchId !== matchId) start(view);
    const p = params!;
    const f = field!;
    const t0 = ctx.now();
    const deadline = t0 + ctx.budgetMs - p.safetyMs;
    const timeUp = () => ctx.now() >= deadline;
    diagnostics.decisions++;
    preBalances.clear();
    for (const o of view.opponents) preBalances.set(o.info.id, o.balance);
    const li = idx(auction.letter);
    if (li < 0) return { words: [], bid: 0 };
    const flushLim: PackLimits = {
      nodeLimit: p.flushNodeLimit,
      timeLimitMs: p.flushTimeMs,
      deadlineAt: deadline,
      now: () => ctx.now(),
    };

    if (auction.remainingAfter === 0) {
      if (p.mode === 'static') {
        const d = { words: packer.packExact(view.me.rack, packOpts(flushLim)).words, bid: 0 };
        lastBid = 0;
        return d;
      }
      const d = finalDecision(view, packer, flushLim, p.finalSimDeny);
      bump(diagnostics.reasons, 'final');
      lastBid = d.bid;
      return d;
    }
    if (p.mode === 'static') {
      const d = staticDecision(view, auction, li);
      lastBid = d.bid;
      return d;
    }

    const entropy = ctx.rng.nextU32();
    const noiseRng = new Rng(hashSeed(seed, entropy, 'noise'));
    const mcRng = new Rng(hashSeed(seed, entropy, 'mc'));

    if (auction.remainingAfter === 1) {
      const prep = prepare(view, auction, view.me.rack, view.me.balance);
      const quick = bidFor(view, auction, li, prep, prep.values[li]!, noiseRng).bid;
      const d = penultimateDecision(view, li, packer, flushLim, {
        allIn: p.penultimateAllIn,
        prePlay: p.penultimatePrePlay,
        preFlushRttMs: p.preFlushRttMs,
        netRttMs: ctx.netRttMs,
        fallbackBid: quick,
      });
      bump(diagnostics.reasons, 'penultimate');
      lastBid = d.bid;
      return d;
    }

    // ---- quick path
    const rack0 = view.me.rack;
    const prep0 = prepare(view, auction, rack0, view.me.balance);
    share = Math.max(p.minWinShare, Math.min(p.maxWinShare, prep0.pacing.share));
    const G0 = f.fieldCdf(view, li, auction.index);
    const quickBid0 = Math.max(Math.floor(prep0.values[li]! * prep0.pacing.kappa), floorFor(prep0, li));
    const pWinOpen = winProb(G0, Math.min(Math.floor(prep0.balance), quickBid0));
    const lim: PackLimits = { nodeLimit: p.mcNodeLimit, timeLimitMs: p.packTimeMs, deadlineAt: deadline, now: () => ctx.now() };
    const wordIn = {
      packer,
      index: engine.index,
      rack: rack0,
      li,
      pWinOpen,
      balance: view.me.balance,
      remainingAfter: auction.remainingAfter,
      minCashLen: p.minCashLen,
      holdGain: p.holdGain,
      poorBelow: p.poorBelow,
      poorMinLen: p.poorMinLen,
      poorMinAuctions: p.poorMinAuctions,
      lim,
    };
    let wc: WordChoice = chooseWordsRules(wordIn);

    const runMc = !quickOnly && p.mode !== 'quick' && ctx.budgetMs >= QUICK_BUDGET_MS && !timeUp();
    const futureUseful = Math.max(0, auction.remainingAfter - 1);
    let scenarios: Scenario[] = [];
    if (runMc && futureUseful >= 0) {
      const S = p.mode === 'rollout' ? Math.min(p.mcSamples, 8) : p.mcSamples;
      scenarios = sampleScenarios(view.unseen, futureUseful, S, mcRng);
      if (p.wordPolicy === 'scenario') {
        const H0 = Math.max(0, Math.min(p.mcHorizon, p.mcMaxLetters - rackTotal(rack0) - 1));
        const futures0 = scenarios.map((sc) => acquisitions(sc, prep0.pacing.pWin, H0));
        wc = chooseWordsScenario({
          ...wordIn,
          futures: futures0,
          lambda: 1 / Math.max(0.05, prep0.pacing.kappa),
          coinBonus: p.coinBonus,
          playMargin: p.playMargin,
          maxPlays: p.maxPlays,
        });
      }
    }
    bump(diagnostics.wordReasons, wc.reason);
    const words = wc.words;
    const rack = words.length ? removeWords(rack0, words) : rack0;
    const balance = view.me.balance + wc.reward;
    const prep = words.length ? prepare(view, auction, rack, balance) : { ...prep0 };
    const vTable = prep.values[li]!;

    if (!runMc) {
      diagnostics.quickOnly++;
      const b = bidFor(view, auction, li, prep, vTable, noiseRng);
      bump(diagnostics.reasons, `quick:${b.reason}`);
      diagnostics.kappaSum += prep.pacing.kappa;
      lastBid = b.bid;
      return { words, bid: b.bid };
    }

    // ---- Monte Carlo refinement
    const expectedWins = futureUseful * share;
    const sizeCap = Math.max(0, p.mcMaxLetters - rackTotal(rack) - 1);
    let H = Math.min(p.mcHorizon, sizeCap);
    if (p.mode === 'k13') H = Math.min(13, sizeCap, Math.ceil(1.07 * expectedWins));
    const futures = scenarios.map((sc) => acquisitions(sc, prep.pacing.pWin, H));
    let value = vTable;
    let kappaOverride: number | undefined;
    if (p.mode === 'rollout') {
      const T = view.config.totalAuctions;
      const futIndex = Math.min(T - 3, Math.max(auction.index + 1, Math.floor((auction.index + T) / 2)));
      const cdfs: Float64Array[] = [];
      for (let l = 0; l < NUM_LETTERS; l++) cdfs.push(f.fieldCdf(view, l, futIndex));
      const bidOf = new Float64Array(NUM_LETTERS);
      for (let l = 0; l < NUM_LETTERS; l++) bidOf[l] = Math.max(prep.values[l]! * prep.pacing.kappa, prep.floors[l]!);
      const be = rolloutBreakEven({
        packer,
        rack,
        li,
        balance,
        scenarios,
        bidOf,
        fieldCdf: cdfs,
        H,
        lim,
        deadline: timeUp,
      });
      diagnostics.mcSamples += be.samples;
      // bid the break-even price directly: value in coins with κ = 1
      value = Math.max(0, be.price);
      kappaOverride = 1;
    } else if (p.mode !== 'k13' && expectedWins > 0 && H / expectedWins < p.mcMinCover) {
      bump(diagnostics.reasons, 'mcSkipped');
    } else {
      const mc = mcMarginal(packer, rack, li, futures, lim, timeUp, 4, p.mcNodeBudget);
      diagnostics.mcSamples += mc.samples;
      if (mc.samples > 0) {
        diagnostics.mcValueSum += mc.value;
        diagnostics.tableValueSum += vTable;
        diagnostics.mcDecisions++;
        if (p.mode === 'k13') value = mc.value;
        else {
          const realSeats = view.config.players.filter((x) => !x.isSim).length;
          const capped = expectedWins <= p.mcFullBelow || realSeats < p.mcCoverCapMinReal ? 1 : p.mcCoverCap;
          const cover = expectedWins <= 0 ? 1 : Math.min(capped, H / expectedWins);
          value = cover * mc.value + (1 - cover) * vTable;
        }
      }
    }
    const b = bidFor(view, auction, li, prep, value, noiseRng, kappaOverride);
    bump(diagnostics.reasons, b.reason);
    diagnostics.kappaSum += prep.pacing.kappa;
    lastBid = b.bid;
    return { words, bid: b.bid };
  };

  const policy: BawtPolicy = {
    name,
    get params() {
      return params;
    },
    diagnostics,
    onMatchStart(view) {
      start(view);
    },
    decide(view, auction, ctx) {
      return decideImpl(view, auction, ctx, false);
    },
    decideQuick(view, auction, ctx) {
      return decideImpl(view, auction, ctx, true);
    },
    onAuctionClosed(view, outcome: AuctionOutcome) {
      field?.observe(outcome, preBalances, lastBid, myId);
      const p = params;
      if (p && view.config.auctionType !== 'FirstPrice' && outcome.winnerId === myId && lastBid > 0) {
        const r = Math.min(1, outcome.paid / lastBid);
        baitEwma = baitWins === 0 ? r : (1 - p.baitAlpha) * baitEwma + p.baitAlpha * r;
        baitWins++;
        if (!baited && baitWins >= p.baitMinWins && baitEwma >= p.baitRatio) baited = true;
        else if (baited && baitEwma < p.baitRatio - p.baitHyst) baited = false;
      }
    },
  };
  return policy;
}

const withMode =
  (mode: BawtMode, name: string, extra: Partial<BawtParams> = {}): PolicyFactory =>
  (seed, opts) =>
    createBawt(seed, { mode, ...extra, ...checkOverrides(opts) }, name);

/**
 * A learning arm (src/learn/arms.ts vocabulary, e.g. {"tableScale":1.1,"denyScale":0.9}) played
 * exactly as the live learning wrapper plays it: clamped to the LEARNABLE ranges and resolved per
 * match config (denyScale scales the resolved profile's denyWeights). Used by the learn-cycle gate.
 */
const armFactory: PolicyFactory = (seed, opts) => {
  const params = opts ?? {};
  for (const k of Object.keys(params)) if (!isLearnable(k)) throw new Error(`bawt-arm: '${k}' is not a learnable knob`);
  let inner: Policy | undefined;
  return {
    name: 'bawt-arm',
    onMatchStart(view) {
      inner = createBawt(seed, { mode: 'hyb', ...armOverrides(params, view.config) }, 'bawt-arm');
      inner.onMatchStart(view);
    },
    decide(view, auction, ctx) {
      if (!inner) this.onMatchStart(view);
      return inner!.decide(view, auction, ctx);
    },
    onAuctionClosed(view, outcome) {
      inner?.onAuctionClosed?.(view, outcome);
    },
    onMatchEnd(view) {
      inner?.onMatchEnd?.(view);
    },
  };
};

export const policies: Record<string, PolicyFactory> = {
  bawt: withMode('hyb', 'bawt'),
  'bawt-arm': armFactory,
  'bawt-quick': withMode('quick', 'bawt-quick'),
  'bawt-rollout': withMode('rollout', 'bawt-rollout'),
  'bawt-static': withMode('static', 'bawt-static'),
  'bawt-k13': withMode('k13', 'bawt-k13'),
  'bawt-default': withMode('hyb', 'bawt-default', { profile: 'default' }),
  'bawt-lobby': withMode('hyb', 'bawt-lobby', { profile: 'lobby' }),
  'bawt-fullTable': withMode('hyb', 'bawt-fullTable', { profile: 'fullTable' }),
  'bawt-bigTable': withMode('hyb', 'bawt-bigTable', { profile: 'bigTable' }),
  'bawt-headsUp': withMode('hyb', 'bawt-headsUp', { profile: 'headsUp' }),
  'bawt-firstPrice': withMode('hyb', 'bawt-firstPrice', { profile: 'firstPrice' }),
};
