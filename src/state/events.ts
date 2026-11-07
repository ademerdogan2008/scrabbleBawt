// Serializable match event log. The simulator and the live client both emit these; replaying a
// recorded trace through a fresh MatchTracker reproduces the exact same MatchView.
// All events are plain JSON (racks as sorted letter strings, e.g. "AEINRST").
import { rackFromWord, rackToString, type Rack } from '../core/rack.js';
import type { AuctionInfo, AuctionOutcome, MatchConfig, PlayerId, WordPlayEvent } from '../core/types.js';
import { MatchTracker } from './tracker.js';

export type MatchEvent =
  | { t: 'start'; config: MatchConfig; myStartRack: string }
  | { t: 'open'; auction: AuctionInfo }
  | { t: 'result'; outcome: AuctionOutcome }
  | { t: 'word'; ev: WordPlayEvent }
  | { t: 'balance'; id: PlayerId; balance: number; score: number }
  | { t: 'rack'; rack: string };

/** Build the 'start' event (normalizes the rack to a sorted string). */
export function startEvent(config: MatchConfig, myStartRack: Rack | string): MatchEvent {
  const rack = typeof myStartRack === 'string' ? rackFromWord(myStartRack) : myStartRack;
  return { t: 'start', config, myStartRack: rackToString(rack) };
}

/** Create a tracker from a 'start' event. */
export function trackerFromStart(e: MatchEvent): MatchTracker {
  if (e.t !== 'start') throw new Error(`trackerFromStart: expected 'start' event, got '${e.t}'`);
  return new MatchTracker(e.config, rackFromWord(e.myStartRack));
}

/** Apply one non-start event to a tracker. */
export function applyEvent(tracker: MatchTracker, e: MatchEvent): void {
  switch (e.t) {
    case 'start':
      throw new Error("applyEvent: 'start' may only be the first event (use replay/trackerFromStart)");
    case 'open':
      tracker.auctionOpen(e.auction);
      return;
    case 'result':
      tracker.auctionResult(e.outcome);
      return;
    case 'word':
      tracker.wordPlay(e.ev);
      return;
    case 'balance':
      tracker.setBalance(e.id, e.balance, e.score);
      return;
    case 'rack':
      tracker.setMyRack(rackFromWord(e.rack));
      return;
    default: {
      const never: never = e;
      throw new Error(`applyEvent: unknown event ${JSON.stringify(never)}`);
    }
  }
}

/** Replay a full trace. The first event must be 'start'. */
export function replay(events: readonly MatchEvent[]): MatchTracker {
  const first = events[0];
  if (!first || first.t !== 'start') throw new Error("replay: first event must be 'start'");
  const tracker = trackerFromStart(first);
  for (let k = 1; k < events.length; k++) applyEvent(tracker, events[k]!);
  return tracker;
}

/**
 * A tracker that records every event it applies, so a match can be dumped as a trace.
 * Events are stored by reference; callers must not mutate them after recording.
 */
export class MatchRecorder {
  readonly tracker: MatchTracker;
  readonly events: MatchEvent[];

  constructor(config: MatchConfig, myStartRack: Rack | string) {
    const start = startEvent(config, myStartRack);
    this.tracker = trackerFromStart(start);
    this.events = [start];
  }

  apply(e: MatchEvent): void {
    applyEvent(this.tracker, e);
    this.events.push(e);
  }

  open(auction: AuctionInfo): void {
    this.apply({ t: 'open', auction });
  }

  result(outcome: AuctionOutcome): void {
    this.apply({ t: 'result', outcome });
  }

  word(ev: WordPlayEvent): void {
    this.apply({ t: 'word', ev });
  }

  balance(id: PlayerId, balance: number, score: number): void {
    this.apply({ t: 'balance', id, balance, score });
  }

  rack(rack: Rack | string): void {
    this.apply({ t: 'rack', rack: typeof rack === 'string' ? rackToString(rackFromWord(rack)) : rackToString(rack) });
  }

  toJSON(): MatchEvent[] {
    return this.events;
  }
}
