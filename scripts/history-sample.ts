// Build the committed history sample data/history-sample/*.ndjson.gz (<= 3 MB) from a full dump.
//   NODE_OPTIONS=--max-old-space-size=8192 npx tsx scripts/history-sample.ts --data <full dump dir> [--out data/history-sample]
// Deterministic selection (evenly spaced over ascending match ids):
//   - 120 recent lobby matches with Bron, LUCENT and maverick-bot (last 4,000 complete matches)
//   - 120 six-real-bot lobby matches from Oct 24-30 (30 each containing Waupus, K-13, Lionel,
//     Nijello; topped up from all six-real matches of the window)
//   - all tournament matches (51)
//   - 5 all-sim matches, up to 3 more matches with deleted bot rows, and every incomplete match
//     (so the excluded-incomplete path is exercised)
// Plus the whole bot, bot_version and tournament tables.
import fs from 'node:fs';
import path from 'node:path';
import { extractSubset, loadMatches, resolveBot } from '../src/history/load.js';
import type { HistMatch } from '../src/history/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** n evenly spaced elements of arr (all of arr when shorter). */
export function evenly<T>(arr: readonly T[], n: number): T[] {
  if (arr.length <= n) return [...arr];
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.floor((i * arr.length) / n)]!);
  return out;
}

const US = 1000;
const WINDOW_REAL6: [number, number] = [Date.UTC(2026, 9, 24) * US, Date.UTC(2026, 9, 31) * US];

async function main(): Promise<void> {
  const src = arg('data') ?? 'data/history';
  const out = arg('out') ?? 'data/history-sample';
  const D = await loadMatches(src, { skipWords: true });
  const id = (name: string) => {
    const b = resolveBot(D.bots, name);
    if (!b) throw new Error(`bot '${name}' not found`);
    return b.id;
  };
  const has = (m: HistMatch, ...ids: number[]) => ids.every((x) => m.participants.some((p) => p.botId === x));
  const complete = D.matches.filter((m) => m.complete);
  const chosen = new Set<number>();
  const take = (ms: HistMatch[], label: string) => {
    let added = 0;
    for (const m of ms) if (!chosen.has(m.id)) chosen.add(m.id), added++;
    process.stderr.write(`${label}: +${added}\n`);
  };

  const bron = id('Bron');
  const lucent = id('LUCENT');
  const maverick = id('maverick-bot');
  const recent = complete.slice(-4000).filter((m) => m.kind === 'lobby' && has(m, bron, lucent, maverick));
  take(evenly(recent, 120), 'recent lobby (Bron+LUCENT+maverick-bot)');

  const real6 = complete.filter(
    (m) =>
      m.kind === 'lobby' &&
      m.nReal === 6 &&
      m.participants.length === 6 &&
      (m.startedAtUs ?? 0) >= WINDOW_REAL6[0] &&
      (m.startedAtUs ?? 0) < WINDOW_REAL6[1],
  );
  const before = chosen.size;
  for (const name of ['Waupus', 'K-13', 'Lionel', 'Nijello']) {
    const b = id(name);
    take(evenly(real6.filter((m) => has(m, b)), 30), `six-real with ${name}`);
  }
  const need = 120 - (chosen.size - before);
  if (need > 0) take(evenly(real6.filter((m) => !chosen.has(m.id)), need), 'six-real top-up');

  take(complete.filter((m) => m.tournament !== null), 'tournament');
  take(evenly(complete.filter((m) => m.nReal === 0), 5), 'all-sim');
  const missingIds = new Set([...D.bots.values()].filter((b) => b.missing).map((b) => b.id));
  const sampleHasMissing = [...chosen].some((mid) =>
    D.matches.find((m) => m.id === mid)!.participants.some((p) => missingIds.has(p.botId)),
  );
  if (!sampleHasMissing) {
    take(evenly(complete.filter((m) => m.participants.some((p) => missingIds.has(p.botId))), 3), 'deleted bots');
  }
  take(D.matches.filter((m) => !m.complete), 'incomplete');

  fs.rmSync(out, { recursive: true, force: true });
  const counts = await extractSubset(src, out, chosen);
  let bytes = 0;
  for (const f of fs.readdirSync(out)) bytes += fs.statSync(path.join(out, f)).size;
  process.stdout.write(`${chosen.size} matches -> ${out} (${(bytes / 1e6).toFixed(2)} MB)\n${JSON.stringify(counts)}\n`);
  if (bytes > 3e6) throw new Error('sample exceeds 3 MB');
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
