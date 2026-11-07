// Bawt benchmark suite: tournaments vs baselines/sims, head-to-heads, paired ablations.
//
//   npx tsx scripts/bawt-bench.ts [--matches 400] [--workers 8] [--budget-ms 200] [--seed 1]
//                                 [--only name1,name2] [--focal bawt] [--json runs/bawt-bench.json]
//
// Every run uses the simulator's independent seeded streams (identical letters per seed across
// variants) and rotates roster order per seed. Named lineups from src/bots/lineups.ts (plan 03-02)
// are added automatically when that module exists ('*' = the focal seat).
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import type { MatchSpec } from '../src/sim/match.js';
import type { LabelStats, PairedTest } from '../src/sim/stats.js';
import { comparePaired, runTournament } from '../src/sim/tournament.js';
import { LINEUPS } from '../src/bots/lineups.js';

interface ZooLineup {
  readonly seats: readonly string[];
  readonly spec?: Readonly<Partial<MatchSpec>>;
}

interface Args {
  matches: number;
  workers: number;
  budget: number;
  seed: number;
  only?: Set<string>;
  focal: string;
  json?: string;
}

function parse(argv: string[]): Args {
  const a: Args = { matches: 400, workers: Math.min(8, availableParallelism()), budget: 200, seed: 1, focal: 'bawt' };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const v = argv[i + 1];
    const need = () => {
      if (v === undefined) throw new Error(`missing value for ${k}`);
      i++;
      return v;
    };
    if (k === '--matches') a.matches = Number(need());
    else if (k === '--workers') a.workers = Number(need());
    else if (k === '--budget-ms') a.budget = Number(need());
    else if (k === '--seed') a.seed = Number(need());
    else if (k === '--only') a.only = new Set(need().split(','));
    else if (k === '--focal') a.focal = need();
    else if (k === '--json') a.json = need();
    else throw new Error(`unknown option ${k}`);
  }
  return a;
}

const SIMS5 = ['sim:Cheapskate', 'sim:ValueBidder', 'sim:Aggressive', 'sim:ValueBidder', 'sim:Aggressive'];

interface TourBench {
  kind: 'tour';
  name: string;
  lineup: string[];
  spec?: Partial<MatchSpec>;
}
interface PairBench {
  kind: 'pair';
  name: string;
  a: string;
  b: string;
  template: string[];
  spec?: Partial<MatchSpec>;
}
type Bench = TourBench | PairBench;

function benches(focal: string, lineups: Record<string, ZooLineup>): Bench[] {
  const F = focal;
  const out: Bench[] = [
    { kind: 'tour', name: 'lobbySims', lineup: [F, ...SIMS5] },
    { kind: 'tour', name: 'starterFlood', lineup: [F, 'starter', 'starter', 'starter', 'starter', 'starter'] },
    { kind: 'tour', name: 'greedyHoarderMix', lineup: [F, 'greedy', 'hoarder', 'greedy', 'hoarder', 'sim:Aggressive'] },
    { kind: 'tour', name: 'h2hStarter', lineup: [F, 'starter'] },
    { kind: 'tour', name: 'h2hGreedy', lineup: [F, 'greedy'] },
    { kind: 'tour', name: 'h2hHoarder', lineup: [F, 'hoarder'] },
    { kind: 'tour', name: 'h2hStatic', lineup: [F, 'bawt-static'] },
    // proxies for the live lobby (us + a Bron-like price setter + 0-2 others + sims) and for a
    // 6-real table, built from what exists before the opponent zoo (03-02) is merged
    { kind: 'tour', name: 'lobbyProxy', lineup: [F, 'bawt-static', 'greedy', 'hoarder', 'sim:Aggressive', 'sim:ValueBidder'] },
    { kind: 'tour', name: 'tableProxy', lineup: [F, 'bawt-static', 'bawt-k13', 'bawt-quick', 'greedy', 'hoarder'] },
    { kind: 'tour', name: 'tableProxyFP', lineup: [F, 'bawt-static', 'bawt-k13', 'bawt-quick', 'greedy', 'hoarder'], spec: { auctionType: 'FirstPrice' } },
  ];
  for (const [name, l] of Object.entries(lineups)) {
    out.push({ kind: 'tour', name: `zoo:${name}`, lineup: l.seats.map((s) => (s === '*' ? F : s)), spec: l.spec });
  }
  // paired ablations (A = focal)
  const tLobby = ['*', 'bawt-static', 'greedy', 'hoarder', 'sim:Aggressive', 'sim:ValueBidder'];
  const tTable = ['*', 'bawt-static', 'bawt-k13', 'bawt-quick', 'greedy', 'hoarder'];
  const tSims = ['*', ...SIMS5];
  for (const b of ['bawt-quick', 'bawt-k13', 'bawt-static', 'bawt-rollout']) {
    out.push({ kind: 'pair', name: `ab:${b}@lobby`, a: F, b, template: tLobby });
    out.push({ kind: 'pair', name: `ab:${b}@table`, a: F, b, template: tTable });
  }
  out.push({ kind: 'pair', name: 'ab:bawt-quick@sims', a: F, b: 'bawt-quick', template: tSims });
  // improvement round (03-01 Task 3): v1.0 = the first build, before the three fixes
  //   drive: price-driving utility with rank-relevant rivals (heads-up / small fields)
  //   incomeShareSims: spendable-income share when only sims compete (0.35 -> 0.8)
  //   mcCoverCap: early MC blend weight capped at 0.25 with >= 5 real seats
  const v10 = `${F}:{"drive":false,"incomeShareSims":0.35,"mcCoverCapMinReal":99}`;
  const tH2h = ['*', 'bawt-static'];
  for (const [t, tmpl] of [
    ['sims', tSims],
    ['h2h', tH2h],
    ['lobby', tLobby],
    ['table', tTable],
  ] as const) {
    out.push({ kind: 'pair', name: `imp:v1.0@${t}`, a: F, b: v10, template: [...tmpl] });
  }
  out.push({ kind: 'pair', name: 'imp:drive@h2h', a: F, b: `${F}:{"drive":false}`, template: tH2h });
  out.push({ kind: 'pair', name: 'imp:incomeShareSims@sims', a: F, b: `${F}:{"incomeShareSims":0.35}`, template: tSims });
  out.push({ kind: 'pair', name: 'imp:mcCoverCap@table', a: F, b: `${F}:{"mcCoverCapMinReal":99}`, template: tTable });
  return out;
}

const f1 = (x: number) => x.toFixed(1);
const f2 = (x: number) => x.toFixed(2);
const pct = (x: number) => (100 * x).toFixed(1);
const ci = (t: PairedTest) => `${f2(t.mean)} [${f2(t.lo)}, ${f2(t.hi)}]`;

function tourRow(name: string, s: LabelStats[], focalLabel: string, wallMs: number, p: { p50: number; p99: number } | undefined): string {
  const me = s.find((x) => x.label === focalLabel || x.label.startsWith(`${focalLabel}`))!;
  const others = s.filter((x) => x !== me);
  const bestOther = others.reduce((b, x) => (x.winRate > b.winRate ? x : b), others[0]!);
  return `| ${name} | ${me.n} | ${pct(me.winRate)} [${pct(me.winCI.lo)}, ${pct(me.winCI.hi)}] | ${f2(me.avgRank)} | ${f1(me.avgScore)} | ${f1(me.avgMargin)} | ${bestOther.label} ${pct(bestOther.winRate)} / ${f1(bestOther.avgScore)} | ${f1(me.avgLettersWon)} | ${f2(me.avgPaidPerLetter)} | ${f2(me.avgUnplayedTiles)} | ${me.rejectedWords}/${me.rejectedBids}/${me.voidedDecisions} | ${p ? `${f1(p.p50)}/${f1(p.p99)}` : '-'} | ${(wallMs / 1000).toFixed(0)}s |`;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const lineups: Record<string, ZooLineup> = LINEUPS;
  const all = benches(args.focal, lineups).filter((b) => !args.only || args.only.has(b.name) || [...args.only].some((o) => b.name.startsWith(o)));
  const spec: Partial<MatchSpec> = { decisionBudgetMs: args.budget };
  const results: unknown[] = [];
  const tourLines: string[] = [];
  const pairLines: string[] = [];
  for (const b of all) {
    const t0 = performance.now();
    if (b.kind === 'tour') {
      const r = await runTournament({ lineups: [b.lineup], matches: args.matches, workers: args.workers, baseSeed: args.seed, spec: { ...spec, ...b.spec } });
      const focalLabel = r.stats[0]!.label;
      const line = tourRow(b.name, r.stats, focalLabel, r.timing.wallMs, r.timing.decideMs[focalLabel]);
      tourLines.push(line);
      console.log(line);
      results.push({ bench: b, stats: r.stats, digest: r.digest, timing: r.timing });
    } else {
      const r = await comparePaired({ focalA: b.a, focalB: b.b, template: b.template, matches: args.matches, workers: args.workers, baseSeed: args.seed, spec: { ...spec, ...b.spec } });
      const A = r.a.find((x) => x.label === `A:${b.a}`)!;
      const B = r.b.find((x) => x.label === `B:${b.b}`)!;
      const line = `| ${b.name} | ${r.matches} | ${ci(r.score)} | ${ci(r.rank)} | ${pct(A.winRate)} vs ${pct(B.winRate)} | ${f1(A.avgScore)} vs ${f1(B.avgScore)} | ${r.scoreSign.pos}/${r.scoreSign.neg}/${r.scoreSign.ties} p=${r.scoreSign.p.toExponential(1)} | ${(r.timing.wallMs / 1000).toFixed(0)}s |`;
      pairLines.push(line);
      console.log(line);
      results.push({ bench: b, score: r.score, rank: r.rank, win: r.win, sign: r.scoreSign, a: r.a, b: r.b, timing: r.timing });
    }
    void t0;
  }
  console.log('\n## Tournaments (focal = first seat)\n');
  console.log('| bench | n | win% [95% CI] | avg rank | score | margin | best other (win% / score) | letters | paid/letter | unplayed | rej w/b/void | decide p50/p99 ms | wall |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const l of tourLines) console.log(l);
  if (pairLines.length) {
    console.log('\n## Paired comparisons (A - B on identical seeds)\n');
    console.log('| bench | n | Δscore [95% CI] | Δrank [95% CI] | win% A vs B | score A vs B | sign +/-/0 | wall |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const l of pairLines) console.log(l);
  }
  if (args.json) {
    mkdirSync(dirname(args.json), { recursive: true });
    writeFileSync(args.json, JSON.stringify({ args: { ...args, only: args.only ? [...args.only] : undefined }, results }, null, 1));
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
