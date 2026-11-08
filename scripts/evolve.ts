// Continuous improvement loop (low priority, safe next to the live client `src/client/main.ts`).
//
//   npm run evolve                       # loop forever, one iteration every EVOLVE_HOURS (default 3)
//   npx tsx scripts/evolve.ts --once     # one iteration, then exit
//   options: --once --hours H --budget-min 30 --matches 200 --workers 4 --no-fetch --no-sim
//            --state PATH (default LEARN_STATE / .cache/learn/state.json) --journal .planning/LEARNING.md
//
// Each iteration shells out to the existing tools (all children run under `nice -n 15`):
//   1. live-only loss cycle      scripts/learn-cycle.ts --once --live-only
//   2. history refetch           scripts/history-fetch.ts --recent 3000 (read-only SQL, --sleep 1000)
//                                into .cache/hist-live.next, swapped in only when every table finished
//   3. live profile refit        scripts/history-profiles.ts -> data/profiles-live.json.next, renamed
//                                over data/profiles-live.json only when it parses and still has every
//                                live:<Name> seat of liveField/liveFieldB (else the old file stays)
//   4. bounded tuning search     scripts/pacing-sweep.ts, paired seeds, 'bawt-arm:<params>' neighbours
//                                of the best tested live arm vs that arm, on liveField + liveFieldB,
//                                until --budget-min is spent; winners must beat the parent by >= 2
//                                win points with CI lo > 0 on both fields, then pass the guards
//                                (lobbySims >= 98% wins; baiterTable/baitSpiteH2H/baiterH2H not
//                                significantly worse)
//   5. promote <= 2 winners      updateState + addLiveArms (src/learn/cycle/live.ts): clamped params,
//                                origin 'cycle', gate = sim stats, pool cap 6, untested cap 2,
//                                retire lowest posterior with >= 8 plays, never 'default'
// Logs: runs/evolve.log (child output appended) and .planning/LEARNING.md (one entry per iteration).
// Never connects to the game (no reducers), never restarts the live client, never reads .env.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { clampParams, LEARNABLE, type LearnableKey } from '../src/learn/arms.js';
import { armIdFor } from '../src/learn/bandit.js';
import { appendJournal, lowerPriority } from '../src/learn/cycle/cycle.js';
import { addLiveArms, paramsEqual, parentArm, type LivePoolChange } from '../src/learn/cycle/live.js';
import { defaultStatePath, loadStateStrict, updateState, type Arm } from '../src/learn/store.js';
import { LINEUPS } from '../src/bots/lineups.js';

// ------------------------------------------------------------------------------ args

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(k);
const val = (k: string, d: string) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const num = (k: string, d: number) => {
  const n = Number(val(k, String(d)));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} needs a positive number`);
  return n;
};
const A = {
  once: flag('--once'),
  hours: num('--hours', Number(process.env.EVOLVE_HOURS) > 0 ? Number(process.env.EVOLVE_HOURS) : 3),
  budgetMs: num('--budget-min', 30) * 60_000,
  matches: Math.floor(num('--matches', 200)),
  workers: Math.min(4, Math.floor(num('--workers', 4))), // CPU cap: the live bot must keep bidding on time
  fetch: !flag('--no-fetch'),
  sim: !flag('--no-sim'),
  state: resolve(val('--state', defaultStatePath())),
  journal: resolve(val('--journal', '.planning/LEARNING.md')),
};
const LOG = resolve('runs/evolve.log');
const HIST = resolve('.cache/hist-live');
const PROFILES = resolve('data/profiles-live.json');
/** Minimum sim win-rate gain (fraction) over the parent arm on both live fields. */
const MIN_GAIN = 0.02;
const FIELDS = ['liveField', 'liveFieldB'];
const GUARDS = ['lobbySims', 'baiterTable', 'baitSpiteH2H', 'baiterH2H'];

mkdirSync(resolve('runs'), { recursive: true });
const log = (m: string) => {
  const line = `[evolve ${new Date().toISOString()}] ${m}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
};

// ------------------------------------------------------------------------------ children

/** Run `nice -n 15 npx tsx <script> ...args`; output appended to runs/evolve.log; resolves stdout. */
function run(script: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' };
    delete env.BOT_TOKEN; // no child needs the game token (none of them connects to the game)
    const p = spawn('nice', ['-n', '15', 'npx', 'tsx', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let out = '';
    p.stdout.on('data', (b: Buffer) => {
      out += b.toString();
      appendFileSync(LOG, b);
    });
    p.stderr.on('data', (b: Buffer) => appendFileSync(LOG, b));
    p.on('error', (e) => {
      appendFileSync(LOG, `spawn error: ${e.message}\n`);
      res({ code: -1, out });
    });
    p.on('close', (code) => res({ code: code ?? -1, out }));
  });
}

// ------------------------------------------------------------------------------ steps

async function refetch(): Promise<boolean> {
  const next = `${HIST}.next`;
  rmSync(next, { recursive: true, force: true });
  const common = ['--out', next, '--sleep', '1000', '--fresh'];
  const a = await run('scripts/history-fetch.ts', ['--tables', 'bot,bot_version', '--all', ...common]);
  const b = a.code === 0 ? await run('scripts/history-fetch.ts', ['--tables', 'match_state,match_participant,word_play,auction_result,auction_top_bid_archive', '--recent', '3000', ...common]) : a;
  if (a.code !== 0 || b.code !== 0) {
    log(`fetch failed (exit ${a.code}/${b.code}); keeping ${HIST}`);
    return false;
  }
  rmSync(`${HIST}.prev`, { recursive: true, force: true });
  if (existsSync(HIST)) renameSync(HIST, `${HIST}.prev`);
  renameSync(next, HIST);
  return true;
}

/** live:<Name> seats the lineups need; a refit that drops one would break every sim. */
const liveSeats = () => [...new Set(FIELDS.flatMap((f) => [...LINEUPS[f as keyof typeof LINEUPS].seats]).filter((s) => s.startsWith('live:')).map((s) => s.slice(5)))];

async function refit(): Promise<string> {
  const next = `${PROFILES}.next`;
  const r = await run('scripts/history-profiles.ts', ['--data', HIST, '--out', next, '--min-matches', '25', '--active-window', '1000', '--finalists', 'none']);
  if (r.code !== 0) return `refit failed (exit ${r.code}); kept previous profiles`;
  try {
    const p = JSON.parse(readFileSync(next, 'utf8')) as { bots?: Array<{ name: string }> };
    const names = new Set((p.bots ?? []).map((b) => b.name));
    const missing = liveSeats().filter((n) => !names.has(n));
    if (missing.length) return `refit dropped ${missing.join(', ')}; kept previous profiles`;
    renameSync(next, PROFILES);
    return `profiles refit: ${names.size} bots`;
  } catch (e) {
    return `refit output unreadable (${(e as Error).message}); kept previous profiles`;
  } finally {
    rmSync(next, { force: true });
  }
}

interface Row {
  template: string;
  winA: number;
  winB: number;
  d: number;
  lo: number;
  hi: number;
  rank: number;
}

/** Parse pacing-sweep lines: "<v> @<tpl>: win A vs B | winΔ m [lo, hi] | rank Δ r ...". */
function parseSweep(out: string): Row[] {
  const rows: Row[] = [];
  const re = / @(\w+): win ([\d.]+) vs ([\d.]+) \| winΔ (-?[\d.]+) \[(-?[\d.]+), (-?[\d.]+)\] \| rank Δ (-?[\d.]+)/;
  for (const line of out.split('\n')) {
    const m = re.exec(line);
    if (m) rows.push({ template: m[1]!, winA: +m[2]!, winB: +m[3]!, d: +m[4]! / 100, lo: +m[5]! / 100, hi: +m[6]! / 100, rank: +m[7]! });
  }
  return rows;
}

const spec = (p: Record<string, unknown>) => `bawt-arm:${JSON.stringify(p)}`;

async function sweep(cand: Record<string, unknown>, base: Record<string, unknown>, templates: string[]): Promise<Row[]> {
  const r = await run('scripts/pacing-sweep.ts', ['--templates', templates.join(','), '--matches', String(A.matches), '--workers', String(A.workers), '--base', '1', spec(base), spec(cand)]);
  return r.code === 0 ? parseSweep(r.out) : [];
}

/** One-knob neighbours of the parent (steps in learnable units), plus the tune report's picks. */
function neighbours(parent: Record<string, unknown>, rot: number): Array<Record<string, unknown>> {
  const steps: Array<[LearnableKey, number]> = [
    ['tableScale', 0.1], ['earlyScale', -0.1], ['endWindow', 5], ['endKappaLo', 0.3], ['keyEdge', 1],
    ['tableScale', -0.1], ['earlyScale', 0.1], ['incomeShare', 0.1], ['reserve', -5], ['kappaLo', 0.1],
    ['greedMinSeats', 3], ['endWindow', -5], ['incomeShare', -0.1], ['dumpWindow', 5], ['denyScale', 0.15],
  ];
  const out: Array<Record<string, unknown>> = [
    { tableScale: 1.15, endWindow: 20, endKappaLo: 1.6, greedMinSeats: 3 }, // tune report #3 (guard-safe)
    { earlyScale: 0.7, endWindow: 20, endKappaLo: 1.6, greedMinSeats: 3, baitRatio: 0.9, baitShade: 0.85 }, // #1
  ];
  for (let i = 0; i < steps.length; i++) {
    const [k, s] = steps[(i + rot) % steps.length]!;
    const cur = typeof parent[k] === 'number' ? (parent[k] as number) : LEARNABLE[k].def;
    out.push(clampParams({ ...parent, [k]: Math.round((cur + s) * 1000) / 1000 }));
  }
  const uniq: Array<Record<string, unknown>> = [];
  for (const c of out.map((x) => clampParams(x) as Record<string, unknown>)) {
    if (!paramsEqual(c, parent) && !uniq.some((u) => paramsEqual(u, c))) uniq.push(c);
  }
  return uniq;
}

interface Winner {
  params: Record<string, unknown>;
  fields: Row[];
  guards: Row[];
}

async function tune(iter: number): Promise<{ lines: string[]; winners: Winner[]; parent: Arm }> {
  const t0 = Date.now();
  const state = loadStateStrict(A.state); // read-only; writes go through updateState
  const parent = parentArm(state);
  const lines = [`- parent \`${parent.id}\` ${JSON.stringify(parent.params)} (${parent.plays} plays, a=${parent.alpha.toFixed(2)} b=${parent.beta.toFixed(2)})`];
  const cands = neighbours(parent.params, iter * 3).filter((c) => !state.arms.some((a) => paramsEqual(a.params, c)));
  const passed: Winner[] = [];
  for (const c of cands) {
    if (Date.now() - t0 > A.budgetMs) {
      lines.push(`- budget ${A.budgetMs / 60000} min spent; ${cands.length - cands.indexOf(c)} candidate(s) untested`);
      break;
    }
    const rows = await sweep(c, parent.params, FIELDS);
    const ok = rows.length === FIELDS.length && rows.every((r) => r.d >= MIN_GAIN && r.lo > 0);
    lines.push(`- hypothesis ${JSON.stringify(c)} -> ${rows.map((r) => `${r.template} ${(100 * r.d).toFixed(1)} [${(100 * r.lo).toFixed(1)}, ${(100 * r.hi).toFixed(1)}]`).join('; ') || 'sweep failed'} -> ${ok ? 'beats parent' : 'no'}`);
    if (ok) passed.push({ params: c, fields: rows, guards: [] });
  }
  passed.sort((x, y) => Math.min(...y.fields.map((r) => r.d)) - Math.min(...x.fields.map((r) => r.d)));
  const winners: Winner[] = [];
  for (const w of passed) {
    if (winners.length >= 2) break;
    w.guards = await sweep(w.params, parent.params, GUARDS);
    const lobby = w.guards.find((r) => r.template === 'lobbySims');
    const bad = w.guards.filter((r) => r.template !== 'lobbySims' && r.hi < 0).map((r) => r.template);
    const ok = w.guards.length === GUARDS.length && !!lobby && lobby.winA >= 98 && bad.length === 0;
    lines.push(`- guards ${JSON.stringify(w.params)}: ${w.guards.map((r) => `${r.template} ${r.winA.toFixed(1)} vs ${r.winB.toFixed(1)}`).join('; ')} -> ${ok ? 'pass' : `fail${bad.length ? ` (${bad.join(', ')})` : ''}`}`);
    if (ok) winners.push(w);
  }
  lines.push(`- sim ${((Date.now() - t0) / 60000).toFixed(1)} min, ${A.matches} paired seeds, ${A.workers} workers`);
  return { lines, winners, parent };
}

function promote(winners: Winner[], parent: Arm): LivePoolChange {
  const now = new Date().toISOString();
  const arms: Arm[] = winners.map((w) => {
    const params = clampParams(w.params) as Record<string, unknown>;
    const worst = w.fields.reduce((a, b) => (b.d < a.d ? b : a));
    return {
      id: armIdFor(params),
      params,
      origin: 'cycle' as const,
      createdAt: now,
      parent: parent.id,
      alpha: 1,
      beta: 1,
      plays: 0,
      gate: {
        lineups: w.fields.map((r) => r.template),
        matches: A.matches,
        meanRankDelta: w.fields.reduce((s, r) => s + r.rank, 0) / w.fields.length,
        ciLo: worst.lo,
        ciHi: worst.hi,
        lobbySimsWin: (w.guards.find((r) => r.template === 'lobbySims')?.winA ?? 0) / 100,
      },
    };
  });
  let change: LivePoolChange = { added: [], retired: [], skipped: [] };
  updateState(A.state, (s) => {
    change = addLiveArms(s, arms);
  });
  return change;
}

// ------------------------------------------------------------------------------ loop

let stopping = false;
let wake: (() => void) | undefined;
const stop = () => {
  if (!stopping) log('stop requested: exiting after the current step');
  stopping = true;
  wake?.();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function iteration(iter: number): Promise<void> {
  const t0 = Date.now();
  const lines: string[] = [];
  log(`iteration ${iter} start (state ${A.state})`);
  const lc = await run('scripts/learn-cycle.ts', ['--once', '--live-only', '--state', A.state, '--journal', A.journal]);
  lines.push(`- live-only loss cycle: exit ${lc.code}`);
  if (A.fetch && !stopping) {
    const ok = await refetch();
    lines.push(`- history refetch (--recent 3000): ${ok ? 'ok' : 'failed, kept previous'}`);
    if (ok && !stopping) lines.push(`- ${await refit()}`);
  }
  let promoted = 'no (sim skipped)';
  if (A.sim && !stopping) {
    const t = await tune(iter);
    lines.push(...t.lines);
    if (t.winners.length && !stopping) {
      const ch = promote(t.winners, t.parent);
      promoted = `added ${ch.added.join(', ') || '-'}; retired ${ch.retired.join(', ') || '-'}${ch.skipped.length ? `; skipped ${JSON.stringify(ch.skipped)}` : ''}`;
    } else promoted = 'no (nothing beat the parent and passed the guards)';
  }
  lines.push(`- promoted? ${promoted}`, `- iteration ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  appendJournal(A.journal, [`### Evolve iteration ${iter} ${new Date().toISOString()}`, '', ...lines].join('\n'));
  for (const l of lines) log(l);
}

/** Single instance: two loops would race on .cache/hist-live and double the CPU load. */
function singleInstance(): boolean {
  const pidFile = resolve('runs/evolve.pid');
  try {
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        /* stale pid file */
      }
    }
  } catch {
    /* none */
  }
  writeFileSync(pidFile, String(process.pid));
  process.once('exit', () => {
    try {
      if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) rmSync(pidFile, { force: true });
    } catch {
      /* gone */
    }
  });
  return true;
}

async function main(): Promise<void> {
  if (!singleInstance()) {
    log('another evolve loop is running (runs/evolve.pid); exiting');
    return;
  }
  if (!lowerPriority()) log('could not lower process priority (continuing)');
  log(`start: ${A.once ? 'once' : `every ${A.hours} h`}; budget ${A.budgetMs / 60000} min; ${A.matches} seeds; ${A.workers} workers; fetch ${A.fetch}; sim ${A.sim}`);
  for (let iter = 0; !stopping; iter++) {
    const t0 = Date.now();
    try {
      await iteration(iter);
    } catch (e) {
      log(`iteration ${iter} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (A.once || stopping) break;
    const wait = Math.max(60_000, A.hours * 3_600_000 - (Date.now() - t0));
    log(`next iteration in ${(wait / 60000).toFixed(0)} min`);
    await new Promise<void>((r) => {
      wake = r;
      setTimeout(r, wait);
    });
  }
  log('exit');
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
