// Counterfactual replay benchmark: put a policy in a target bot's seat across historical matches.
//   NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/history-replay.ts --policy starter --target Bron \
//     --matches 500 --data <dir> [--real6] [--recent] [--tie-mode coin|historical] [--seed 1] \
//     [--budget-ms 50] [--json out.json] [--verbose]
// --policy mimic is built in (src/history/mimic.ts). Every other name is resolved through the 02-01
// registry (src/bots/registry.ts) via a dynamic import; when it is missing the script exits 2.
// Match selection: complete Vickrey matches with the target (and 6 real bots with --real6);
// --recent takes the N most recent, otherwise N evenly spaced over the whole history.
import fs from 'node:fs';
import type { Policy, PolicyFactory } from '../src/core/types.js';
import { getEngine } from '../src/engine/index.js';
import { loadMatches, readTable, resolveBot, toHistBot } from '../src/history/load.js';
import { mimicFactory } from '../src/history/mimic.js';
import { replayMatches, type TieMode } from '../src/history/replay.js';
import type { BotRow, HistMatch } from '../src/history/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

interface Registry {
  createPolicy(spec: string, seed: number): Policy;
}

async function loadRegistry(): Promise<Registry | undefined> {
  // Specifier held in a variable so typechecking does not require 02-01's module to exist.
  const spec = '../src/bots/registry.js';
  try {
    const mod = (await import(spec)) as Partial<Registry>;
    return typeof mod.createPolicy === 'function' ? (mod as Registry) : undefined;
  } catch {
    return undefined;
  }
}

function evenly<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * arr.length) / n)]!);
  return out;
}

const f1 = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : x.toFixed(d));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

async function main(): Promise<void> {
  const policyName = arg('policy');
  const targetName = arg('target');
  if (!policyName || !targetName) throw new Error('--policy and --target are required');
  const dir = arg('data') ?? 'data/history';
  const nMatches = Number(arg('matches') ?? 500);
  const tieMode = (arg('tie-mode') ?? 'coin') as TieMode;
  if (tieMode !== 'coin' && tieMode !== 'historical') throw new Error('--tie-mode must be coin or historical');
  const seed = Number(arg('seed') ?? 1);
  const budgetMs = Number(arg('budget-ms') ?? 50);

  let factoryFor: (m: HistMatch, targetId: number) => PolicyFactory;
  if (policyName === 'mimic') factoryFor = (m, t) => mimicFactory(m, t);
  else {
    const reg = await loadRegistry();
    if (!reg) {
      process.stderr.write('registry not available (02-01 not merged)\n');
      process.exit(2);
    }
    factoryFor = () => (s: number) => reg.createPolicy(policyName, s);
  }

  // Resolve the target from the bot table, then load only its matches.
  const botRows = await readTable<BotRow>(dir, 'bot');
  const botMap = new Map(botRows.map((r) => [r.id, toHistBot(r)]));
  const target = resolveBot(botMap, targetName);
  if (!target) throw new Error(`target '${targetName}' not found in ${dir}/bot`);
  const simIds = new Set(botRows.filter((r) => r.is_simulated).map((r) => r.id));
  const t0 = performance.now();
  const D = await loadMatches(dir, {
    filter: (h) =>
      h.participants.some((p) => p.botId === target.id) &&
      (!flag('real6') || (h.participants.length === 6 && h.participants.every((p) => !simIds.has(p.botId)))),
  });
  const eligible = D.matches.filter((m) => m.complete && m.auctionType === 'Vickrey');
  const chosen = flag('recent') ? eligible.slice(-nMatches) : evenly(eligible, nMatches);
  const t1 = performance.now();
  const { dict } = getEngine();
  const report = replayMatches(chosen, D.bots, target.id, (m) => factoryFor(m, target.id), {
    dict,
    seed,
    tieMode,
    budgetMs,
  });
  const t2 = performance.now();
  const ag = report.aggregate;
  const incomplete = D.matches.length - D.matches.filter((m) => m.complete).length;
  const nonVickrey = D.matches.filter((m) => m.complete && m.auctionType !== 'Vickrey').length;

  if (flag('verbose')) {
    for (const r of report.results) {
      process.stdout.write(
        `m${r.matchId}\tours ${r.ourScore} (rank ${r.ourRank})\ttarget ${r.targetScore} (rank ${r.targetRank})\t` +
          `letters ${r.lettersWon}/${r.targetLettersWon}\tavg price ${f1(r.avgPrice)}\tunplayed ${r.unplayed}\t` +
          `rej ${r.rejectedWords}/${r.rejectedBids}\tunattributed ${r.unattributedLosses}\tdiag ${r.diagnostics.hiddenOverflow}/${r.diagnostics.unseenNegative}\n`,
      );
    }
  }
  const lines = [
    `policy ${policyName} in ${target.name}'s seat (bot ${target.id}); tie-mode ${tieMode}; seed ${seed}; data ${dir}`,
    `matches: ${D.matches.length} with ${target.name}${flag('real6') ? ' (6 real bots)' : ''}; excluded ${incomplete} incomplete, ${nonVickrey} non-Vickrey; replayed ${ag.n} (${flag('recent') ? 'most recent' : 'evenly spaced'})`,
    `win rate   ours ${pct(ag.ourWinRate.p)} [${pct(ag.ourWinRate.lo)}, ${pct(ag.ourWinRate.hi)}]   original ${pct(ag.targetWinRate.p)} [${pct(ag.targetWinRate.lo)}, ${pct(ag.targetWinRate.hi)}]   (Wilson 95%)`,
    `avg rank   ours ${f1(ag.ourAvgRank, 3)}   original ${f1(ag.targetAvgRank, 3)}`,
    `avg score  ours ${f1(ag.ourAvgScore.mean, 2)} ± ${f1(ag.ourAvgScore.half, 2)}   original ${f1(ag.targetAvgScore.mean, 2)} ± ${f1(ag.targetAvgScore.half, 2)}   delta ${f1(ag.avgScoreDelta.mean, 2)} ± ${f1(ag.avgScoreDelta.half, 2)}`,
    `exact score matches ${ag.exactScoreMatches}/${ag.n}`,
    `letters/match ours ${f1(ag.lettersWonPerMatch, 2)} original ${f1(ag.targetLettersWonPerMatch, 2)}; avg price ${f1(ag.avgPrice, 2)}; unplayed/match ${f1(ag.unplayedPerMatch, 2)}`,
    `rejected words ${ag.rejectedWords}, bids ${ag.rejectedBids}; policy errors ${ag.policyErrors}; unattributed losses ${ag.unattributedLosses}; ties ${ag.ties} (won ${ag.tiesWon})`,
    `tracker diagnostics (expected when opponents replay letters we took): hiddenOverflow ${ag.diagnostics.hiddenOverflow}, unseenNegative ${ag.diagnostics.unseenNegative}, matches affected ${ag.diagnostics.matchesWithDiagnostics}`,
    `load ${((t1 - t0) / 1000).toFixed(1)} s, replay ${((t2 - t1) / 1000).toFixed(1)} s (${f1((t2 - t1) / Math.max(1, ag.n), 2)} ms/match)`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
  const out = arg('json');
  if (out) fs.writeFileSync(out, JSON.stringify({ policy: policyName, target: target.name, tieMode, seed, ...report }, null, 2));
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
