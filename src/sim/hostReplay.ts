// SIMULATOR VERIFICATION ONLY. Do not import from src/bots or src/client (fair-play guard:
// test/sim/fairplayGuard.test.ts). Not re-exported from src/sim/index.ts. Our bot never uses
// host-RNG inference (PROJECT.md fair-play decision).
//
// hostReplay re-simulates a historical ALL-SIM match from its public timestamps by driving the
// SAME runMatchCore + step functions as runMatch, with
//   - a MatchRngSource backed by the server RNG (one HostRandom per transaction: match start at
//     started_at, each close at its closed_at), consumed in module order (RULES.md §4.2), and
//   - the datastore iteration-order model of RULES.md §4.3 (rows updated in the transaction
//     first, then committed rows in a per-key vector maintained by swap_remove + push).
import type { AuctionType, PlayerId, SimStrategy } from '../core/types.js';
import { HostRandom, hostShuffle } from './hostRng.js';
import { DEFAULT_SPEC, runMatchCore, type MatchResult, type MatchSpec, type SeatSpec } from './match.js';
import type { BidOrderModel, MatchRngSource, TxBoundary } from './rngStreams.js';

export interface HostSim {
  id: PlayerId;
  name: string;
  strategy: SimStrategy;
}

/** Public rows of one historical match (see test/fixtures/allsim/extract.ts). */
export interface HostMatch {
  id: number;
  startedAt: number;
  auctionType: AuctionType;
  auctionDurationMs: number;
  startingRackSize: number;
  /** Participant bot ids in match_participant id (roster) order. */
  roster: PlayerId[];
  /** closed_at (µs) of every auction, in auction order. */
  closedAt: readonly number[];
}

export interface HostReplayOptions {
  /** Simulated bots in `bot` table-scan order (the lobby padding pool). */
  sims: readonly HostSim[];
  /** Lobby max size (padding target). */
  lobbyMaxSize: number;
  /** Real (non-sim) lobby members before padding (0 for all-sim matches). */
  realMembers?: number;
}

export interface HostReplayResult {
  result: MatchResult;
  /** Sim padding order predicted by the lobby-timeout shuffle (should equal the roster). */
  predictedPadOrder: PlayerId[];
}

class HostRngSource implements MatchRngSource {
  private rng: HostRandom | undefined;
  predictedPadOrder: PlayerId[] = [];

  constructor(
    private readonly match: HostMatch,
    private readonly opts: HostReplayOptions,
  ) {}

  beginTx(tx: TxBoundary): void {
    if (tx.kind === 'start') {
      // Lobby timeout transaction: shuffle(availableSims) over every sim not in the roster
      // (S-1 calls, even when fewer sims are needed), then the deal.
      this.rng = new HostRandom(this.match.startedAt);
      const real = this.opts.realMembers ?? 0;
      const rosterSims = new Set(this.match.roster.slice(0, real));
      const avail = this.opts.sims.map((s) => s.id).filter((id) => !rosterSims.has(id));
      hostShuffle(this.rng, avail);
      this.predictedPadOrder = avail.slice(0, Math.max(this.opts.lobbyMaxSize - real, 0));
      return;
    }
    const ts = this.match.closedAt[tx.index];
    if (ts === undefined) throw new Error(`hostReplay: no closed_at for auction ${tx.index}`);
    this.rng = new HostRandom(ts);
  }

  private r(): HostRandom {
    if (!this.rng) throw new Error('hostReplay: RNG used outside a transaction');
    return this.rng;
  }

  deal(bagTotal: number): number {
    return this.r().integerInRange(0, bagTotal - 1);
  }

  draw(bagTotal: number): number {
    return this.r().integerInRange(0, bagTotal - 1);
  }

  simJitter(): number {
    return this.r().integerInRange(-2, 2);
  }

  tieShuffle(i: number): number {
    return this.r().integerInRange(0, i);
  }
}

/** RULES.md §4.3 mpByMatch iteration order: in-transaction updated rows first, then committed order. */
export class HostOrderModel implements BidOrderModel {
  private committed: number[] = [];
  private updated: number[] = [];

  reset(seatCount: number): void {
    this.committed = Array.from({ length: seatCount }, (_, k) => k);
    this.updated = [];
  }

  participantOrder(): readonly number[] {
    if (this.updated.length === 0) return this.committed;
    return [...this.updated, ...this.committed.filter((s) => !this.updated.includes(s))];
  }

  onCloseUpdated(seat: number | null): void {
    this.updated = seat === null ? [] : [seat];
  }

  onCloseCommit(): void {
    for (const s of this.updated) this.swapRemovePush(s);
    this.updated = [];
  }

  onWord(seat: number): void {
    this.swapRemovePush(seat);
  }

  /** Committed per-key vector after commit: swap_remove the row, push it to the end. */
  private swapRemovePush(seat: number): void {
    const a = this.committed;
    const i = a.indexOf(seat);
    if (i >= 0) {
      a[i] = a[a.length - 1]!;
      a.pop();
    }
    a.push(seat);
  }
}

/** Re-simulate an all-sim historical match through runMatchCore with the host RNG and order model. */
export function hostReplay(match: HostMatch, opts: HostReplayOptions): HostReplayResult {
  const byId = new Map(opts.sims.map((s) => [s.id, s]));
  const seats: SeatSpec[] = match.roster.map((id) => {
    const sim = byId.get(id);
    if (!sim) throw new Error(`hostReplay: participant ${id} is not a known sim (all-sim matches only)`);
    return { id, name: sim.name, kind: 'sim', simStrategy: sim.strategy };
  });
  const spec: MatchSpec = {
    ...DEFAULT_SPEC,
    auctionType: match.auctionType,
    auctionDurationMs: match.auctionDurationMs,
    startingRackSize: match.startingRackSize,
    matchId: match.id,
    trace: true,
  };
  const source = new HostRngSource(match, opts);
  const result = runMatchCore(spec, seats, source, new HostOrderModel(), match.id);
  return { result, predictedPadOrder: source.predictedPadOrder };
}
