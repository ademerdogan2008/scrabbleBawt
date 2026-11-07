// Local E2E run (plan 02-04): K of OUR live clients (`npm start`, real session code) play full
// matches on the official module running on the loopback SpacetimeDB server.
//
//   npx tsx e2e/run-local.ts --matches 3
//   npx tsx e2e/run-local.ts --matches 1 --kill-one            SIGKILL one client mid-match, restart
//   options: --policies starter,greedy,hoarder,random,starter,greedy   --auction-ms 250  --rack 7
//            --kill-after <auctions> (default 20)  --timeout-min <m>  --out runs/e2e/<stamp>
//
// Safety: refuses unless the target host is loopback; every child gets an explicit environment
// (STDB_HOST=<loopback>, ENV_FILE=<empty file>, no ALLOW_MAINCLOUD_PLAY), so a repo .env pointing at
// maincloud is never read by the children.
//
// Checks (exit 1 if any fails):
//   * every client finishes its matches; every match Ended on the server
//   * 0 'Auction window expired' / 'Auction closed' / 'Match not running' errors for our clients
//   * every client JSONL match log (including the killed client's partial log) replays through
//     src/state with all diagnostics 0, and each client's final score equals the server's
//   * anchor latency p99 <= 30 ms (per client-match p99 from the driver's timing record; the max is
//     reported and gated)
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { percentile } from '../src/client/clock.js';
import { eventsFromLog } from '../src/client/log.js';
import { replay } from '../src/state/events.js';
import {
  adminToken,
  call,
  cliSql,
  connect,
  E2E_DB,
  E2E_HOST,
  enumIdx,
  requireLoopback,
  ROOT,
  TOKEN_DIR,
} from './lib.js';

const TIMING_ERRORS = ['Auction window expired', 'Auction closed', 'Match not running'];
const DEFAULT_POLICIES = ['starter', 'greedy', 'hoarder', 'random', 'starter', 'greedy'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Client {
  bot: string;
  policy: string;
  token: string;
  logDir: string;
  maxMatches: number;
  child?: ChildProcess;
  exitCode?: number | null;
  signal?: string | null;
  role: 'normal' | 'killed' | 'resumed';
}

function spawnClient(c: Client, emptyEnv: string): void {
  mkdirSync(c.logDir, { recursive: true });
  const out = openSync(join(c.logDir, 'stdout.log'), 'a');
  // Explicit environment only (no inheritance beyond PATH/HOME): loopback host, no maincloud flag.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ENV_FILE: emptyEnv,
    STDB_HOST: E2E_HOST,
    STDB_DB: E2E_DB,
    BOT_NAME: c.bot,
    BOT_TOKEN: c.token,
    BOT_POLICY: c.policy,
    BOT_PARAMS: '{}',
    MAX_MATCHES: String(c.maxMatches),
    NO_LADDER: '0',
    SHADOW: '0',
    LOG_DIR: c.logDir,
    LOG_LEVEL: 'info',
  };
  requireLoopback(env.STDB_HOST!);
  if ('ALLOW_MAINCLOUD_PLAY' in env) throw new Error('refusing: ALLOW_MAINCLOUD_PLAY in child env');
  const child = spawn('npm', ['start', '--silent'], { cwd: ROOT, env, detached: true, stdio: ['ignore', out, out] });
  c.child = child;
  child.on('exit', (code, signal) => {
    c.exitCode = code;
    c.signal = signal;
  });
}

function killGroup(c: Client, sig: NodeJS.Signals): void {
  if (c.child?.pid) {
    try {
      process.kill(-c.child.pid, sig);
    } catch {
      /* already gone */
    }
  }
}

const alive = (c: Client): boolean => c.child !== undefined && c.exitCode === undefined && c.signal === undefined;

/** Count 'open' events in a client's newest match log (for the kill trigger). */
function opensInNewestMatch(dir: string): { matchId: number; opens: number } | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).filter((f) => /^match-\d+\.jsonl$/.test(f));
  if (files.length === 0) return undefined;
  const newest = files.map((f) => Number(f.slice(6, -6))).sort((a, b) => b - a)[0]!;
  const text = readFileSync(join(dir, `match-${newest}.jsonl`), 'utf8');
  let opens = 0;
  let ended = false;
  for (const l of text.split('\n')) {
    if (l.includes('"t":"open"')) opens++;
    if (l.includes('"msg":"match ended"')) ended = true;
  }
  return ended ? undefined : { matchId: newest, opens };
}

interface MatchLogResult {
  client: string;
  role: Client['role'];
  policy: string;
  matchId: number;
  file: string;
  events: number;
  ended: boolean;
  partial: boolean;
  diagnostics: Record<string, number>;
  diagZero: boolean;
  score?: number;
  unplayed?: number;
  timing?: Record<string, number>;
  submits: { bids: number; words: number; rejected: number; byOutcome: Record<string, number> };
  timingErrorLines: string[];
  resumed: boolean;
  /** Boot resume-check of a match that had already Ended before this process started (0 decisions). */
  bootCheck: boolean;
}

function analyzeLog(c: Client, file: string): MatchLogResult {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const recs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const events = eventsFromLog(lines);
  const tr = replay(events);
  const d = { ...tr.diagnostics } as unknown as Record<string, number>;
  const ended = recs.find((r) => r.k === 'info' && r.msg === 'match ended');
  const timing = recs.find((r) => r.k === 'timing') as Record<string, number> | undefined;
  const byOutcome: Record<string, number> = {};
  let bids = 0;
  let words = 0;
  let rejected = 0;
  const timingErrorLines: string[] = [];
  for (const r of recs) {
    if (r.k === 'submit') {
      if (r.what === 'bid') bids++;
      else words++;
      const o = String(r.outcome);
      byOutcome[o] = (byOutcome[o] ?? 0) + 1;
      if (o !== 'ok') rejected++;
    }
  }
  for (const l of lines) if (TIMING_ERRORS.some((e) => l.includes(e))) timingErrorLines.push(l.slice(0, 240));
  const matchId = Number(file.match(/match-(\d+)\.jsonl$/)![1]);
  return {
    client: c.bot,
    role: c.role,
    policy: c.policy,
    matchId,
    file: relative(ROOT, file),
    events: events.length,
    ended: !!ended,
    partial: !ended,
    diagnostics: d,
    diagZero: Object.values(d).every((v) => v === 0),
    score: ended ? Number(ended.score) : undefined,
    unplayed: ended ? Number((ended.unplayed as { value?: number } | undefined)?.value ?? NaN) : undefined,
    timing,
    submits: { bids, words, rejected, byOutcome },
    timingErrorLines,
    resumed: recs.some((r) => r.k === 'info' && r.msg === 'resumed from snapshot'),
    bootCheck: !!ended && ended.source === 'snapshot' && !recs.some((r) => r.k === 'decision'),
  };
}

async function setMatchConfig(rack: number, auctionMs: number): Promise<void> {
  const admin = await connect(E2E_HOST, E2E_DB, adminToken());
  try {
    await call(admin, E2E_HOST, 'set_matchmaker_config', {
      startingRackSize: rack,
      lobbyMaxSize: 6,
      auctionDurationMs: BigInt(auctionMs),
    });
  } finally {
    admin.conn.disconnect();
  }
}

async function main(): Promise<number> {
  requireLoopback(E2E_HOST);
  const matches = Number(arg('matches') ?? 3);
  const killOne = flag('kill-one');
  const killAfter = Number(arg('kill-after') ?? 20);
  const rack = Number(arg('rack') ?? 5);
  const auctionMs = Number(arg('auction-ms') ?? 1000);
  const policies = (arg('policies') ?? DEFAULT_POLICIES.join(',')).split(',').map((s) => s.trim());
  if (flag('first-price')) {
    throw new Error('--first-price needs a tournament (lobbies are Vickrey-only in the module); not implemented in 02-04');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = arg('out') ?? join('runs', 'e2e', `${stamp}${killOne ? '-kill' : ''}`);
  const absOut = join(ROOT, outDir);
  mkdirSync(absOut, { recursive: true });
  const emptyEnv = join(ROOT, '.cache', 'e2e', 'empty.env');
  mkdirSync(join(ROOT, '.cache', 'e2e'), { recursive: true });
  writeFileSync(emptyEnv, '# intentionally empty: E2E children get an explicit environment\n');

  const clients: Client[] = policies.map((policy, i) => {
    const bot = `e2e${i + 1}`;
    const tf = join(TOKEN_DIR, `${bot}.token`);
    if (!existsSync(tf)) throw new Error(`missing ${relative(ROOT, tf)}: run npx tsx e2e/provision.ts --bots ${policies.length}`);
    return { bot, policy, token: readFileSync(tf, 'utf8').trim(), logDir: join(absOut, bot), maxMatches: matches, role: 'normal' };
  });

  await setMatchConfig(rack, auctionMs);
  const totalAuctions = 98 - rack * clients.length;
  const timeoutMs = Number(arg('timeout-min') ?? 0) * 60_000 || matches * (totalAuctions * auctionMs + 90_000) + 120_000;
  console.log(
    `run-local: ${clients.length} clients [${policies.join(', ')}] x ${matches} match(es) on ${E2E_HOST}/${E2E_DB}` +
      ` rack=${rack} auctionMs=${auctionMs} killOne=${killOne} out=${outDir}`,
  );
  for (const c of clients) spawnClient(c, emptyEnv);

  const t0 = Date.now();
  let kill: { victim: string; matchId: number; atOpens: number; restartMs: number } | undefined;
  const all = [...clients];
  while (Date.now() - t0 < timeoutMs) {
    if (killOne && !kill) {
      const v = clients[0]!;
      const st = opensInNewestMatch(v.logDir);
      if (st && st.opens >= killAfter && alive(v)) {
        killGroup(v, 'SIGKILL');
        const tk = Date.now();
        while (alive(v) && Date.now() - tk < 5000) await sleep(20);
        v.role = 'killed';
        const doneBefore = existsSync(v.logDir)
          ? readdirSync(v.logDir).filter((f) => /^match-\d+\.jsonl$/.test(f) && readFileSync(join(v.logDir, f), 'utf8').includes('"msg":"match ended"')).length
          : 0;
        const r: Client = { ...v, child: undefined, exitCode: undefined, signal: undefined, logDir: `${v.logDir}-resume`, maxMatches: matches - doneBefore, role: 'resumed' };
        spawnClient(r, emptyEnv);
        all.push(r);
        kill = { victim: v.bot, matchId: st.matchId, atOpens: st.opens, restartMs: Date.now() - tk };
        console.log(`killed ${v.bot} (pid group ${v.child?.pid}) in match ${st.matchId} after ${st.opens} opens; restarted with the same token`);
      }
    }
    if (all.every((c) => !alive(c))) break;
    await sleep(100);
  }
  const timedOut = all.some(alive);
  for (const c of all) if (alive(c)) killGroup(c, 'SIGTERM');
  await sleep(500);
  for (const c of all) if (alive(c)) killGroup(c, 'SIGKILL');
  const wallS = (Date.now() - t0) / 1000;

  // ---- analysis -------------------------------------------------------------------------------
  const logs: MatchLogResult[] = [];
  const otherTimingLines: string[] = [];
  for (const c of all) {
    if (!existsSync(c.logDir)) continue;
    for (const f of readdirSync(c.logDir)) {
      if (/^match-\d+\.jsonl$/.test(f)) logs.push(analyzeLog(c, join(c.logDir, f)));
      if (f === 'client.jsonl' || f === 'stdout.log') {
        for (const l of readFileSync(join(c.logDir, f), 'utf8').split('\n')) {
          if (TIMING_ERRORS.some((e) => l.includes(e))) otherTimingLines.push(`${c.bot}/${f}: ${l.slice(0, 200)}`);
        }
      }
    }
  }
  // Raw per-auction latency samples dumped by main.ts (latency-<match>.json) for every played match.
  const anchors: Array<{ ms: number; client: string; policy: string; matchId: number }> = [];
  const decides: number[] = [];
  for (const c of all) {
    if (!existsSync(c.logDir)) continue;
    for (const f of readdirSync(c.logDir).filter((x) => /^latency-\d+\.json$/.test(x))) {
      const j = JSON.parse(readFileSync(join(c.logDir, f), 'utf8')) as { matchId: number; anchorMs: number[]; decideMs: number[] };
      j.anchorMs.forEach((ms) => anchors.push({ ms, client: c.bot, policy: c.policy, matchId: j.matchId }));
      decides.push(...j.decideMs);
    }
  }
  const anchorVals = anchors.map((a) => a.ms);
  const pooled = {
    samples: anchorVals.length,
    p50: anchorVals.length ? percentile(anchorVals, 0.5) : NaN,
    p90: anchorVals.length ? percentile(anchorVals, 0.9) : NaN,
    p99: anchorVals.length ? percentile(anchorVals, 0.99) : NaN,
    max: anchorVals.length ? Math.max(...anchorVals) : NaN,
    over30: anchorVals.filter((v) => v > 30).length,
    over15: anchorVals.filter((v) => v > 15).length,
    decideP99: decides.length ? percentile(decides, 0.99) : NaN,
  };
  const worst = [...anchors].sort((a, b) => b.ms - a.ms).slice(0, 3).map((a) => `${a.client}/${a.policy}/m${a.matchId}=${a.ms.toFixed(2)}ms`);
  const matchIds = [...new Set(logs.filter((l) => !l.bootCheck).map((l) => l.matchId))].sort((a, b) => a - b);
  const server: Record<number, { status: number; round: number; results: number; scores: Map<number, number> }> = {};
  const botIds = new Map<number, string>();
  for (const r of cliSql(`SELECT id, name FROM bot WHERE id >= 7`)) botIds.set(Number(r[0]), String(r[1]));
  for (const m of matchIds) {
    const st = cliSql(`SELECT status, current_round FROM match_state WHERE id = ${m}`)[0] ?? [];
    const parts = cliSql(`SELECT bot_id, score FROM match_participant WHERE match_id = ${m}`);
    const results = cliSql(`SELECT auction_id, winner_bot_id FROM auction_result WHERE match_id = ${m}`);
    server[m] = {
      status: enumIdx(st[0]),
      round: Number(st[1] ?? 0),
      results: results.length,
      scores: new Map(parts.map((p) => [Number(p[0]), Number(p[1])])),
    };
  }
  const nameToId = new Map([...botIds].map(([id, n]) => [n, id]));

  // ---- report ---------------------------------------------------------------------------------
  console.log(`\nwall ${wallS.toFixed(1)} s; matches ${matchIds.join(', ')}`);
  console.log('\nmatch | status | auctions | final scores (rank)');
  for (const m of matchIds) {
    const s = server[m]!;
    const ranked = [...s.scores.entries()].sort((a, b) => b[1] - a[1]);
    const desc = ranked.map(([id, sc], i) => `${botIds.get(id) ?? id}=${sc}(#${i + 1})`).join(' ');
    console.log(`${m} | ${['Lobby', 'Running', 'Ended'][s.status] ?? s.status} | ${s.results} | ${desc}`);
  }
  console.log('\nclient | role | policy | match | events | ended | diag | score(server) | unplayed | bids/words sent | rejected | anchor p50/p99 ms | decide p99 | late opens | timing errs');
  const anchorP99s: number[] = [];
  const anchorP50s: number[] = [];
  for (const l of logs.filter((x) => !x.bootCheck).sort((a, b) => a.matchId - b.matchId || a.client.localeCompare(b.client))) {
    const t = l.timing ?? {};
    const sid = nameToId.get(l.client);
    const srv = sid !== undefined ? server[l.matchId]?.scores.get(sid) : undefined;
    if (l.timing) {
      anchorP99s.push(Number(t.anchorP99));
      anchorP50s.push(Number(t.anchorP50));
    }
    console.log(
      [
        l.client,
        l.role,
        l.policy,
        l.matchId,
        l.events,
        l.ended ? 'yes' : 'partial',
        l.diagZero ? '0' : JSON.stringify(l.diagnostics),
        `${l.score ?? '-'}(${srv ?? '?'})`,
        l.unplayed ?? '-',
        `${t.bidsSent ?? l.submits.bids}/${t.wordsSent ?? l.submits.words}`,
        `${l.submits.rejected} ${JSON.stringify(l.submits.byOutcome)}`,
        `${Number(t.anchorP50 ?? 0).toFixed(2)}/${Number(t.anchorP99 ?? 0).toFixed(2)}`,
        Number(t.decideP99 ?? 0).toFixed(2),
        t.lateOpens ?? '-',
        l.timingErrorLines.length,
      ].join(' | '),
    );
  }
  const unplayedByPolicy = new Map<string, number[]>();
  for (const l of logs) if (!l.bootCheck && l.unplayed !== undefined) unplayedByPolicy.set(l.policy, [...(unplayedByPolicy.get(l.policy) ?? []), l.unplayed]);
  console.log('\nunplayed rack value at Ended, per policy (mean over client-matches):');
  for (const [p, v] of unplayedByPolicy) console.log(`  ${p}: mean ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2)} [${v.join(', ')}]`);

  // ---- checks ---------------------------------------------------------------------------------
  const failures: string[] = [];
  if (timedOut) failures.push('timeout: some clients did not finish');
  for (const c of all) {
    if (c.role === 'killed') continue;
    if (c.exitCode !== 0) failures.push(`${c.bot}${c.role === 'resumed' ? '(resumed)' : ''} exited ${c.exitCode ?? c.signal}`);
  }
  for (const m of matchIds) if (server[m]!.status !== 2) failures.push(`match ${m} not Ended on the server`);
  const finished = logs.filter((l) => l.ended && !l.bootCheck);
  const expectedFinished = clients.length * matches;
  if (finished.length !== expectedFinished) failures.push(`finished client-match logs ${finished.length} != ${expectedFinished}`);
  for (const l of logs) {
    if (!l.diagZero) failures.push(`${l.file}: diagnostics ${JSON.stringify(l.diagnostics)}`);
    if (l.timingErrorLines.length) failures.push(`${l.file}: ${l.timingErrorLines.length} timing error line(s)`);
    if (l.ended && !l.bootCheck) {
      const sid = nameToId.get(l.client);
      const srv = sid !== undefined ? server[l.matchId]?.scores.get(sid) : undefined;
      if (srv !== l.score) failures.push(`${l.file}: final score ${l.score} != server ${srv}`);
    }
  }
  if (otherTimingLines.length) failures.push(`${otherTimingLines.length} timing error line(s) in client logs`);
  const anchorMax = anchorP99s.length ? Math.max(...anchorP99s) : NaN;
  console.log(
    `\nanchor latency (tx received -> anchor submit_bid sent), pooled over ${pooled.samples} auctions: ` +
      `p50 ${pooled.p50.toFixed(2)} / p90 ${pooled.p90.toFixed(2)} / p99 ${pooled.p99.toFixed(2)} / max ${pooled.max.toFixed(2)} ms; ` +
      `>15 ms: ${pooled.over15}, >30 ms: ${pooled.over30}; worst: ${worst.join(', ')}; per-client-match p99 max ${anchorMax.toFixed(2)} ms`,
  );
  if (!(pooled.p99 <= 30)) failures.push(`anchor latency p99 ${pooled.p99} ms > 30 ms`);
  const expectSamples = finished.filter((l) => l.role !== 'resumed').length;
  if (pooled.samples === 0 || anchors.length < expectSamples) failures.push('anchor latency samples missing (latency-<match>.json)');
  if (killOne) {
    if (!kill) failures.push('kill-one: the victim was never killed');
    else {
      const resumed = logs.find((l) => l.role === 'resumed' && l.matchId === kill!.matchId);
      if (!resumed?.ended || !resumed.resumed) failures.push('kill-one: the restarted client did not resume and finish the match');
    }
  }

  const summary = {
    run: outDir,
    hostLoopback: true,
    clients: clients.length,
    policies,
    matches: matchIds,
    rack,
    auctionMs,
    wallS,
    kill,
    clientMatchLogs: logs.length,
    finishedClientMatches: finished.length,
    partialLogs: logs.filter((l) => l.partial).length,
    resumedLogs: logs.filter((l) => l.resumed && !l.bootCheck).map((l) => l.file),
    allDiagnosticsZero: logs.every((l) => l.diagZero),
    timingErrors: logs.reduce((s, l) => s + l.timingErrorLines.length, 0) + otherTimingLines.length,
    rejectedCalls: logs.reduce((s, l) => s + l.submits.rejected, 0),
    anchorPooled: pooled,
    anchorWorst: worst,
    anchorP50Median: anchorP50s.length ? percentile(anchorP50s, 0.5) : null,
    anchorP99MaxPerClientMatch: anchorMax,
    bootCheckLogs: logs.filter((l) => l.bootCheck).length,
    unplayedByPolicy: Object.fromEntries([...unplayedByPolicy].map(([p, v]) => [p, v.reduce((a, b) => a + b, 0) / v.length])),
    failures,
  };
  writeFileSync(join(absOut, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nsummary: ${JSON.stringify(summary)}`);
  if (failures.length) {
    console.error(`\nFAILED:\n  ${failures.join('\n  ')}`);
    return 1;
  }
  console.log('\nE2E OK');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 200).unref();
  },
  (e: unknown) => {
    console.error(`run-local failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
