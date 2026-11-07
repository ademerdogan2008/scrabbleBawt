// Shadow mode: spectate live matches as a GHOST OBSERVER (CLI-06, plan 02-04).
//
// Fair play and safety:
//   * Anonymous identity (server-minted, never persisted). The bot token is never used here.
//   * Subscriptions: subscriptions.perMatchQueries(M) plus the small `bot` roster table. Every list
//     passes assertQueriesAllowed, so the live top-bid leak view can never be subscribed.
//   * No reducer path exists: this module never imports guard.callReducer and the observer has no
//     reducer host at all. Would-be bids and words are only logged.
//
// Ghost seat: MatchConfig.players = real roster (match_participant id order) + one synthetic
// PlayerInfo {id: -1, name: 'shadow'} as myId; totalAuctions = 98 - startingRackSize * (real P);
// myStartRack is empty. The ghost never wins and never plays, so the tracker never throws, and every
// real seat is an opponent, so the unseen invariant holds:
//     total(unseen) == bagRemaining + Σ_real hiddenUnknown.
// Event order per transaction is identical to adapter.MatchDriver (results -> words -> balances ->
// new open -> end) and the log is the same MatchLog format, so `replay(eventsFromLog(file))` works.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuctionInfo, MatchConfig, Policy, PolicyFactory } from '../core/types.js';
import { Rng } from '../core/rng.js';
import { MatchRecorder, replay, type MatchEvent } from '../state/events.js';
import type { MatchTracker, TrackerDiagnostics } from '../state/tracker.js';
import {
  auctionInfo,
  buildMatchConfig,
  outcomeOf,
  rebuildFromSnapshot,
  type AuctionRow,
  type BotRow,
  type MatchStateRow,
  type MatchTx,
  type ParticipantRow,
  type ResultRow,
  type TournamentPhase,
  type WordRow,
} from './adapter.js';
import { ClientClock, percentile } from './clock.js';
import type { ClientConfig } from './config.js';
import { ConnectionSupervisor } from './connection.js';
import { eventsFromLog, Logger, type MatchLog } from './log.js';
import type { DbConnection } from './module_bindings/index';
import { bindConnection, cacheSnapshot, matchSlice, type SessionCore, type GlobalTx } from './session.js';
import {
  assertQueriesAllowed,
  FORBIDDEN_TABLES,
  perMatchQueries,
  rangeProbeQueries,
  safeUnsubscribe,
  subscribeQueries,
  type SubscriptionHandleLike,
} from './subscriptions.js';

export const GHOST_ID = -1;
export const GHOST_NAME = 'shadow';

/** Queries of the ghost observer for match M: the per-match set plus the bot roster. */
export function shadowQueries(matchId: number): string[] {
  return assertQueriesAllowed([...perMatchQueries(matchId), 'SELECT * FROM "bot"']);
}

/**
 * Ghost MatchConfig: real roster in match_participant id order plus the synthetic ghost seat (last),
 * myId = GHOST_ID, totalAuctions from the REAL participant count.
 */
export function ghostMatchConfig(
  state: MatchStateRow,
  participants: readonly ParticipantRow[],
  botInfo: (id: number) => BotRow | undefined,
  phase?: TournamentPhase,
): MatchConfig {
  const real = participants.filter((p) => p.botId !== GHOST_ID);
  const base = buildMatchConfig(state, real, GHOST_ID, botInfo, phase); // totalAuctions = 98 - rack * real P
  return { ...base, players: [...base.players, { id: GHOST_ID, name: GHOST_NAME, isSim: false }], myId: GHOST_ID };
}

// ---------------------------------------------------------------------------------------------
// GhostObserver

export interface GhostOptions {
  matchId: number;
  policyFactory: PolicyFactory;
  policyOpts?: Record<string, unknown>;
  seed: number;
  clock: ClientClock;
  log?: MatchLog;
  botInfo: (id: number) => BotRow | undefined;
  /** SHADOW_SEAT: a real seat (bot id) whose balance/score label every decision record. */
  seatBotId?: number;
  anchorBudgetMs?: number;
  maxRefineBudgetMs?: number;
  /** Schedules the refine pass (default setImmediate). */
  schedule?: (fn: () => void) => void;
  onEnded?: (g: GhostObserver) => void;
}

export interface GhostStats {
  /** Auction opens seen (snapshot + live). */
  opens: number;
  /** Opens received live in their opening transaction. */
  liveOpens: number;
  /** Opens tagged late (snapshot delivery, event-loop stall, or lag above offsetEst + stallMs). */
  lateOpens: number;
  /** localRecv - opens_at (ms) of every live open (includes clock skew). */
  recvLatencyMs: number[];
  /** recv -> processing start (event-loop lag) per processed transaction. */
  loopLagMs: number[];
  decideMs: number[];
  /** recv -> anchor decision done (when a live bot would send its anchor bid). */
  anchorMs: number[];
  decisions: number;
  wouldBids: number;
  wouldBidTotal: number;
  wouldWords: number;
  /** Opens whose would-be anchor decision came after the deadline (never happens unless stalled). */
  pastDeadline: number;
  results: number;
  words: number;
  policyErrors: number;
}

export function emptyGhostStats(): GhostStats {
  return {
    opens: 0,
    liveOpens: 0,
    lateOpens: 0,
    recvLatencyMs: [],
    loopLagMs: [],
    decideMs: [],
    anchorMs: [],
    decisions: 0,
    wouldBids: 0,
    wouldBidTotal: 0,
    wouldWords: 0,
    pastDeadline: 0,
    results: 0,
    words: 0,
    policyErrors: 0,
  };
}

/** p50/p90/p99 summary of ghost stats (NaN-free: 0 when empty). */
export function summarizeGhost(s: GhostStats): Record<string, number> {
  const p = (a: number[], q: number): number => (a.length === 0 ? 0 : percentile(a, q));
  return {
    opens: s.opens,
    liveOpens: s.liveOpens,
    lateOpens: s.lateOpens,
    recvP50: p(s.recvLatencyMs, 0.5),
    recvP90: p(s.recvLatencyMs, 0.9),
    recvP99: p(s.recvLatencyMs, 0.99),
    recvMax: s.recvLatencyMs.length ? Math.max(...s.recvLatencyMs) : 0,
    loopLagP99: p(s.loopLagMs, 0.99),
    decideP50: p(s.decideMs, 0.5),
    decideP99: p(s.decideMs, 0.99),
    anchorP50: p(s.anchorMs, 0.5),
    anchorP99: p(s.anchorMs, 0.99),
    decisions: s.decisions,
    wouldBids: s.wouldBids,
    wouldBidTotal: s.wouldBidTotal,
    wouldWords: s.wouldWords,
    pastDeadline: s.pastDeadline,
    results: s.results,
    words: s.words,
    policyErrors: s.policyErrors,
  };
}

interface GhostPlay {
  info: AuctionInfo;
  recvLocalMs: number;
  late: boolean;
  deadline: number;
  closed: boolean;
  refined: boolean;
}

export class GhostObserver {
  readonly matchId: number;
  readonly stats: GhostStats = emptyGhostStats();
  startRound: number | undefined;
  private readonly o: GhostOptions;
  private readonly store = {
    state: undefined as MatchStateRow | undefined,
    participants: new Map<number, ParticipantRow>(),
    auctions: new Map<number, AuctionRow>(),
    results: new Map<number, ResultRow>(),
    words: new Map<number, WordRow>(),
    phase: undefined as TournamentPhase | undefined,
  };
  private recorder: MatchRecorder | undefined;
  private policy: Policy | undefined;
  private readonly rng: Rng;
  private readonly appliedResults = new Set<number>();
  private readonly appliedWords = new Set<number>();
  private readonly openedAuctions = new Set<number>();
  private play: GhostPlay | undefined;
  private endedFlag = false;
  private disposed = false;

  constructor(opts: GhostOptions) {
    this.o = opts;
    this.matchId = opts.matchId;
    this.rng = new Rng(opts.seed);
  }

  get started(): boolean {
    return this.recorder !== undefined;
  }
  get ended(): boolean {
    return this.endedFlag;
  }
  get tracker(): MatchTracker | undefined {
    return this.recorder?.tracker;
  }
  get events(): readonly MatchEvent[] {
    return this.recorder?.events ?? [];
  }
  get config(): MatchConfig | undefined {
    return this.recorder?.tracker.config;
  }

  dispose(): void {
    this.disposed = true;
    if (this.play) this.play.closed = true;
  }

  private now(): number {
    return this.o.clock.now();
  }

  private ingest(tx: MatchTx): void {
    const s = this.store;
    const m = this.matchId;
    for (const r of tx.matchStates) if (r.id === m) s.state = r;
    for (const r of tx.participants) if (r.matchId === m) s.participants.set(r.botId, r);
    for (const r of tx.auctions) if (r.matchId === m) s.auctions.set(r.id, r);
    for (const r of tx.results) if (r.matchId === m) s.results.set(r.auctionId, r);
    for (const r of tx.words) if (r.matchId === m) s.words.set(r.id, r);
    for (const r of tx.tournamentMatches) if (r.matchId === m) s.phase = r.phase;
  }

  private auctionIndex(id: number): number {
    let n = 0;
    for (const k of this.store.auctions.keys()) if (k < id) n++;
    return n;
  }

  private emit(e: MatchEvent): void {
    this.recorder!.apply(e);
    this.o.log?.event(e);
  }

  private lag(recvLocalMs: number): boolean {
    const lag = this.now() - recvLocalMs;
    this.stats.loopLagMs.push(lag);
    return lag > this.o.clock.stallMs;
  }

  /** Initial rows of the per-match subscription: rebuild history, then observe the open auction. */
  applySnapshot(tx: MatchTx, recvLocalMs: number): void {
    if (this.disposed) return;
    this.ingest(tx);
    if (this.started) {
      this.processLive(tx, recvLocalMs, true);
      return;
    }
    this.lag(recvLocalMs);
    const s = this.store;
    const state = s.state;
    if (!state || s.participants.size === 0) {
      this.o.log?.record({ k: 'error', msg: 'snapshot without match_state / participants' });
      return;
    }
    const participants = [...s.participants.values()];
    const config = ghostMatchConfig(state, participants, this.o.botInfo, s.phase);
    const rebuilt = rebuildFromSnapshot(
      {
        state,
        participants,
        auctions: [...s.auctions.values()],
        results: [...s.results.values()],
        words: [...s.words.values()],
        rack: [],
      },
      config,
    );
    this.startRound = state.currentRound;
    this.recorder = new MatchRecorder(config, rebuilt.myStartRack);
    this.o.log?.event(this.recorder.events[0]!);
    this.policy = this.o.policyFactory(this.o.seed, this.o.policyOpts);
    for (const e of rebuilt.events) {
      this.emit(e);
      if (e.t === 'result') {
        this.appliedResults.add(e.outcome.auctionId);
        this.stats.results++;
      }
      if (e.t === 'open') {
        this.openedAuctions.add(e.auction.auctionId);
        this.stats.opens++;
      }
      if (e.t === 'word') this.stats.words++;
    }
    for (const w of s.words.values()) this.appliedWords.add(w.id);
    for (const info of config.players) {
      const p = s.participants.get(info.id);
      if (p) this.emit({ t: 'balance', id: p.botId, balance: p.balance, score: p.score });
    }
    this.o.log?.record({
      k: 'info',
      msg: 'ghost started from snapshot',
      startRound: state.currentRound,
      status: state.status,
      realPlayers: participants.length,
      totalAuctions: config.totalAuctions,
      history: rebuilt.events.length,
    });
    this.safePolicy('onMatchStart', () => this.policy!.onMatchStart(this.recorder!.tracker.view));
    if (state.status === 'Ended') {
      this.finish('snapshot');
      return;
    }
    const current = rebuilt.openAuction;
    if (current && state.status === 'Running' && this.recorder.tracker.view.current?.auctionId === current.auctionId) {
      this.stats.lateOpens++;
      this.beginAuction(current, recvLocalMs, true);
    }
  }

  /** One live server transaction (rows of this match). */
  applyTx(tx: MatchTx, recvLocalMs: number): void {
    if (this.disposed) return;
    this.ingest(tx);
    if (!this.started || this.endedFlag) return;
    this.processLive(tx, recvLocalMs, false);
  }

  private processLive(tx: MatchTx, recvLocalMs: number, late: boolean): void {
    const tr = this.recorder!.tracker;
    const stalled = this.lag(recvLocalMs);
    const m = this.matchId;

    // 1. results
    const newResults = tx.results
      .filter((r) => r.matchId === m && !this.appliedResults.has(r.auctionId))
      .sort((a, b) => a.auctionId - b.auctionId);
    let lastResultIndex: number | undefined;
    for (const r of newResults) {
      const index = this.auctionIndex(r.auctionId);
      this.appliedResults.add(r.auctionId);
      if (this.play && this.play.info.auctionId === r.auctionId) this.play.closed = true;
      const outcome = outcomeOf(r, index);
      this.emit({ t: 'result', outcome });
      this.stats.results++;
      lastResultIndex = index;
      if (this.o.seatBotId !== undefined && r.winnerBotId === this.o.seatBotId) {
        this.o.log?.record({ k: 'info', msg: 'seat won', auctionId: r.auctionId, letter: r.letter, paid: r.paid });
      }
      this.safePolicy('onAuctionClosed', () => this.policy?.onAuctionClosed?.(tr.view, outcome));
    }

    // 2. words (dedupe by row id; same attribution rule as the live driver)
    const newWords = tx.words
      .filter((w) => w.matchId === m && !this.appliedWords.has(w.id))
      .sort((a, b) => (a.playedAtUs < b.playedAtUs ? -1 : a.playedAtUs > b.playedAtUs ? 1 : a.id - b.id));
    for (const w of newWords) {
      this.appliedWords.add(w.id);
      const index =
        lastResultIndex ?? tr.view.current?.index ?? (tr.view.history.length > 0 ? tr.view.history[tr.view.history.length - 1]!.index : 0);
      this.emit({ t: 'word', ev: { playerId: w.botId, word: w.word, reward: w.reward, auctionIndex: index } });
      this.stats.words++;
    }

    // 3. balances (authoritative resync of every real seat touched in this transaction)
    const seen = new Set<number>();
    for (const p of tx.participants) {
      if (p.matchId !== m || seen.has(p.botId)) continue;
      seen.add(p.botId);
      const cur = this.store.participants.get(p.botId);
      if (!cur || !tr.view.players.has(p.botId)) continue;
      this.emit({ t: 'balance', id: cur.botId, balance: cur.balance, score: cur.score });
    }

    // 4. new auction open
    const opens = tx.auctions
      .filter((a) => a.matchId === m && a.open && !this.openedAuctions.has(a.id) && !this.store.results.has(a.id))
      .sort((a, b) => a.id - b.id);
    for (const a of opens) {
      const cur = this.store.auctions.get(a.id)!;
      const index = this.auctionIndex(a.id);
      const state = this.store.state;
      const remaining =
        state && state.currentAuctionId === a.id ? state.bagTotal : Math.max(0, tr.config.totalAuctions - 1 - index);
      const info = auctionInfo(cur, index, remaining);
      this.openedAuctions.add(info.auctionId);
      this.emit({ t: 'open', auction: info });
      this.stats.opens++;
      let isLate = late || stalled;
      if (!late) {
        this.stats.liveOpens++;
        this.stats.recvLatencyMs.push(recvLocalMs - info.opensAtMs);
      }
      if (!isLate) isLate = this.o.clock.observeLiveOpen(info.opensAtMs, recvLocalMs);
      if (isLate) this.stats.lateOpens++;
      this.beginAuction(info, recvLocalMs, isLate);
    }

    // 5. match end
    if (this.store.state?.status === 'Ended') this.finish('live');
  }

  private safePolicy(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.stats.policyErrors++;
      this.o.log?.record({ k: 'error', msg: `policy.${what} threw`, error: String(e) });
    }
  }

  private beginAuction(info: AuctionInfo, recvLocalMs: number, late: boolean): void {
    if (this.play) this.play.closed = true;
    const deadline = this.o.clock.deadlineFor(info, recvLocalMs, { late });
    const play: GhostPlay = { info, recvLocalMs, late, deadline, closed: false, refined: false };
    this.play = play;
    this.pass(play, 'anchor', this.o.anchorBudgetMs ?? 15);
    if (info.remainingAfter === 0) return; // final auction: a live bot flushes at the anchor
    const sched = this.o.schedule ?? ((fn: () => void) => setImmediate(fn));
    sched(() => {
      if (play.closed || this.disposed || play.refined) return;
      play.refined = true;
      const budget = Math.min(this.o.maxRefineBudgetMs ?? 250, this.o.clock.budgetFor(play.deadline, this.now()));
      if (budget >= 3) this.pass(play, 'refine', budget);
    });
  }

  private pass(play: GhostPlay, pass: 'anchor' | 'refine', budgetMs: number): void {
    if (!this.policy || this.disposed) return;
    const tr = this.recorder!.tracker;
    if (tr.view.current?.auctionId !== play.info.auctionId) return;
    const t0 = performance.now();
    let decision: { words: string[]; bid: number } = { words: [], bid: 0 };
    try {
      decision = this.policy.decide(tr.view, play.info, {
        budgetMs,
        rng: this.rng,
        now: () => performance.now(),
        netRttMs: this.o.clock.rttP90,
      });
    } catch (e) {
      this.stats.policyErrors++;
      this.o.log?.record({ k: 'error', msg: 'policy.decide threw', error: String(e), auctionId: play.info.auctionId });
    }
    const decideMs = performance.now() - t0;
    const doneAt = this.now();
    this.stats.decisions++;
    this.stats.decideMs.push(decideMs);
    const bid = Number.isFinite(decision.bid) ? Math.max(0, Math.floor(decision.bid)) : 0;
    if (pass === 'anchor') {
      this.stats.anchorMs.push(doneAt - play.recvLocalMs);
      if (doneAt >= play.deadline) this.stats.pastDeadline++;
      if (bid > 0) {
        this.stats.wouldBids++;
        this.stats.wouldBidTotal += bid;
      }
      this.stats.wouldWords += decision.words.length;
    }
    const rec: Record<string, unknown> = {
      k: 'decision',
      auctionId: play.info.auctionId,
      index: play.info.index,
      pass,
      bid,
      words: decision.words,
      decideMs,
      budgetMs,
      late: play.late,
      ghost: true,
      recvLagMs: play.recvLocalMs - play.info.opensAtMs,
      msToDeadline: play.deadline - doneAt,
    };
    if (this.o.seatBotId !== undefined && tr.view.players.has(this.o.seatBotId)) {
      const seat = tr.player(this.o.seatBotId);
      rec.seat = { botId: this.o.seatBotId, balance: seat.balance, score: seat.score };
    }
    this.o.log?.record(rec as never);
  }

  private finish(source: string): void {
    if (this.endedFlag) return;
    this.endedFlag = true;
    if (this.play) this.play.closed = true;
    const tr = this.recorder?.tracker;
    if (tr) {
      this.safePolicy('onMatchEnd', () => this.policy?.onMatchEnd?.(tr.view));
      const scores = tr.view.opponents.map((p) => ({ id: p.info.id, name: p.info.name, score: p.score, balance: p.balance }));
      this.o.log?.record({ k: 'info', msg: 'match ended', source, ghost: true, scores, diagnostics: { ...tr.diagnostics } });
      this.o.log?.record({ k: 'timing', ghost: true, ...summarizeGhost(this.stats) });
    }
    this.o.log?.flush();
    this.o.onEnded?.(this);
  }
}

// ---------------------------------------------------------------------------------------------
// Running-match discovery (HTTP SQL, read-only, anonymous)

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** ws(s):// -> http(s):// base URL without trailing slash. */
export function httpBase(host: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `https://${host}`;
  return withScheme.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:').replace(/\/+$/, '');
}

/** Tiny read-only SQL client with an in-memory anonymous identity (never persisted or printed). */
export class AnonSql {
  private token: string | undefined;
  constructor(
    private readonly base: string,
    private readonly db: string,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}

  async query(sql: string): Promise<unknown[][]> {
    if (!/^SELECT /.test(sql)) throw new Error('AnonSql: only SELECT statements');
    if (FORBIDDEN_TABLES.some((t) => sql.toLowerCase().includes(t))) throw new Error('AnonSql: forbidden view');
    if (!this.token) {
      const r = await this.fetchImpl(`${this.base}/v1/identity`, { method: 'POST' });
      if (!r.ok) throw new Error(`identity mint failed: HTTP ${r.status}`);
      const j = JSON.parse(await r.text()) as { token?: string };
      if (!j.token) throw new Error('identity mint: no token');
      this.token = j.token;
    }
    const res = await this.fetchImpl(`${this.base}/v1/database/${this.db}/sql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'text/plain' },
      body: sql,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`sql HTTP ${res.status}: ${text.split(this.token).join('<redacted>').slice(0, 200)}`);
    const parsed = JSON.parse(text) as Array<{ rows: unknown[][] }>;
    return parsed[0]?.rows ?? [];
  }
}

/** Option encoding [0, v] -> v, [1, []] -> null. */
function optU64(v: unknown): number | null {
  return Array.isArray(v) && v[0] === 0 ? Number(v[1]) : null;
}

export interface RunningMatch {
  id: number;
  currentRound: number;
}

/**
 * Newest Running match: open lobby L (anon view) -> resolved_match_id of lobbies id >= L-8 ->
 * match_state rows id >= newest-16 with status Running (variant index 1). Read-only.
 */
export async function findRunningMatches(sql: AnonSql): Promise<RunningMatch[]> {
  const lobbies = await sql.query('SELECT id FROM open_lobbies');
  const open = lobbies.length ? Number(lobbies[0]![0]) : undefined;
  let bound: number | undefined;
  if (open !== undefined) {
    const rows = await sql.query(`SELECT id, resolved_match_id FROM lobby WHERE id >= ${Math.max(0, open - 8)}`);
    for (const r of rows) {
      const m = optU64(r[1]);
      if (m !== null && (bound === undefined || m > bound)) bound = m;
    }
  }
  if (bound === undefined) return [];
  const rows = await sql.query(`SELECT id, status, current_round FROM match_state WHERE id >= ${Math.max(0, bound - 16)}`);
  return rows
    .filter((r) => Array.isArray(r[1]) && (r[1] as unknown[])[0] === 1)
    .map((r) => ({ id: Number(r[0]), currentRound: Number(r[2]) }))
    .sort((a, b) => b.id - a.id);
}

// ---------------------------------------------------------------------------------------------
// runShadow (entrypoint behind SHADOW=1 and scripts/client-shadow.ts)

export interface ShadowRunOptions {
  cfg: ClientConfig;
  policyFactory: PolicyFactory;
  matches: number;
  timeoutMin: number;
  /** SHADOW_SEAT: bot id or name of a real seat to label logs with. */
  seat?: string;
  logger?: Logger;
  /** Run the range-predicate probe once (default true). */
  probe?: boolean;
  /** Prefer matches at or below this round (default 3); falls back to the newest after 30 s. */
  freshRound?: number;
  /** Only observe matches joined at or below freshRound (full matches); never fall back. */
  freshOnly?: boolean;
  fetchImpl?: FetchLike;
}

export interface ShadowMatchResult {
  matchId: number;
  startRound: number;
  completed: boolean;
  events: number;
  eventCounts: Record<string, number>;
  diagnostics: TrackerDiagnostics | undefined;
  replayDiagnostics: TrackerDiagnostics | undefined;
  replayMatches: boolean;
  timing: Record<string, number>;
  logFile: string;
  error?: string;
}

export interface ShadowResult {
  ok: boolean;
  reason?: string;
  matches: ShadowMatchResult[];
  rangeProbe?: { ok: boolean; rows?: number; error?: string; ms: number };
  clock: Record<string, number | undefined>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function countEvents(events: readonly MatchEvent[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const e of events) c[e.t] = (c[e.t] ?? 0) + 1;
  return c;
}

/** Replay a match log file through src/state; returns its diagnostics and the final tracker. */
export function replayLogFile(path: string): { tracker: MatchTracker; events: MatchEvent[] } {
  const events = eventsFromLog(readFileSync(path, 'utf8'));
  return { tracker: replay(events), events };
}

/** Spectate `matches` live matches anonymously as a ghost observer. Never calls a reducer. */
export async function runShadow(o: ShadowRunOptions): Promise<ShadowResult> {
  const { cfg } = o;
  const logger = o.logger ?? new Logger({ dir: cfg.logDir, level: cfg.logLevel, console: true });
  const clock = new ClientClock();
  const sql = new AnonSql(httpBase(cfg.host), cfg.db, o.fetchImpl);
  const results: ShadowMatchResult[] = [];
  const observed = new Set<number>();
  const bots = new Map<number, BotRow>();
  let rangeProbe: ShadowResult['rangeProbe'];

  // Connection (anonymous; supervisor never reads cfg.botToken when anonymous).
  let conn: DbConnection | undefined;
  let generation = -1;
  let onTx: ((tx: GlobalTx, recv: number) => void) | undefined;
  let connectedResolve!: () => void;
  const connected = new Promise<void>((r) => (connectedResolve = r));
  const supervisor = new ConnectionSupervisor({
    cfg,
    log: logger,
    anonymous: true,
    onConnected: ({ conn: c, generation: g }) => {
      conn = c;
      generation = g;
      // bindConnection only calls core.applyTx(tx, recv): route each batched transaction to the ghost.
      const sink = { applyTx: (tx: GlobalTx, recv: number) => onTx?.(tx, recv) } as unknown as SessionCore;
      bindConnection(c, sink, clock);
      connectedResolve();
    },
  });
  supervisor.start();

  const subscribe = (queries: string[], timeoutMs: number): Promise<SubscriptionHandleLike> =>
    new Promise((resolve, reject) => {
      if (!conn) return reject(new Error('not connected'));
      const t = setTimeout(() => reject(new Error('subscription timeout')), timeoutMs);
      const h = subscribeQueries(conn as never, queries, {
        onApplied: () => {
          clearTimeout(t);
          resolve(h);
        },
        onError: (msg) => {
          clearTimeout(t);
          reject(new Error(msg));
        },
      });
    });

  const refreshBots = (): void => {
    if (!conn) return;
    for (const r of conn.db.bot.iter()) {
      const b = { id: Number(r.id), name: r.name, isSimulated: r.isSimulated, strategy: r.strategy.tag };
      bots.set(b.id, b);
    }
  };
  const seatBotId = (): number | undefined => {
    if (!o.seat) return undefined;
    const n = Number(o.seat);
    if (Number.isInteger(n) && n > 0) return n;
    for (const b of bots.values()) if (b.name === o.seat) return b.id;
    return undefined;
  };

  const finish = (ok: boolean, reason?: string): ShadowResult => {
    onTx = undefined;
    supervisor.stop();
    logger.info('shadow finished', { ok, reason, matches: results.length });
    logger.flush();
    return { ok, reason, matches: results, rangeProbe, clock: clock.stats() };
  };

  try {
    await Promise.race([connected, sleep(30_000).then(() => Promise.reject(new Error('connect timeout')))]);
    const botSub = await subscribe(assertQueriesAllowed(['SELECT * FROM "bot"']), 30_000);
    refreshBots();

    for (let k = 0; k < o.matches; k++) {
      // 1. find a running match we have not observed yet
      const waitUntil = Date.now() + o.timeoutMin * 60_000;
      const preferUntil = Date.now() + 30_000;
      let target: RunningMatch | undefined;
      while (Date.now() < waitUntil) {
        let running: RunningMatch[] = [];
        try {
          running = (await findRunningMatches(sql)).filter((m) => !observed.has(m.id));
        } catch (e) {
          logger.warn('running-match query failed', { error: String(e) });
        }
        const fresh = running.find((m) => m.currentRound <= (o.freshRound ?? 3));
        target = fresh ?? (!o.freshOnly && Date.now() >= preferUntil ? running[0] : undefined);
        if (target) break;
        await sleep(2000);
      }
      if (!target) {
        logger.error('no running match found', { timeoutMin: o.timeoutMin });
        return finish(false, 'no running match found');
      }
      observed.add(target.id);
      const M = target.id;
      logger.info('shadowing match', { matchId: M, round: target.currentRound });

      // 2. range-predicate probe (once): does the server accept `match_id > X`?
      if ((o.probe ?? true) && !rangeProbe) {
        const t0 = Date.now();
        try {
          const h = await subscribe(rangeProbeQueries(M - 1), 15_000);
          let rows = 0;
          for (const a of conn!.db.auction.iter()) if (Number(a.matchId) > M - 1) rows++;
          safeUnsubscribe(h);
          rangeProbe = { ok: true, rows, ms: Date.now() - t0 };
        } catch (e) {
          rangeProbe = { ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
        }
        logger.info('range probe', rangeProbe);
      }

      // 3. ghost-observe M until Ended
      const log = logger.match(M);
      const gen0 = generation;
      let endedResolve!: () => void;
      const ended = new Promise<void>((r) => (endedResolve = r));
      let lastTx = Date.now();
      const ghost = new GhostObserver({
        matchId: M,
        policyFactory: o.policyFactory,
        policyOpts: cfg.params,
        seed: M,
        clock,
        log,
        botInfo: (id) => bots.get(id),
        seatBotId: seatBotId(),
        onEnded: () => endedResolve(),
      });
      onTx = (tx, recv) => {
        if (tx.bots.length) for (const b of tx.bots) bots.set(b.id, b);
        const slice = matchSlice(tx, M);
        if (slice.matchStates.length + slice.auctions.length + slice.results.length + slice.words.length + slice.participants.length === 0) return;
        lastTx = Date.now();
        ghost.applyTx(slice, recv);
      };
      let error: string | undefined;
      let sub: SubscriptionHandleLike | undefined;
      try {
        sub = await subscribe(shadowQueries(M), 30_000);
        refreshBots();
        ghost.applySnapshot(matchSlice(cacheSnapshot(conn!), M), clock.now());
        while (!ghost.ended) {
          if (generation !== gen0) {
            error = 'connection lost mid-match (observation abandoned)';
            break;
          }
          if (Date.now() - lastTx > 60_000) {
            error = 'no transaction for 60 s';
            break;
          }
          await Promise.race([ended, sleep(1000)]);
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      ghost.dispose();
      onTx = undefined;
      safeUnsubscribe(sub);
      logger.flush();

      const logFile = join(cfg.logDir, log.file);
      let replayDiagnostics: TrackerDiagnostics | undefined;
      let replayMatches = false;
      let events: MatchEvent[] = [];
      try {
        const r = replayLogFile(logFile);
        events = r.events;
        replayDiagnostics = { ...r.tracker.diagnostics };
        const live = ghost.tracker;
        replayMatches =
          !!live &&
          JSON.stringify(r.tracker.snapshot().opponents.map((p) => [p.info.id, p.score, p.balance])) ===
            JSON.stringify(live.snapshot().opponents.map((p) => [p.info.id, p.score, p.balance]));
      } catch (e) {
        error = error ?? `replay failed: ${e instanceof Error ? e.message : String(e)}`;
      }
      results.push({
        matchId: M,
        startRound: ghost.startRound ?? 0,
        completed: ghost.ended && !error,
        events: events.length,
        eventCounts: countEvents(events),
        diagnostics: ghost.tracker ? { ...ghost.tracker.diagnostics } : undefined,
        replayDiagnostics,
        replayMatches,
        timing: summarizeGhost(ghost.stats),
        logFile,
        error,
      });
      logger.info('shadow match done', { matchId: M, completed: ghost.ended && !error, error });
    }
    safeUnsubscribe(botSub);
    const ok = results.every((r) => r.completed && r.replayMatches && diagZero(r.replayDiagnostics));
    return finish(ok, ok ? undefined : 'a shadow match failed (see results)');
  } catch (e) {
    return finish(false, e instanceof Error ? e.message : String(e));
  }
}

export function diagZero(d: TrackerDiagnostics | undefined): boolean {
  return !!d && d.balanceMismatches === 0 && d.rackMismatches === 0 && d.hiddenOverflow === 0 && d.unseenNegative === 0;
}

