// Zoo sanity run: every named lineup (src/bots/lineups.ts) for N matches with a focal policy
// (default `starter`), reporting exceptions, rejected words/bids and decide() timing per seat.
//
//   npx tsx scripts/zoo-sanity.ts [--matches 200] [--focal starter] [--workers 4] [--seed 1]
//        [--lineups a,b,...] [--json out.json]
//
// A match that throws aborts its lineup's run; it is counted as an exception and the remaining
// lineups still run. Exit code 1 if any exception, rejected word/bid, or a zoo seat's decide p99
// >= 50 ms.
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { LINEUP_NAMES, getLineup, resolveLineup } from '../src/bots/lineups.js';
import { runTournament, type TournamentResult } from '../src/sim/tournament.js';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : dflt;
}

const matches = Number(arg('matches', '200'));
const focal = arg('focal', 'starter');
// decide() timings are part of the result: leave cores free so workers do not contend (on an
// M1 Pro, 8 workers on 8 P + 2 E cores doubled the K-13 p99 versus 4 workers).
const workers = Number(arg('workers', String(Math.max(1, Math.min(4, availableParallelism() - 2)))));
const seed = Number(arg('seed', '1'));
const names = arg('lineups', LINEUP_NAMES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const P99_LIMIT = 50;

interface LineupRow {
  lineup: string;
  seats: number;
  matches: number;
  exceptions: number;
  error?: string;
  focalScore?: number;
  focalRank?: number;
  focalWin?: number;
  rejectedWords: number;
  rejectedBids: number;
  worstP99?: { label: string; p99: number; max: number };
  wallMs: number;
  result?: TournamentResult;
}

interface PolicyAgg {
  n: number;
  score: number;
  wins: number;
  rank: number;
  rejected: number;
  p50: number;
  p99: number;
  max: number;
  lineups: Set<string>;
}

const baseName = (label: string): string => label.replace(/#\d+$/, '');

async function main(): Promise<void> {
  const t0 = performance.now();
  const rows: LineupRow[] = [];
  const perPolicy = new Map<string, PolicyAgg>();
  for (const name of names) {
    const l = getLineup(name);
    const seats = resolveLineup(l, focal);
    const row: LineupRow = { lineup: name, seats: seats.length, matches, exceptions: 0, rejectedWords: 0, rejectedBids: 0, wallMs: 0 };
    const s0 = performance.now();
    try {
      const r = await runTournament({ lineups: [seats], matches, workers, baseSeed: seed, spec: { ...(l.spec ?? {}) } });
      row.result = r;
      for (const st of r.stats) {
        row.rejectedWords += st.rejectedWords;
        row.rejectedBids += st.rejectedBids;
        const t = r.timing.decideMs[st.label];
        if (st.label === focal || st.label === `${focal}#1`) {
          row.focalScore = st.avgScore;
          row.focalRank = st.avgRank;
          row.focalWin = st.winRate;
        }
        const pol = baseName(st.label);
        if (pol.startsWith('sim:')) continue;
        if (t && pol !== focal && (!row.worstP99 || t.p99 > row.worstP99.p99)) row.worstP99 = { label: st.label, p99: t.p99, max: t.max };
        if (pol === focal) continue;
        const a = perPolicy.get(pol) ?? { n: 0, score: 0, wins: 0, rank: 0, rejected: 0, p50: 0, p99: 0, max: 0, lineups: new Set<string>() };
        a.n += st.n;
        a.score += st.avgScore * st.n;
        a.wins += st.wins;
        a.rank += st.avgRank * st.n;
        a.rejected += st.rejectedWords + st.rejectedBids;
        if (t) {
          a.p50 = Math.max(a.p50, t.p50);
          a.p99 = Math.max(a.p99, t.p99);
          a.max = Math.max(a.max, t.max);
        }
        a.lineups.add(name);
        perPolicy.set(pol, a);
      }
    } catch (e) {
      row.exceptions = 1;
      row.error = e instanceof Error ? e.message : String(e);
    }
    row.wallMs = Math.round(performance.now() - s0);
    rows.push(row);
    console.error(`  ${name}: ${row.exceptions ? `EXCEPTION ${row.error}` : 'ok'} (${row.wallMs} ms)`);
  }

  const f = (x: number | undefined, d = 1) => (x === undefined ? '-' : x.toFixed(d));
  console.log(`\n## Zoo sanity: ${matches} matches per lineup, focal = ${focal}, seed ${seed}, workers ${workers}\n`);
  console.log('| lineup | seats | matches | exceptions | focal avg score | focal avg rank | focal win% | rejected words/bids (all seats) | slowest zoo seat (decide p99 / max ms) | wall ms |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const w = r.worstP99 ? `${r.worstP99.label} ${f(r.worstP99.p99, 2)} / ${f(r.worstP99.max, 1)}` : '-';
    console.log(
      `| ${r.lineup} | ${r.seats} | ${r.matches} | ${r.exceptions} | ${f(r.focalScore)} | ${f(r.focalRank, 2)} | ${r.focalWin === undefined ? '-' : (100 * r.focalWin).toFixed(1)} | ${r.rejectedWords}/${r.rejectedBids} | ${w} | ${r.wallMs} |`,
    );
  }
  console.log('\n## Per zoo policy (all lineups it appears in)\n');
  console.log('| policy | lineups | seat-matches | avg score | win% | avg rank | rejected | decide p50 / p99 / max ms (worst lineup) |');
  console.log('|---|---|---|---|---|---|---|---|');
  const sorted = [...perPolicy.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [pol, a] of sorted) {
    console.log(
      `| ${pol} | ${a.lineups.size} | ${a.n} | ${f(a.score / a.n)} | ${((100 * a.wins) / a.n).toFixed(1)} | ${f(a.rank / a.n, 2)} | ${a.rejected} | ${f(a.p50, 3)} / ${f(a.p99, 2)} / ${f(a.max, 1)} |`,
    );
  }
  const exceptions = rows.reduce((s, r) => s + r.exceptions, 0);
  const rejected = rows.reduce((s, r) => s + r.rejectedWords + r.rejectedBids, 0);
  const slow = sorted.filter(([, a]) => a.p99 >= P99_LIMIT).map(([p]) => p);
  console.log(
    `\nexceptions=${exceptions} rejected=${rejected} zoo policies=${sorted.length} p99>=${P99_LIMIT}ms: ${slow.length ? slow.join(', ') : 'none'}`,
  );
  console.log(`wallMs=${Math.round(performance.now() - t0)}`);
  const json = arg('json', '');
  if (json) {
    writeFileSync(
      json,
      JSON.stringify(
        {
          matches,
          focal,
          seed,
          rows: rows.map(({ result, ...r }) => ({ ...r, stats: result?.stats, decideMs: result?.timing.decideMs })),
          perPolicy: Object.fromEntries(sorted.map(([p, a]) => [p, { ...a, lineups: [...a.lineups] }])),
        },
        null,
        2,
      ),
    );
  }
  if (exceptions > 0 || rejected > 0 || slow.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
