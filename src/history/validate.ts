// Historical E2E validation: our engine, sim model and tracker versus the live server's own history.
// Every check runs over COMPLETE matches only (load.ts `complete`); excluded matches are counted.
// On the full dataset and on the committed sample every check must report 0 mismatches
// (HISTORICAL.md §F, §G). Each check returns {checked, mismatches, examples}.
import { BAG, NUM_LETTERS, SIM_BID_JITTER, STARTING_BALANCE, idx, wordBase, wordReward } from '../core/letters.js';
import { emptyRack, rackFromWord, rackToString, rackTotal, type Rack } from '../core/rack.js';
import { simBid } from '../core/simbots.js';
import type { PlayerId } from '../core/types.js';
import type { AnagramIndex } from '../engine/anagram.js';
import type { Dictionary } from '../engine/dictionary.js';
import { MatchTracker } from '../state/tracker.js';
import { bagRemaining, opponentsHiddenUnknown } from '../state/view.js';
import { auctionInfo, canonicalSchedule, matchConfig, revealStartTiles, type Schedule } from './load.js';
import type { HistBot, HistDataset, HistMatch, HistWord } from './types.js';

export interface CheckResult {
  id: string;
  description: string;
  checked: number;
  mismatches: number;
  examples: string[];
}

export interface ValidationReport {
  matchesTotal: number;
  matchesComplete: number;
  excludedIncomplete: number;
  /** Complete matches whose auction type is not Vickrey (also reported by check match.vickrey). */
  nonVickrey: number;
  checks: CheckResult[];
  /** Sim wins whose full rack was reconstructible (all hidden tiles revealed) / all sim wins. */
  simBestWordCoverage: { reconstructible: number; simWins: number };
  /** Seats replayed through a MatchTracker. */
  trackerSeats: number;
}

export interface ValidateOptions {
  dict: Dictionary;
  index: AnagramIndex;
  maxExamples?: number;
  /** Skip the per-seat tracker replay (faster). Default false. */
  skipTracker?: boolean;
}

export const CHECKS: ReadonlyArray<[string, string]> = [
  ['word.reward', 'word_play total_reward == wordReward(word)'],
  ['word.base', 'word_play base_score == wordBase(word)'],
  ['word.bonus', 'word_play bonus == total_reward - base_score'],
  ['word.dictionary', 'word is in the engine dictionary (ENABLE)'],
  ['word.length', 'word length >= 2'],
  ['word.player', 'word played by a participant of the match'],
  ['score.sum', 'participant final score == sum of its word rewards'],
  ['balance.identity', 'final balance == 100 - sum(paid on wins) + sum(rewards)'],
  ['match.auctions', 'auctions == 98 - rack*P == match_state.current_round, bag_total == 0'],
  ['match.closeOrder', 'auction close times strictly increase in auction_id order'],
  ['match.bag', 'per letter: auctioned + proven starting tiles <= bag count'],
  ['match.vickrey', 'auction type is Vickrey (others counted as mismatches)'],
  ['start.overdraw', 'proven starting tiles per player <= starting_rack_size'],
  ['auction.topGePaid', 'top_bid >= paid'],
  ['auction.shape', 'winner has top_bid >= 1 and paid >= 1; no winner has paid == top == 0'],
  ['auction.winnerBalance', 'winner balance (reconstructed) >= paid at close'],
  ['sim.winBid', 'sim win: top_bid is a possible simBid(strategy, letter, balance at open, jitter)'],
  ['sim.lossBid', 'sim loss with balance >= 1: smallest possible sim bid <= paid'],
  ['sim.wordAfterWin', 'sim words only in the close of an auction that sim won, <= 1 per win'],
  ['sim.wordLength', 'sim word length >= 3'],
  ['sim.bestWord', 'sim word == findBestPlayable(rack, 3) (and none played iff none exists) when the rack is reconstructible'],
  ['real.noWordAfterFinal', 'no real-bot word at or after the final close'],
  ['tracker.seat', 'MatchTracker per seat: no throw, opponent diagnostics 0, balances/scores resync with 0 mismatches, unseen invariant'],
];

class Checker {
  readonly results = new Map<string, CheckResult>();
  constructor(private readonly maxExamples: number) {
    for (const [id, description] of CHECKS) {
      this.results.set(id, { id, description, checked: 0, mismatches: 0, examples: [] });
    }
  }
  check(id: string, ok: boolean, example: () => string): void {
    const r = this.results.get(id);
    if (!r) throw new Error(`unknown check ${id}`);
    r.checked++;
    if (!ok) {
      r.mismatches++;
      if (r.examples.length < this.maxExamples) r.examples.push(example());
    }
  }
}

function botOf(bots: ReadonlyMap<PlayerId, HistBot>, id: PlayerId): HistBot | undefined {
  return bots.get(id);
}

/** Validate a loaded dataset. Pure (no I/O). */
export function validateDataset(D: HistDataset, opts: ValidateOptions): ValidationReport {
  const C = new Checker(opts.maxExamples ?? 5);
  const cov = { reconstructible: 0, simWins: 0 };
  let complete = 0;
  let nonVickrey = 0;
  let trackerSeats = 0;
  for (const m of D.matches) {
    if (!m.complete) continue;
    complete++;
    if (m.auctionType !== 'Vickrey') nonVickrey++;
    validateMatch(m, D, opts, C, cov);
    if (!opts.skipTracker) trackerSeats += trackerCheck(m, D, C);
  }
  return {
    matchesTotal: D.matches.length,
    matchesComplete: complete,
    excludedIncomplete: D.matches.length - complete,
    nonVickrey,
    checks: [...C.results.values()],
    simBestWordCoverage: cov,
    trackerSeats,
  };
}

function validateMatch(
  m: HistMatch,
  D: HistDataset,
  opts: ValidateOptions,
  C: Checker,
  cov: { reconstructible: number; simWins: number },
): void {
  const tag = `m${m.id}`;
  const T = m.auctions.length;
  const P = m.participants.length;
  const partIds = new Set(m.participants.map((p) => p.botId));

  // ---- match-level
  C.check(
    'match.auctions',
    T === 98 - m.startingRackSize * P && m.currentRound === T && m.bagTotal === 0,
    () => `${tag}: auctions ${T}, expected ${98 - m.startingRackSize * P}, current_round ${m.currentRound}, bag_total ${m.bagTotal}`,
  );
  let mono = true;
  for (let k = 1; k < T; k++) if (m.auctions[k]!.closedAtUs <= m.auctions[k - 1]!.closedAtUs) mono = false;
  C.check('match.closeOrder', mono, () => `${tag}: close times not strictly increasing`);
  C.check('match.vickrey', m.auctionType === 'Vickrey', () => `${tag}: auction type ${m.rawAuctionType}`);

  const { revealed, overdraw } = revealStartTiles(m);
  for (const p of m.participants) {
    const r = revealed.get(p.botId)!;
    C.check('start.overdraw', rackTotal(r) <= m.startingRackSize, () => `${tag} bot ${p.botId}: proven start ${rackToString(r)}`);
  }
  void overdraw;
  const used = new Int32Array(NUM_LETTERS);
  for (const a of m.auctions) {
    const i = idx(a.letter);
    if (i >= 0) used[i]!++;
  }
  for (const r of revealed.values()) for (let i = 0; i < NUM_LETTERS; i++) used[i]! += r[i]!;
  let bagOk = true;
  for (let i = 0; i < NUM_LETTERS; i++) if (used[i]! > BAG[i]!) bagOk = false;
  C.check('match.bag', bagOk, () => `${tag}: letters over bag count`);

  // ---- words (static)
  const rewardSum = new Map<PlayerId, number>();
  for (const w of m.words) {
    const ex = () => `${tag} word#${w.id} '${w.word}' bot ${w.botId}`;
    C.check('word.reward', w.reward === wordReward(w.word), () => `${ex()}: reward ${w.reward} vs ${wordReward(w.word)}`);
    C.check('word.base', w.baseScore === wordBase(w.word), () => `${ex()}: base ${w.baseScore} vs ${wordBase(w.word)}`);
    C.check('word.bonus', w.bonus === w.reward - w.baseScore, ex);
    C.check('word.dictionary', opts.dict.isValid(w.word), ex);
    C.check('word.length', w.word.length >= 2, ex);
    C.check('word.player', partIds.has(w.botId), ex);
    rewardSum.set(w.botId, (rewardSum.get(w.botId) ?? 0) + w.reward);
    const b = botOf(D.bots, w.botId);
    if (b && !b.isSim) {
      const finalClose = m.auctions[T - 1]!.closedAtUs;
      C.check('real.noWordAfterFinal', w.playedAtUs < finalClose, () => `${ex()}: at ${w.playedAtUs} >= final close ${finalClose}`);
    }
  }
  const paidSum = new Map<PlayerId, number>();
  for (const a of m.auctions) if (a.winnerId !== null) paidSum.set(a.winnerId, (paidSum.get(a.winnerId) ?? 0) + a.paid);
  for (const p of m.participants) {
    const rs = rewardSum.get(p.botId) ?? 0;
    C.check('score.sum', p.score === rs, () => `${tag} bot ${p.botId}: score ${p.score} vs sum ${rs}`);
    const bal = STARTING_BALANCE - (paidSum.get(p.botId) ?? 0) + rs;
    C.check('balance.identity', p.balance === bal, () => `${tag} bot ${p.botId}: balance ${p.balance} vs ${bal}`);
  }

  // ---- auctions (static)
  for (const a of m.auctions) {
    const top = a.topBid!;
    const ex = () => `${tag} a${a.index} ${a.letter}: winner ${a.winnerId} paid ${a.paid} top ${top}`;
    C.check('auction.topGePaid', top >= a.paid, ex);
    const shapeOk = a.winnerId !== null ? top >= 1 && a.paid >= 1 : a.paid === 0 && top === 0;
    C.check('auction.shape', shapeOk, ex);
  }

  // ---- chronological pass: balances, sims
  const sched = canonicalSchedule(m);
  simAndBalancePass(m, D, opts, C, cov, sched, revealed);
}

function simAndBalancePass(
  m: HistMatch,
  D: HistDataset,
  opts: ValidateOptions,
  C: Checker,
  cov: { reconstructible: number; simWins: number },
  sched: Schedule,
  revealed: Map<PlayerId, Rack>,
): void {
  const tag = `m${m.id}`;
  const balance = new Map<PlayerId, number>();
  const rack = new Map<PlayerId, Rack>(); // exact rack for sims with a fully revealed start
  const sims: Array<{ id: PlayerId; bot: HistBot }> = [];
  for (const p of m.participants) {
    balance.set(p.botId, STARTING_BALANCE);
    const b = botOf(D.bots, p.botId);
    if (b && b.isSim && !b.missing && b.simStrategy) {
      sims.push({ id: p.botId, bot: b });
      const r = revealed.get(p.botId)!;
      if (rackTotal(r) === m.startingRackSize) rack.set(p.botId, new Uint8Array(r));
    }
  }
  const play = (w: HistWord) => {
    balance.set(w.botId, (balance.get(w.botId) ?? 0) + w.reward);
    const r = rack.get(w.botId);
    if (r) {
      const need = rackFromWord(w.word);
      for (let i = 0; i < NUM_LETTERS; i++) r[i] = Math.max(0, r[i]! - need[i]!);
    }
  };

  for (const step of sched.steps) {
    const a = step.auction;
    const li = idx(a.letter);
    const top = a.topBid!;
    // Sims bid at open with their balance at open (sim balances only change at closes).
    for (const s of sims) {
      const bal = balance.get(s.id)!;
      const strat = s.bot.simStrategy!;
      const ex = () => `${tag} a${a.index} ${a.letter} sim ${s.bot.name} bal ${bal}: winner ${a.winnerId} paid ${a.paid} top ${top}`;
      if (a.winnerId === s.id) {
        let possible = false;
        for (let j = -SIM_BID_JITTER; j <= SIM_BID_JITTER; j++) if (simBid(strat, li, bal, j) === top) possible = true;
        C.check('sim.winBid', possible, ex);
      } else if (bal >= 1) {
        C.check('sim.lossBid', simBid(strat, li, bal, -SIM_BID_JITTER) <= a.paid, ex);
      }
    }
    for (const w of step.before) {
      const b = botOf(D.bots, w.botId);
      if (b?.isSim) C.check('sim.wordAfterWin', false, () => `${tag} word#${w.id} '${w.word}': sim word outside a close`);
      play(w);
    }
    if (a.winnerId !== null) {
      const bal = balance.get(a.winnerId) ?? 0;
      C.check('auction.winnerBalance', bal >= a.paid, () => `${tag} a${a.index}: winner ${a.winnerId} balance ${bal} < paid ${a.paid}`);
      balance.set(a.winnerId, bal - a.paid);
      const r = rack.get(a.winnerId);
      if (r && li >= 0) r[li]!++;
    }
    // Sim words of this close.
    const simAfter = new Map<PlayerId, HistWord[]>();
    for (const w of step.after) {
      const b = botOf(D.bots, w.botId);
      if (!b?.isSim) continue; // real bots never share a close timestamp (validated by real.noWordAfterFinal / attribution)
      let arr = simAfter.get(w.botId);
      if (!arr) simAfter.set(w.botId, (arr = []));
      arr.push(w);
    }
    for (const [id, ws] of simAfter) {
      C.check('sim.wordAfterWin', a.winnerId === id && ws.length <= 1, () => `${tag} a${a.index}: sim ${id} played ${ws.length} word(s), winner ${a.winnerId}`);
      for (const w of ws) C.check('sim.wordLength', w.word.length >= 3, () => `${tag} '${w.word}'`);
    }
    const winnerBot = a.winnerId !== null ? botOf(D.bots, a.winnerId) : undefined;
    if (winnerBot?.isSim && !winnerBot.missing) {
      cov.simWins++;
      const r = rack.get(a.winnerId!);
      if (r) {
        cov.reconstructible++;
        const best = opts.index.findBestPlayable(r, 3);
        const played = simAfter.get(a.winnerId!)?.[0]?.word;
        C.check('sim.bestWord', best === played, () => `${tag} a${a.index}: sim ${a.winnerId} rack ${rackToString(r)} played ${played ?? '-'} best ${best ?? '-'}`);
      }
    }
    for (const w of step.after) play(w);
  }
  for (const w of sched.trailing) {
    const b = botOf(D.bots, w.botId);
    if (b?.isSim) C.check('sim.wordAfterWin', false, () => `${tag} word#${w.id}: sim word after the final close`);
    play(w);
  }
}

/**
 * Replay the match through one MatchTracker per participant seat P (myId = P, my start rack =
 * P's proven starting tiles). My own unseen/hidden accounting is relaxed for P's unknown start
 * tiles: the unseen invariant becomes total(unseen) == bagRemaining + Σ_opp hiddenUnknown +
 * (rack size - proven start tiles). Returns the number of seats checked.
 */
function trackerCheck(m: HistMatch, D: HistDataset, C: Checker): number {
  if (m.auctionType === 'Unknown') return 0;
  const { revealed } = revealStartTiles(m);
  const sched = canonicalSchedule(m);
  let seats = 0;
  for (const seat of m.participants) {
    seats++;
    const start = revealed.get(seat.botId) ?? emptyRack();
    const missingStart = m.startingRackSize - rackTotal(start);
    let problem = '';
    try {
      const t = new MatchTracker(matchConfig(m, D.bots, seat.botId), start);
      const invariant = (where: string) => {
        if (problem) return;
        let unseen = 0;
        for (let i = 0; i < NUM_LETTERS; i++) unseen += t.view.unseen[i]!;
        const expected = bagRemaining(t.view) + opponentsHiddenUnknown(t.view) + missingStart;
        if (unseen !== expected) problem = `unseen ${unseen} != ${expected} at ${where}`;
      };
      const word = (w: HistWord) =>
        t.wordPlay({ playerId: w.botId, word: w.word, reward: w.reward, auctionIndex: w.auctionIndex });
      for (const step of sched.steps) {
        const a = step.auction;
        t.auctionOpen(auctionInfo(m, a.index));
        invariant(`open ${a.index}`);
        for (const w of step.before) word(w);
        t.auctionResult({ auctionId: a.auctionId, index: a.index, letter: a.letter, winnerId: a.winnerId, paid: a.paid });
        for (const w of step.after) word(w);
      }
      for (const w of sched.trailing) word(w);
      invariant('end');
      for (const p of m.participants) t.setBalance(p.botId, p.balance, p.score);
      const d = t.diagnostics;
      if (!problem && (d.hiddenOverflow || d.unseenNegative || d.balanceMismatches || d.rackMismatches)) {
        problem = `diagnostics ${JSON.stringify(d)}`;
      }
    } catch (e) {
      problem = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    C.check('tracker.seat', problem === '', () => `m${m.id} seat ${seat.botId}: ${problem}`);
  }
  return seats;
}

/** Plain-text table of a report. */
export function formatReport(r: ValidationReport): string {
  const lines: string[] = [];
  lines.push(
    `matches: ${r.matchesTotal} total, ${r.matchesComplete} complete, ${r.excludedIncomplete} excluded (incomplete); non-Vickrey ${r.nonVickrey}; tracker seats ${r.trackerSeats}`,
  );
  lines.push(
    `sim best-word coverage: ${r.simBestWordCoverage.reconstructible}/${r.simBestWordCoverage.simWins} sim wins with a reconstructible rack`,
  );
  const w = Math.max(...r.checks.map((c) => c.id.length));
  lines.push(`${'check'.padEnd(w)}  ${'checked'.padStart(10)}  ${'mismatch'.padStart(8)}  description`);
  for (const c of r.checks) {
    lines.push(`${c.id.padEnd(w)}  ${String(c.checked).padStart(10)}  ${String(c.mismatches).padStart(8)}  ${c.description}`);
    for (const e of c.examples) lines.push(`${''.padEnd(w)}    e.g. ${e}`);
  }
  const bad = r.checks.reduce((s, c) => s + c.mismatches, 0);
  lines.push(`TOTAL mismatches: ${bad}`);
  return lines.join('\n');
}

export function totalMismatches(r: ValidationReport): number {
  return r.checks.reduce((s, c) => s + c.mismatches, 0);
}
