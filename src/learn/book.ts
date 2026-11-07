// Opponent book: what we have seen each real rival (by bot NAME, ids change between matches) do
// in our own matches: match count, match wins, mean final score, letters won and the prices paid
// (overall and per letter), plus the field model's end-of-match calibration scale. The scale is
// fed back as the next match's prior (opponents.ts setFieldModelHook), so real-bot price models
// start from what they actually paid against us, blended with the profiles.json prior by count.
import type { AuctionOutcome, MatchView, PlayerId, PlayerInfo } from '../core/types.js';
import type { OpponentKind, OpponentPrior } from '../bots/bawt/opponents.js';
import type { MatchEvent } from '../state/events.js';
import { replay } from '../state/events.js';
import type { BookEntry, BookScale, LearnState } from './store.js';

/** Running means of the calibration scale use at most this many matches (adapts to new versions). */
export const SCALE_WINDOW = 30;
/** Minimum auctions a rival must have been observed in for its end-of-match scale to count. */
export const SCALE_MIN_OBSERVED = 10;

export interface MatchFacts {
  players: readonly PlayerInfo[];
  myId: PlayerId;
  outcomes: readonly AuctionOutcome[];
  scores: ReadonlyMap<PlayerId, number>;
}

export function factsFromView(view: MatchView): MatchFacts {
  const scores = new Map<PlayerId, number>();
  for (const info of view.config.players) scores.set(info.id, view.players.get(info.id)?.score ?? 0);
  return { players: view.config.players, myId: view.config.myId, outcomes: view.history, scores };
}

/** Facts from a recorded MatchEvent stream (live match log or simulator trace). */
export function factsFromEvents(events: readonly MatchEvent[]): MatchFacts {
  return factsFromView(replay(events).view);
}

/** End-of-match calibration of one rival (FieldModel posterior). */
export interface ScaleObservation {
  logScale: number;
  kind: Exclude<OpponentKind, 'sim'>;
  observed: number;
}

function emptyEntry(now: string): BookEntry {
  return { matches: 0, wins: 0, avgScore: 0, avgPricePaid: 0, lettersWon: 0, pricesByLetter: {}, updatedAt: now };
}

/**
 * Fold one finished match into the book (real opponents only; sims are modelled exactly).
 * `scales` = end-of-match calibration by rival name (optional).
 */
export function updateBook(
  state: LearnState,
  facts: MatchFacts,
  now: Date = new Date(),
  scales?: ReadonlyMap<string, ScaleObservation>,
): string[] {
  const ts = now.toISOString();
  const touched: string[] = [];
  let best = -Infinity;
  let nBest = 0;
  for (const s of facts.scores.values()) {
    if (s > best) {
      best = s;
      nBest = 1;
    } else if (s === best) nBest++;
  }
  for (const info of facts.players) {
    if (info.id === facts.myId || info.isSim || !info.name) continue;
    const e = (state.book[info.name] ??= emptyEntry(ts));
    const score = facts.scores.get(info.id) ?? 0;
    e.matches += 1;
    if (score === best && nBest === 1) e.wins += 1;
    e.avgScore += (score - e.avgScore) / e.matches;
    let paid = 0;
    let won = 0;
    for (const o of facts.outcomes) {
      if (o.winnerId !== info.id) continue;
      won++;
      paid += o.paid;
      const L = o.letter.toUpperCase();
      const pl = (e.pricesByLetter[L] ??= { n: 0, mean: 0 });
      pl.n += 1;
      pl.mean += (o.paid - pl.mean) / pl.n;
    }
    if (won > 0) {
      e.avgPricePaid = (e.avgPricePaid * e.lettersWon + paid) / (e.lettersWon + won);
      e.lettersWon += won;
    }
    const sc = scales?.get(info.name);
    if (sc && sc.observed >= SCALE_MIN_OBSERVED && Number.isFinite(sc.logScale)) {
      const prev: BookScale | undefined = e.scale && e.scale.kind === sc.kind ? e.scale : undefined;
      const n = (prev?.n ?? 0) + 1;
      const mean = prev ? prev.meanLog + (sc.logScale - prev.meanLog) / Math.min(n, SCALE_WINDOW) : sc.logScale;
      e.scale = { n, meanLog: mean, kind: sc.kind };
    }
    e.updatedAt = ts;
    touched.push(info.name);
  }
  return touched;
}

/** Book prior for a rival's field model, when the book holds a scale measured against `kind`. */
export function bookPrior(entry: BookEntry | undefined, kind: Exclude<OpponentKind, 'sim'>): OpponentPrior | undefined {
  const s = entry?.scale;
  if (!s || s.kind !== kind || !(s.n > 0) || !Number.isFinite(s.meanLog)) return undefined;
  return { logScale: s.meanLog, n: s.n };
}
