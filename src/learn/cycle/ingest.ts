// Ingest live match logs (runs/live/match-<id>.jsonl, written by src/client/log.ts) into compact
// per-match summaries for loss diagnosis, and backfill finished matches missing from LearnState.
//
// Robust to partial logs: a truncated last line is ignored, and a match is only "finished" once its
// `{k:'info', msg:'match ended'}` record exists. All I/O is synchronous and per file.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { letterValue } from '../../core/letters.js';
import { rackToString, rackTotal, rackValue } from '../../core/rack.js';
import type { AuctionInfo, AuctionOutcome, MatchConfig, PlayerId } from '../../core/types.js';
import { applyEvent, trackerFromStart, type MatchEvent } from '../../state/events.js';
import type { MatchTracker } from '../../state/tracker.js';
import { banditUpdate, DEFAULT_ARM_ID, rewardOf, type LearnState, type MatchRec } from './pool.js';

export interface AuctionRow {
  index: number;
  auctionId: number;
  letter: string;
  value: number;
  winnerId: PlayerId | null;
  paid: number;
  /** Our final intended bid (last decision for the auction, else last accepted submit). */
  myBid: number | undefined;
  /** Our balance when the auction opened. */
  myBalance: number;
}

export interface PlayerSummary {
  id: PlayerId;
  name: string;
  isSim: boolean;
  simStrategy?: string;
  score: number;
  balance: number;
  lettersWon: number;
  totalPaid: number;
  avgPaid: number;
  words: string[];
  bingos: number;
}

export interface MatchSummary {
  matchId: number;
  file?: string;
  endedAt: string;
  config: MatchConfig;
  armId: string;
  me: PlayerSummary;
  others: PlayerSummary[];
  /** Average rank (ties share), 1 = best. */
  rank: number;
  won: boolean;
  reward: number;
  winner: PlayerSummary;
  auctions: AuctionRow[];
  finalRack: string;
  unplayedTiles: number;
  unplayedValue: number;
  /** Events that failed to apply (inconsistent log); the summary is still usable. */
  replayErrors: number;
}

export const BINGO_LEN = 7;

/** Parse JSONL text; malformed lines (e.g. a half-written last line) are skipped and counted. */
export function parseLogLines(text: string): { records: Array<Record<string, unknown>>; bad: number } {
  const records: Array<Record<string, unknown>> = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as unknown;
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) records.push(v as Record<string, unknown>);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { records, bad };
}

/** Average rank of `mine` among `scores` (which include it): 1 + #higher + #tied-others / 2. */
export function averageRank(scores: readonly number[], mine: number): number {
  let higher = 0;
  let tied = -1;
  for (const s of scores) {
    if (s > mine) higher++;
    else if (s === mine) tied++;
  }
  return 1 + higher + Math.max(0, tied) / 2;
}

function summarizePlayer(t: MatchTracker, id: PlayerId): PlayerSummary {
  const p = t.view.players.get(id)!;
  const words = p.words.map((w) => w.word);
  return {
    id,
    name: p.info.name,
    isSim: p.info.isSim,
    ...(p.info.simStrategy ? { simStrategy: p.info.simStrategy } : {}),
    score: p.score,
    balance: p.balance,
    lettersWon: p.lettersWon,
    totalPaid: p.totalPaid,
    avgPaid: p.lettersWon > 0 ? p.totalPaid / p.lettersWon : 0,
    words,
    bingos: words.filter((w) => w.length >= BINGO_LEN).length,
  };
}

/** Summarize a FINISHED match log; undefined when it has no start or no 'match ended' record. */
export function summarizeMatch(records: ReadonlyArray<Record<string, unknown>>, file?: string): MatchSummary | undefined {
  const end = records.find((r) => r.k === 'info' && r.msg === 'match ended');
  if (!end) return undefined;
  const events: MatchEvent[] = [];
  for (const r of records) if (r.k === 'event' && r.e && typeof r.e === 'object') events.push(r.e as MatchEvent);
  const start = events[0];
  if (!start || start.t !== 'start') return undefined;
  const armRec = records.find((r) => typeof r.armId === 'string' && (r.armId as string).length > 0);
  const armId = armRec ? (armRec.armId as string) : DEFAULT_ARM_ID;

  const decided = new Map<number, number>();
  const submitted = new Map<number, number>();
  for (const r of records) {
    if (r.k === 'decision' && typeof r.auctionId === 'number' && typeof r.bid === 'number') decided.set(r.auctionId, r.bid);
    if (r.k === 'submit' && r.what === 'bid' && r.outcome === 'ok' && typeof r.auctionId === 'number' && typeof r.value === 'number') {
      submitted.set(r.auctionId, r.value);
    }
  }

  const tracker = trackerFromStart(start);
  const config = tracker.config;
  const opens = new Map<number, { info: AuctionInfo; myBalance: number }>();
  const rows: AuctionRow[] = [];
  let replayErrors = 0;
  for (let i = 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.t === 'start') continue;
    if (e.t === 'open') opens.set(e.auction.auctionId, { info: e.auction, myBalance: tracker.view.me.balance });
    try {
      applyEvent(tracker, e);
    } catch {
      replayErrors++;
      continue;
    }
    if (e.t === 'result') {
      const o: AuctionOutcome = e.outcome;
      const op = opens.get(o.auctionId);
      rows.push({
        index: o.index,
        auctionId: o.auctionId,
        letter: o.letter,
        value: letterValue(o.letter),
        winnerId: o.winnerId,
        paid: o.paid,
        myBid: decided.get(o.auctionId) ?? submitted.get(o.auctionId),
        myBalance: op ? op.myBalance : tracker.view.me.balance,
      });
    }
  }

  const me = summarizePlayer(tracker, config.myId);
  if (typeof end.score === 'number') me.score = end.score;
  if (typeof end.balance === 'number') me.balance = end.balance;
  const others = config.players.filter((p) => p.id !== config.myId).map((p) => summarizePlayer(tracker, p.id));
  const scores = [me.score, ...others.map((o) => o.score)];
  const rank = averageRank(scores, me.score);
  const best = others.reduce<PlayerSummary | undefined>((b, o) => (!b || o.score > b.score ? o : b), undefined);
  const won = !best || me.score >= best.score;
  const unplayed = (end.unplayed ?? {}) as { rack?: string; letters?: number; value?: number };
  const rack = tracker.view.me.rack;
  const ts = typeof end.ts === 'number' ? end.ts : Date.now();
  return {
    matchId: config.matchId,
    ...(file ? { file } : {}),
    endedAt: new Date(ts).toISOString(),
    config,
    armId,
    me,
    others,
    rank,
    won,
    reward: rewardOf(config.players.length, rank),
    winner: won ? me : best!,
    auctions: rows.sort((a, b) => a.index - b.index),
    finalRack: typeof unplayed.rack === 'string' ? unplayed.rack : rackToString(rack),
    unplayedTiles: typeof unplayed.letters === 'number' ? unplayed.letters : rackTotal(rack),
    unplayedValue: typeof unplayed.value === 'number' ? unplayed.value : rackValue(rack),
    replayErrors,
  };
}

export interface LogFile {
  file: string;
  matchId: number;
  mtimeMs: number;
}

/** match-<id>.jsonl files in `dir`, ascending match id (missing dir => []). */
export function scanLogs(dir: string): LogFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LogFile[] = [];
  for (const n of names) {
    const m = /^match-(\d+)\.jsonl$/.exec(n);
    if (!m) continue;
    const file = join(dir, n);
    try {
      out.push({ file, matchId: Number(m[1]), mtimeMs: statSync(file).mtimeMs });
    } catch {
      /* vanished */
    }
  }
  return out.sort((a, b) => a.matchId - b.matchId);
}

/** Summary of one log file, or undefined (unfinished, unreadable or inconsistent). Never throws. */
export function readFinishedMatch(file: string): MatchSummary | undefined {
  try {
    return summarizeMatch(parseLogLines(readFileSync(file, 'utf8')).records, file);
  } catch {
    return undefined;
  }
}

export function matchRecordOf(s: MatchSummary): MatchRec {
  return {
    matchId: s.matchId,
    armId: s.armId,
    endedAt: s.endedAt,
    players: s.config.players.length,
    realPlayers: s.config.players.filter((p) => !p.isSim).length,
    rank: s.rank,
    score: s.me.score,
    bestOtherScore: s.others.reduce((b, o) => Math.max(b, o.score), 0),
    won: s.won,
    reward: s.reward,
    opponents: s.others.map((o) => o.name),
  };
}

/**
 * Add finished matches the live client did not record (its learning hook off or failed) and give
 * their arm the bandit update. Only logs older than graceMs are backfilled so a client that is
 * about to record the match itself wins the race. Returns the backfilled match ids.
 */
export function backfill(s: LearnState, summaries: readonly MatchSummary[], mtimes: ReadonlyMap<number, number>, nowMs: number, graceMs: number): number[] {
  const known = new Set(s.matches.map((m) => m.matchId));
  const out: number[] = [];
  for (const sum of [...summaries].sort((a, b) => a.matchId - b.matchId)) {
    if (known.has(sum.matchId)) continue;
    const mt = mtimes.get(sum.matchId) ?? 0;
    if (nowMs - mt < graceMs) continue;
    const rec = matchRecordOf(sum);
    if (!s.arms.some((a) => a.id === rec.armId)) rec.armId = DEFAULT_ARM_ID;
    s.matches.push(rec);
    banditUpdate(s, rec.armId, rec.reward);
    known.add(sum.matchId);
    out.push(sum.matchId);
  }
  return out;
}

/** Lost = not a (shared) top score and average rank above 1. */
export function isLoss(m: Pick<MatchRec, 'rank' | 'won'>): boolean {
  return m.rank > 1 && !m.won;
}
