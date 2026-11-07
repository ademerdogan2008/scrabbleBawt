// Run the historical validation suite (src/history/validate.ts) over a dataset directory.
// Full dataset (~340 MB NDJSON, tables not sorted by match_id) needs a bigger heap:
//   NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/history-validate.ts --data <dir> [--json out.json]
// Default --data is data/history (git-ignored full dump); data/history-sample is the committed sample.
// Exit code 1 when any check reports a mismatch.
import fs from 'node:fs';
import { getEngine } from '../src/engine/index.js';
import { loadMatches } from '../src/history/load.js';
import { formatReport, totalMismatches, validateDataset } from '../src/history/validate.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dir = arg('data') ?? 'data/history';
  const t0 = performance.now();
  const D = await loadMatches(dir);
  const t1 = performance.now();
  const { dict, index } = getEngine();
  const report = validateDataset(D, { dict, index, maxExamples: 5 });
  const t2 = performance.now();
  process.stdout.write(formatReport(report) + '\n');
  process.stdout.write(`load ${((t1 - t0) / 1000).toFixed(1)} s, validate ${((t2 - t1) / 1000).toFixed(1)} s\n`);
  const out = arg('json');
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  if (totalMismatches(report) > 0) process.exit(1);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(2);
});
