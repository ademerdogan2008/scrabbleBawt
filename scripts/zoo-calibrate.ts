// Calibrate the data-fitted clones (LUCENT, Bron, maverick-bot; COMPETITORS.md §4.9) in the NOW
// table mix (mostly 3 real + 3 sims; see calibration.ts NOW_TABLES) against the NOW fingerprints
// (§2.2), then print target-vs-achieved and head-to-head.
//
//   npx tsx scripts/zoo-calibrate.ts --matches 500 [--tune-matches 200] [--passes 3]
//        [--kappa-iters 7] [--need-iters 0] [--workers 8] [--seed 1] [--no-tune] [--write]
//
// Tuning: coordinate-wise bisection of log κ on tiles/match, one clone at a time, repeated in
// passes (src/bots/clones/calibration.ts), on common seeds. The B == 1 fraction stays at the
// spec's measured value (no signal; see calibration.ts); --need-iters > 0 also bisects the
// optional rack-need weight on end balance (off: it lowers scores, see fitted.ts).
// --write stores the tuned constants in src/bots/clones/{lucent,bron,maverick}.ts (the
// *_CALIBRATION lines). The final table is a fresh --matches run with a different base seed
// (held out from tuning).
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BRON_CALIBRATION } from '../src/bots/clones/bron.js';
import {
  CALIBRATED_KEYS,
  FITTED_NAMES,
  FITTED_TARGETS,
  evaluateFitted,
  relErr,
  tuneFitted,
  type CloneParams,
  type FittedEvaluation,
} from '../src/bots/clones/calibration.js';
import { LUCENT_CALIBRATION } from '../src/bots/clones/lucent.js';
import { MAVERICK_CALIBRATION } from '../src/bots/clones/maverick.js';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : dflt;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const matches = Number(arg('matches', '500'));
const tuneMatches = Number(arg('tune-matches', '200'));
const workers = Number(arg('workers', String(Math.min(8, availableParallelism()))));
const seed = Number(arg('seed', '1'));
const TOL = 0.15;

const FILES: Record<string, { file: string; constName: string }> = {
  'clone:lucent': { file: 'lucent.ts', constName: 'LUCENT_CALIBRATION' },
  'clone:bron': { file: 'bron.ts', constName: 'BRON_CALIBRATION' },
  'clone:maverick': { file: 'maverick.ts', constName: 'MAVERICK_CALIBRATION' },
};

const fmt = (x: number, d = 2) => x.toFixed(d);
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(100 * x).toFixed(1)}%`;

function table(ev: FittedEvaluation, params: Record<string, CloneParams>): string {
  const rows: string[] = [];
  rows.push('| clone | κ | needW | penFrac | metric | target (NOW) | achieved | error | within ±15% |');
  rows.push('|---|---|---|---|---|---|---|---|---|');
  for (const n of FITTED_NAMES) {
    const m = ev.metrics[n]!;
    const t = FITTED_TARGETS[n]!;
    const all = [
      ...CALIBRATED_KEYS.map((k) => [k, t[k], m[k], true] as const),
      ['score', t.score, m.score, false] as const,
      ['firstWordRound', t.firstWordRound, m.firstWordRound, false] as const,
      ['balR20', t.balR20, m.balR20, false] as const,
      ['balR45', t.balR45, m.balR45, false] as const,
      ['balR56', t.balR56, m.balR56, false] as const,
    ];
    for (const [k, target, got, calibrated] of all) {
      const e = relErr(got, target);
      rows.push(
        `| ${n} | ${params[n]!.kappa} | ${params[n]!.needW} | ${params[n]!.penFrac} | ${k}${calibrated ? '' : ' (info)'} | ${target} | ${fmt(got)} | ${pct(e)} | ${calibrated ? (Math.abs(e) <= TOL ? 'yes' : '**no**') : '-'} |`,
      );
    }
  }
  return rows.join('\n');
}

function h2hTable(ev: FittedEvaluation): string {
  const hist: Record<string, number> = {
    'clone:lucent|clone:bron': 324 / (324 + 160),
    'clone:bron|clone:maverick': 320 / (320 + 149),
    'clone:lucent|clone:maverick': 282 / (282 + 78),
  };
  const rows = ['| pair | sim P(first > second) | history (NOW) |', '|---|---|---|'];
  for (const [k, h] of Object.entries(hist)) {
    const [a, b] = k.split('|') as [string, string];
    rows.push(`| ${a} > ${b} | ${(100 * ev.headToHead[a]![b]!).toFixed(1)}% (n=${ev.shared[a]![b]}) | ${(100 * h).toFixed(1)}% |`);
  }
  return rows.join('\n');
}

function writeConstants(params: Record<string, CloneParams>): void {
  const dir = fileURLToPath(new URL('../src/bots/clones/', import.meta.url));
  for (const n of FITTED_NAMES) {
    const { file, constName } = FILES[n]!;
    const path = dir + file;
    const src = readFileSync(path, 'utf8');
    const re = new RegExp(`export const ${constName} = \\{[^}]*\\};`);
    if (!re.test(src)) throw new Error(`zoo-calibrate: ${constName} not found in ${file}`);
    const p = params[n]!;
    writeFileSync(path, src.replace(re, `export const ${constName} = { kappa: ${p.kappa}, penFrac: ${p.penFrac}, needW: ${p.needW} };`));
  }
}

async function main(): Promise<void> {
  const t0 = performance.now();
  let params: Record<string, CloneParams> = {
    'clone:lucent': { ...LUCENT_CALIBRATION },
    'clone:bron': { ...BRON_CALIBRATION },
    'clone:maverick': { ...MAVERICK_CALIBRATION },
  };
  if (!flag('no-tune')) {
    console.log(`tuning on ${tuneMatches} matches/step (seed ${seed}), workers ${workers}`);
    params = await tuneFitted(params, {
      matches: tuneMatches,
      baseSeed: seed,
      workers,
      passes: Number(arg('passes', '3')),
      kappaIters: Number(arg('kappa-iters', '7')),
      needIters: Number(arg('need-iters', '0')),
      onStep: (step, p, ev) => {
        const s = FITTED_NAMES.map((n) => {
          const m = ev.metrics[n]!;
          return `${n.slice(6)} κ=${p[n]!.kappa} need=${p[n]!.needW} tiles=${fmt(m.tiles, 1)} paid=${fmt(m.paidPerTile)} end=${fmt(m.endBalance, 1)} words=${fmt(m.words)}`;
        });
        console.log(`  ${step}: ${s.join(' | ')}`);
      },
    });
    if (flag('write')) {
      writeConstants(params);
      console.log('wrote tuned constants to src/bots/clones/{lucent,bron,maverick}.ts');
    }
  }
  const holdout = seed + 1000;
  const ev = await evaluateFitted(params, matches, holdout, workers);
  console.log(`\n## Calibration: ${matches} matches in the NOW table mix (NOW_TABLES), held-out seed ${holdout}\n`);
  console.log(table(ev, params));
  console.log('\n## Head-to-head (higher score in shared matches)\n');
  console.log(h2hTable(ev));
  const fails = FITTED_NAMES.flatMap((n) =>
    CALIBRATED_KEYS.filter((k) => Math.abs(relErr(ev.metrics[n]![k], FITTED_TARGETS[n]![k])) > TOL).map((k) => `${n}.${k}`),
  );
  console.log(`\nwithin ±15%: ${fails.length === 0 ? 'ALL' : `gaps: ${fails.join(', ')}`}`);
  console.log(`wallMs=${Math.round(performance.now() - t0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
