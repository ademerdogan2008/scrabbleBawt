// SessionCore lifecycle against a fake world (no network): boot, lobby join/rejoin, MAX_MATCHES,
// NO_LADDER, quiet refusals, tournament registration and holds, resume at boot, read-only refusal,
// pid lock file. Every reducer call goes through the guard; every query passes the FORBIDDEN check.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getEngine } from '../../src/engine/index.js';
import { emptyMatchTx, type MatchTx } from '../../src/client/adapter.js';
import { ClientClock } from '../../src/client/clock.js';
import { Logger } from '../../src/client/log.js';
import {
  acquireLock,
  emptyGlobalTx,
  LockError,
  releaseLock,
  SessionCore,
  type EntryRow,
  type GlobalTx,
  type SessionDeps,
  type TournamentRow,
} from '../../src/client/session.js';
import { assertQueriesAllowed } from '../../src/client/subscriptions.js';
import { FakeServer, DEFAULT_PLAYERS } from './fixtures/fakeServer.js';
import { scriptedFactory } from './fixtures/harness.js';

const ME_HEX = 'ab'.repeat(32);
const LOCAL = 'http://127.0.0.1:3000';

interface WorldOpts {
  cfg?: Partial<SessionDeps['cfg']>;
  credential?: boolean;
  joinError?: string;
  tournaments?: TournamentRow[];
  entries?: EntryRow[];
  /** Start a match before boot (resume at boot). */
  runningAtBoot?: boolean;
  seed?: number;
  guardEnv?: Record<string, string | undefined>;
}

class World {
  server: FakeServer;
  readonly calls: Array<{ name: string; args: unknown }> = [];
  readonly queries: string[][] = [];
  readonly lines: string[] = [];
  readonly queue: Array<() => void> = [];
  readonly core: SessionCore;
  lobbyMembers: Array<{ id: number; lobbyId: number; botId: number }> = [];
  oldMatches: number[] = [77];
  matchSeq = 4242;
  tournaments: TournamentRow[];
  entries: EntryRow[];
  private readonly opts: WorldOpts;

  constructor(opts: WorldOpts = {}) {
    this.opts = opts;
    this.tournaments = opts.tournaments ?? [];
    this.entries = opts.entries ?? [];
    this.server = this.newServer();
    const clock = new ClientClock({ now: () => this.server.serverMs });
    const logger = new Logger({ sink: (_f, l) => this.lines.push(l), level: 'debug' });
    const reducers = {
      joinLobby: async () => {
        await Promise.resolve();
        this.calls.push({ name: 'join_lobby', args: {} });
        if (this.opts.joinError) throw new Error(this.opts.joinError);
        this.lobbyMembers.push({ id: this.lobbyMembers.length + 1, lobbyId: 1, botId: 101 });
        this.deliver({ ...emptyGlobalTx(), openLobbyMembers: [...this.lobbyMembers] });
      },
      registerForTournament: async (args: unknown) => {
        await Promise.resolve();
        this.calls.push({ name: 'register_for_tournament', args });
      },
      submitBid: (args: { auctionId: bigint; amount: bigint }) => {
        this.calls.push({ name: 'submit_bid', args });
        return this.server.reducers.submitBid(args);
      },
      submitWord: (args: { matchId: bigint; word: string }) => {
        this.calls.push({ name: 'submit_word', args });
        return this.server.reducers.submitWord(args);
      },
    };
    this.core = new SessionCore({
      cfg: { botName: 'bawt', host: LOCAL, isMaincloud: false, noLadder: false, maxMatches: undefined, tournamentId: undefined, params: {}, ...opts.cfg },
      policyFactory: scriptedFactory(),
      host: { reducers },
      clock,
      logger,
      subscribe: (queries, cb) => {
        assertQueriesAllowed(queries);
        this.queries.push(queries);
        queueMicrotask(() => cb.onApplied());
        return { unsubscribe: () => undefined };
      },
      snapshot: () => this.snapshot(),
      matchSnapshot: (m) => (m === this.server.matchId ? this.server.snapshot(m) : this.endedMatch(m)),
      guardOptions: { env: opts.guardEnv ?? {} },
      flushPacker: getEngine().packer,
      schedule: (fn) => this.queue.push(fn),
      later: (fn) => fn(),
      joinRetryMs: 0,
    });
    this.server.onTx = (tx) => this.deliver(tx);
  }

  newServer(): FakeServer {
    return new FakeServer({ players: DEFAULT_PLAYERS, meId: 101, seed: this.opts.seed ?? 5, matchId: this.matchSeq });
  }

  deliver(tx: MatchTx | GlobalTx): void {
    this.core.applyTx({ ...emptyGlobalTx(), ...tx }, this.server.serverMs);
  }

  endedMatch(m: number): MatchTx {
    const tx = emptyMatchTx();
    tx.matchStates.push({
      id: m,
      status: 'Ended',
      currentRound: 78,
      currentAuctionId: null,
      bagTotal: 0,
      auctionType: 'Vickrey',
      auctionDurationMs: 1000,
      startingRackSize: 5,
      createdAtUs: 1n,
    });
    DEFAULT_PLAYERS.forEach((p, i) => tx.participants.push({ id: m * 10 + i, matchId: m, botId: p.botId, balance: 50, score: 40 }));
    return tx;
  }

  snapshot(): GlobalTx {
    const tx = emptyGlobalTx();
    if (this.opts.credential !== false) tx.credentials.push({ identityHex: ME_HEX, botId: 101, connected: true });
    tx.bots.push(...this.server.bots());
    for (const m of this.oldMatches) tx.participants.push({ id: m * 10, matchId: m, botId: 101, balance: 50, score: 40 });
    if (this.server.state) tx.participants.push(...this.server.participants.values());
    tx.tournaments.push(...this.tournaments);
    tx.entries.push(...this.entries);
    tx.openLobbyMembers.push(...this.lobbyMembers);
    return tx;
  }

  async settle(): Promise<void> {
    for (let k = 0; k < 40; k++) {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const fns = this.queue.splice(0);
      if (fns.length === 0) {
        await new Promise((r) => setImmediate(r));
        if (this.queue.length === 0) return;
      }
      for (const f of fns) f();
    }
  }

  /** The open lobby resolves into a match containing us (start transaction delivered live). */
  async startMatch(): Promise<void> {
    // One server transaction: the lobby resolves (our member row leaves the open lobby view) and
    // the match starts.
    const removed = this.lobbyMembers.splice(0);
    const hook = this.server.onTx;
    this.server.onTx = undefined;
    const tx = this.server.startTx();
    this.server.onTx = hook;
    this.deliver({ ...emptyGlobalTx(), ...tx, openLobbyMembersDeleted: removed });
    await this.settle();
  }

  async playToEnd(): Promise<void> {
    while (!this.server.ended) {
      await this.settle();
      this.server.serverUs = this.server.current!.closesAtUs;
      this.server.closeTx();
    }
    await this.settle();
  }

  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  msgs(): Array<Record<string, unknown>> {
    return this.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  async boot(): Promise<void> {
    expect(this.core.start()).toBe(true);
    this.core.onConnected(ME_HEX);
    await this.settle();
  }
}

describe('SessionCore lifecycle', () => {
  it('read-only: refuses to play on maincloud without ALLOW_MAINCLOUD_PLAY=1, before any call', async () => {
    const w = new World({ cfg: { host: 'https://maincloud.spacetimedb.com', isMaincloud: true } });
    expect(w.core.start()).toBe(false);
    expect(w.core.status).toBe('refused');
    w.core.onConnected(ME_HEX);
    await w.settle();
    expect(w.calls).toEqual([]);
    expect(w.queries).toEqual([]);
    expect(w.msgs().some((m) => m.msg === 'read-only: refusing to play')).toBe(true);
  });

  it('ALLOW_MAINCLOUD_PLAY=1 lifts the refusal', () => {
    const w = new World({ cfg: { host: 'https://maincloud.spacetimedb.com', isMaincloud: true }, guardEnv: { ALLOW_MAINCLOUD_PLAY: '1' } });
    expect(w.core.start()).toBe(true);
  });

  it('boot without a credential stops with an error', async () => {
    const w = new World({ credential: false });
    await w.boot();
    expect(w.core.status).toBe('error');
    expect(w.calls).toEqual([]);
  });

  it('boot: resolves the bot, ignores an ended old match, joins the lobby once; plays; rejoins after Ended', async () => {
    const w = new World();
    await w.boot();
    expect(w.core.myBotId).toBe(101);
    expect(w.count('join_lobby')).toBe(1);
    // Old match 77 was checked via its per-match snapshot and found Ended: not counted.
    expect(w.queries.some((q) => q.some((s) => s.includes('= 77')))).toBe(true);
    expect(w.core.matchesPlayed).toBe(0);
    // Lobby membership row is visible: no duplicate join on further transactions.
    w.deliver(emptyGlobalTx());
    await w.settle();
    expect(w.count('join_lobby')).toBe(1);

    await w.startMatch();
    expect(w.core.drivers.has(w.server.matchId)).toBe(true);
    expect(w.core.inRunningMatch()).toBe(true);
    expect(w.count('submit_bid')).toBeGreaterThan(0);
    await w.playToEnd();
    expect(w.core.matchesPlayed).toBe(1);
    expect(w.count('join_lobby')).toBe(2); // rejoined after Ended
    expect(w.core.status).toBe('running');
    const end = w.msgs().find((m) => m.msg === 'match ended');
    expect((end?.diagnostics as Record<string, number>).rackMismatches).toBe(0);
  });

  it('MAX_MATCHES stops after N matches without rejoining', async () => {
    const w = new World({ cfg: { maxMatches: 1 } });
    await w.boot();
    await w.startMatch();
    await w.playToEnd();
    expect(w.core.status).toBe('done');
    expect(w.count('join_lobby')).toBe(1);
  });

  it('NO_LADDER never joins the lobby but still plays tournament-started matches', async () => {
    const w = new World({ cfg: { noLadder: true } });
    await w.boot();
    expect(w.count('join_lobby')).toBe(0);
    w.server.startTx();
    await w.settle();
    expect(w.count('submit_bid')).toBeGreaterThan(0);
    await w.playToEnd();
    expect(w.count('join_lobby')).toBe(0);
  });

  it('"already in a running match" refusal is quiet (debug, not warn)', async () => {
    const w = new World({ joinError: "You're already in a running match" });
    await w.boot();
    expect(w.count('join_lobby')).toBe(1);
    const warns = w.msgs().filter((m) => m.level === 'warn' || m.level === 'error');
    expect(warns).toEqual([]);
    expect(w.msgs().some((m) => m.msg === 'join_lobby refused')).toBe(true);
  });

  it('tournament refusal sets a hold: no further joins until tournament rows change', async () => {
    const w = new World({ joinError: "You're playing in a tournament; the lobby reopens to you when you're knocked out or it ends" });
    await w.boot();
    expect(w.count('join_lobby')).toBe(1);
    w.deliver(emptyGlobalTx());
    w.deliver(emptyGlobalTx());
    await w.settle();
    expect(w.count('join_lobby')).toBe(1);
    expect(w.core.tournamentHold).toBe(true);
  });

  it("TOURNAMENT_ID=auto registers once for a tournament in Registration; an active entry holds the lobby", async () => {
    const w = new World({ cfg: { tournamentId: 'auto' }, tournaments: [{ id: 5, status: 'Registration' }, { id: 4, status: 'Ended' }] });
    await w.boot();
    expect(w.calls.filter((c) => c.name === 'register_for_tournament')).toEqual([
      { name: 'register_for_tournament', args: { tournamentId: 5n } },
    ]);
    w.deliver({ ...emptyGlobalTx(), tournaments: [{ id: 5, status: 'Registration' }] });
    await w.settle();
    expect(w.count('register_for_tournament')).toBe(1);
    // Tournament starts with our entry alive: held (no lobby join while not in a match).
    w.lobbyMembers = [];
    w.deliver({
      ...emptyGlobalTx(),
      tournaments: [{ id: 5, status: 'Swiss' }],
      entries: [{ id: 1, tournamentId: 5, botId: 101, eliminated: false }],
      openLobbyMembersDeleted: [{ id: 1, lobbyId: 1, botId: 101 }],
    });
    await w.settle();
    expect(w.core.tournamentHold).toBe(true);
    const joins = w.count('join_lobby');
    w.deliver(emptyGlobalTx());
    await w.settle();
    expect(w.count('join_lobby')).toBe(joins);
    // Knocked out -> hold released -> rejoin.
    w.deliver({ ...emptyGlobalTx(), entries: [{ id: 1, tournamentId: 5, botId: 101, eliminated: true }] });
    await w.settle();
    expect(w.core.tournamentHold).toBe(false);
    expect(w.count('join_lobby')).toBe(joins + 1);
  });

  it('TOURNAMENT_ID=<id> registers only for that tournament', async () => {
    const w = new World({ cfg: { tournamentId: 6 }, tournaments: [{ id: 5, status: 'Registration' }, { id: 6, status: 'Registration' }] });
    await w.boot();
    expect(w.calls.filter((c) => c.name === 'register_for_tournament').map((c) => c.args)).toEqual([{ tournamentId: 6n }]);
  });

  it('resume at boot: a Running match found in the boot rows is rebuilt and its open auction re-bid', async () => {
    const w = new World({ runningAtBoot: true });
    w.server.startTx();
    for (let i = 0; i < 6; i++) {
      w.server.serverUs = w.server.current!.closesAtUs;
      w.server.closeTx();
    }
    await w.boot();
    const dr = w.core.drivers.get(w.server.matchId)!;
    expect(dr).toBeDefined();
    expect(dr.tracker!.view.auctionsDone).toBe(6);
    expect(dr.tracker!.diagnostics.rackMismatches).toBe(0);
    const bids = w.calls.filter((c) => c.name === 'submit_bid');
    expect(bids.length).toBe(1);
    expect(Number((bids[0]!.args as { auctionId: bigint }).auctionId)).toBe(w.server.current!.id);
    expect(w.count('join_lobby')).toBe(0); // in a running match
    await w.playToEnd();
    expect(w.core.matchesPlayed).toBe(1);
    expect(w.count('join_lobby')).toBe(1);
  });

  it('reconnect: drivers are disposed and rebuilt from fresh snapshots (resume)', async () => {
    const w = new World();
    await w.boot();
    await w.startMatch();
    for (let i = 0; i < 3; i++) {
      w.server.serverUs = w.server.current!.closesAtUs;
      w.server.closeTx();
      await w.settle();
    }
    const old = w.core.drivers.get(w.server.matchId)!;
    // Connection drops; a close happens meanwhile; then a new connection comes up.
    w.server.onTx = undefined;
    w.server.serverUs = w.server.current!.closesAtUs;
    w.server.closeTx();
    w.server.onTx = (tx) => w.deliver(tx);
    const bidsBefore = w.count('submit_bid');
    w.core.onConnected(ME_HEX);
    await w.settle();
    const neu = w.core.drivers.get(w.server.matchId)!;
    expect(neu).not.toBe(old);
    expect(neu.tracker!.view.auctionsDone).toBe(4);
    expect(w.count('submit_bid')).toBe(bidsBefore + 1);
    await w.playToEnd();
    expect(neu.tracker!.diagnostics).toEqual({ balanceMismatches: 0, rackMismatches: 0, hiddenOverflow: 0, unseenNegative: 0 });
  });
});

describe('runSession', () => {
  it('on maincloud without ALLOW_MAINCLOUD_PLAY=1 resolves "refused" without connecting', async () => {
    const { runSession } = await import('../../src/client/session.js');
    const { loadConfig } = await import('../../src/client/config.js');
    const prev = process.env.ALLOW_MAINCLOUD_PLAY;
    delete process.env.ALLOW_MAINCLOUD_PLAY;
    try {
      const cfg = loadConfig({ env: { BOT_NAME: 'refusetest' }, tokenDir: tmpdir() });
      expect(cfg.isMaincloud).toBe(true);
      const lines: string[] = [];
      const s = await runSession({ cfg, policyFactory: scriptedFactory(), noLock: true, logger: new Logger({ sink: (_f, l) => lines.push(l) }) });
      await expect(s.done).resolves.toBe('refused');
      expect(lines.some((l) => l.includes('read-only: refusing to play'))).toBe(true);
      expect(lines.some((l) => l.includes('"msg":"connecting"'))).toBe(false);
    } finally {
      if (prev !== undefined) process.env.ALLOW_MAINCLOUD_PLAY = prev;
    }
  });
});

describe('bindConnection (SDK callbacks -> per-transaction batches)', () => {
  type Cb = (...a: unknown[]) => void;
  function fakeConn() {
    const handlers = new Map<string, Cb[]>();
    const rows = new Map<string, unknown[]>();
    const table = (name: string) => ({
      onInsert: (cb: Cb) => handlers.set(`${name}.insert`, [...(handlers.get(`${name}.insert`) ?? []), cb]),
      onUpdate: (cb: Cb) => handlers.set(`${name}.update`, [...(handlers.get(`${name}.update`) ?? []), cb]),
      onDelete: (cb: Cb) => handlers.set(`${name}.delete`, [...(handlers.get(`${name}.delete`) ?? []), cb]),
      iter: () => rows.get(name) ?? [],
    });
    const names = [
      'matchState', 'matchParticipant', 'auction', 'auctionResult', 'wordPlay', 'myRack', 'tournamentMatch',
      'bot', 'botCredential', 'tournament', 'tournamentEntry', 'openLobbies', 'openLobbyMembers',
    ];
    const db = Object.fromEntries(names.map((n) => [n, table(n)]));
    const fire = (key: string, ctx: unknown, ...args: unknown[]) => {
      for (const cb of handlers.get(key) ?? []) cb(ctx, ...args);
    };
    return { conn: { db } as never, fire, rows };
  }
  const ts = (us: bigint) => ({ microsSinceUnixEpoch: us });
  const auctionRow = (id: bigint, open: boolean) => ({
    id, matchId: 9n, letter: 'E', opensAt: ts(1000n), closesAt: ts(1_001_000n), status: { tag: open ? 'Open' : 'Closed' },
  });

  it('groups callbacks by event id, flushes once per transaction in a microtask, ignores initial rows', async () => {
    const { bindConnection, cacheSnapshot } = await import('../../src/client/session.js');
    const got: GlobalTx[] = [];
    const { conn, fire, rows } = fakeConn();
    bindConnection(conn, { applyTx: (tx: GlobalTx) => got.push(tx) } as never, new ClientClock({ now: () => 5 }));
    const tx1 = { event: { id: 'e1', tag: 'Transaction' } };
    const tx2 = { event: { id: 'e2', tag: 'Transaction' } };
    fire('auction.update', tx1, auctionRow(1n, true), auctionRow(1n, false));
    fire('auctionResult.insert', tx1, { auctionId: 1n, matchId: 9n, letter: 'E', winnerBotId: 101n, paid: 2n, closedAt: ts(1_001_500n) });
    fire('auction.insert', tx1, auctionRow(2n, true));
    fire('myRack.delete', tx2, { id: 3n, matchId: 9n, botId: 101n, letter: 'Q', count: 0 });
    fire('auction.insert', { event: { id: 'e3', tag: 'SubscribeApplied' } }, auctionRow(3n, true));
    expect(got.length).toBe(1); // e1 flushed synchronously when e2 started
    await Promise.resolve();
    expect(got.length).toBe(2);
    expect(got[0]!.auctions.map((a) => [a.id, a.open])).toEqual([[1, false], [2, true]]);
    expect(got[0]!.results[0]).toMatchObject({ auctionId: 1, winnerBotId: 101, paid: 2, closedAtUs: 1_001_500n });
    expect(got[1]!.rackDeleted.map((r) => r.letter)).toEqual(['Q']);
    rows.set('botCredential', [{ identity: { toHexString: () => 'AB'.repeat(32) }, botId: 101n, connected: true }]);
    rows.set('openLobbyMembers', [{ id: 1n, lobbyId: 2n, botId: 101n }]);
    const snap = cacheSnapshot(conn);
    expect(snap.credentials).toEqual([{ identityHex: 'ab'.repeat(32), botId: 101, connected: true }]);
    expect(snap.openLobbyMembers).toEqual([{ id: 1, lobbyId: 2, botId: 101 }]);
  });
});

describe('pid lock file (PITFALLS M15)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmpLock = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'bawt-lock-'));
    dirs.push(d);
    return join(d, '.cache', 'client-bawt.lock');
  };

  it('refuses when another live pid holds the lock; takes over stale locks; releases', () => {
    const p = tmpLock();
    acquireLock(p, process.pid);
    expect(() => acquireLock(p, process.pid + 100000)).toThrow(LockError); // we are alive
    releaseLock(p, process.pid);
    acquireLock(p, 4_000_000); // free now
    releaseLock(p, 4_000_000);
    writeFileSync(p, '3999999'); // stale (no such pid)
    expect(() => acquireLock(p, process.pid)).not.toThrow();
    releaseLock(p, 1); // not ours: kept
    expect(() => acquireLock(p, process.pid + 100000)).toThrow(LockError);
    releaseLock(p, process.pid);
  });
});
