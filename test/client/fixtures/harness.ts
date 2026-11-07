// Test harness: a FakeServer wired to a MatchDriver through a fake reducer host and a manual clock.
import { VALUE, idx } from '../../../src/core/letters.js';
import { rackClone } from '../../../src/core/rack.js';
import type { AuctionInfo, Decision, DecideContext, MatchView, Policy, PolicyFactory } from '../../../src/core/types.js';
import { getEngine } from '../../../src/engine/index.js';
import { MatchDriver, type DriverOptions, type SubmissionRecord } from '../../../src/client/adapter.js';
import { ClientClock } from '../../../src/client/clock.js';
import { Logger, type MatchLog } from '../../../src/client/log.js';
import { FakeServer, DEFAULT_PLAYERS, type FakeServerOptions } from './fakeServer.js';

/**
 * Deterministic test policy (no rng, no budget dependence): bids value + 1 + (index % 3) capped at
 * balance; plays its best >= 5-letter word mid-match; on the last two auctions plays the exact
 * packing of the whole rack (as a "flush" policy would).
 */
export class ScriptedPolicy implements Policy {
  readonly name = 'scripted';
  decideCalls = 0;
  constructor(
    private readonly over: {
      bid?: (view: MatchView, a: AuctionInfo) => number;
      words?: (view: MatchView, a: AuctionInfo) => string[];
    } = {},
  ) {}
  onMatchStart(): void {}
  decide(view: MatchView, auction: AuctionInfo, _ctx: DecideContext): Decision {
    this.decideCalls++;
    const words = this.over.words ? this.over.words(view, auction) : defaultWords(view, auction);
    const bid = this.over.bid ? this.over.bid(view, auction) : Math.min(view.me.balance, VALUE[idx(auction.letter)]! + 1 + (auction.index % 3));
    return { words, bid };
  }
}

export function defaultWords(view: MatchView, auction: AuctionInfo): string[] {
  const { index, packer } = getEngine();
  if (auction.remainingAfter <= 1) return packer.packExact(rackClone(view.me.rack)).words;
  const w = index.findBestPlayable(view.me.rack, 5);
  return w ? [w] : [];
}

export const scriptedFactory =
  (over?: ConstructorParameters<typeof ScriptedPolicy>[0]): PolicyFactory =>
  () =>
    new ScriptedPolicy(over);

export interface HarnessOptions extends Partial<FakeServerOptions> {
  skewMs?: number;
  policyFactory?: PolicyFactory;
  driver?: Partial<DriverOptions>;
  clockMarginMs?: number;
}

export class Harness {
  readonly server: FakeServer;
  readonly clock: ClientClock;
  readonly queue: Array<() => void> = [];
  readonly submissions: SubmissionRecord[] = [];
  readonly logLines: string[] = [];
  readonly logger: Logger;
  driver: MatchDriver;
  private readonly skewMs: number;
  private readonly opts: HarnessOptions;

  constructor(opts: HarnessOptions = {}) {
    this.opts = opts;
    this.skewMs = opts.skewMs ?? 0;
    this.server = new FakeServer({ players: DEFAULT_PLAYERS, meId: 101, seed: 7, ...opts });
    this.clock = new ClientClock({ now: () => this.localMs(), marginMs: opts.clockMarginMs ?? 120 });
    this.logger = new Logger({ sink: (_f, l) => this.logLines.push(l) });
    this.driver = this.newDriver(false);
    this.server.onTx = (tx) => this.driver.applyTx(tx, this.localMs());
  }

  localMs(): number {
    return this.server.serverMs + this.skewMs;
  }

  newDriver(resume: boolean, log?: MatchLog): MatchDriver {
    return new MatchDriver({
      matchId: this.server.matchId,
      myBotId: this.server.meId,
      policyFactory: this.opts.policyFactory ?? scriptedFactory(),
      seed: 1,
      host: this.server,
      target: { host: 'http://127.0.0.1:3000' },
      guardOptions: { env: {} },
      clock: this.clock,
      log: log ?? this.logger.match(this.server.matchId),
      botInfo: this.server.botInfo,
      resume,
      schedule: (fn) => this.queue.push(fn),
      flushPacker: getEngine().packer,
      onSubmit: (s) => this.submissions.push(s),
      ...this.opts.driver,
    });
  }

  /** Start: start transaction, then the per-match snapshot (first auction from initial rows). */
  start(): void {
    this.server.startTx();
    this.driver.applySnapshot(this.server.snapshot(), this.localMs());
  }

  /** Run microtasks and queued refine passes until quiet. */
  async settle(): Promise<void> {
    for (let k = 0; k < 50; k++) {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      if (this.queue.length === 0) {
        await new Promise((r) => setImmediate(r));
        if (this.queue.length === 0) return;
      }
      const fns = this.queue.splice(0);
      for (const f of fns) f();
    }
  }

  /** One auction cycle: settle, optional mid-auction hook, advance to the close, close, settle. */
  async step(mid?: (h: Harness) => void | Promise<void>): Promise<void> {
    await this.settle();
    if (mid) {
      this.server.advanceMs(300);
      await mid(this);
      await this.settle();
    }
    const a = this.server.current!;
    this.server.serverUs = a.closesAtUs;
    this.server.closeTx();
    await this.settle();
  }

  async runToEnd(mid?: (h: Harness, auctionIndex: number) => void | Promise<void>): Promise<void> {
    while (!this.server.ended) {
      const i = this.server.auctions.length - 1;
      await this.step(mid ? (h) => mid(h, i) : undefined);
    }
    await this.settle();
  }

  callsFor(name: string): number {
    return this.server.calls.filter((c) => c.name === name).length;
  }
}
