// Extract opponent profiles + market priors -> data/profiles.json (schema v1, src/history/profiles.ts).
// The full dataset (~340 MB NDJSON, tables not sorted by match_id) needs a bigger heap:
//   NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/history-profiles.ts --data <dir> [--out data/profiles.json]
// Live-field fit (today's lobby): --min-matches 25 --active-window 1000 --finalists none
//   npx tsx scripts/history-profiles.ts --data .cache/hist-live --out data/profiles-live.json \
//       --min-matches 25 --active-window 1000 --finalists none
import fs from 'node:fs';
import { loadMatches } from '../src/history/load.js';
import { buildProfiles, checkProfiles, type ProfileOptions } from '../src/history/profiles.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dir = arg('data') ?? 'data/history';
  const out = arg('out') ?? 'data/profiles.json';
  const t0 = performance.now();
  const D = await loadMatches(dir);
  const t1 = performance.now();
  const opts: ProfileOptions = {};
  const num = (k: string) => {
    const v = arg(k);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`--${k} must be a non-negative integer`);
    return n;
  };
  const minM = num('min-matches');
  if (minM !== undefined) opts.minMatches = minM;
  const win = num('active-window');
  if (win !== undefined) opts.activeWindow = win;
  const fin = arg('finalists');
  if (fin !== undefined) opts.finalists = fin === 'none' ? [] : fin.split(',');
  const prof = buildProfiles(D, opts);
  const errs = checkProfiles(prof);
  if (errs.length) throw new Error(`profiles failed validation:\n${errs.slice(0, 20).join('\n')}`);
  const json = JSON.stringify(prof);
  fs.writeFileSync(out, json + '\n');
  const t2 = performance.now();
  process.stdout.write(
    `${prof.bots.length} bot profiles from ${prof.generatedFrom.completeMatches} complete matches ` +
      `(${prof.generatedFrom.excludedIncomplete} incomplete excluded) -> ${out} (${(json.length / 1e6).toFixed(2)} MB); ` +
      `load ${((t1 - t0) / 1000).toFixed(1)} s, build ${((t2 - t1) / 1000).toFixed(1)} s\n`,
  );
  for (const b of prof.bots) {
    const jx = b.caps.filter((c) => 'JXQZ'.includes(c.letter)).map((c) => `${c.letter}:${c.cap ?? '-'}`);
    process.stdout.write(
      `  ${b.name.padEnd(22)} v${b.version} n=${String(b.matches).padStart(6)} model=${String(b.modelMatches).padStart(5)} ` +
        `win=${b.results.all.winRate} won/m=${b.buying.lettersWonPerMatch} paid=${b.buying.avgPaid} ` +
        `penAllIn=${b.penultimate.allInRateOfWins} caps[${jx.join(' ')}]\n`,
    );
  }
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
