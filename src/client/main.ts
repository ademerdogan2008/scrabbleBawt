// `npm start`: the live client entrypoint (CLI-01, CLI-07).
//
//   * Config from the repo .env (or ENV_FILE=<path>); the real environment wins over the file.
//   * BOT_POLICY resolves through the policy registry (src/bots/registry.ts); BOT_PARAMS is merged in.
//   * SHADOW=1 runs the anonymous ghost observer instead (src/client/shadow.ts, no reducers).
//   * Live mode runs the 02-03 session. Against maincloud without ALLOW_MAINCLOUD_PLAY=1 in the real
//     environment it prints "read-only: refusing to play" and exits non-zero BEFORE connecting
//     (guard.ts default-deny; runSession refuses without touching the network).
import { createPolicy, listPolicies } from '../bots/registry.js';
import type { PolicyFactory } from '../core/types.js';
import { defaultEnvPath, loadConfig, type ClientConfig } from './config.js';
import { runSession } from './session.js';
import { runShadow } from './shadow.js';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_REFUSED = 3;

/** Env file for entrypoints: ENV_FILE overrides the repo-root .env. */
export function entryEnvPath(env: Record<string, string | undefined> = process.env): string {
  return env.ENV_FILE && env.ENV_FILE.trim() ? env.ENV_FILE.trim() : defaultEnvPath();
}

/** Registry spec for the configured policy: BOT_POLICY, plus BOT_PARAMS as inline JSON when given. */
export function policySpec(cfg: Pick<ClientConfig, 'policy' | 'params'>): string {
  if (cfg.policy.includes(':') || Object.keys(cfg.params).length === 0) return cfg.policy;
  return `${cfg.policy}:${JSON.stringify(cfg.params)}`;
}

/** PolicyFactory over the registry. Validates the spec once (throws on an unknown policy). */
export function registryFactory(spec: string): PolicyFactory {
  createPolicy(spec, 0);
  return (seed) => createPolicy(spec, seed);
}

export function loadEntryConfig(): ClientConfig {
  const names = new Set(listPolicies());
  return loadConfig({ envPath: entryEnvPath(), isPolicyRegistered: (n) => names.has(n) });
}

async function main(): Promise<number> {
  const cfg = loadEntryConfig();
  const spec = policySpec(cfg);
  const policyFactory = registryFactory(spec);

  if (cfg.shadow) {
    const res = await runShadow({
      cfg,
      policyFactory,
      matches: cfg.maxMatches ?? 1,
      timeoutMin: Number(process.env.SHADOW_TIMEOUT_MIN ?? 10),
      seat: process.env.SHADOW_SEAT,
    });
    if (!res.ok) console.error(res.reason ?? 'shadow failed');
    return res.ok ? EXIT_OK : res.reason === 'no running match found' ? 2 : EXIT_ERROR;
  }

  console.log(`live client: ${String(cfg)} spec=${spec}`);
  const s = await runSession({ cfg, policyFactory });
  const stop = (): void => s.stop();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const status = await s.done;
  if (status === 'refused') {
    console.error('read-only: refusing to play');
    return EXIT_REFUSED;
  }
  console.log(`live client finished: ${status} (matches played: ${s.core.matchesPlayed})`);
  return status === 'error' ? EXIT_ERROR : EXIT_OK;
}

const isEntry = (() => {
  const arg = process.argv[1] ?? '';
  return /[\\/]src[\\/]client[\\/]main\.(ts|js)$/.test(arg);
})();

if (isEntry) {
  main().then(
    (code) => {
      // Let buffered log lines and socket closes settle, then exit (no lingering timers).
      setTimeout(() => process.exit(code), 250).unref();
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`live client failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(EXIT_ERROR);
    },
  );
}
