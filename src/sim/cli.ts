// Bench CLI: `npm run bench -- [options]` (scripts/bench.ts is a thin wrapper).
//
//   --lineup "a,b,sim:Aggressive,..."   lineup (repeatable; matches cycle through lineups)
//   --compare A,B --template "*,sim:Aggressive,..."   paired comparison of A vs B in the '*' seat
//   --matches N (1000)  --workers K (min(8, cpus))  --seed S (1)
//   --auction vickrey|first  --rack 5  --players auto|N  --duration-ms 1000  --latency-ms 60
//   --budget-ms 250  --enforce-budget  --no-rotate
//   --trace-dir runs/traces [--trace-limit 20]  --json runs/out.json
// Prints a markdown table and a final line `wallMs=<n>` (also stored in the JSON).
import { mkdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listPolicies } from '../bots/registry.js';
import type { MatchSpec } from './match.js';
import type { LabelStats, PairedTest } from './stats.js';
import { comparePaired, runTournament, type CompareResult, type TournamentResult } from './tournament.js';

/** Module lobby sim padding (bot ids 1..6). */
const LOBBY_SIMS = ['sim:Cheapskate', 'sim:ValueBidder', 'sim:Aggressive', 'sim:ValueBidder', 'sim:Aggressive', 'sim:Cheapskate'];

export interface CliOptions {
  lineups: string[][];
  compare?: [string, string];
  template?: string[];
  matches: number;
  workers: number;
  seed: number;
  spec: Partial<MatchSpec>;
  players: number | 'auto';
  rotate: boolean;
  traceDir?: string;
  traceLimit: number;
  json?: string;
  quiet: boolean;
}

const splitList = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

export function parseArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = {
    lineups: [],
    matches: 1000,
    workers: Math.min(8, availableParallelism()),
    seed: 1,
    spec: {},
    players: 'auto',
    rotate: true,
    traceLimit: 20,
    quiet: false,
  };
  const need = (i: number, flag: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`missing value for ${flag}`);
    return v;
  };
  const int = (v: string, flag: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`${flag} expects an integer, got '${v}'`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--lineup':
        o.lineups.push(splitList(need(i++, a)));
        break;
      case '--compare': {
        const parts = splitList(need(i++, a));
        if (parts.length !== 2) throw new Error('--compare expects A,B');
        o.compare = [parts[0]!, parts[1]!];
        break;
      }
      case '--template':
        o.template = splitList(need(i++, a));
        break;
      case '--matches':
        o.matches = int(need(i++, a), a);
        break;
      case '--workers':
        o.workers = int(need(i++, a), a);
        break;
      case '--seed':
        o.seed = int(need(i++, a), a);
        break;
      case '--auction': {
        const v = need(i++, a).toLowerCase();
        if (v === 'vickrey') o.spec.auctionType = 'Vickrey';
        else if (v === 'first' || v === 'firstprice') o.spec.auctionType = 'FirstPrice';
        else throw new Error(`--auction expects vickrey|first, got '${v}'`);
        break;
      }
      case '--rack':
        o.spec.startingRackSize = int(need(i++, a), a);
        break;
      case '--duration-ms':
        o.spec.auctionDurationMs = int(need(i++, a), a);
        break;
      case '--latency-ms':
        o.spec.simulatedLatencyMs = int(need(i++, a), a);
        break;
      case '--budget-ms':
        o.spec.decisionBudgetMs = int(need(i++, a), a);
        break;
      case '--enforce-budget':
        o.spec.enforceBudget = true;
        break;
      case '--players': {
        const v = need(i++, a);
        o.players = v === 'auto' ? 'auto' : int(v, a);
        break;
      }
      case '--no-rotate':
        o.rotate = false;
        break;
      case '--trace-dir':
        o.traceDir = need(i++, a);
        break;
      case '--trace-limit':
        o.traceLimit = int(need(i++, a), a);
        break;
      case '--json':
        o.json = need(i++, a);
        break;
      case '--quiet':
        o.quiet = true;
        break;
      case '--help':
      case '-h':
        throw new Error('help');
      default:
        throw new Error(`unknown option '${a}'`);
    }
  }
  return o;
}

/** Pad a lineup with lobby sims up to `players` seats (auto = as given). */
export function padLineup(lineup: string[], players: number | 'auto'): string[] {
  if (players === 'auto') return lineup;
  if (lineup.length > players) throw new Error(`lineup has ${lineup.length} seats, more than --players ${players}`);
  const out = [...lineup];
  for (let k = 0; out.length < players; k++) out.push(LOBBY_SIMS[k % LOBBY_SIMS.length]!);
  return out;
}

const f = (x: number, d = 2) => x.toFixed(d);
const pm = (mean: number, lo: number, d = 2) => `${f(mean, d)} ± ${f(mean - lo, d)}`;

export function statsTable(stats: readonly LabelStats[], timing?: TournamentResult['timing']['decideMs']): string {
  const head =
    '| seat | n | win% [95% CI] | avg rank | avg score | margin | OpenSkill | letters | paid/letter | words | unplayed | rej w/b/void | decide p50/p99/max ms |';
  const sep = '|' + head.split('|').slice(1, -1).map(() => '---').join('|') + '|';
  const rows = stats.map((s) => {
    const t = timing?.[s.label];
    const dt = t ? `${f(t.p50, 3)} / ${f(t.p99, 3)} / ${f(t.max, 1)}` : '-';
    return (
      `| ${s.label} | ${s.n} | ${f(100 * s.winRate, 1)} [${f(100 * s.winCI.lo, 1)}, ${f(100 * s.winCI.hi, 1)}] | ` +
      `${pm(s.avgRank, s.rankCI.lo)} | ${pm(s.avgScore, s.scoreCI.lo, 1)} | ${pm(s.avgMargin, s.marginCI.lo, 1)} | ` +
      `${s.openskill.display} (μ ${f(s.openskill.mu)}) | ${f(s.avgLettersWon, 1)} | ${f(s.avgPaidPerLetter)} | ` +
      `${f(s.avgWords, 1)} | ${f(s.avgUnplayedTiles, 2)} | ${s.rejectedWords}/${s.rejectedBids}/${s.voidedDecisions} | ${dt} |`
    );
  });
  return [head, sep, ...rows].join('\n');
}

function pairedLine(name: string, t: PairedTest, d = 3): string {
  return `| ${name} | ${f(t.mean, d)} | [${f(t.lo, d)}, ${f(t.hi, d)}] | ${f(t.t, 2)} | ${t.p.toExponential(2)} |`;
}

export function compareTable(r: CompareResult): string {
  return [
    `Paired comparison A=${r.focalA} vs B=${r.focalB}, template ${r.template.join(',')}, ${r.matches} seeds`,
    '',
    '| delta (A - B) | mean | 95% CI | t | p |',
    '|---|---|---|---|---|',
    pairedLine('score', r.score, 2),
    pairedLine('rank (neg = A better)', r.rank),
    pairedLine('win', r.win),
    '',
    `sign test on score: +${r.scoreSign.pos} / -${r.scoreSign.neg} / =${r.scoreSign.ties}, p = ${r.scoreSign.p.toExponential(2)}`,
    '',
    'A runs:',
    statsTable(r.a),
    '',
    'B runs:',
    statsTable(r.b),
  ].join('\n');
}

function writeJson(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(body, null, 2));
}

const USAGE = `usage: npm run bench -- --lineup "starter,sim:Aggressive,..." [--matches N] [--workers K] [--seed S]
       npm run bench -- --compare A,B --template "*,sim:Aggressive,..." [--matches N]
options: --auction vickrey|first --rack 5 --players auto|N --duration-ms 1000 --latency-ms 60
         --budget-ms 250 --enforce-budget --no-rotate --trace-dir DIR --trace-limit 20 --json FILE
policies: ${listPolicies().join(', ')}; sims: sim:Cheapskate|ValueBidder|Aggressive|Human`;

export async function main(argv: readonly string[]): Promise<number> {
  let o: CliOptions;
  try {
    o = parseArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg !== 'help') console.error(`error: ${msg}`);
    console.error(USAGE);
    return msg === 'help' ? 0 : 2;
  }
  const progress = (done: number, total: number) => {
    if (!o.quiet && process.stderr.isTTY && (done % 50 === 0 || done === total)) {
      process.stderr.write(`\r${done}/${total}`);
      if (done === total) process.stderr.write('\n');
    }
  };
  if (o.compare) {
    if (!o.template) throw new Error('--compare needs --template');
    const r = await comparePaired({
      focalA: o.compare[0],
      focalB: o.compare[1],
      template: padLineup(o.template, o.players),
      matches: o.matches,
      workers: o.workers,
      baseSeed: o.seed,
      spec: o.spec,
      rotateSeats: o.rotate,
      onProgress: progress,
    });
    console.log(compareTable(r));
    if (o.json) writeJson(o.json, { ...r, wallMs: r.timing.wallMs });
    console.log(`wallMs=${r.timing.wallMs}`);
    return 0;
  }
  if (o.lineups.length === 0) {
    console.error('error: give at least one --lineup (or --compare)');
    console.error(USAGE);
    return 2;
  }
  const lineups = o.lineups.map((l) => padLineup(l, o.players));
  const r = await runTournament({
    lineups,
    matches: o.matches,
    workers: o.workers,
    baseSeed: o.seed,
    spec: o.spec,
    rotateSeats: o.rotate,
    ...(o.traceDir ? { traceDir: o.traceDir, traceLimit: o.traceLimit } : {}),
    onProgress: progress,
  });
  console.log(
    `${r.matches} matches, ${lineups.map((l) => l.length).join('/')} seats, seed ${r.baseSeed}, workers ${o.workers}, digest ${r.digest}`,
  );
  console.log('');
  console.log(statsTable(r.stats, r.timing.decideMs));
  if (o.json) writeJson(o.json, { ...r, wallMs: r.timing.wallMs });
  console.log(`wallMs=${r.timing.wallMs}`);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : e);
      process.exit(1);
    },
  );
}
