// Counterfactual replay benchmark ("replacement mode"): a Policy takes a target bot's seat in a
// historical match; every other bot replays its historical words and keeps its historical score.
//
// Field model (Vickrey only; other auction types are skipped and counted):
//   field = max bid of everyone except the target, which history pins down EXACTLY:
//     historical winner W != target  -> field = W's top bid (archived)
//     W == target                    -> field = paid (runner-up's bid; paid == 1 may mean "no
//                                       runner-up", conservatively treated as a bid of 1)
//     no winner                      -> field = 0
//   We win iff bid >= 1 and (bid > field, or bid == field and the tie is won):
//     tieMode "coin" (default): seeded rng, p = 1/2;  "historical": iff the target won historically.
//   Vickrey price = field (1 when field == 0).
// Attribution of the auction result fed to our tracker:
//   we won                                  -> winnerId = us, paid = price
//   we lost, historical winner W != target  -> winnerId = W, paid = historical paid (W's historical
//                                              balance/words are replayed unchanged)
//   we lost, the target had won             -> winnerId = null, paid = 0 (the runner-up cannot be
//                                              identified; counted as unattributedLosses)
//   Our seat is NEVER credited with a letter our policy did not win.
// Event order per auction k (canonical order from load.ts; no look-ahead):
//   open(k) -> our decide(view, auction k) -> our words, our bid -> opponents' historical words
//   with auctionIndex == k && !inClose -> result(k) -> opponents' inClose words of k (sims).
//   The target's own historical words are dropped. Opponents' words played during auction k are
//   not visible to our decide for k.
// Our starting rack = the target's proven starting tiles (letters it played but never won), topped
// up to startingRackSize by sampling the remaining unknown starting-tile pool (seeded).
// Ranks are conservative: other bots keep their HISTORICAL final scores (even when we took letters
// they used). Tracker diagnostics (hiddenOverflow, unseenNegative) are expected when opponents
// replay words containing letters we took; they are reported, not errors.
//
// This module must not import src/bots/** statically (02-01 builds the registry in parallel); the
// CLI resolves non-mimic policies with a dynamic import.
import { BAG, NUM_LETTERS, idx, isWellFormedWord, wordReward } from '../core/letters.js';
import { emptyRack, rackCanSpell, rackTotal, type Rack } from '../core/rack.js';
import { Rng, hashSeed } from '../core/rng.js';
import type { AuctionOutcome, Decision, MatchConfig, PlayerId, Policy, PolicyFactory } from '../core/types.js';
import type { Dictionary } from '../engine/dictionary.js';
import { MatchTracker, type TrackerDiagnostics } from '../state/tracker.js';
import { auctionInfo, canonicalSchedule, matchConfig, rankOf, revealStartTiles } from './load.js';
import { meanCI, wilson, type Interval } from './stats.js';
import type { HistBot, HistMatch, HistWord } from './types.js';

export type TieMode = 'coin' | 'historical';

export interface ReplayOptions {
  dict: Dictionary;
  seed?: number; // default 1
  tieMode?: TieMode; // default 'coin'
  budgetMs?: number; // DecideContext.budgetMs, default 50
  policyOpts?: Record<string, unknown>;
  /** Record a per-auction trace in the result. */
  trace?: boolean;
}

export interface AuctionTrace {
  k: number;
  letter: string;
  bid: number;
  field: number;
  won: boolean;
  paid: number;
  tie: boolean;
  outcome: AuctionOutcome;
}

export interface MatchReplayResult {
  matchId: number;
  targetId: PlayerId;
  policy: string;
  players: number;
  nReal: number;
  ourScore: number;
  ourRank: number;
  ourWin: boolean;
  targetScore: number;
  targetRank: number;
  targetWin: boolean;
  lettersWon: number;
  targetLettersWon: number;
  totalPaid: number;
  avgPrice: number | null;
  unplayed: number;
  wordsPlayed: number;
  rejectedWords: number;
  rejectedBids: number;
  policyErrors: number;
  unattributedLosses: number;
  ties: number;
  tiesWon: number;
  diagnostics: TrackerDiagnostics;
  trace?: AuctionTrace[];
}

export class ReplaySkipError extends Error {
  constructor(
    readonly reason: 'incomplete' | 'non-vickrey' | 'target-absent',
    msg: string,
  ) {
    super(msg);
    this.name = 'ReplaySkipError';
  }
}

/** Throws ReplaySkipError when `m` cannot be replayed with `targetId` in the target seat. */
export function assertReplayable(m: HistMatch, targetId: PlayerId): void {
  if (!m.complete) throw new ReplaySkipError('incomplete', `match ${m.id} is incomplete`);
  if (m.auctionType !== 'Vickrey') throw new ReplaySkipError('non-vickrey', `match ${m.id} is ${m.rawAuctionType}`);
  if (!m.participants.some((p) => p.botId === targetId)) {
    throw new ReplaySkipError('target-absent', `bot ${targetId} did not play match ${m.id}`);
  }
}

/** Our starting rack: the target's proven starting tiles, topped up from the unknown pool (seeded). */
export function replayStartRack(m: HistMatch, targetId: PlayerId, rng: Rng): Rack {
  const { revealed } = revealStartTiles(m);
  const start = new Uint8Array(revealed.get(targetId) ?? emptyRack());
  const pool = Int32Array.from(BAG);
  for (const a of m.auctions) {
    const i = idx(a.letter);
    if (i >= 0) pool[i]!--;
  }
  for (const r of revealed.values()) for (let i = 0; i < NUM_LETTERS; i++) pool[i]! -= r[i]!;
  let need = m.startingRackSize - rackTotal(start);
  let size = 0;
  for (let i = 0; i < NUM_LETTERS; i++) size += Math.max(0, pool[i]!);
  while (need > 0 && size > 0) {
    let pick = rng.int(0, size - 1);
    for (let i = 0; i < NUM_LETTERS; i++) {
      const c = Math.max(0, pool[i]!);
      if (pick < c) {
        start[i]!++;
        pool[i]!--;
        size--;
        need--;
        break;
      }
      pick -= c;
    }
  }
  return start;
}

/** Replay one match with `factory`'s policy in the target's seat. */
export function replayMatch(
  m: HistMatch,
  bots: ReadonlyMap<PlayerId, HistBot>,
  targetId: PlayerId,
  factory: PolicyFactory,
  opts: ReplayOptions,
): MatchReplayResult {
  assertReplayable(m, targetId);
  const seed = hashSeed(opts.seed ?? 1, m.id, targetId);
  const rng = new Rng(seed);
  const startRng = rng.fork('start');
  const tieRng = rng.fork('tie');
  const ctxRng = rng.fork('ctx');
  const policy: Policy = factory(hashSeed(seed, 'policy'), opts.policyOpts);
  const tieMode = opts.tieMode ?? 'coin';
  const budgetMs = opts.budgetMs ?? 50;

  const base = matchConfig(m, bots, targetId);
  const config: MatchConfig = {
    ...base,
    players: base.players.map((p) =>
      p.id === targetId ? { id: targetId, name: `${policy.name}@${p.name}`, isSim: false } : p,
    ),
  };
  const tracker = new MatchTracker(config, replayStartRack(m, targetId, startRng));
  const me = tracker.me;
  const view = tracker.view;
  policy.onMatchStart(view);

  const res: MatchReplayResult = {
    matchId: m.id,
    targetId,
    policy: policy.name,
    players: m.participants.length,
    nReal: m.nReal,
    ourScore: 0,
    ourRank: 0,
    ourWin: false,
    targetScore: 0,
    targetRank: 0,
    targetWin: false,
    lettersWon: 0,
    targetLettersWon: 0,
    totalPaid: 0,
    avgPrice: null,
    unplayed: 0,
    wordsPlayed: 0,
    rejectedWords: 0,
    rejectedBids: 0,
    policyErrors: 0,
    unattributedLosses: 0,
    ties: 0,
    tiesWon: 0,
    diagnostics: tracker.diagnostics,
  };
  const trace: AuctionTrace[] | undefined = opts.trace ? [] : undefined;
  const oppWord = (w: HistWord) => {
    if (w.botId === targetId) return;
    tracker.wordPlay({ playerId: w.botId, word: w.word, reward: w.reward, auctionIndex: w.auctionIndex });
  };

  const sched = canonicalSchedule(m);
  for (const step of sched.steps) {
    const a = step.auction;
    const k = a.index;
    const info = auctionInfo(m, k);
    tracker.auctionOpen(info);

    let decision: Decision;
    try {
      decision = policy.decide(view, info, { budgetMs, rng: ctxRng, now: () => performance.now() });
    } catch {
      res.policyErrors++;
      decision = { words: [], bid: 0 };
    }
    const words = Array.isArray(decision?.words) ? decision.words : [];
    for (const w of words) {
      if (typeof w !== 'string' || !isWellFormedWord(w) || !opts.dict.isValid(w) || !rackCanSpell(me.rack, w)) {
        res.rejectedWords++;
        continue;
      }
      tracker.wordPlay({ playerId: targetId, word: w, reward: wordReward(w), auctionIndex: k });
      res.wordsPlayed++;
    }
    let bid = decision?.bid;
    if (typeof bid !== 'number' || !Number.isInteger(bid) || bid < 0 || bid > me.balance) {
      res.rejectedBids++;
      bid = 0;
    }

    for (const w of step.before) oppWord(w);

    const hw = a.winnerId;
    const targetWon = hw === targetId;
    if (targetWon) res.targetLettersWon++;
    const field = hw === null ? 0 : targetWon ? a.paid : a.topBid!;
    let tie = false;
    let weWin = false;
    if (bid >= 1) {
      if (bid > field) weWin = true;
      else if (bid === field) {
        tie = true;
        res.ties++;
        weWin = tieMode === 'historical' ? targetWon : tieRng.int(0, 1) === 1;
        if (weWin) res.tiesWon++;
      }
    }
    let outcome: AuctionOutcome;
    if (weWin) {
      const price = field === 0 ? 1 : field;
      outcome = { auctionId: a.auctionId, index: k, letter: a.letter, winnerId: targetId, paid: price };
      res.lettersWon++;
      res.totalPaid += price;
    } else if (hw !== null && !targetWon) {
      outcome = { auctionId: a.auctionId, index: k, letter: a.letter, winnerId: hw, paid: a.paid };
    } else {
      if (targetWon) res.unattributedLosses++;
      outcome = { auctionId: a.auctionId, index: k, letter: a.letter, winnerId: null, paid: 0 };
    }
    tracker.auctionResult(outcome);
    trace?.push({ k, letter: a.letter, bid, field, won: weWin, paid: weWin ? outcome.paid : 0, tie, outcome });
    policy.onAuctionClosed?.(view, outcome);

    for (const w of step.after) oppWord(w);
  }
  for (const w of sched.trailing) oppWord(w);
  policy.onMatchEnd?.(view);

  const others = m.participants.filter((p) => p.botId !== targetId).map((p) => p.score);
  const target = m.participants.find((p) => p.botId === targetId)!;
  res.ourScore = me.score;
  res.ourRank = rankOf(others, me.score);
  res.ourWin = res.ourRank === 1;
  res.targetScore = target.score;
  res.targetRank = rankOf(others, target.score);
  res.targetWin = res.targetRank === 1;
  res.avgPrice = res.lettersWon ? res.totalPaid / res.lettersWon : null;
  res.unplayed = rackTotal(me.rack);
  res.diagnostics = { ...tracker.diagnostics };
  if (trace) res.trace = trace;
  return res;
}

export interface ReplayAggregate {
  n: number;
  ourWinRate: Interval;
  targetWinRate: Interval;
  ourAvgRank: number;
  targetAvgRank: number;
  ourAvgScore: { mean: number; half: number };
  targetAvgScore: { mean: number; half: number };
  avgScoreDelta: { mean: number; half: number };
  exactScoreMatches: number;
  lettersWonPerMatch: number;
  targetLettersWonPerMatch: number;
  avgPrice: number | null;
  unplayedPerMatch: number;
  rejectedWords: number;
  rejectedBids: number;
  policyErrors: number;
  unattributedLosses: number;
  ties: number;
  tiesWon: number;
  diagnostics: { hiddenOverflow: number; unseenNegative: number; matchesWithDiagnostics: number };
}

export function aggregate(results: readonly MatchReplayResult[]): ReplayAggregate {
  const n = results.length;
  const sum = (f: (r: MatchReplayResult) => number) => results.reduce((s, r) => s + f(r), 0);
  const ours = results.map((r) => r.ourScore);
  const theirs = results.map((r) => r.targetScore);
  const won = sum((r) => r.lettersWon);
  const os = meanCI(ours);
  const ts = meanCI(theirs);
  const ds = meanCI(results.map((r) => r.ourScore - r.targetScore));
  return {
    n,
    ourWinRate: wilson(sum((r) => (r.ourWin ? 1 : 0)), n),
    targetWinRate: wilson(sum((r) => (r.targetWin ? 1 : 0)), n),
    ourAvgRank: n ? sum((r) => r.ourRank) / n : NaN,
    targetAvgRank: n ? sum((r) => r.targetRank) / n : NaN,
    ourAvgScore: { mean: os.mean, half: os.half },
    targetAvgScore: { mean: ts.mean, half: ts.half },
    avgScoreDelta: { mean: ds.mean, half: ds.half },
    exactScoreMatches: sum((r) => (r.ourScore === r.targetScore ? 1 : 0)),
    lettersWonPerMatch: n ? won / n : NaN,
    targetLettersWonPerMatch: n ? sum((r) => r.targetLettersWon) / n : NaN,
    avgPrice: won ? sum((r) => r.totalPaid) / won : null,
    unplayedPerMatch: n ? sum((r) => r.unplayed) / n : NaN,
    rejectedWords: sum((r) => r.rejectedWords),
    rejectedBids: sum((r) => r.rejectedBids),
    policyErrors: sum((r) => r.policyErrors),
    unattributedLosses: sum((r) => r.unattributedLosses),
    ties: sum((r) => r.ties),
    tiesWon: sum((r) => r.tiesWon),
    diagnostics: {
      hiddenOverflow: sum((r) => r.diagnostics.hiddenOverflow),
      unseenNegative: sum((r) => r.diagnostics.unseenNegative),
      matchesWithDiagnostics: sum((r) => (r.diagnostics.hiddenOverflow + r.diagnostics.unseenNegative > 0 ? 1 : 0)),
    },
  };
}

export interface ReplayRunReport {
  results: MatchReplayResult[];
  skipped: Record<'incomplete' | 'non-vickrey' | 'target-absent', number>;
  aggregate: ReplayAggregate;
}

/** Replay a list of matches; unreplayable matches are skipped and counted by reason. */
export function replayMatches(
  matches: readonly HistMatch[],
  bots: ReadonlyMap<PlayerId, HistBot>,
  targetId: PlayerId,
  factoryFor: (m: HistMatch) => PolicyFactory,
  opts: ReplayOptions,
): ReplayRunReport {
  const skipped = { incomplete: 0, 'non-vickrey': 0, 'target-absent': 0 };
  const results: MatchReplayResult[] = [];
  for (const m of matches) {
    try {
      assertReplayable(m, targetId);
    } catch (e) {
      if (e instanceof ReplaySkipError) {
        skipped[e.reason]++;
        continue;
      }
      throw e;
    }
    results.push(replayMatch(m, bots, targetId, factoryFor(m), opts));
  }
  return { results, skipped, aggregate: aggregate(results) };
}
