// Live session: lobby + tournament lifecycle around one MatchDriver per running match.
//
//   SessionCore      pure lifecycle logic over normalized rows (unit-tested with fakes)
//   bindConnection   SDK row callbacks -> per-transaction GlobalTx batches -> SessionCore
//   runSession       lock file + logger + ConnectionSupervisor + bindConnection (02-04 entrypoints)
//
// Lifecycle: join_lobby when not in a Running match, not held for a tournament, not NO_LADDER and
// below MAX_MATCHES; rejoin after Ended; TOURNAMENT_ID registration ('auto' registers once for any
// tournament in Registration); "already in a running match" / tournament refusals are handled
// quietly. New matches are detected from our match_participant rows (lobby AND tournament starts).
// Every reducer goes through guard.ts: on maincloud without ALLOW_MAINCLOUD_PLAY=1 the session logs
// "read-only: refusing to play" and stops before any call.
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hashSeed } from '../core/rng.js';
import type { PolicyFactory } from '../core/types.js';
import {
  emptyMatchTx,
  MatchDriver,
  normAuction,
  normBot,
  normMatchState,
  normParticipant,
  normRack,
  normResult,
  normTournamentMatch,
  normWord,
  type BotRow,
  type DriverOptions,
  type MatchTx,
} from './adapter.js';
import { ClientClock } from './clock.js';
import { repoRoot, type ClientConfig } from './config.js';
import { ConnectionSupervisor } from './connection.js';
import { callReducer, isBlocked, lazyReducerHost, type GuardOptions, type GuardTarget, type ReducerHost } from './guard.js';
import { Logger } from './log.js';
import type { DbConnection } from './module_bindings/index';
import {
  identityQueries,
  myBotQueries,
  perMatchQueries,
  safeUnsubscribe,
  subscribeQueries,
  type SubscriptionHandleLike,
} from './subscriptions.js';
import { loadDefaultFlushPacker, type FlushPacker } from './words.js';

// ---------------------------------------------------------------------------------------------
// Global rows

export interface CredentialRow {
  identityHex: string;
  botId: number;
  connected: boolean;
}
export interface TournamentRow {
  id: number;
  status: string; // TournamentStatus tag: Lobby | Registration | Swiss | Bracket | Final | Ended | ForceEnded
}
export interface EntryRow {
  id: number;
  tournamentId: number;
  botId: number;
  eliminated: boolean;
}
export interface LobbyRow {
  id: number;
  status: string;
}
export interface LobbyMemberRow {
  id: number;
  lobbyId: number;
  botId: number;
}

/** Every row change of one server transaction (all tables), or a full cache snapshot. */
export interface GlobalTx extends MatchTx {
  bots: BotRow[];
  credentials: CredentialRow[];
  tournaments: TournamentRow[];
  entries: EntryRow[];
  openLobbies: LobbyRow[];
  openLobbiesDeleted: LobbyRow[];
  openLobbyMembers: LobbyMemberRow[];
  openLobbyMembersDeleted: LobbyMemberRow[];
}

export function emptyGlobalTx(): GlobalTx {
  return {
    ...emptyMatchTx(),
    bots: [],
    credentials: [],
    tournaments: [],
    entries: [],
    openLobbies: [],
    openLobbiesDeleted: [],
    openLobbyMembers: [],
    openLobbyMembersDeleted: [],
  };
}

/** Rows of `tx` that belong to match `m` (my_rack filtered by match_id, PITFALLS M13). */
export function matchSlice(tx: MatchTx, m: number): MatchTx {
  return {
    matchStates: tx.matchStates.filter((r) => r.id === m),
    participants: tx.participants.filter((r) => r.matchId === m),
    auctions: tx.auctions.filter((r) => r.matchId === m),
    results: tx.results.filter((r) => r.matchId === m),
    words: tx.words.filter((r) => r.matchId === m),
    rack: tx.rack.filter((r) => r.matchId === m),
    rackDeleted: tx.rackDeleted.filter((r) => r.matchId === m),
    tournamentMatches: tx.tournamentMatches.filter((r) => r.matchId === m),
  };
}

function isEmptySlice(t: MatchTx): boolean {
  return (
    t.matchStates.length + t.participants.length + t.auctions.length + t.results.length + t.words.length +
      t.rack.length + t.rackDeleted.length + t.tournamentMatches.length ===
    0
  );
}

// ---------------------------------------------------------------------------------------------
// Lock file (PITFALLS M15: one live process per bot)

export class LockError extends Error {
  constructor(path: string, pid: number) {
    super(`another live client (pid ${pid}) holds ${path}`);
    this.name = 'LockError';
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockPath(botName: string, root: string = repoRoot()): string {
  return join(root, '.cache', `client-${botName}.lock`);
}

/** Acquire the per-bot lock; throws LockError if another live pid holds it (stale locks are taken over). */
export function acquireLock(path: string, pid: number = process.pid): void {
  if (existsSync(path)) {
    const held = Number(readFileSync(path, 'utf8').trim());
    if (held !== pid && pidAlive(held)) throw new LockError(path, held);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(pid), { mode: 0o600 });
}

/** Remove the lock if we hold it. */
export function releaseLock(path: string, pid: number = process.pid): void {
  try {
    if (existsSync(path) && Number(readFileSync(path, 'utf8').trim()) === pid) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// SessionCore

export type SessionStatus = 'init' | 'running' | 'refused' | 'done' | 'stopped' | 'error';

export interface SessionDeps {
  cfg: Pick<ClientConfig, 'botName' | 'host' | 'isMaincloud' | 'noLadder' | 'maxMatches' | 'tournamentId' | 'params'>;
  policyFactory: PolicyFactory;
  host: ReducerHost;
  clock: ClientClock;
  logger: Logger;
  /** Subscribe to a query list; onApplied fires once the initial rows are in the cache. */
  subscribe(queries: string[], cb: { onApplied: () => void; onError: (msg: string) => void }): SubscriptionHandleLike;
  /** Full current cache (all subscribed tables) as a GlobalTx. */
  snapshot(): GlobalTx;
  /** Current cache rows of one match. */
  matchSnapshot(matchId: number): MatchTx;
  guardOptions?: GuardOptions;
  flushPacker?: FlushPacker;
  schedule?: (fn: () => void) => void;
  /** Delay before unsubscribing an ended match (default 3000 ms; tests pass a sync scheduler). */
  later?: (fn: () => void, ms: number) => void;
  /** Minimum ms between failed join_lobby retries (default 2000). */
  joinRetryMs?: number;
  seed?: number;
  driverOptions?: Partial<DriverOptions>;
  onStatus?: (s: SessionStatus, reason?: string) => void;
}

const QUIET_JOIN_ERRORS = ["You're already in a running match", "You're playing in a tournament"];

export class SessionCore {
  status: SessionStatus = 'init';
  myBotId: number | undefined;
  identityHex: string | undefined;
  matchesPlayed = 0;
  tournamentHold = false;
  readonly drivers = new Map<number, MatchDriver>();
  private readonly finished = new Set<number>();
  private readonly matchSubs = new Map<number, SubscriptionHandleLike>();
  private readonly bootSubs: SubscriptionHandleLike[] = [];
  private readonly bots = new Map<number, BotRow>();
  private readonly credentials = new Map<string, CredentialRow>();
  private readonly tournaments = new Map<number, TournamentRow>();
  private readonly entries = new Map<number, EntryRow>();
  private readonly lobbyMembers = new Map<number, LobbyMemberRow>();
  private readonly myMatches = new Set<number>();
  private readonly registrationAttempted = new Set<number>();
  private booted = false;
  private joinInFlight = false;
  private nextJoinAt = 0;
  private errorHold = false;
  private generation = 0;
  private readonly target: GuardTarget;

  constructor(private readonly d: SessionDeps) {
    this.target = { host: d.cfg.host, isMaincloud: d.cfg.isMaincloud };
  }

  private setStatus(s: SessionStatus, reason?: string): void {
    this.status = s;
    this.d.onStatus?.(s, reason);
  }

  /** Read-only refusal check; must pass before connecting. Returns false when refused. */
  start(): boolean {
    if (isBlocked('join_lobby', this.target, this.d.guardOptions)) {
      this.d.logger.error('read-only: refusing to play', { host: this.d.cfg.host });
      this.setStatus('refused', 'read-only: refusing to play');
      return false;
    }
    this.setStatus('running');
    return true;
  }

  get active(): boolean {
    return this.status === 'running';
  }

  stop(status: SessionStatus = 'stopped', reason?: string): void {
    if (!this.active && this.status !== 'init') return;
    for (const dr of this.drivers.values()) dr.dispose();
    for (const h of this.matchSubs.values()) safeUnsubscribe(h);
    this.matchSubs.clear();
    for (const h of this.bootSubs.splice(0)) safeUnsubscribe(h);
    this.d.logger.info('session stopped', { status, reason, matchesPlayed: this.matchesPlayed });
    this.setStatus(status, reason);
  }

  // ----- connection lifecycle -------------------------------------------------------------------

  /** A (new) connection is up: (re)subscribe. Running drivers are rebuilt from fresh snapshots. */
  onConnected(identityHex: string): void {
    if (!this.active) return;
    if (this.generation > 0) {
      // Reconnect: the old connection's pending calls and caches are gone (PITFALLS M9).
      for (const [m, dr] of this.drivers) {
        dr.dispose();
        if (!dr.ended) this.d.logger.warn('reconnect: match will resume from snapshot', { matchId: m });
      }
      this.drivers.clear();
      this.matchSubs.clear();
      this.bootSubs.length = 0;
      this.booted = false;
      this.joinInFlight = false;
    }
    this.generation++;
    this.identityHex = identityHex.toLowerCase().replace(/^0x/, '');
    const h = this.d.subscribe(identityQueries(this.identityHex), {
      onApplied: () => this.onIdentityApplied(),
      onError: (msg) => this.d.logger.error('identity subscription failed', { error: msg }),
    });
    this.bootSubs.push(h);
  }

  private onIdentityApplied(): void {
    if (!this.active) return;
    this.ingest(this.d.snapshot());
    const cred = this.identityHex ? this.credentials.get(this.identityHex) : undefined;
    if (!cred) {
      this.d.logger.error('no BotCredential for this identity (set BOT_TOKEN / claim a credential)');
      this.stop('error', 'no credential');
      return;
    }
    const first = this.myBotId === undefined;
    this.myBotId = cred.botId;
    if (first) this.d.logger.info('acting as bot', { botId: cred.botId, name: this.bots.get(cred.botId)?.name });
    const h = this.d.subscribe(myBotQueries(cred.botId), {
      onApplied: () => this.onMyBotApplied(),
      onError: (msg) => this.d.logger.error('bot subscription failed', { error: msg }),
    });
    this.bootSubs.push(h);
  }

  private onMyBotApplied(): void {
    if (!this.active) return;
    this.ingest(this.d.snapshot());
    this.booted = true;
    // We are in at most one running match: only the newest seat can still be Running.
    let newest: number | undefined;
    for (const m of this.myMatches) if (!this.finished.has(m) && (newest === undefined || m > newest)) newest = m;
    if (newest !== undefined) this.ensureDriver(newest, true);
    this.lifecycle();
  }

  // ----- row ingestion -------------------------------------------------------------------------

  private ingest(tx: GlobalTx): number[] {
    for (const b of tx.bots) this.bots.set(b.id, b);
    for (const c of tx.credentials) this.credentials.set(c.identityHex.toLowerCase().replace(/^0x/, ''), c);
    for (const t of tx.tournaments) this.tournaments.set(t.id, t);
    for (const e of tx.entries) this.entries.set(e.id, e);
    for (const m of tx.openLobbyMembers) this.lobbyMembers.set(m.id, m);
    for (const m of tx.openLobbyMembersDeleted) this.lobbyMembers.delete(m.id);
    const fresh: number[] = [];
    if (this.myBotId !== undefined) {
      for (const p of tx.participants) {
        if (p.botId !== this.myBotId || this.myMatches.has(p.matchId)) continue;
        this.myMatches.add(p.matchId);
        fresh.push(p.matchId);
      }
    }
    if (tx.tournaments.length || tx.entries.length) this.errorHold = false;
    return fresh;
  }

  /** One live server transaction. */
  applyTx(tx: GlobalTx, recvLocalMs: number = this.d.clock.now()): void {
    if (!this.active) return;
    const fresh = this.ingest(tx);
    if (this.booted) for (const m of fresh) this.ensureDriver(m, false);
    for (const [m, dr] of this.drivers) {
      const slice = matchSlice(tx, m);
      if (!isEmptySlice(slice)) dr.applyTx(slice, recvLocalMs);
    }
    this.lifecycle();
  }

  // ----- matches --------------------------------------------------------------------------------

  private ensureDriver(matchId: number, resume: boolean): void {
    if (this.drivers.has(matchId) || this.finished.has(matchId) || this.myBotId === undefined) return;
    const log = this.d.logger.match(matchId);
    const dr = new MatchDriver({
      matchId,
      myBotId: this.myBotId,
      policyFactory: this.d.policyFactory,
      policyOpts: this.d.cfg.params,
      seed: hashSeed(this.d.seed ?? 0, matchId, this.myBotId),
      host: this.d.host,
      target: this.target,
      guardOptions: this.d.guardOptions,
      clock: this.d.clock,
      log,
      botInfo: (id) => this.bots.get(id),
      resume,
      schedule: this.d.schedule,
      flushPacker: this.d.flushPacker,
      onEnded: (x) => this.onDriverEnded(x),
      ...this.d.driverOptions,
    });
    this.drivers.set(matchId, dr);
    this.d.logger.info(resume ? 'tracking match (resume check)' : 'new match', { matchId });
    const h = this.d.subscribe(perMatchQueries(matchId), {
      onApplied: () => {
        if (!this.active || this.drivers.get(matchId) !== dr) return;
        dr.applySnapshot(this.d.matchSnapshot(matchId), this.d.clock.now());
        this.lifecycle();
      },
      onError: (msg) => this.d.logger.error('match subscription failed', { matchId, error: msg }),
    });
    this.matchSubs.set(matchId, h);
  }

  private onDriverEnded(dr: MatchDriver): void {
    const m = dr.matchId;
    this.finished.add(m);
    const played = dr.stats.decisions > 0;
    if (played) this.matchesPlayed++;
    this.d.logger.info('match finished', { matchId: m, played, matchesPlayed: this.matchesPlayed });
    const later = this.d.later ?? ((fn: () => void, ms: number) => setTimeout(fn, ms).unref?.());
    later(() => {
      if (this.drivers.get(m) === dr) this.drivers.delete(m);
      safeUnsubscribe(this.matchSubs.get(m));
      this.matchSubs.delete(m);
    }, 3000);
    const max = this.d.cfg.maxMatches;
    if (max !== undefined && this.matchesPlayed >= max) {
      this.stop('done', `MAX_MATCHES=${max} reached`);
      return;
    }
    // Lifecycle re-evaluation happens after the current transaction (applyTx calls lifecycle()).
    queueMicrotask(() => this.lifecycle());
  }

  /** True while any tracked match has not ended. */
  inRunningMatch(): boolean {
    for (const dr of this.drivers.values()) if (!dr.ended) return true;
    return false;
  }

  private heldForTournament(): boolean {
    if (this.errorHold) return true;
    for (const e of this.entries.values()) {
      if (e.botId !== this.myBotId || e.eliminated) continue;
      const t = this.tournaments.get(e.tournamentId);
      if (t && (t.status === 'Swiss' || t.status === 'Bracket' || t.status === 'Final')) return true;
    }
    return false;
  }

  private inOpenLobby(): boolean {
    for (const m of this.lobbyMembers.values()) if (m.botId === this.myBotId) return true;
    return false;
  }

  /** Re-evaluate tournament registration and lobby join. */
  lifecycle(): void {
    if (!this.active || !this.booted || this.myBotId === undefined) return;
    this.tournamentHold = this.heldForTournament();
    this.maybeRegister();
    this.maybeJoinLobby();
  }

  private maybeRegister(): void {
    const want = this.d.cfg.tournamentId;
    if (want === undefined) return;
    for (const t of this.tournaments.values()) {
      if (t.status !== 'Registration') continue;
      if (want !== 'auto' && t.id !== want) continue;
      if (this.registrationAttempted.has(t.id)) continue;
      const already = [...this.entries.values()].some((e) => e.tournamentId === t.id && e.botId === this.myBotId);
      this.registrationAttempted.add(t.id);
      if (already) continue;
      this.d.logger.info('registering for tournament', { tournamentId: t.id });
      this.call('register_for_tournament', { tournamentId: BigInt(t.id) }).then(
        () => this.d.logger.info('registered for tournament', { tournamentId: t.id }),
        (e: unknown) => this.d.logger.warn('tournament registration refused', { tournamentId: t.id, error: errMsg(e) }),
      );
    }
  }

  private maybeJoinLobby(): void {
    if (this.d.cfg.noLadder || this.joinInFlight || this.inRunningMatch() || this.tournamentHold) return;
    const max = this.d.cfg.maxMatches;
    if (max !== undefined && this.matchesPlayed >= max) return;
    if (this.inOpenLobby()) return;
    const now = this.d.clock.now();
    if (now < this.nextJoinAt) return;
    this.joinInFlight = true;
    const gen = this.generation;
    this.call('join_lobby', {}).then(
      () => {
        if (gen !== this.generation) return;
        this.joinInFlight = false;
        this.d.logger.info('joined lobby');
      },
      (e: unknown) => {
        if (gen !== this.generation) return;
        this.joinInFlight = false;
        const msg = errMsg(e);
        this.nextJoinAt = this.d.clock.now() + (this.d.joinRetryMs ?? 2000);
        if (msg.startsWith("You're playing in a tournament")) this.errorHold = true;
        if (QUIET_JOIN_ERRORS.some((q) => msg.startsWith(q))) this.d.logger.debug('join_lobby refused', { error: msg });
        else this.d.logger.warn('join_lobby failed', { error: msg });
      },
    );
  }

  private call(name: string, args: Record<string, unknown>): Promise<void> {
    try {
      return callReducer(this.d.host, name, args, this.target, this.d.guardOptions);
    } catch (e) {
      this.d.logger.error('read-only: refusing to play', { reducer: name });
      this.stop('refused', 'read-only: refusing to play');
      return Promise.reject(e);
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------------------------
// SDK binding

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ctx = { event: { id: string; tag: string } };

function normCredential(r: { identity: { toHexString(): string }; botId: bigint; connected: boolean }): CredentialRow {
  return { identityHex: r.identity.toHexString().toLowerCase(), botId: Number(r.botId), connected: r.connected };
}
function normTournament(r: { id: bigint; status: { tag: string } }): TournamentRow {
  return { id: Number(r.id), status: r.status.tag };
}
function normEntry(r: { id: bigint; tournamentId: bigint; botId: bigint; eliminated: boolean }): EntryRow {
  return { id: Number(r.id), tournamentId: Number(r.tournamentId), botId: Number(r.botId), eliminated: r.eliminated };
}
function normLobby(r: { id: bigint; status: { tag: string } }): LobbyRow {
  return { id: Number(r.id), status: r.status.tag };
}
function normMember(r: { id: bigint; lobbyId: bigint; botId: bigint }): LobbyMemberRow {
  return { id: Number(r.id), lobbyId: Number(r.lobbyId), botId: Number(r.botId) };
}

/** Full cache dump of the subscribed tables. */
export function cacheSnapshot(conn: DbConnection): GlobalTx {
  const db = conn.db;
  const tx = emptyGlobalTx();
  for (const r of db.matchState.iter()) tx.matchStates.push(normMatchState(r));
  for (const r of db.matchParticipant.iter()) tx.participants.push(normParticipant(r));
  for (const r of db.auction.iter()) tx.auctions.push(normAuction(r));
  for (const r of db.auctionResult.iter()) tx.results.push(normResult(r));
  for (const r of db.wordPlay.iter()) tx.words.push(normWord(r));
  for (const r of db.myRack.iter()) tx.rack.push(normRack(r));
  for (const r of db.tournamentMatch.iter()) tx.tournamentMatches.push(normTournamentMatch(r));
  for (const r of db.bot.iter()) tx.bots.push(normBot(r));
  for (const r of db.botCredential.iter()) tx.credentials.push(normCredential(r));
  for (const r of db.tournament.iter()) tx.tournaments.push(normTournament(r));
  for (const r of db.tournamentEntry.iter()) tx.entries.push(normEntry(r));
  for (const r of db.openLobbies.iter()) tx.openLobbies.push(normLobby(r));
  for (const r of db.openLobbyMembers.iter()) tx.openLobbyMembers.push(normMember(r));
  return tx;
}

/**
 * Register row callbacks: each server message's callbacks are collected into one GlobalTx (split
 * by ctx.event.id) and handed to the core in a microtask, after the whole transaction is applied.
 * Initial-row (SubscribeApplied) and unsubscribe callbacks are ignored: snapshots are read from the
 * cache in onApplied instead.
 */
export function bindConnection(conn: DbConnection, core: SessionCore, clock: ClientClock): void {
  let batch: GlobalTx | undefined;
  let batchId: string | undefined;
  let recv = 0;
  const flush = (): void => {
    const b = batch;
    batch = undefined;
    batchId = undefined;
    if (b) core.applyTx(b, recv);
  };
  const add = (ctx: Ctx, fn: (b: GlobalTx) => void): void => {
    const tag = ctx.event.tag;
    if (tag === 'SubscribeApplied' || tag === 'UnsubscribeApplied' || tag === 'Error') return;
    if (batch && batchId !== ctx.event.id) flush();
    if (!batch) {
      batch = emptyGlobalTx();
      batchId = ctx.event.id;
      recv = clock.now();
      queueMicrotask(flush);
    }
    fn(batch);
  };
  const db = conn.db as any;
  const on = (table: string, ins: (b: GlobalTx, r: any) => void, del?: (b: GlobalTx, r: any) => void): void => {
    const t = db[table];
    t.onInsert((ctx: Ctx, r: any) => add(ctx, (b) => ins(b, r)));
    if (typeof t.onUpdate === 'function') t.onUpdate((ctx: Ctx, _o: any, r: any) => add(ctx, (b) => ins(b, r)));
    if (del) t.onDelete((ctx: Ctx, r: any) => add(ctx, (b) => del(b, r)));
  };
  on('matchState', (b, r) => b.matchStates.push(normMatchState(r)));
  on('matchParticipant', (b, r) => b.participants.push(normParticipant(r)));
  on('auction', (b, r) => b.auctions.push(normAuction(r)));
  on('auctionResult', (b, r) => b.results.push(normResult(r)));
  on('wordPlay', (b, r) => b.words.push(normWord(r)));
  on('myRack', (b, r) => b.rack.push(normRack(r)), (b, r) => b.rackDeleted.push(normRack(r)));
  on('tournamentMatch', (b, r) => b.tournamentMatches.push(normTournamentMatch(r)));
  on('bot', (b, r) => b.bots.push(normBot(r)));
  on('botCredential', (b, r) => b.credentials.push(normCredential(r)));
  on('tournament', (b, r) => b.tournaments.push(normTournament(r)));
  on('tournamentEntry', (b, r) => b.entries.push(normEntry(r)));
  on('openLobbies', (b, r) => b.openLobbies.push(normLobby(r)), (b, r) => b.openLobbiesDeleted.push(normLobby(r)));
  on(
    'openLobbyMembers',
    (b, r) => b.openLobbyMembers.push(normMember(r)),
    (b, r) => b.openLobbyMembersDeleted.push(normMember(r)),
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------------------------
// runSession

export interface RunSessionOptions {
  cfg: ClientConfig;
  policyFactory: PolicyFactory;
  logger?: Logger;
  clock?: ClientClock;
  /** Skip the pid lock (tests only). */
  noLock?: boolean;
}

export interface RunningSession {
  core: SessionCore;
  stop(): void;
  /** Resolves with the final status ('refused' | 'done' | 'stopped' | 'error'). */
  done: Promise<SessionStatus>;
}

/** Live entrypoint used by 02-04 main.ts. Never touches the network when refused. */
export async function runSession(opts: RunSessionOptions): Promise<RunningSession> {
  const { cfg } = opts;
  const logger =
    opts.logger ?? new Logger({ dir: cfg.logDir, level: cfg.logLevel, secrets: cfg.botToken ? [cfg.botToken] : [], console: true });
  const clock = opts.clock ?? new ClientClock();
  let resolveDone!: (s: SessionStatus) => void;
  const done = new Promise<SessionStatus>((r) => (resolveDone = r));
  let conn: DbConnection | undefined;
  const lock = lockPath(cfg.botName);
  let supervisor: ConnectionSupervisor | undefined;

  const hostProxy = lazyReducerHost(() => conn as unknown as ReducerHost | undefined);
  const core = new SessionCore({
    cfg,
    policyFactory: opts.policyFactory,
    host: hostProxy,
    clock,
    logger,
    subscribe: (queries, cb) => {
      if (!conn) throw new Error('not connected');
      return subscribeQueries(conn as never, queries, cb);
    },
    snapshot: () => cacheSnapshot(conn!),
    matchSnapshot: (m) => matchSlice(cacheSnapshot(conn!), m),
    // flushPacker: drivers fall back to the shared engine packer loaded below.
    onStatus: (s) => {
      if (s === 'running' || s === 'init') return;
      supervisor?.stop();
      if (!opts.noLock) releaseLock(lock);
      logger.flush();
      resolveDone(s);
    },
  });

  if (!core.start()) {
    logger.flush();
    return { core, stop: () => undefined, done };
  }
  if (!opts.noLock) acquireLock(lock);
  await loadDefaultFlushPacker(); // build the word engine (~0.3 s) before the first match
  const onExit = (): void => {
    if (!opts.noLock) releaseLock(lock);
  };
  process.once('exit', onExit);

  supervisor = new ConnectionSupervisor({
    cfg,
    log: logger,
    onConnected: ({ conn: c, identityHex }) => {
      conn = c;
      bindConnection(c, core, clock);
      core.onConnected(identityHex);
    },
  });
  supervisor.start();
  return { core, stop: () => core.stop('stopped'), done };
}
