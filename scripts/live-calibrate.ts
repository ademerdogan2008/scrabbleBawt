// Calibrate the live-field clones (live:<Name>) against the live history window.
//   npx tsx scripts/live-calibrate.ts --data .cache/hist-live --window 1000 --top 12
//       -> most frequent bots in the window (and with Malicious)
//   nice npx tsx scripts/live-calibrate.ts --data .cache/hist-live --window 1000 \
//       --lineup live:A,live:B,live:C,live:D,live:E,live:F --matches 300 --workers 6
//       -> per-clone table: live vs sim win%, score, rank, end balance, letters/paid per quarter,
//          plus a suggested qScale (live paid / sim paid per quarter x current qScale)
// A lineup entry that is not live:* (e.g. 'bawt') is reported with sim stats only.
import { loadMatches } from '../src/history/load.js';
import type { HistDataset } from '../src/history/types.js';
import { lineupLabels, matchSeed, rosterOrder, runJobs, type Job } from '../src/sim/tournament.js';
import { liveCalibFor } from '../src/bots/clones/live.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Acc {
  n: number;
  wins: number;
  score: number;
  rank: number;
  bal: number;
  qWon: number[];
  qPaid: number[];
}
const newAcc = (): Acc => ({ n: 0, wins: 0, score: 0, rank: 0, bal: 0, qWon: [0, 0, 0, 0], qPaid: [0, 0, 0, 0] });
const quarter = (k: number, T: number) => Math.min(3, Math.floor((4 * k) / T));

function liveStats(D: HistDataset, window: number): Map<string, Acc> {
  const out = new Map<string, Acc>();
  const complete = D.matches.filter((m) => m.complete).slice(-window);
  for (const m of complete) {
    const T = m.auctions.length;
    const scores = m.participants.map((p) => p.score);
    const max = Math.max(...scores);
    for (const p of m.participants) {
      const name = D.bots.get(p.botId)?.name ?? String(p.botId);
      let a = out.get(name);
      if (!a) out.set(name, (a = newAcc()));
      a.n++;
      a.score += p.score;
      a.wins += p.score === max ? 1 : 0;
      a.rank += 1 + scores.filter((s) => s > p.score).length;
      a.bal += p.balance;
    }
    for (const au of m.auctions) {
      if (au.winnerId == null) continue;
      const name = D.bots.get(au.winnerId)?.name ?? String(au.winnerId);
      const a = out.get(name);
      if (!a) continue;
      const q = quarter(au.index, T);
      a.qWon[q]!++;
      a.qPaid[q]! += au.paid;
    }
  }
  return out;
}

async function simStats(lineup: string[], matches: number, workers: number): Promise<Map<string, Acc>> {
  const labels = lineupLabels(lineup);
  const jobs: Job[] = [];
  for (let k = 0; k < matches; k++) {
    const seed = matchSeed(7, k);
    jobs.push({ k, lineup, labels, seed, order: rosterOrder(seed, lineup.length, true), spec: { trace: true, matchId: k + 1, decisionBudgetMs: 200 } });
  }
  const res = await runJobs(jobs, workers);
  const out = new Map<string, Acc>();
  for (const r of res) {
    const T = r.trace!.auctions.length;
    const scores = r.record.seats.map((s) => s.score);
    const max = Math.max(...scores);
    for (const s of r.record.seats) {
      let a = out.get(s.label);
      if (!a) out.set(s.label, (a = newAcc()));
      a.n++;
      a.score += s.score;
      a.wins += s.score === max ? 1 : 0;
      a.rank += 1 + scores.filter((x) => x > s.score).length;
      a.bal += 100 - s.totalPaid + s.score;
    }
    for (const au of r.trace!.auctions) {
      if (au.winnerId == null) continue;
      const a = out.get(labels[au.winnerId - 1]!)!;
      const q = quarter(au.index, T);
      a.qWon[q]!++;
      a.qPaid[q]! += au.paid;
    }
  }
  return out;
}

const f1 = (x: number) => x.toFixed(1);
function row(tag: string, a: Acc): string {
  const won = a.qWon.map((w) => f1(w / a.n)).join('/');
  const ppl = a.qPaid.map((p, i) => f1(p / Math.max(1, a.qWon[i]!))).join('/');
  return `${tag.padEnd(5)} n=${String(a.n).padStart(5)} win=${f1((100 * a.wins) / a.n).padStart(5)}% score=${f1(a.score / a.n).padStart(5)} rank=${(a.rank / a.n).toFixed(2)} endBal=${f1(a.bal / a.n).padStart(5)} won/q=${won} paid/q=${ppl}`;
}

async function main(): Promise<void> {
  const D = await loadMatches(arg('data') ?? '.cache/hist-live');
  const window = Number(arg('window') ?? 1000);
  const live = liveStats(D, window);
  const top = arg('top');
  if (top) {
    const complete = D.matches.filter((m) => m.complete).slice(-window);
    const withMal = new Map<string, number>();
    for (const m of complete) {
      if (!m.participants.some((p) => p.botId === 168)) continue;
      for (const p of m.participants) {
        const nm = D.bots.get(p.botId)?.name ?? String(p.botId);
        withMal.set(nm, (withMal.get(nm) ?? 0) + 1);
      }
    }
    const recent = complete.slice(-200);
    const rec = new Map<string, number>();
    for (const m of recent) for (const p of m.participants) {
      const nm = D.bots.get(p.botId)?.name ?? String(p.botId);
      rec.set(nm, (rec.get(nm) ?? 0) + 1);
    }
    const seats = new Map<number, number>();
    for (const m of complete) seats.set(m.participants.length, (seats.get(m.participants.length) ?? 0) + 1);
    console.log(`window ids ${complete[0]!.id}..${complete[complete.length - 1]!.id}; seats ${JSON.stringify(Object.fromEntries(seats))}`);
    for (const [nm, a] of [...live].sort((x, y) => y[1].n - x[1].n).slice(0, Number(top))) {
      console.log(`${nm.padEnd(22)} last200=${String(rec.get(nm) ?? 0).padStart(4)} withMalicious=${String(withMal.get(nm) ?? 0).padStart(4)} ${row('live', a)}`);
    }
  }
  const lineupArg = arg('lineup');
  if (!lineupArg) return;
  const lineup = lineupArg.split(/,(?![^{]*\})/);
  const sim = await simStats(lineup, Number(arg('matches') ?? 300), Number(arg('workers') ?? 4));
  const suggest: Record<string, { scale: number; qScale: number[] }> = {};
  for (const label of lineupLabels(lineup)) {
    const s = sim.get(label);
    const base = label.replace(/#\d+$/, '').replace(/:\{.*$/, '');
    const name = base.startsWith('live:') ? base.slice(5) : undefined;
    const l = name ? live.get(name) : undefined;
    console.log(`== ${label}`);
    if (l) console.log(row('live', l));
    if (s) console.log(row('sim', s));
    if (name && l && s && !suggest[name]) {
      const cur = liveCalibFor(name);
      const qScale = cur.qScale.map((q, i) => {
        const lp = l.qPaid[i]! / Math.max(1, l.qWon[i]!);
        const sp = s.qPaid[i]! / Math.max(1, s.qWon[i]!);
        return Math.round(100 * Math.min(2, Math.max(0.5, q * (sp > 0 ? lp / sp : 1)))) / 100;
      });
      suggest[name] = { scale: cur.scale, qScale };
    }
  }
  console.log(`SUGGEST ${JSON.stringify(suggest)}`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
