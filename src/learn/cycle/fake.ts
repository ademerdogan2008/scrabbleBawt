// Simulated lost match written in the live client's JSONL format (src/client/log.ts), so the cycle
// can be exercised end to end offline: scripts/learn-cycle.ts --fake-loss.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashSeed } from '../../core/rng.js';
import { parseSeat } from '../../bots/registry.js';
import { runMatch, type SeatSpec } from '../../sim/match.js';
import type { MatchEvent } from '../../state/events.js';

export interface FakeSeat {
  spec: string;
  /** Live display name (e.g. 'LUCENT'); sims keep their '<Strategy>-sim' name. */
  name?: string;
}

export const FAKE_TABLE: readonly FakeSeat[] = [
  { spec: 'bawt:{"tableScale":0.75,"kappaHi":1.9}', name: 'Malicious' },
  { spec: 'clone:lucent', name: 'LUCENT' },
  { spec: 'clone:bron', name: 'Bron' },
  { spec: 'clone:maverick', name: 'maverick-bot' },
  { spec: 'sim:Aggressive' },
  { spec: 'sim:ValueBidder' },
];

export interface FakeLossOptions {
  dir: string;
  matchId: number;
  seats?: readonly FakeSeat[];
  /** First seed tried; seeds advance until seat 0 loses (at most maxTries). */
  seed?: number;
  maxTries?: number;
  startTs?: number;
}

/** Simulate until seat 0 loses, then write match-<id>.jsonl. Returns the file and the focal rank. */
export function writeFakeLoss(o: FakeLossOptions): { file: string; rank: number; seed: number } {
  const seats = o.seats ?? FAKE_TABLE;
  const tries = o.maxTries ?? 60;
  for (let t = 0; t < tries; t++) {
    const seed = hashSeed(o.seed ?? 1, 'fake-loss', t);
    const specs: SeatSpec[] = seats.map((s, i) => {
      const tpl = parseSeat(s.spec, hashSeed(seed, 'policy', i));
      return { ...tpl, id: i + 1, name: s.name ?? tpl.name } as SeatSpec;
    });
    const r = runMatch({ trace: true, matchId: o.matchId, decisionBudgetMs: 200 }, specs, seed);
    const me = r.seats.find((s) => s.id === 1)!;
    if (me.win || !r.trace) continue;
    const events: MatchEvent[] = r.trace.events['1'] ?? [];
    if (events.length === 0) continue;
    const ts0 = o.startTs ?? Date.now() - 600_000;
    const auctionIds = new Map<number, number>();
    for (const e of events) if (e.t === 'open') auctionIds.set(e.auction.index, e.auction.auctionId);
    const lines: string[] = [];
    let n = 0;
    const put = (rec: Record<string, unknown>) => lines.push(JSON.stringify({ ts: ts0 + 50 * n++, matchId: o.matchId, ...rec }));
    for (const e of events) {
      put({ k: 'event', e });
      if (e.t === 'open') {
        const a = r.trace.auctions.find((x) => x.index === e.auction.index);
        const bid = a?.bids['1'] ?? 0;
        put({ k: 'decision', auctionId: e.auction.auctionId, index: e.auction.index, pass: 'refine', bid, words: [], decideMs: 1, budgetMs: 200, late: false });
      }
    }
    put({
      k: 'info',
      msg: 'match ended',
      source: 'sim',
      score: me.score,
      balance: me.balance,
      unplayed: { rack: r.trace.finalRacks['1'] ?? '', letters: me.unplayedTiles, value: me.unplayedValue },
    });
    mkdirSync(o.dir, { recursive: true });
    const file = join(o.dir, `match-${o.matchId}.jsonl`);
    writeFileSync(file, lines.join('\n') + '\n');
    return { file, rank: me.rank, seed };
  }
  throw new Error(`fake loss: seat 0 never lost in ${tries} tries`);
}
