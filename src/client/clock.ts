// Per-connection latency / clock estimation and bid deadlines (PITFALLS C5, STACK §7).
//
//   rtt        reducer round trip (send -> promise settle): EWMA + p90 over a sliding window
//   lag        arrival-lag samples localRecv - opens_at, taken ONLY from auctions received live in
//              the transaction that opened them (steady state). lag = clock skew + downlink delay.
//   offsetEst  robust low percentile (p10) of the lag window
//
//   deadlineFor(a, recv, {late}) = min(recv + (closesAt - opensAt), closesAt + offsetEst) - rttP90 - margin
//
// Deliveries from subscription initial rows (first auction of a match, reconnect snapshots) or
// processed after an event-loop stall are `late`: their recv time says nothing about the opening
// time, so only the closesAt + offsetEst branch is trusted. Without an offset estimate a late
// delivery uses the recv branch minus an extra 250 ms.
// All times are local wall-aligned ms (performance.timeOrigin + performance.now()), server times
// are epoch ms from row timestamps.

export interface ClockOptions {
  /** Safety margin subtracted from every deadline (default 120 ms, PITFALLS C5). */
  marginMs?: number;
  /** Extra margin for late deliveries without an offset estimate (default 250 ms). */
  lateExtraMs?: number;
  /** RTT assumed before any sample (default 100 ms). */
  defaultRttMs?: number;
  /** Sliding window sizes. */
  rttWindow?: number;
  lagWindow?: number;
  /** EWMA weight of a new RTT sample (default 0.2). */
  rttAlpha?: number;
  /** A live open whose lag exceeds offsetEst + this is treated as a stall => late (default 150 ms). */
  stallMs?: number;
  /** Local cost to issue a submission, subtracted by budgetFor (default 5 ms). */
  submitCostMs?: number;
  /** Local clock (default performance.timeOrigin + performance.now()). */
  now?: () => number;
}

export interface DeadlineInput {
  opensAtMs: number;
  closesAtMs: number;
}

/** Wall-aligned monotonic local clock in ms. */
export function localNowMs(): number {
  return performance.timeOrigin + performance.now();
}

/** Nearest-rank percentile of an unsorted sample (p in [0, 1]); NaN when empty. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[rank]!;
}

class Ring {
  private readonly buf: number[] = [];
  private pos = 0;
  constructor(private readonly cap: number) {}
  push(v: number): void {
    if (this.buf.length < this.cap) this.buf.push(v);
    else {
      this.buf[this.pos] = v;
      this.pos = (this.pos + 1) % this.cap;
    }
  }
  values(): readonly number[] {
    return this.buf;
  }
  get size(): number {
    return this.buf.length;
  }
}

/** Consecutive late live opens after which the lag window is reset (regime shift). */
const RESET_AFTER_LATE = 4;
/** Upper bound on the RTT term of a deadline (ms). */
const MAX_RTT_GUARD_MS = 350;

export class ClientClock {
  readonly marginMs: number;
  readonly lateExtraMs: number;
  readonly defaultRttMs: number;
  readonly stallMs: number;
  readonly submitCostMs: number;
  private readonly alpha: number;
  private readonly rtts: Ring;
  private lags: Ring;
  private readonly lagWindowSize: number;
  private consecutiveLate = 0;
  /** Times the lag window was reset after a regime shift. */
  offsetResets = 0;
  private ewma: number | undefined;
  private p90Cache: number | undefined;
  private offsetCache: number | undefined;
  private readonly clock: () => number;

  constructor(opts: ClockOptions = {}) {
    this.marginMs = opts.marginMs ?? 120;
    this.lateExtraMs = opts.lateExtraMs ?? 250;
    this.defaultRttMs = opts.defaultRttMs ?? 100;
    this.stallMs = opts.stallMs ?? 150;
    this.submitCostMs = opts.submitCostMs ?? 5;
    this.alpha = opts.rttAlpha ?? 0.2;
    this.rtts = new Ring(opts.rttWindow ?? 64);
    this.lagWindowSize = opts.lagWindow ?? 64;
    this.lags = new Ring(this.lagWindowSize);
    this.clock = opts.now ?? localNowMs;
  }

  now(): number {
    return this.clock();
  }

  /** Record one reducer round trip (send -> settle) in ms. */
  recordRtt(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.rtts.push(ms);
    this.ewma = this.ewma === undefined ? ms : this.ewma + this.alpha * (ms - this.ewma);
    this.p90Cache = undefined;
  }

  get rttSamples(): number {
    return this.rtts.size;
  }

  get rttEwma(): number {
    return this.ewma ?? this.defaultRttMs;
  }

  /** p90 RTT over the window (defaultRttMs before any sample). */
  get rttP90(): number {
    if (this.rtts.size === 0) return this.defaultRttMs;
    if (this.p90Cache === undefined) this.p90Cache = percentile(this.rtts.values(), 0.9);
    return this.p90Cache;
  }

  /**
   * Record a steady-state arrival-lag sample (auction received live in its opening transaction).
   * Callers must not feed initial-row / snapshot / stalled deliveries.
   */
  recordArrival(opensAtMs: number, recvLocalMs: number): void {
    const lag = recvLocalMs - opensAtMs;
    if (!Number.isFinite(lag)) return;
    this.lags.push(lag);
    this.offsetCache = undefined;
  }

  get lagSamples(): number {
    return this.lags.size;
  }

  /** p10 of the arrival-lag window (skew + downlink), undefined before any sample. */
  get offsetEst(): number | undefined {
    if (this.lags.size === 0) return undefined;
    if (this.offsetCache === undefined) this.offsetCache = percentile(this.lags.values(), 0.1);
    return this.offsetCache;
  }

  /**
   * Classify a live open: returns true (late) when its lag exceeds offsetEst + stallMs (event-loop
   * stall or delayed frame). Non-late live opens are recorded as lag samples.
   */
  observeLiveOpen(opensAtMs: number, recvLocalMs: number): boolean {
    const off = this.offsetEst;
    const lag = recvLocalMs - opensAtMs;
    if (off !== undefined && lag > off + this.stallMs) {
      // Regime shift guard: if the lag stays high for several opens in a row (network latency or
      // local clock stepped up), the old offset is stale. Without this the offset froze at the old
      // value, every deadline came out too early and every bid was skipped (live 2026-11-07).
      if (++this.consecutiveLate >= RESET_AFTER_LATE) {
        this.lags = new Ring(this.lagWindowSize);
        this.offsetCache = undefined;
        this.consecutiveLate = 0;
        this.recordArrival(opensAtMs, recvLocalMs);
        this.offsetResets++;
        return false;
      }
      return true;
    }
    this.consecutiveLate = 0;
    this.recordArrival(opensAtMs, recvLocalMs);
    return false;
  }

  /** Local time after which no submission for this auction may be sent. */
  deadlineFor(a: DeadlineInput, recvLocalMs: number, opts: { late?: boolean } = {}): number {
    const duration = a.closesAtMs - a.opensAtMs;
    const recvBranch = recvLocalMs + duration;
    const off = this.offsetEst;
    // cap the RTT allowance: a burst of slow reducer replies once pushed rttP90 past the auction
    // length, every deadline fell in the past, no bid was sent, so no new RTT sample could ever
    // bring it back (live 2026-11-07 22:28: 68/68 auctions skipped)
    const guard = Math.min(this.rttP90, MAX_RTT_GUARD_MS) + this.marginMs;
    if (off === undefined) {
      return recvBranch - guard - (opts.late ? this.lateExtraMs : 0);
    }
    const offBranch = a.closesAtMs + off;
    return (opts.late ? offBranch : Math.min(recvBranch, offBranch)) - guard;
  }

  /** Compute budget for a policy call: deadline - now - submitCost (may be <= 0). */
  budgetFor(deadline: number, now: number = this.now(), submitCostMs: number = this.submitCostMs): number {
    return deadline - now - submitCostMs;
  }

  stats(): Record<string, number | undefined> {
    return {
      rttSamples: this.rtts.size,
      rttEwma: this.rttEwma,
      rttP90: this.rttP90,
      lagSamples: this.lags.size,
      offsetEst: this.offsetEst,
    };
  }
}
