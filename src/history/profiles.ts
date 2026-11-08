// Opponent profiles and market priors extracted from history -> data/profiles.json (schema v1).
// Seeds our bot's priors (Phase 3) and the clone bots of the opponent zoo.
//
// Selection: every bot with >= MIN_MATCHES complete matches on its CURRENT version (bot_version;
// bots without version rows are on v1), plus the tournament finalists regardless (TileShark,
// SookraBot, BuySpellRepeat-bot, K-13, Waupus). Sims qualify like any other bot.
// Bid models (KM curves, regression, caps) use the bot's last <= MODEL_MATCHES current-version
// matches; every other statistic uses all current-version complete matches.
//
// PHASES ARE DISJOINT (T = total auctions, k = 0-based auction index):
//   final       k == T-1
//   penultimate k == T-2
//   late        2T/3 <= k < T-2
//   mid         T/3  <= k < 2T/3
//   early       k < T/3
// NOTE: this differs from HISTORICAL.md, whose `late` (k >= 2T/3) overlaps its `last5` bucket.
//
// Bid curves: reverse Kaplan-Meier (src/history/km.ts, HISTORICAL.md §E2): a win is an exact
// observation of the bid (archived top bid); a loss is left-censored at the winner's top bid (0 when
// nobody bid). pGe[x-1] = P(bid >= x) for x = 1..60. Mass below ~3-5 is not identified.
import { IS_VOWEL, LETTERS, NUM_LETTERS, STARTING_BALANCE, VALUE, idx } from '../core/letters.js';
import type { PlayerId, SimStrategy } from '../core/types.js';
import { KmAccumulator, type KmCurve } from './km.js';
import { canonicalSchedule, currentVersion, currentVersionStart, rankOf, revealStartTiles } from './load.js';
import { mean, ols, quantiles, rnd } from './stats.js';
import type { HistBot, HistDataset, HistMatch, HistWord } from './types.js';

export const PROFILE_SCHEMA_VERSION = 1 as const;
export const BID_X_MAX = 60;
export const MIN_MATCHES = 150;
export const MODEL_MATCHES = 3000;
export const RECENT_MATCHES = 4000;
export const FINALISTS: readonly string[] = ['TileShark', 'SookraBot', 'BuySpellRepeat-bot', 'K-13', 'Waupus'];

export type LetterGroup = 'vowel' | 'LNSTR' | 'DG' | 'BCMP' | 'FHVWY' | 'K' | 'JX' | 'QZ';
export const LETTER_GROUPS: Readonly<Record<LetterGroup, string>> = {
  vowel: 'AEIOU',
  LNSTR: 'LNSTR',
  DG: 'DG',
  BCMP: 'BCMP',
  FHVWY: 'FHVWY',
  K: 'K',
  JX: 'JX',
  QZ: 'QZ',
};
export const GROUPS = Object.keys(LETTER_GROUPS) as LetterGroup[];

export type Phase = 'early' | 'mid' | 'late' | 'penultimate' | 'final';
export const PHASES: readonly Phase[] = ['early', 'mid', 'late', 'penultimate', 'final'];

export const REGRESSION_FEATURES = [
  'intercept',
  'value',
  'vowel',
  'phase',
  'last5',
  'balance100',
  'nRealOpp',
  'heldSame',
  'heldTotal',
] as const;
export type RegressionFeature = (typeof REGRESSION_FEATURES)[number];

const GROUP_OF: LetterGroup[] = (() => {
  const g: LetterGroup[] = new Array(NUM_LETTERS);
  for (const name of GROUPS) for (const c of LETTER_GROUPS[name]) g[idx(c)] = name;
  return g;
})();

export function groupOf(letter: string): LetterGroup {
  const g = GROUP_OF[idx(letter)];
  if (!g) throw new Error(`groupOf: invalid letter '${letter}'`);
  return g;
}

/** Disjoint phase of auction k (0-based) in a match of T auctions (see file header). */
export function phaseOf(k: number, T: number): Phase {
  if (k === T - 1) return 'final';
  if (k === T - 2) return 'penultimate';
  if (3 * k >= 2 * T) return 'late';
  if (3 * k >= T) return 'mid';
  return 'early';
}

// ---------------------------------------------------------------------------------------------
// Schema v1
// ---------------------------------------------------------------------------------------------

/** A KM curve rounded to 3 decimals. */
export type BidCurve = KmCurve;

export interface LetterCap {
  letter: string;
  /** Wins used (model window, excluding the penultimate and final auctions). */
  wins: number;
  maxTop: number;
  /** Most frequent winning top bid and its share of wins. */
  mode: number;
  modeShare: number;
  /** Detected cap: modal point mass c >= 5 (share >= 0.15, <= 15% above, sharp drop-off above c); else null. */
  cap: number | null;
  /** P(top > cap) (0 when cap is null). */
  aboveCapShare: number;
}

export interface ResultCell {
  n: number;
  avgScore: number | null;
  winRate: number | null;
  avgRank: number | null;
}

export interface BotProfile {
  id: PlayerId;
  name: string;
  isSim: boolean;
  simStrategy?: SimStrategy;
  version: number;
  versionStartUs: number;
  finalist: boolean;
  /** Complete matches on the current version. */
  matches: number;
  /** Matches used by the bid models (last <= 3000). */
  modelMatches: number;
  firstMatchUs: number;
  lastMatchUs: number;
  /** bidCurves[group][phase]. */
  bidCurves: Record<LetterGroup, Record<Phase, BidCurve>>;
  /** All phases pooled. */
  bidCurvesAllPhases: Record<LetterGroup, BidCurve>;
  /** OLS of the archived top bid on wins (HISTORICAL.md §E1); null coefficient = dropped feature. */
  regression: {
    n: number;
    r2: number | null;
    rmse: number | null;
    coef: Record<RegressionFeature, number | null>;
  };
  caps: LetterCap[];
  penultimate: {
    auctions: number;
    wins: number;
    /** Wins whose top bid equalled the public balance (at open or right before payment). */
    allInWins: number;
    allInRateOfWins: number | null;
    allInRateOfAuctions: number | null;
    topP50: number | null;
    paidP50: number | null;
  };
  /** kmPBidGe1: KM P(bid >= 1) on the final auction, all letters pooled (low end: weakly identified). */
  final: { auctions: number; wins: number; winRate: number | null; kmPBidGe1: number | null };
  buying: {
    lettersWonPerMatch: number | null;
    avgPaid: number | null;
    avgTopWhenWinning: number | null;
    /** Share of wins with top == paid >= 2 (a tie broken at random). */
    tieShareOfWins: number | null;
    spendPerMatch: number | null;
  };
  words: {
    perMatch: number | null;
    avgLen: number | null;
    /** Share of words with length 2,3,4,5,6,7,8+ (index 0 = length 2). */
    lenDist: number[];
    avgReward: number | null;
    pts7PlusShare: number | null;
    sevenPlusPerMatch: number | null;
  };
  timing: {
    /** Share of words per tenth of the match (auctionIndex / T at play time). */
    tenths: number[];
    /** T - auctionIndex of the match's last word (1 = played during the final auction). */
    lastWordAuctionsLeft: { p10: number | null; p50: number | null; p90: number | null };
    lastWordMsBeforeFinalClose: { p10: number | null; p50: number | null; p90: number | null };
  };
  unplayedAtEnd: { mean: number | null; p50: number | null; p90: number | null };
  finalBalance: { mean: number | null; p50: number | null };
  results: { all: ResultCell; byRealOpponents: Record<string, ResultCell> };
}

export interface LetterPrice {
  /** Auctions with a winner. */
  n: number;
  /** Share of auctions without any bid. */
  noBid: number | null;
  /** Paid quantiles p10, p25, p50, p75, p90. */
  paid: Array<number | null>;
  paidMean: number | null;
  /** Top bid quantiles p50, p90. */
  top: Array<number | null>;
  topMean: number | null;
}

export interface IndexPoint {
  k: number;
  n: number;
  /** Mean paid over all auctions (no-bid = 0). */
  meanPaid: number | null;
  meanTop: number | null;
  noBid: number | null;
  /** Share of won auctions won by a real (non-sim) bot. */
  realWinnerShare: number | null;
}

export interface MarketPriors {
  /** priceByPhase[window][phase][letter | 'ALL']. Windows: all, recent (last 4,000 complete). */
  priceByPhase: Record<'all' | 'recent', Record<Phase, Record<string, LetterPrice>>>;
  /** priceByRealBots[nReal][letter | 'ALL'] over all complete matches. */
  priceByRealBots: Record<string, Record<string, LetterPrice>>;
  /** Auction-index curve for 68-auction (6-player) matches. */
  indexCurve68: Record<'all' | 'recent' | 'real6', IndexPoint[]>;
}

export interface ProfilesFile {
  schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  generatedFrom: {
    source: string;
    matches: number;
    completeMatches: number;
    excludedIncomplete: number;
    matchIdRange: [number, number];
    startedRange: [string, string];
    recentWindowIdRange: [number, number];
  };
  definitions: {
    phases: string;
    letterGroups: Record<LetterGroup, string>;
    bidCurveX: string;
    selection: string;
    regressionFeatures: readonly string[];
  };
  bots: BotProfile[];
  market: MarketPriors;
}

// ---------------------------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------------------------

export interface ProfileOptions {
  minMatches?: number;
  modelMatches?: number;
  finalists?: readonly string[];
  recentMatches?: number;
  source?: string;
  /** Only bots that played in the last N complete matches qualify (live-field fits); 0/undefined = no filter. */
  activeWindow?: number;
}

const LEN_BUCKETS = 7; // 2,3,4,5,6,7,8+

class BotAcc {
  readonly km = new Map<string, KmAccumulator>();
  readonly kmAll = new Map<LetterGroup, KmAccumulator>();
  /** Final auction, all letters pooled. */
  readonly kmFinal = new KmAccumulator();
  readonly regX: number[][] = [];
  readonly regY: number[] = [];
  readonly regNReal: number[] = [];
  readonly capTops: number[][] = Array.from({ length: NUM_LETTERS }, () => []);
  pen = { auctions: 0, wins: 0, allIn: 0, tops: [] as number[], paids: [] as number[] };
  fin = { auctions: 0, wins: 0 };
  matches = 0;
  firstUs = Infinity;
  lastUs = -Infinity;
  lettersWon = 0;
  paidSum = 0;
  topSum = 0;
  ties = 0;
  spend: number[] = [];
  words = 0;
  lenHist = new Array<number>(LEN_BUCKETS).fill(0);
  lenSum = 0;
  rewardSum = 0;
  pts7 = 0;
  n7 = 0;
  tenths = new Array<number>(10).fill(0);
  lastLeft: number[] = [];
  lastMs: number[] = [];
  unplayed: number[] = [];
  finalBal: number[] = [];
  res = new Map<string, { n: number; score: number; wins: number; rank: number }>();
  resAll = { n: 0, score: 0, wins: 0, rank: 0 };

  constructor(readonly bot: HistBot, readonly modelSet: Set<number>) {
    for (const g of GROUPS) {
      this.kmAll.set(g, new KmAccumulator());
      for (const p of PHASES) this.km.set(`${g}/${p}`, new KmAccumulator());
    }
  }
}

class PriceAcc {
  paid: number[] = [];
  top: number[] = [];
  noBid = 0;
  total = 0;
  add(paid: number, top: number, winner: boolean): void {
    this.total++;
    if (!winner) {
      this.noBid++;
      return;
    }
    this.paid.push(paid);
    this.top.push(top);
  }
  out(): LetterPrice {
    const pq = quantiles(this.paid, [0.1, 0.25, 0.5, 0.75, 0.9]).map((x) => rnd(x, 1));
    const tq = quantiles(this.top, [0.5, 0.9]).map((x) => rnd(x, 1));
    return {
      n: this.paid.length,
      noBid: this.total ? rnd(this.noBid / this.total, 4) : null,
      paid: pq,
      paidMean: rnd(mean(this.paid), 2),
      top: tq,
      topMean: rnd(mean(this.top), 2),
    };
  }
}

class IndexAcc {
  n: number[] = [];
  paid: number[] = [];
  top: number[] = [];
  nobid: number[] = [];
  won: number[] = [];
  realWon: number[] = [];
  add(k: number, paid: number, top: number, winner: boolean, realWinner: boolean): void {
    this.n[k] = (this.n[k] ?? 0) + 1;
    this.paid[k] = (this.paid[k] ?? 0) + paid;
    this.top[k] = (this.top[k] ?? 0) + top;
    if (!winner) this.nobid[k] = (this.nobid[k] ?? 0) + 1;
    else {
      this.won[k] = (this.won[k] ?? 0) + 1;
      if (realWinner) this.realWon[k] = (this.realWon[k] ?? 0) + 1;
    }
  }
  out(): IndexPoint[] {
    const pts: IndexPoint[] = [];
    for (let k = 0; k < this.n.length; k++) {
      const n = this.n[k] ?? 0;
      const won = this.won[k] ?? 0;
      pts.push({
        k,
        n,
        meanPaid: n ? rnd((this.paid[k] ?? 0) / n, 2) : null,
        meanTop: n ? rnd((this.top[k] ?? 0) / n, 2) : null,
        noBid: n ? rnd((this.nobid[k] ?? 0) / n, 4) : null,
        realWinnerShare: won ? rnd((this.realWon[k] ?? 0) / won, 4) : null,
      });
    }
    return pts;
  }
}

function q3(xs: number[], qs: number[]): Array<number | null> {
  return quantiles(xs, qs).map((x) => rnd(x, 1));
}

function roundCurve(c: KmCurve): BidCurve {
  return { ...c, pNoBid: rnd(c.pNoBid, 3)!, pGe: c.pGe.map((p) => rnd(p, 3)!) };
}

function detectCap(letter: string, tops: number[]): LetterCap {
  const counts = new Map<number, number>();
  let maxTop = 0;
  for (const t of tops) {
    counts.set(t, (counts.get(t) ?? 0) + 1);
    if (t > maxTop) maxTop = t;
  }
  let mode = 0;
  let modeN = 0;
  for (const [v, n] of counts) if (n > modeN || (n === modeN && v > mode)) (mode = v), (modeN = n);
  const n = tops.length;
  let cap: number | null = null;
  let above = 0;
  // Point-mass cap: the mode c >= 5 holds >= 15% of wins, at most 15% of wins lie above it, and the
  // density drops sharply right above it (share(c) >= 10 x mean share of c+1..c+3).
  // Bron's J/X/Q/Z bids: ~33-52% exactly at 30, ~5-12% above (late-game escalation).
  if (n > 0 && mode >= 5 && modeN / n >= 0.15) {
    let gt = 0;
    for (const t of tops) if (t > mode) gt++;
    const next = ((counts.get(mode + 1) ?? 0) + (counts.get(mode + 2) ?? 0) + (counts.get(mode + 3) ?? 0)) / 3;
    if (gt / n <= 0.15 && modeN >= 10 * next) {
      cap = mode;
      above = gt / n;
    }
  }
  return {
    letter,
    wins: n,
    maxTop,
    mode,
    modeShare: n ? rnd(modeN / n, 3)! : 0,
    cap,
    aboveCapShare: rnd(above, 4)!,
  };
}

/** Build profiles.json content from a loaded dataset (pure, deterministic). */
/** Bot ids seen in the last `window` complete matches (undefined when no window is set). */
export function activeBots(complete: readonly HistMatch[], window?: number): Set<PlayerId> | undefined {
  if (!window || window <= 0) return undefined;
  const s = new Set<PlayerId>();
  for (const m of complete.slice(-window)) for (const p of m.participants) s.add(p.botId);
  return s;
}

export function buildProfiles(D: HistDataset, opts: ProfileOptions = {}): ProfilesFile {
  const minMatches = opts.minMatches ?? MIN_MATCHES;
  const modelMatches = opts.modelMatches ?? MODEL_MATCHES;
  const finalists = new Set((opts.finalists ?? FINALISTS).map((s) => s.toLowerCase()));
  const complete = D.matches.filter((m) => m.complete);
  if (complete.length === 0) throw new Error('buildProfiles: no complete matches');

  // ---- selection: current-version complete matches per bot
  const eligible = new Map<PlayerId, number[]>(); // match ids (ascending)
  for (const m of complete) {
    for (const p of m.participants) {
      const b = D.bots.get(p.botId);
      if (!b || b.missing) continue;
      if ((m.startedAtUs ?? m.createdAtUs) < currentVersionStart(D.versions, p.botId)) continue;
      let arr = eligible.get(p.botId);
      if (!arr) eligible.set(p.botId, (arr = []));
      arr.push(m.id);
    }
  }
  const active = activeBots(complete, opts.activeWindow);
  const accs = new Map<PlayerId, BotAcc>();
  for (const [id, ids] of eligible) {
    const b = D.bots.get(id)!;
    if (active && !active.has(id)) continue;
    if (ids.length >= minMatches || finalists.has(b.name.toLowerCase())) {
      accs.set(id, new BotAcc(b, new Set(ids.slice(-modelMatches))));
    }
  }
  const eligibleSets = new Map<PlayerId, Set<number>>();
  for (const id of accs.keys()) eligibleSets.set(id, new Set(eligible.get(id)!));

  // ---- market accumulators
  const recentIds = new Set(complete.slice(-(opts.recentMatches ?? RECENT_MATCHES)).map((m) => m.id));
  const keyLetters = [...LETTERS, 'ALL'];
  const mkPhaseTable = () => {
    const t = new Map<string, PriceAcc>();
    for (const p of PHASES) for (const l of keyLetters) t.set(`${p}/${l}`, new PriceAcc());
    return t;
  };
  const priceAll = mkPhaseTable();
  const priceRecent = mkPhaseTable();
  const priceReal = new Map<string, PriceAcc>();
  const idxAll = new IndexAcc();
  const idxRecent = new IndexAcc();
  const idxReal6 = new IndexAcc();

  for (const m of complete) {
    marketPass(m, D, recentIds.has(m.id), priceAll, priceRecent, priceReal, idxAll, idxRecent, idxReal6);
    const tracked: BotAcc[] = [];
    for (const p of m.participants) {
      const a = accs.get(p.botId);
      if (a && eligibleSets.get(p.botId)!.has(m.id)) tracked.push(a);
    }
    if (tracked.length > 0) botPass(m, D, tracked);
  }

  const bots = [...accs.values()]
    .map((a) => finishBot(a, D, finalists))
    .sort((x, y) => y.matches - x.matches || x.id - y.id);

  const priceOut = (t: Map<string, PriceAcc>) => {
    const o = {} as Record<Phase, Record<string, LetterPrice>>;
    for (const p of PHASES) {
      o[p] = {};
      for (const l of keyLetters) o[p][l] = t.get(`${p}/${l}`)!.out();
    }
    return o;
  };
  const realOut: Record<string, Record<string, LetterPrice>> = {};
  for (const key of [...priceReal.keys()].sort()) {
    const [nReal, l] = key.split('/') as [string, string];
    (realOut[nReal] ??= {})[l] = priceReal.get(key)!.out();
  }

  const started = complete.map((m) => m.startedAtUs ?? m.createdAtUs);
  const recentList = complete.filter((m) => recentIds.has(m.id));
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    generatedFrom: {
      source: opts.source ?? 'maincloud scrabblebot public tables (HTTP SQL dump)',
      matches: D.matches.length,
      completeMatches: complete.length,
      excludedIncomplete: D.matches.length - complete.length,
      matchIdRange: [complete[0]!.id, complete[complete.length - 1]!.id],
      startedRange: [
        new Date(Math.min(...started) / 1000).toISOString(),
        new Date(Math.max(...started) / 1000).toISOString(),
      ],
      recentWindowIdRange: [recentList[0]!.id, recentList[recentList.length - 1]!.id],
    },
    definitions: {
      phases:
        'disjoint, T = total auctions, k = 0-based index: final k=T-1; penultimate k=T-2; late 2T/3<=k<T-2; mid T/3<=k<2T/3; early k<T/3 (HISTORICAL.md late/last5 overlap differently)',
      letterGroups: { ...LETTER_GROUPS },
      bidCurveX: `pGe[x-1] = P(bid >= x), x = 1..${BID_X_MAX}; reverse Kaplan-Meier (wins exact, losses left-censored at the winner's top bid)`,
      selection: `bots with >= ${minMatches} complete matches on their current version, plus finalists ${[...(opts.finalists ?? FINALISTS)].join(', ')}; bid models use the last <= ${modelMatches} current-version matches`,
      regressionFeatures: REGRESSION_FEATURES,
    },
    bots,
    market: {
      priceByPhase: { all: priceOut(priceAll), recent: priceOut(priceRecent) },
      priceByRealBots: realOut,
      indexCurve68: { all: idxAll.out(), recent: idxRecent.out(), real6: idxReal6.out() },
    },
  };
}

function marketPass(
  m: HistMatch,
  D: HistDataset,
  recent: boolean,
  priceAll: Map<string, PriceAcc>,
  priceRecent: Map<string, PriceAcc>,
  priceReal: Map<string, PriceAcc>,
  idxAll: IndexAcc,
  idxRecent: IndexAcc,
  idxReal6: IndexAcc,
): void {
  const T = m.auctions.length;
  for (const a of m.auctions) {
    const ph = phaseOf(a.index, T);
    const top = a.topBid ?? 0;
    const winner = a.winnerId !== null;
    for (const l of [a.letter, 'ALL']) {
      priceAll.get(`${ph}/${l}`)!.add(a.paid, top, winner);
      if (recent) priceRecent.get(`${ph}/${l}`)!.add(a.paid, top, winner);
      const key = `${m.nReal}/${l}`;
      let acc = priceReal.get(key);
      if (!acc) priceReal.set(key, (acc = new PriceAcc()));
      acc.add(a.paid, top, winner);
    }
    if (T === 68) {
      const realW = winner && !(D.bots.get(a.winnerId!)?.isSim ?? false);
      idxAll.add(a.index, a.paid, top, winner, realW);
      if (recent) idxRecent.add(a.index, a.paid, top, winner, realW);
      if (m.nReal === 6) idxReal6.add(a.index, a.paid, top, winner, realW);
    }
  }
}

function botPass(m: HistMatch, D: HistDataset, tracked: BotAcc[]): void {
  const T = m.auctions.length;
  const { revealed } = revealStartTiles(m);
  const held = new Map<PlayerId, Int16Array>();
  const balance = new Map<PlayerId, number>();
  const tilesPlayed = new Map<PlayerId, number>();
  const won = new Map<PlayerId, number>();
  const paid = new Map<PlayerId, number>();
  for (const p of m.participants) {
    held.set(p.botId, Int16Array.from(revealed.get(p.botId)!));
    balance.set(p.botId, STARTING_BALANCE);
    tilesPlayed.set(p.botId, 0);
    won.set(p.botId, 0);
    paid.set(p.botId, 0);
  }
  const byId = new Map(tracked.map((a) => [a.bot.id, a]));
  const inModel = new Map(tracked.map((a) => [a.bot.id, a.modelSet.has(m.id)]));
  const nRealOpp = (id: PlayerId) => m.nReal - (D.bots.get(id)?.isSim ? 0 : 1);
  const play = (w: HistWord) => {
    balance.set(w.botId, (balance.get(w.botId) ?? 0) + w.reward);
    tilesPlayed.set(w.botId, (tilesPlayed.get(w.botId) ?? 0) + w.word.length);
    const h = held.get(w.botId);
    if (h) {
      for (let k = 0; k < w.word.length; k++) {
        const i = w.word.charCodeAt(k) - 65;
        if (i >= 0 && i < NUM_LETTERS && h[i]! > 0) h[i]!--;
      }
    }
  };
  const sched = canonicalSchedule(m);
  for (const step of sched.steps) {
    const a = step.auction;
    const k = a.index;
    const li = idx(a.letter);
    const top = a.topBid ?? 0;
    const ph = phaseOf(k, T);
    const grp = GROUP_OF[li]!;
    const balOpen = new Map<PlayerId, number>();
    for (const acc of tracked) {
      const id = acc.bot.id;
      const isWin = a.winnerId === id;
      const bal = balance.get(id)!;
      balOpen.set(id, bal);
      if (inModel.get(id)) {
        acc.km.get(`${grp}/${ph}`)!.add(top, isWin);
        acc.kmAll.get(grp)!.add(top, isWin);
        if (ph === 'final') acc.kmFinal.add(top, isWin);
        if (isWin) {
          const h = held.get(id)!;
          let ht = 0;
          for (let i = 0; i < NUM_LETTERS; i++) ht += h[i]!;
          acc.regX.push([
            1,
            VALUE[li]!,
            IS_VOWEL[li] ? 1 : 0,
            T > 1 ? k / (T - 1) : 0,
            k >= T - 5 ? 1 : 0,
            bal / 100,
            nRealOpp(id),
            h[li]!,
            ht,
          ]);
          acc.regY.push(top);
          acc.regNReal.push(nRealOpp(id));
          if (k < T - 2) acc.capTops[li]!.push(top);
        }
      }
      if (ph === 'penultimate') {
        acc.pen.auctions++;
        if (isWin) {
          acc.pen.wins++;
          acc.pen.tops.push(top);
          acc.pen.paids.push(a.paid);
        }
      } else if (ph === 'final') {
        acc.fin.auctions++;
        if (isWin) acc.fin.wins++;
      }
    }
    for (const w of step.before) play(w);
    if (a.winnerId !== null) {
      const acc = byId.get(a.winnerId);
      if (acc) {
        if (ph === 'penultimate' && (top === balOpen.get(a.winnerId) || top === balance.get(a.winnerId))) acc.pen.allIn++;
        acc.lettersWon++;
        acc.paidSum += a.paid;
        acc.topSum += top;
        if (top === a.paid && a.paid >= 2) acc.ties++;
      }
      balance.set(a.winnerId, (balance.get(a.winnerId) ?? 0) - a.paid);
      won.set(a.winnerId, (won.get(a.winnerId) ?? 0) + 1);
      paid.set(a.winnerId, (paid.get(a.winnerId) ?? 0) + a.paid);
      const h = held.get(a.winnerId);
      if (h) h[li]!++;
    }
    for (const w of step.after) play(w);
  }
  for (const w of sched.trailing) play(w);

  const finalClose = m.auctions[T - 1]!.closedAtUs;
  const scores = m.participants.map((p) => p.score);
  const maxScore = Math.max(...scores);
  for (const acc of tracked) {
    const id = acc.bot.id;
    const part = m.participants.find((p) => p.botId === id)!;
    const t0 = m.startedAtUs ?? m.createdAtUs;
    acc.matches++;
    acc.firstUs = Math.min(acc.firstUs, t0);
    acc.lastUs = Math.max(acc.lastUs, t0);
    acc.spend.push(paid.get(id)!);
    acc.unplayed.push(m.startingRackSize + won.get(id)! - tilesPlayed.get(id)!);
    acc.finalBal.push(part.balance);
    const others = m.participants.filter((p) => p !== part).map((p) => p.score);
    const rank = rankOf(others, part.score);
    const win = part.score === maxScore ? 1 : 0;
    const key = String(nRealOpp(id));
    const cell = acc.res.get(key) ?? { n: 0, score: 0, wins: 0, rank: 0 };
    cell.n++;
    cell.score += part.score;
    cell.wins += win;
    cell.rank += rank;
    acc.res.set(key, cell);
    acc.resAll.n++;
    acc.resAll.score += part.score;
    acc.resAll.wins += win;
    acc.resAll.rank += rank;
    let last: HistWord | undefined;
    for (const w of m.words) {
      if (w.botId !== id) continue;
      acc.words++;
      const L = w.word.length;
      acc.lenHist[Math.min(LEN_BUCKETS - 1, Math.max(0, L - 2))]!++;
      acc.lenSum += L;
      acc.rewardSum += w.reward;
      if (L >= 7) {
        acc.pts7 += w.reward;
        acc.n7++;
      }
      acc.tenths[Math.min(9, Math.floor((10 * w.auctionIndex) / T))]!++;
      last = w;
    }
    if (last) {
      acc.lastLeft.push(T - last.auctionIndex);
      acc.lastMs.push((finalClose - last.playedAtUs) / 1000);
    }
  }
}

function cellOut(c: { n: number; score: number; wins: number; rank: number }): ResultCell {
  return {
    n: c.n,
    avgScore: c.n ? rnd(c.score / c.n, 2) : null,
    winRate: c.n ? rnd(c.wins / c.n, 4) : null,
    avgRank: c.n ? rnd(c.rank / c.n, 3) : null,
  };
}

function finishBot(a: BotAcc, D: HistDataset, finalists: Set<string>): BotProfile {
  const b = a.bot;
  const bidCurves = {} as Record<LetterGroup, Record<Phase, BidCurve>>;
  const bidAll = {} as Record<LetterGroup, BidCurve>;
  for (const g of GROUPS) {
    bidCurves[g] = {} as Record<Phase, BidCurve>;
    for (const p of PHASES) bidCurves[g][p] = roundCurve(a.km.get(`${g}/${p}`)!.curve(BID_X_MAX));
    bidAll[g] = roundCurve(a.kmAll.get(g)!.curve(BID_X_MAX));
  }

  // Regression: drop nRealOpp when one value covers > 95% of wins (collinear with the intercept).
  const coef = {} as Record<RegressionFeature, number | null>;
  for (const f of REGRESSION_FEATURES) coef[f] = null;
  let r2: number | null = null;
  let rmse: number | null = null;
  if (a.regY.length >= 30) {
    const counts = new Map<number, number>();
    for (const v of a.regNReal) counts.set(v, (counts.get(v) ?? 0) + 1);
    const dominant = Math.max(...counts.values()) / a.regNReal.length > 0.95;
    const keep = REGRESSION_FEATURES.map((f) => !(dominant && f === 'nRealOpp'));
    const X = a.regX.map((row) => row.filter((_, i) => keep[i]));
    const fit = ols(X, a.regY);
    let j = 0;
    REGRESSION_FEATURES.forEach((f, i) => {
      if (keep[i]) coef[f] = rnd(fit.beta[j++]!, 3);
    });
    r2 = rnd(fit.r2, 3);
    rmse = rnd(fit.rmse, 3);
  }

  const caps: LetterCap[] = [];
  for (let i = 0; i < NUM_LETTERS; i++) {
    const tops = a.capTops[i]!;
    if (tops.length >= 20) caps.push(detectCap(LETTERS[i]!, tops));
  }

  const W = a.lettersWon;
  const nWords = a.words;
  const byReal: Record<string, ResultCell> = {};
  for (const key of [...a.res.keys()].sort()) byReal[key] = cellOut(a.res.get(key)!);
  const p: BotProfile = {
    id: b.id,
    name: b.name,
    isSim: b.isSim,
    version: currentVersion(D.versions, b.id),
    versionStartUs: currentVersionStart(D.versions, b.id),
    finalist: finalists.has(b.name.toLowerCase()),
    matches: a.matches,
    modelMatches: a.modelSet.size,
    firstMatchUs: a.firstUs,
    lastMatchUs: a.lastUs,
    bidCurves,
    bidCurvesAllPhases: bidAll,
    regression: { n: a.regY.length, r2, rmse, coef },
    caps,
    penultimate: {
      auctions: a.pen.auctions,
      wins: a.pen.wins,
      allInWins: a.pen.allIn,
      allInRateOfWins: a.pen.wins ? rnd(a.pen.allIn / a.pen.wins, 4) : null,
      allInRateOfAuctions: a.pen.auctions ? rnd(a.pen.allIn / a.pen.auctions, 4) : null,
      topP50: a.pen.tops.length ? rnd(quantiles(a.pen.tops, [0.5])[0]!, 1) : null,
      paidP50: a.pen.paids.length ? rnd(quantiles(a.pen.paids, [0.5])[0]!, 1) : null,
    },
    final: {
      auctions: a.fin.auctions,
      wins: a.fin.wins,
      winRate: a.fin.auctions ? rnd(a.fin.wins / a.fin.auctions, 4) : null,
      kmPBidGe1: a.kmFinal.n ? rnd(a.kmFinal.curve(BID_X_MAX).pGe[0]!, 3) : null,
    },
    buying: {
      lettersWonPerMatch: a.matches ? rnd(W / a.matches, 3) : null,
      avgPaid: W ? rnd(a.paidSum / W, 3) : null,
      avgTopWhenWinning: W ? rnd(a.topSum / W, 3) : null,
      tieShareOfWins: W ? rnd(a.ties / W, 4) : null,
      spendPerMatch: rnd(mean(a.spend), 2),
    },
    words: {
      perMatch: a.matches ? rnd(nWords / a.matches, 3) : null,
      avgLen: nWords ? rnd(a.lenSum / nWords, 3) : null,
      lenDist: a.lenHist.map((c) => (nWords ? rnd(c / nWords, 3)! : 0)),
      avgReward: nWords ? rnd(a.rewardSum / nWords, 3) : null,
      pts7PlusShare: a.rewardSum ? rnd(a.pts7 / a.rewardSum, 4) : null,
      sevenPlusPerMatch: a.matches ? rnd(a.n7 / a.matches, 3) : null,
    },
    timing: {
      tenths: a.tenths.map((c) => (nWords ? rnd(c / nWords, 3)! : 0)),
      lastWordAuctionsLeft: (() => {
        const [p10, p50, p90] = q3(a.lastLeft, [0.1, 0.5, 0.9]);
        return { p10: p10 ?? null, p50: p50 ?? null, p90: p90 ?? null };
      })(),
      lastWordMsBeforeFinalClose: (() => {
        const [p10, p50, p90] = q3(a.lastMs, [0.1, 0.5, 0.9]);
        return { p10: p10 ?? null, p50: p50 ?? null, p90: p90 ?? null };
      })(),
    },
    unplayedAtEnd: (() => {
      const [p50, p90] = q3(a.unplayed, [0.5, 0.9]);
      return { mean: rnd(mean(a.unplayed), 3), p50: p50 ?? null, p90: p90 ?? null };
    })(),
    finalBalance: { mean: rnd(mean(a.finalBal), 2), p50: q3(a.finalBal, [0.5])[0] ?? null },
    results: { all: cellOut(a.resAll), byRealOpponents: byReal },
  };
  if (b.isSim && b.simStrategy) p.simStrategy = b.simStrategy;
  return p;
}

// ---------------------------------------------------------------------------------------------
// Schema validation (used by tests and by consumers loading data/profiles.json)
// ---------------------------------------------------------------------------------------------

/** Structural validation of a profiles file; returns a list of problems (empty = valid). */
export function checkProfiles(x: unknown): string[] {
  const errs: string[] = [];
  const f = x as ProfilesFile;
  if (!f || typeof f !== 'object') return ['not an object'];
  if (f.schemaVersion !== PROFILE_SCHEMA_VERSION) errs.push(`schemaVersion ${String(f.schemaVersion)}`);
  if (!f.generatedFrom || !Array.isArray(f.generatedFrom.matchIdRange)) errs.push('generatedFrom.matchIdRange');
  if (!Array.isArray(f.bots) || f.bots.length === 0) return [...errs, 'bots'];
  const isProb = (p: unknown) => typeof p === 'number' && p >= 0 && p <= 1;
  for (const b of f.bots) {
    const t = `bot ${b?.name}`;
    if (typeof b.id !== 'number' || typeof b.name !== 'string') errs.push(`${t}: id/name`);
    if (!(b.matches > 0)) errs.push(`${t}: matches`);
    for (const g of GROUPS) {
      const curves: Array<[string, BidCurve | undefined]> = [
        ...PHASES.map((p) => [`${g}/${p}`, b.bidCurves?.[g]?.[p]] as [string, BidCurve | undefined]),
        [`${g}/all`, b.bidCurvesAllPhases?.[g]],
      ];
      for (const [name, c] of curves) {
        if (!c || !Array.isArray(c.pGe) || c.pGe.length !== BID_X_MAX) {
          errs.push(`${t}: curve ${name} missing or wrong length`);
          continue;
        }
        if (!c.pGe.every(isProb)) errs.push(`${t}: curve ${name} has values outside [0,1]`);
        for (let i = 1; i < c.pGe.length; i++) {
          if (c.pGe[i]! > c.pGe[i - 1]!) {
            errs.push(`${t}: curve ${name} increases at x=${i + 1}`);
            break;
          }
        }
        if (!isProb(c.pNoBid)) errs.push(`${t}: curve ${name} pNoBid`);
        if (!(c.n >= c.nExact && c.nExact >= 0)) errs.push(`${t}: curve ${name} counts`);
      }
    }
    for (const fName of REGRESSION_FEATURES) {
      const v = b.regression?.coef?.[fName];
      if (v !== null && typeof v !== 'number') errs.push(`${t}: coef ${fName}`);
    }
    if (!Array.isArray(b.words?.lenDist) || b.words.lenDist.length !== LEN_BUCKETS) errs.push(`${t}: lenDist`);
    if (!Array.isArray(b.timing?.tenths) || b.timing.tenths.length !== 10) errs.push(`${t}: tenths`);
    if (!b.results?.all || typeof b.results.all.n !== 'number') errs.push(`${t}: results`);
  }
  if (!f.market?.priceByPhase?.all || !f.market.indexCurve68?.all) errs.push('market');
  return errs;
}

/** Simple consumer helper: P(bid >= x) from a curve (1 for x <= 0, 0 beyond the curve). */
export function pBidAtLeast(c: BidCurve, x: number): number {
  if (x <= 0) return 1;
  if (x > c.pGe.length) return 0;
  return c.pGe[x - 1]!;
}
