// Paired-seed sweep of Bawt param variants vs the current default on several table templates.
//   npx tsx scripts/pacing-sweep.ts --matches 300 --workers 4 '{"reserve":5}' '{"incomeShare":0.6}'
//   nice npx tsx scripts/pacing-sweep.ts --templates liveField,liveFieldB '{"keyEdge":2}'  (live-fitted field)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { comparePaired } from '../src/sim/tournament.js';
import { mirrorLineup, type MirrorInput } from '../src/learn/cycle/mirror.js';
import { eventsFromLog } from '../src/client/log.js';
import { LINEUPS } from '../src/bots/lineups.js';

/** Live-mirror lineup from the last 20 live match logs (runs/live), '*' = focal. */
function liveMirror(): string[] | undefined {
  const dir = 'runs/live';
  if (!existsSync(dir)) return undefined;
  const inputs: MirrorInput[] = [];
  for (const f of readdirSync(dir).filter((x) => x.startsWith('match-')).sort().slice(-20)) {
    const st = (eventsFromLog(readFileSync(`${dir}/${f}`, 'utf8')) as any[]).find((e) => e.t === 'start');
    if (st) inputs.push({ players: st.config.players, myId: st.config.myId });
  }
  const l = mirrorLineup(inputs);
  return l?.map((x) => (x === '*' || x.startsWith('__') ? '*' : x));
}

const MIRROR = liveMirror();
const TEMPLATES: Record<string, string[]> = {
  ...(MIRROR ? { mirror: MIRROR } : {}),
  full: ['*', 'clone:k13', 'clone:lionel', 'clone:nijello', 'clone:lala', 'profile:Waupus'],
  lobby: ['*', 'clone:lucent', 'clone:bron', 'clone:maverick', 'sim:Aggressive', 'sim:ValueBidder'],
  prof: ['*', 'profile:LUCENT', 'profile:Bron', 'profile:K-13', 'profile:Lionel', 'profile:Lala'],
  sims: ['*', 'sim:Aggressive', 'sim:Aggressive', 'sim:ValueBidder', 'sim:ValueBidder', 'sim:Cheapskate'],
  // greedy-bait: price-pushers / spite drainers that push our price then let go
  baitShadow: ['*', 'trick:shadow', 'trick:allin', 'trick:bottomFeeder', 'sim:Aggressive', 'sim:ValueBidder'],
  baitSpiteTable: ['*', 'trick:spite', 'trick:shadow', 'clone:lucent', 'clone:bron', 'clone:k13'],
  baitSpiteH2H: ['*', 'trick:spite'],
  baiterTable: ['*', 'trick:baiter', 'trick:baiter', 'clone:lucent', 'clone:bron', 'clone:k13'],
  baiterH2H: ['*', 'trick:baiter'],
  baitLate: ['*', 'trick:late', 'trick:jitter', 'trick:sniper', 'trick:endgameDumper', 'sim:Aggressive'],
  liveField: [...LINEUPS.liveField.seats],
  liveFieldB: [...LINEUPS.liveFieldB.seats],
};
const only = (() => {
  let i = process.argv.indexOf('--only');
  if (i < 0) i = process.argv.indexOf('--templates');
  if (i < 0) return undefined;
  const names = process.argv.splice(i, 2)[1]!.split(',');
  for (const n of names) if (!TEMPLATES[n]) throw new Error(`unknown template '${n}' (known: ${Object.keys(TEMPLATES).join(', ')})`);
  return new Set(names);
})();
const argv = process.argv.slice(2);
const opt = (k: string, d: number) => {
  const i = argv.indexOf(k);
  return i >= 0 ? Number(argv.splice(i, 2)[1]) : d;
};
const matches = opt('--matches', 300);
const workers = opt('--workers', 4);
const base = opt('--base', 0) ? argv.shift()! : 'bawt';
const pct = (x: number) => (100 * x).toFixed(1);
for (const v of argv) {
  const spec = `bawt:${v}`;
  for (const [name, template] of Object.entries(TEMPLATES)) {
    if (only && !only.has(name)) continue;
    const r = await comparePaired({ focalA: spec, focalB: base, template, matches, workers, baseSeed: 1, spec: { decisionBudgetMs: 200 } as never });
    const A = r.a.find((x) => x.label === `A:${spec}`)!;
    const B = r.b.find((x) => x.label === `B:${base}`)!;
    console.log(
      `${v} @${name}: win ${pct(A.winRate)} vs ${pct(B.winRate)} | rank Δ ${r.rank.mean.toFixed(3)} [${r.rank.lo.toFixed(3)}, ${r.rank.hi.toFixed(3)}] | score ${A.avgScore.toFixed(1)} vs ${B.avgScore.toFixed(1)} | n=${r.matches}`,
    );
  }
}
