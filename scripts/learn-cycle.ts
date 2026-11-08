// Offline loss-learning cycle (see .planning/LEARNING.md).
//
//   npx tsx scripts/learn-cycle.ts [--once|--watch] [--matches 200] [--workers 4] [--state PATH]
//                                  [--logs runs/live] [--journal .planning/LEARNING.md]
//                                  [--budget-ms 200] [--poll-ms 30000] [--grace-ms 120000]
//                                  [--max-losses 12] [--fake-loss MATCH_ID] [--live-only|--sim-gate]
//
// --live-only  (default) no sim gate: at most 2 candidates per cycle go straight into the bandit
//              pool as live arms (src/learn/cycle/live.ts: 1 cycle per 3 new matches, <= 2 untested
//              arms, pool cap 6, retire lowest posterior with >= 8 plays)
// --sim-gate   old mode: candidates must pass the paired-seed simulator gate first
// --once   one cycle, then exit (default)
// --watch  poll every 30 s for new finished matches; low CPU priority; never two cycles at once
// --fake-loss writes a simulated lost match (live JSONL format) into --logs first (offline demo;
//             requires explicit --state and --logs so it never touches the live learning state)
//
// Offline only: reads runs/live/*.jsonl and the LearnState file; never connects to a server.
import { resolve } from 'node:path';
import { DEFAULTS, lowerPriority, runCycleLocked, watch, type CycleOptions } from '../src/learn/cycle/cycle.js';
import { writeFakeLoss } from '../src/learn/cycle/fake.js';
import { GATE_BUDGET_MS } from '../src/learn/cycle/gate.js';
import { defaultStatePath } from '../src/learn/store.js';

interface Args {
  mode: 'once' | 'watch';
  matches: number;
  workers: number;
  state: string;
  logs: string;
  journal: string;
  budgetMs: number;
  pollMs: number;
  graceMs: number;
  maxLosses: number;
  fakeLoss?: number;
  liveOnly: boolean;
}

function parse(argv: string[]): Args {
  const a: Args = {
    mode: 'once',
    matches: DEFAULTS.matches,
    workers: DEFAULTS.workers,
    state: defaultStatePath(),
    logs: resolve(process.env.LEARN_LOGS?.trim() || 'runs/live'),
    journal: resolve(process.env.LEARN_JOURNAL?.trim() || '.planning/LEARNING.md'),
    budgetMs: GATE_BUDGET_MS,
    pollMs: DEFAULTS.pollMs,
    graceMs: DEFAULTS.graceMs,
    maxLosses: DEFAULTS.maxLosses,
    liveOnly: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const need = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${k}`);
      return v;
    };
    const int = (): number => {
      const n = Number(need());
      if (!Number.isFinite(n) || n < 0) throw new Error(`${k} needs a non-negative number`);
      return n;
    };
    if (k === '--once') a.mode = 'once';
    else if (k === '--watch') a.mode = 'watch';
    else if (k === '--matches') a.matches = Math.max(2, Math.floor(int()));
    else if (k === '--workers') a.workers = Math.floor(int());
    else if (k === '--state') a.state = resolve(need());
    else if (k === '--logs') a.logs = resolve(need());
    else if (k === '--journal') a.journal = resolve(need());
    else if (k === '--budget-ms') a.budgetMs = int();
    else if (k === '--poll-ms') a.pollMs = Math.max(1000, int());
    else if (k === '--grace-ms') a.graceMs = int();
    else if (k === '--max-losses') a.maxLosses = Math.max(1, Math.floor(int()));
    else if (k === '--live-only') a.liveOnly = true;
    else if (k === '--sim-gate') a.liveOnly = false;
    else if (k === '--fake-loss') a.fakeLoss = Math.floor(int());
    else throw new Error(`unknown option ${k}`);
  }
  // A fake loss is backfilled into the state as a real match (bandit update included): never let
  // the demo write into the live logs or the live learning state.
  if (a.fakeLoss !== undefined && (!argv.includes('--state') || !argv.includes('--logs'))) {
    throw new Error('--fake-loss needs explicit --state and --logs (keep the demo out of the live learning state)');
  }
  return a;
}

async function main(): Promise<number> {
  const a = parse(process.argv.slice(2));
  const log = (m: string) => console.log(`[learn ${new Date().toISOString()}] ${m}`);
  if (a.mode === 'watch' && !lowerPriority()) log('could not lower process priority (continuing)');
  if (a.fakeLoss !== undefined) {
    const f = writeFakeLoss({ dir: a.logs, matchId: a.fakeLoss });
    log(`fake loss written: ${f.file} (rank ${f.rank}, seed ${f.seed})`);
  }
  let last = -1;
  const opts: CycleOptions = {
    statePath: a.state,
    logsDir: a.logs,
    journalPath: a.journal,
    matches: a.matches,
    workers: a.workers,
    budgetMs: a.budgetMs,
    graceMs: a.fakeLoss !== undefined ? 0 : a.graceMs,
    maxLosses: a.maxLosses,
    liveOnly: a.liveOnly,
    log,
    onProgress: (d, t) => {
      const pct = Math.floor((100 * d) / t);
      if (pct >= last + 10 || d === t) {
        last = pct;
        log(`gate ${d}/${t} sims (${pct}%)`);
        if (d === t) last = -1;
      }
    },
  };
  log(`state ${a.state}; logs ${a.logs}; journal ${a.journal}; ${a.liveOnly ? 'live-only (no sim gate)' : `${a.matches} seeds/lineup, ${a.workers} workers`}`);
  if (a.mode === 'once') {
    const r = await runCycleLocked(opts);
    log(
      r.status === 'idle'
        ? 'no new losses'
        : r.status === 'busy'
          ? 'another cycle is running (lock held)'
          : a.liveOnly
            ? `analysed ${r.analyzed.length} loss(es); added ${r.pool?.added.join(', ') || '-'}; retired ${r.pool?.retired.join(', ') || '-'}; ${(r.ms / 1000).toFixed(1)} s`
            : `analysed ${r.analyzed.length} loss(es); accepted ${r.outcomes.filter((x) => x.gate.pass).length}/${r.outcomes.length}; ${(r.ms / 1000).toFixed(1)} s`,
    );
    return 0;
  }
  const h = watch(opts, a.pollMs);
  const stop = () => {
    log('stopping after the current cycle');
    h.stop();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await h.done;
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
