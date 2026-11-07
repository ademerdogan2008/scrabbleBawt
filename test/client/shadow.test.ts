// Shadow mode (ghost observer) without a network: ghost config, a scripted fake-server match observed
// from the start and from mid-match, log replay with 0 diagnostics, no reducer calls, the query list
// (never the top-bid leak view), running-match discovery over a fake HTTP SQL API, entrypoint helpers.
import { describe, expect, it } from 'vitest';
import { VALUE, idx } from '../../src/core/letters.js';
import { rackTotal } from '../../src/core/rack.js';
import type { Decision, Policy, PolicyFactory } from '../../src/core/types.js';
import { replay } from '../../src/state/events.js';
import type { MatchTracker } from '../../src/state/tracker.js';
import type { MatchStateRow, ParticipantRow } from '../../src/client/adapter.js';
import { ClientClock } from '../../src/client/clock.js';
import { eventsFromLog, Logger } from '../../src/client/log.js';
import { entryEnvPath, policySpec, registryFactory } from '../../src/client/main.js';
import {
  AnonSql,
  diagZero,
  findRunningMatches,
  GHOST_ID,
  ghostMatchConfig,
  GhostObserver,
  httpBase,
  shadowQueries,
  type FetchLike,
} from '../../src/client/shadow.js';
import { assertQueriesAllowed, perMatchQueries } from '../../src/client/subscriptions.js';
import { FakeServer, DEFAULT_PLAYERS } from './fixtures/fakeServer.js';

const state = (over: Partial<MatchStateRow> = {}): MatchStateRow => ({
  id: 9,
  status: 'Running',
  currentRound: 1,
  currentAuctionId: 1,
  bagTotal: 70,
  auctionType: 'Vickrey',
  auctionDurationMs: 1000,
  startingRackSize: 5,
  createdAtUs: 0n,
  ...over,
});
const seat = (id: number, botId: number): ParticipantRow => ({ id, matchId: 9, botId, balance: 100, score: 0 });

/** Records every decide() and bids value + 1 (a would-be bid that is never sent). */
class RecordingPolicy implements Policy {
  readonly name = 'recording';
  calls = 0;
  onMatchStart(): void {}
  decide(_v: unknown, a: { letter: string }): Decision {
    this.calls++;
    return { words: [], bid: VALUE[idx(a.letter)]! + 1 };
  }
}

function unseenInvariant(tr: MatchTracker): boolean {
  const hidden = tr.view.opponents.reduce((s, p) => s + p.hiddenUnknown, 0);
  return rackTotal(tr.view.unseen) === tr.bagRemaining + hidden;
}

interface Run {
  server: FakeServer;
  ghost: GhostObserver;
  lines: string[];
  policies: RecordingPolicy[];
  invariantOk: boolean;
}

/** Observe a full fake match; join from the start or after `joinAfter` closes (mid-match snapshot). */
async function observe(joinAfter = 0, policyFactory?: PolicyFactory): Promise<Run> {
  const server = new FakeServer({
    players: DEFAULT_PLAYERS,
    meId: 101, // the fake server's "me" is just another real seat for the ghost
    seed: 11,
    opponentBid: (botId, letter, index) => VALUE[idx(letter)]! + ((botId + index) % 3),
  });
  const clock = new ClientClock({ now: () => server.serverMs + 25 });
  const lines: string[] = [];
  const logger = new Logger({ sink: (_f, l) => lines.push(l) });
  const policies: RecordingPolicy[] = [];
  const factory: PolicyFactory =
    policyFactory ??
    (() => {
      const p = new RecordingPolicy();
      policies.push(p);
      return p;
    });
  const queue: Array<() => void> = [];
  const ghost = new GhostObserver({
    matchId: server.matchId,
    policyFactory: factory,
    seed: 1,
    clock,
    log: logger.match(server.matchId),
    botInfo: server.botInfo,
    seatBotId: 150,
    schedule: (fn) => queue.push(fn),
  });
  let invariantOk = true;
  const drain = (): void => {
    for (const f of queue.splice(0)) f();
    if (ghost.tracker && !unseenInvariant(ghost.tracker)) invariantOk = false;
  };
  server.startTx();
  let closes = 0;
  while (closes < joinAfter && !server.ended) {
    server.serverUs = server.current!.closesAtUs;
    server.closeTx();
    closes++;
  }
  ghost.applySnapshot(server.snapshot(5), clock.now());
  server.onTx = (tx) => ghost.applyTx(tx, clock.now());
  drain();
  let k = 0;
  while (!server.ended) {
    server.advanceMs(200);
    if (k % 9 === 4) {
      for (const id of [101, 150]) {
        const w = server.opponentBestWord(id, 4);
        if (w) server.opponentWordTx(id, w);
      }
    }
    drain();
    server.serverUs = server.current!.closesAtUs;
    server.closeTx();
    drain();
    k++;
  }
  drain();
  return { server, ghost, lines, policies, invariantOk };
}

describe('ghostMatchConfig', () => {
  it('appends the ghost seat after the real roster and counts auctions from the REAL player count', () => {
    const bots = new Map([
      [3, { id: 3, name: 'Brutus-sim', isSimulated: true, strategy: 'Aggressive' }],
      [7, { id: 7, name: 'rival', isSimulated: false, strategy: 'Human' }],
    ]);
    const cfg = ghostMatchConfig(state(), [seat(12, 7), seat(11, 3), seat(13, 44), seat(14, 45)], (id) => bots.get(id));
    expect(cfg.players.map((p) => p.id)).toEqual([3, 7, 44, 45, GHOST_ID]);
    expect(cfg.players[4]).toEqual({ id: -1, name: 'shadow', isSim: false });
    expect(cfg.players[0]).toMatchObject({ isSim: true, simStrategy: 'Aggressive' });
    expect(cfg.myId).toBe(GHOST_ID);
    expect(cfg.totalAuctions).toBe(98 - 5 * 4); // 78, not 98 - 5 * 5
    const six = ghostMatchConfig(state({ startingRackSize: 7 }), [1, 2, 3, 4, 5, 6].map((i) => seat(i, i)), () => undefined);
    expect(six.totalAuctions).toBe(98 - 7 * 6);
    expect(six.players).toHaveLength(7);
  });
});

describe('GhostObserver over a scripted fake match', () => {
  it('observes a full match from the start: 0 diagnostics, replay equal, no reducer calls', async () => {
    const r = await observe(0);
    const tr = r.ghost.tracker!;
    expect(r.ghost.ended).toBe(true);
    expect(r.server.calls).toHaveLength(0); // the ghost has no reducer path at all
    expect(diagZero(tr.diagnostics)).toBe(true);
    expect(r.invariantOk).toBe(true);
    // every real seat's final score/balance equals the server's
    for (const p of r.server.participants.values()) {
      expect(tr.player(p.botId).score).toBe(p.score);
      expect(tr.player(p.botId).balance).toBe(p.balance);
    }
    // the ghost never wins, never plays, never moves
    expect(tr.me.lettersWon).toBe(0);
    expect(tr.me.words).toHaveLength(0);
    expect(tr.me.balance).toBe(100);
    expect(tr.view.history).toHaveLength(r.server.total);
    // JSONL log replays to the same state with 0 diagnostics
    const events = eventsFromLog(r.lines);
    expect(events[0]!.t).toBe('start');
    const re = replay(events);
    expect(diagZero(re.diagnostics)).toBe(true);
    expect(re.snapshot()).toEqual(tr.snapshot());
    // would-be decisions logged for every auction (anchor), labelled with the SHADOW_SEAT balance
    const decisions = r.lines.map((l) => JSON.parse(l)).filter((x) => x.k === 'decision');
    const anchors = decisions.filter((d) => d.pass === 'anchor');
    expect(anchors).toHaveLength(r.server.total);
    expect(anchors.every((d) => d.ghost === true && d.seat?.botId === 150 && typeof d.seat.balance === 'number')).toBe(true);
    expect(decisions.some((d) => d.pass === 'refine')).toBe(true);
    expect(r.ghost.stats.wouldBids).toBe(r.server.total);
    expect(r.ghost.stats.liveOpens).toBe(r.server.total - 1); // first auction comes from the snapshot
    expect(r.ghost.stats.recvLatencyMs.every((x) => Math.abs(x - 25) < 1e-6)).toBe(true);
    const ended = r.lines.map((l) => JSON.parse(l)).find((x) => x.msg === 'match ended');
    expect(ended.diagnostics).toEqual({ balanceMismatches: 0, rackMismatches: 0, hiddenOverflow: 0, unseenNegative: 0 });
  });

  it('joins mid-match from a shuffled snapshot (sim close-transaction words included) and stays exact', async () => {
    for (const joinAfter of [17, 40, 77]) {
      const r = await observe(joinAfter);
      const tr = r.ghost.tracker!;
      expect(r.ghost.ended).toBe(true);
      expect(r.ghost.startRound).toBeDefined();
      expect(diagZero(tr.diagnostics)).toBe(true);
      expect(r.invariantOk).toBe(true);
      expect(r.server.calls).toHaveLength(0);
      for (const p of r.server.participants.values()) expect(tr.player(p.botId).score).toBe(p.score);
      const re = replay(eventsFromLog(r.lines));
      expect(diagZero(re.diagnostics)).toBe(true);
      expect(re.snapshot()).toEqual(tr.snapshot());
    }
  });

  it('survives a throwing policy (logged, still exact)', async () => {
    const r = await observe(0, () => ({
      name: 'boom',
      onMatchStart() {},
      decide(): Decision {
        throw new Error('boom');
      },
    }));
    expect(r.ghost.ended).toBe(true);
    expect(r.ghost.stats.policyErrors).toBeGreaterThan(0);
    expect(diagZero(r.ghost.tracker!.diagnostics)).toBe(true);
    expect(r.server.calls).toHaveLength(0);
  });
});

describe('shadow queries and discovery', () => {
  it('subscribes only to the per-match set plus the bot roster; never the top-bid leak view', () => {
    const q = shadowQueries(42660);
    expect(q).toEqual([...perMatchQueries(42660), 'SELECT * FROM "bot"']);
    for (const s of q) {
      expect(s.toLowerCase()).not.toContain('visible_auction_top_bids');
      expect(s.toLowerCase()).not.toContain('visibleauctiontopbids');
    }
    expect(() => assertQueriesAllowed(q)).not.toThrow();
    expect(q.filter((s) => s.includes('WHERE')).every((s) => s.includes('42660'))).toBe(true);
  });

  it('finds the newest Running match via read-only HTTP SQL and never sends the leak view', async () => {
    const sent: string[] = [];
    const fake: FetchLike = async (url, init) => {
      if (url.endsWith('/v1/identity')) return { ok: true, status: 200, text: async () => JSON.stringify({ token: 'anon-token-xyz' }) };
      const body = init?.body ?? '';
      sent.push(body);
      expect(init?.headers?.Authorization).toBe('Bearer anon-token-xyz');
      let rows: unknown[][] = [];
      if (body.includes('open_lobbies')) rows = [[37632]];
      else if (body.includes('FROM lobby')) rows = [[37630, [0, 42724]], [37631, [1, []]], [37629, [0, 42723]]];
      else if (body.includes('match_state')) rows = [[42722, [2, []], 68], [42723, [1, []], 60], [42724, [1, []], 2]];
      return { ok: true, status: 200, text: async () => JSON.stringify([{ rows }]) };
    };
    const sql = new AnonSql(httpBase('wss://maincloud.spacetimedb.com'), 'scrabblebot', fake);
    const running = await findRunningMatches(sql);
    expect(running).toEqual([
      { id: 42724, currentRound: 2 },
      { id: 42723, currentRound: 60 },
    ]);
    expect(sent.every((s) => /^SELECT /.test(s) && !/visible_auction_top_bids/i.test(s))).toBe(true);
    expect(sent[1]).toBe('SELECT id, resolved_match_id FROM lobby WHERE id >= 37624');
    expect(sent[2]).toBe('SELECT id, status, current_round FROM match_state WHERE id >= 42708');
    await expect(sql.query('SELECT * FROM visible_auction_top_bids')).rejects.toThrow(/forbidden/);
    await expect(sql.query('DELETE FROM bot')).rejects.toThrow(/only SELECT/);
  });

  it('maps ws(s) hosts to http(s) for SQL', () => {
    expect(httpBase('wss://maincloud.spacetimedb.com')).toBe('https://maincloud.spacetimedb.com');
    expect(httpBase('ws://127.0.0.1:3100/')).toBe('http://127.0.0.1:3100');
    expect(httpBase('http://localhost:3000')).toBe('http://localhost:3000');
  });
});

describe('entrypoint helpers', () => {
  it('builds registry policy specs and validates them', () => {
    expect(policySpec({ policy: 'greedy', params: {} })).toBe('greedy');
    expect(policySpec({ policy: 'hoarder', params: { lateFactor: 2 } })).toBe('hoarder:{"lateFactor":2}');
    expect(policySpec({ policy: 'hoarder:{"x":1}', params: { y: 2 } })).toBe('hoarder:{"x":1}');
    expect(registryFactory('starter')(1).name).toBe('starter');
    expect(() => registryFactory('no-such-policy')).toThrow(/unknown policy/);
  });

  it('ENV_FILE overrides the repo .env path', () => {
    expect(entryEnvPath({ ENV_FILE: '/x/y.env' })).toBe('/x/y.env');
    expect(entryEnvPath({})).toMatch(/\.env$/);
  });
});
