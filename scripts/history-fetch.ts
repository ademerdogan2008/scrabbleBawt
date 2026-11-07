// Download public ScrabbleBot history tables from maincloud into resumable NDJSON (read-only SQL).
//
//   npx tsx scripts/history-fetch.ts --tables match_state --range 1:3 --out .cache/hist-smoke
//   npx tsx scripts/history-fetch.ts --tables bot,bot_version,tournament_match --all
//   npx tsx scripts/history-fetch.ts --tables auction_result,auction_top_bid_archive,word_play \
//       --range 1:43000 --chunk 2000 --sleep 700
//   npx tsx scripts/history-fetch.ts --tables match_state,match_participant,word_play --recent 500
//
// Options: --tables a,b (allow-listed public base tables only; views are refused)
//          --all | --range A:B (match ids A..B inclusive) | --recent N
//          --out DIR (default data/history, git-ignored)   --chunk K (default 2000)
//          --sleep MS (default 700)   --fresh   --token-file F (default .cache/history-ident.json)
//          --host URL   --db NAME
// The identity token is never printed; only its length is logged.
import { DEFAULT_TOKEN_FILE, HistoryClient, fetchHistory, type FetchPlan } from '../src/history/fetch.js';
import { assertAllowedTable } from '../src/history/sql.js';

function parseArgs(argv: string[]): Record<string, string | true> {
  const o: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument '${a}'`);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[a.slice(2)] = true;
    else {
      o[a.slice(2)] = next;
      i++;
    }
  }
  return o;
}

function str(v: string | true | undefined, name: string): string | undefined {
  if (v === undefined) return undefined;
  if (v === true) throw new Error(`--${name} needs a value`);
  return v;
}

function int(v: string | true | undefined, name: string): number | undefined {
  const s = str(v, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error(`--${name} must be an integer`);
  return n;
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const tables = (str(o.tables, 'tables') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (tables.length === 0) throw new Error('--tables is required');
  for (const t of tables) assertAllowedTable(t);
  const plan: FetchPlan = {
    outDir: str(o.out, 'out') ?? 'data/history',
    tables,
    fresh: o.fresh === true,
  };
  const chunk = int(o.chunk, 'chunk');
  if (chunk !== undefined) plan.chunk = chunk;
  const sleepMs = int(o.sleep, 'sleep');
  if (sleepMs !== undefined) plan.sleepMs = sleepMs;
  if (o.all === true) plan.all = true;
  const range = str(o.range, 'range');
  if (range !== undefined) {
    const m = /^(\d+):(\d+)$/.exec(range);
    if (!m) throw new Error('--range must be A:B');
    // Inclusive on both ends on the command line (1:3 = ids 1, 2, 3); FetchPlan.range is [from, to).
    plan.range = [Number(m[1]), Number(m[2]) + 1];
  }
  const recent = int(o.recent, 'recent');
  if (recent !== undefined) plan.recent = recent;

  const log = (m: string) => process.stderr.write(m + '\n');
  const opts: ConstructorParameters<typeof HistoryClient>[0] = {
    tokenFile: str(o['token-file'], 'token-file') ?? DEFAULT_TOKEN_FILE,
    log,
  };
  const host = str(o.host, 'host');
  if (host) opts.host = host;
  const db = str(o.db, 'db');
  if (db) opts.db = db;
  const client = new HistoryClient(opts);
  const s = await fetchHistory(client, plan, log);
  log(`[total] requests=${s.requests} bytes=${s.bytes}`);
  for (const [t, v] of Object.entries(s.tables)) {
    process.stdout.write(`${t}\t${v.rows} rows\t${v.file}\n`);
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
