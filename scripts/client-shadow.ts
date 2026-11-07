// Shadow mode CLI: anonymously spectate live matches as a ghost observer (no reducers, no token).
//
//   npx tsx scripts/client-shadow.ts --matches 2 --timeout-min 10 [--seat <botId|name>] [--policy <spec>]
//                                    [--log-dir runs/shadow/<stamp>] [--no-probe] [--full-only]
//   --full-only  only observe matches from their first rounds (round <= 3), never join mid-match
//
// Host/db come from the repo .env (or ENV_FILE) like `npm start`; the bot token is never used.
// After each match the JSONL log is replayed through src/state; the run fails unless every match
// completed, its replay matches the live tracker and all diagnostics are 0.
// Exit codes: 0 ok, 1 failure, 2 "no running match found" within --timeout-min.
import { loadEntryConfig, policySpec, registryFactory } from '../src/client/main.js';
import { runShadow, type ShadowMatchResult } from '../src/client/shadow.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function row(r: ShadowMatchResult): string {
  const t = r.timing;
  const d = r.replayDiagnostics;
  const diag = d ? `${d.balanceMismatches}/${d.rackMismatches}/${d.hiddenOverflow}/${d.unseenNegative}` : 'n/a';
  return [
    r.matchId,
    r.startRound,
    r.completed ? 'yes' : 'NO',
    r.events,
    JSON.stringify(r.eventCounts),
    `${fmt(t.liveOpens ?? 0)}/${fmt(t.lateOpens ?? 0)}`,
    `${fmt(t.recvP50 ?? 0)}/${fmt(t.recvP90 ?? 0)}/${fmt(t.recvP99 ?? 0)}`,
    `${fmt(t.decideP50 ?? 0)}/${fmt(t.decideP99 ?? 0)}`,
    diag,
    r.replayMatches ? 'yes' : 'NO',
    r.error ?? '',
  ].join(' | ');
}

async function main(): Promise<number> {
  const cfg = loadEntryConfig();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  cfg.logDir = arg('log-dir') ?? process.env.SHADOW_LOG_DIR ?? `runs/shadow/${stamp}`;
  const spec = arg('policy') ?? policySpec(cfg);
  const matches = Number(arg('matches') ?? 1);
  const timeoutMin = Number(arg('timeout-min') ?? 10);
  if (!Number.isInteger(matches) || matches < 1) throw new Error('--matches must be a positive integer');
  if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) throw new Error('--timeout-min must be > 0');
  console.log(`shadow: host=${cfg.host} db=${cfg.db} policy=${spec} matches=${matches} logDir=${cfg.logDir} (anonymous, no reducers)`);
  const res = await runShadow({
    cfg,
    policyFactory: registryFactory(spec),
    matches,
    timeoutMin,
    seat: arg('seat') ?? process.env.SHADOW_SEAT,
    probe: !process.argv.includes('--no-probe'),
    freshOnly: process.argv.includes('--full-only'),
  });
  console.log('\nmatch | startRound | completed | events | counts | liveOpens/late | recv p50/p90/p99 ms | decide p50/p99 ms | replay diag bal/rack/hid/unseen | replay==live | error');
  for (const r of res.matches) console.log(row(r));
  if (res.rangeProbe) console.log(`\nrange probe (auction WHERE match_id > X): ${JSON.stringify(res.rangeProbe)}`);
  console.log(`clock: ${JSON.stringify(res.clock)}`);
  console.log(JSON.stringify({ shadowResult: res }));
  if (!res.ok) {
    console.error(res.reason ?? 'shadow failed');
    return res.reason === 'no running match found' ? 2 : 1;
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 250).unref();
  },
  (e: unknown) => {
    console.error(`shadow failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
