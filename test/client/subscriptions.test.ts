import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toSql, Identity } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { tables } from '../../src/client/module_bindings/index';
import {
  assertQueriesAllowed,
  bootQueries,
  FORBIDDEN_TABLES,
  ForbiddenQueryError,
  identityLiteral,
  identityQueries,
  myBotQueries,
  perMatchQueries,
  queryTables,
  rangeProbeQueries,
  subscribeQueries,
} from '../../src/client/subscriptions.js';

const CLIENT_DIR = join(__dirname, '..', '..', 'src', 'client');
const HEX = 'c200dd4e' + 'ab'.repeat(28);
const LEAK = ['visible', 'auction', 'top', 'bids'].join('_');

function clientSources(dir = CLIENT_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'module_bindings') out.push(...clientSources(p));
    } else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Every query string the client can emit (boot, per-match, shadow helpers, probe). */
function allEmittable(): string[] {
  return [
    ...identityQueries(HEX),
    ...myBotQueries(101),
    ...bootQueries(HEX),
    ...bootQueries(HEX, 101n),
    ...perMatchQueries(1),
    ...perMatchQueries(42_000n),
    ...rangeProbeQueries(40_000),
  ];
}

describe('subscription queries', () => {
  it('renders exactly like the SDK typed query builder', () => {
    const id = Identity.fromString(HEX);
    expect(perMatchQueries(5)).toEqual([
      toSql(tables.matchState.where((r) => r.id.eq(5n)) as never),
      toSql(tables.matchParticipant.where((r) => r.matchId.eq(5n)) as never),
      toSql(tables.auction.where((r) => r.matchId.eq(5n)) as never),
      toSql(tables.auctionResult.where((r) => r.matchId.eq(5n)) as never),
      toSql(tables.wordPlay.where((r) => r.matchId.eq(5n)) as never),
      toSql(tables.tournamentMatch.where((r) => r.matchId.eq(5n)) as never),
    ]);
    expect(identityQueries(HEX)[0]).toBe(toSql(tables.botCredential.where((r) => r.identity.eq(id)) as never));
    expect(myBotQueries(101)).toEqual([
      toSql(tables.matchParticipant.where((r) => r.botId.eq(101n)) as never),
      toSql(tables.tournamentEntry.where((r) => r.botId.eq(101n)) as never),
    ]);
    expect(identityQueries(HEX).slice(1)).toEqual([
      toSql(tables.bot as never),
      toSql(tables.openLobbies as never),
      toSql(tables.openLobbyMembers as never),
      toSql(tables.myRack as never),
      toSql(tables.tournament as never),
    ]);
    expect(rangeProbeQueries(7)).toEqual([toSql(tables.auction.where((r) => r.matchId.gt(7n)) as never)]);
  });

  it('no emittable query references the top-bid leak view or an unfiltered history table', () => {
    for (const q of allEmittable()) {
      expect(q.toLowerCase()).not.toContain(LEAK);
      expect(() => assertQueriesAllowed([q])).not.toThrow();
      expect(queryTables(q).length).toBe(1);
    }
    expect(FORBIDDEN_TABLES).toContain(LEAK);
  });

  it('FORBIDDEN rules are enforced', () => {
    expect(() => assertQueriesAllowed([`SELECT * FROM "${LEAK}"`])).toThrow(ForbiddenQueryError);
    expect(() => assertQueriesAllowed([`SELECT * FROM ${LEAK} WHERE match_id = 1`])).toThrow(ForbiddenQueryError);
    expect(() => assertQueriesAllowed(['SELECT * FROM "visibleAuctionTopBids"'])).toThrow(ForbiddenQueryError);
    for (const t of ['auction', 'auction_result', 'word_play', 'match_participant', 'match_state', 'auction_top_bid_archive']) {
      expect(() => assertQueriesAllowed([`SELECT * FROM "${t}"`])).toThrow(/unfiltered history/);
    }
    expect(() => assertQueriesAllowed(['SELECT 1'])).toThrow(/no table/);
    expect(() => assertQueriesAllowed(['SELECT * FROM "bot"'])).not.toThrow();
  });

  it('identity literal validation and id formatting', () => {
    expect(identityLiteral('0x' + HEX.toUpperCase())).toBe('0x' + HEX);
    expect(() => identityLiteral('abc')).toThrow();
    expect(() => perMatchQueries(-1)).toThrow();
    expect(perMatchQueries(2n ** 60n)[0]).toContain(String(2n ** 60n));
  });

  it('subscribeQueries uses subscribe(string[]) and never the subscribe-to-all API', () => {
    const seen: string[][] = [];
    let applied = 0;
    const builder = {
      onApplied(cb: (ctx: unknown) => void) {
        queueMicrotask(() => cb({}));
        return builder;
      },
      onError() {
        return builder;
      },
      subscribe(q: string[]) {
        seen.push(q);
        return { unsubscribe() {} };
      },
      get subscribeToAllTables(): never {
        throw new Error('forbidden');
      },
    };
    subscribeQueries({ subscriptionBuilder: () => builder }, perMatchQueries(9), { onApplied: () => applied++ });
    expect(seen).toEqual([perMatchQueries(9)]);
    expect(() =>
      subscribeQueries({ subscriptionBuilder: () => builder }, [`SELECT * FROM "${LEAK}"`]),
    ).toThrow(ForbiddenQueryError);
    expect(seen.length).toBe(1);
    return Promise.resolve().then(() => expect(applied).toBe(1));
  });

  it('source scan: no client file calls the subscribe-to-all API or names the leak view outside FORBIDDEN lines', () => {
    const offenders: string[] = [];
    const allApi = ['subscribe', 'To', 'All', 'Tables'].join('');
    for (const f of clientSources()) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((l, i) => {
          const where = `${relative(CLIENT_DIR, f)}:${i + 1}`;
          if (l.includes(allApi)) offenders.push(`${where} ${allApi}`);
          if ((l.includes(LEAK) || /visibleAuctionTopBids/.test(l)) && !l.includes('FORBIDDEN')) offenders.push(`${where} leak`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
