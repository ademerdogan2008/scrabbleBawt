// Shared helpers for the local E2E harness (plan 02-04). Loopback only: every entry point calls
// requireLoopback() before connecting, spawning or calling a reducer.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setGlobalLogLevel } from 'spacetimedb';
import { classifyHost, repoRoot } from '../src/client/config.js';
import { callReducer, type GuardTarget, type ReducerHost } from '../src/client/guard.js';
import { DbConnection } from '../src/client/module_bindings/index';

export const ROOT = repoRoot();
export const PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_HOST = process.env.E2E_HOST ?? `http://127.0.0.1:${PORT}`;
export const E2E_DB = process.env.E2E_DB ?? 'scrabblebot-local';
export const STDB_DIR = join(ROOT, '.cache', 'stdb');
export const TOKEN_DIR = join(ROOT, '.cache', 'e2e', 'tokens');
export const CLI = process.env.SPACETIME_BIN ?? join(homedir(), '.local/share/spacetime/bin/2.12.0/spacetimedb-cli');

/** Throws unless `host` is a loopback address (127.x, localhost, ::1). */
export function requireLoopback(host: string): GuardTarget {
  const hc = classifyHost(host);
  if (!hc.isLocal || hc.isMaincloud) {
    throw new Error(`E2E refuses non-loopback host '${host}' (local server only)`);
  }
  return { host, isMaincloud: false };
}

export interface Connected {
  conn: DbConnection;
  identityHex: string;
  token: string;
}

/** Connect (anonymously when token is undefined) to the loopback E2E server. */
export function connect(host: string, db: string, token?: string, timeoutMs = 15_000): Promise<Connected> {
  requireLoopback(host);
  setGlobalLogLevel('warn');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), timeoutMs);
    DbConnection.builder()
      .withUri(host)
      .withDatabaseName(db)
      .withToken(token)
      .withCompression('none')
      .onConnect((conn, identity, tok) => {
        clearTimeout(t);
        resolve({ conn, identityHex: identity.toHexString(), token: tok });
      })
      .onConnectError((_c, err) => {
        clearTimeout(t);
        reject(err);
      })
      .build();
  });
}

/** Guarded reducer call (loopback target; the 02-03 guard still runs). */
export function call(c: Connected, host: string, name: string, args: Record<string, unknown>): Promise<void> {
  return callReducer(c.conn as unknown as ReducerHost, name, args, requireLoopback(host));
}

/** Subscribe and wait for the initial rows. */
export function subscribeAll(c: Connected, queries: string[], timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('subscription timeout')), timeoutMs);
    c.conn
      .subscriptionBuilder()
      .onApplied(() => {
        clearTimeout(t);
        resolve();
      })
      .onError((ctx) => {
        clearTimeout(t);
        reject(new Error(String((ctx as { event?: { message?: string } }).event?.message ?? 'subscription error')));
      })
      .subscribe(queries);
  });
}

/** Admin token minted by setup-local.sh (local server identity, seeded as admin by the patch). */
export function adminToken(): string {
  const p = join(STDB_DIR, 'admin.json');
  if (!existsSync(p)) throw new Error('no .cache/stdb/admin.json: run bash e2e/setup-local.sh first');
  return (JSON.parse(readFileSync(p, 'utf8')) as { token: string }).token;
}

/** Decode one SpacetimeDB SQL value: Option [0,v]/[1,[]], enum [i,[]], timestamp [µs]. */
export type SqlRows = unknown[][];

/** `spacetime sql` (pinned 2.12.0 CLI, isolated config, local server only) -> rows of the first statement. */
export function cliSql(query: string, db = E2E_DB): SqlRows {
  requireLoopback(E2E_HOST);
  const out = execFileSync(
    CLI,
    ['--config-path', join(STDB_DIR, 'cli.toml'), 'sql', '--server', 'e2e', '--no-config', '--format', 'json', db, query],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const start = out.indexOf('[');
  const parsed = JSON.parse(out.slice(start)) as Array<{ rows: SqlRows }>;
  return parsed[0]?.rows ?? [];
}

export function optNum(v: unknown): number | null {
  return Array.isArray(v) && v[0] === 0 ? Number(v[1]) : null;
}

export function enumIdx(v: unknown): number {
  return Array.isArray(v) ? Number(v[0]) : -1;
}
