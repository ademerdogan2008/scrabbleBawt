// Build the all-sim host-parity fixtures from the full historical dataset (read-only, untracked):
//   npx tsx test/fixtures/allsim/extract.ts --data <hist dir> [--out test/fixtures/allsim/matches.json] [--max-bytes 1000000]
// Selects every match whose participants are all simulated bots and stores only what the
// replay needs (public timestamps, roster order, auction results, top bids, words, finals).
import { createReadStream, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

interface Args {
  data: string;
  out: string;
  maxBytes: number;
}

function parseArgs(argv: readonly string[]): Args {
  const here = dirname(fileURLToPath(import.meta.url));
  const a: Args = { data: '', out: join(here, 'matches.json'), maxBytes: 1_000_000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--data' && v) (a.data = v), i++;
    else if (k === '--out' && v) (a.out = v), i++;
    else if (k === '--max-bytes' && v) (a.maxBytes = Number(v)), i++;
    else throw new Error(`unknown/incomplete option ${k}`);
  }
  if (!a.data) throw new Error('usage: extract.ts --data <hist dir> [--out file] [--max-bytes N]');
  return a;
}

async function* rows(file: string): AsyncGenerator<Record<string, unknown>> {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) if (line.length > 0) yield JSON.parse(line) as Record<string, unknown>;
}

const STRATEGY: Record<string, string> = {
  cheapskate: 'Cheapskate',
  valueBidder: 'ValueBidder',
  aggressive: 'Aggressive',
  human: 'Human',
};
const AUCTION_TYPE: Record<string, string> = { vickrey: 'Vickrey', firstPrice: 'FirstPrice', firstprice: 'FirstPrice' };

export interface FixtureSim {
  id: number;
  name: string;
  strategy: string;
}

export interface FixtureMatch {
  id: number;
  startedAt: number;
  endedAt: number;
  auctionType: string;
  auctionDurationMs: number;
  startingRackSize: number;
  /** bot ids in match_participant id order (roster order). */
  roster: number[];
  /** [letter, winner bot id | null, paid, top bid, closed_at µs] in auction id order. */
  auctions: Array<[string, number | null, number, number, number]>;
  /** [bot id, word, total_reward, played_at µs] in word_play id order. */
  words: Array<[number, string, number, number]>;
  /** [bot id, balance, score] in roster order. */
  final: Array<[number, number, number]>;
}

export interface Fixture {
  source: string;
  /** Simulated bots of the `bot` table in table-scan (id) order: the lobby padding pool. */
  sims: FixtureSim[];
  lobbyMaxSize: number;
  matches: FixtureMatch[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const f = (name: string) => join(args.data, `${name}.ndjson`);

  const sims: FixtureSim[] = [];
  const simIds = new Set<number>();
  for await (const b of rows(f('bot'))) {
    if (b.is_simulated === true) {
      sims.push({ id: b.id as number, name: b.name as string, strategy: STRATEGY[b.strategy as string] ?? String(b.strategy) });
      simIds.add(b.id as number);
    }
  }
  sims.sort((a, b) => a.id - b.id);

  const parts = new Map<number, Array<{ id: number; bot: number; balance: number; score: number }>>();
  for await (const p of rows(f('match_participant'))) {
    const m = p.match_id as number;
    if (!parts.has(m)) parts.set(m, []);
    parts.get(m)!.push({ id: p.id as number, bot: p.bot_id as number, balance: p.balance as number, score: p.score as number });
  }
  const chosen = new Set<number>();
  for (const [m, ps] of parts) if (ps.length >= 2 && ps.every((p) => simIds.has(p.bot))) chosen.add(m);

  const states = new Map<number, Record<string, unknown>>();
  for await (const s of rows(f('match_state'))) if (chosen.has(s.id as number)) states.set(s.id as number, s);
  const auctions = new Map<number, Array<{ id: number; row: Record<string, unknown> }>>();
  for await (const r of rows(f('auction_result'))) {
    const m = r.match_id as number;
    if (!chosen.has(m)) continue;
    if (!auctions.has(m)) auctions.set(m, []);
    auctions.get(m)!.push({ id: r.auction_id as number, row: r });
  }
  const tops = new Map<number, number>();
  for await (const t of rows(f('auction_top_bid_archive'))) {
    if (chosen.has(t.match_id as number)) tops.set(t.auction_id as number, t.top_bid as number);
  }
  const words = new Map<number, Array<{ id: number; row: Record<string, unknown> }>>();
  for await (const w of rows(f('word_play'))) {
    const m = w.match_id as number;
    if (!chosen.has(m)) continue;
    if (!words.has(m)) words.set(m, []);
    words.get(m)!.push({ id: w.id as number, row: w });
  }

  const matches: FixtureMatch[] = [];
  for (const id of [...chosen].sort((a, b) => a - b)) {
    const st = states.get(id);
    const au = (auctions.get(id) ?? []).sort((a, b) => a.id - b.id);
    if (!st || st.status !== 'ended' || au.length === 0) continue;
    const ps = parts.get(id)!.sort((a, b) => a.id - b.id);
    matches.push({
      id,
      startedAt: st.started_at as number,
      endedAt: st.ended_at as number,
      auctionType: AUCTION_TYPE[st.auction_type as string] ?? String(st.auction_type),
      auctionDurationMs: st.auction_duration_ms as number,
      startingRackSize: st.starting_rack_size as number,
      roster: ps.map((p) => p.bot),
      auctions: au.map(({ id: aid, row }) => {
        const top = tops.get(aid);
        if (top === undefined) throw new Error(`match ${id}: no archived top bid for auction ${aid}`);
        return [row.letter as string, (row.winner_bot_id as number | null) ?? null, row.paid as number, top, row.closed_at as number];
      }),
      words: (words.get(id) ?? [])
        .sort((a, b) => a.id - b.id)
        .map(({ row }) => [row.bot_id as number, row.word as string, row.total_reward as number, row.played_at as number]),
      final: ps.map((p) => [p.bot, p.balance, p.score]),
    });
  }

  const fixture: Fixture = {
    source:
      'maincloud scrabblebot history (anonymous read-only SQL, 2026-11-07): every ended match whose participants are all simulated bots',
    sims,
    lobbyMaxSize: 6,
    matches,
  };
  let body = JSON.stringify(fixture);
  while (Buffer.byteLength(body) > args.maxBytes && fixture.matches.length > 3) {
    fixture.matches.pop();
    body = JSON.stringify(fixture);
  }
  writeFileSync(args.out, body + '\n');
  console.log(`wrote ${fixture.matches.length} matches (${Buffer.byteLength(body)} bytes) to ${args.out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
