// Live-client configuration: a tiny .env parser plus typed options with secret-safe printing.
//
// Rules (PITFALLS C6, plan 02-03):
//   * loadConfig() reads a .env file ONLY when an explicit `envPath` is given. Entrypoints pass
//     defaultEnvPath(); tests pass fixtures, so the real repo .env is never read by tests.
//   * Already-set env values win over the file. The file never mutates process.env.
//   * ALLOW_MAINCLOUD_PLAY is honoured only from the real environment (never from a .env file),
//     so a stray file entry cannot enable maincloud play. guard.ts re-checks process.env anyway.
//   * The token never appears in toString()/toJSON()/inspect output (length only).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type TokenSource = 'env' | 'file' | 'none';

export const DEFAULT_HOST = 'https://maincloud.spacetimedb.com';
export const DEFAULT_DB = 'scrabblebot';
export const DEFAULT_LOG_DIR = 'runs/live';

export interface ClientConfig {
  botName: string;
  /** Secret. Non-enumerable: never serialized, never printed. */
  readonly botToken: string | undefined;
  tokenSource: TokenSource;
  /** Path of the persisted token file `.token-<BOT_NAME>` (git-ignored). */
  tokenFile: string;
  host: string;
  db: string;
  policy: string;
  params: Record<string, unknown>;
  tournamentId: number | 'auto' | undefined;
  noLadder: boolean;
  maxMatches: number | undefined;
  shadow: boolean;
  logDir: string;
  logLevel: LogLevel;
  /** True only when the real environment (not a .env file) sets ALLOW_MAINCLOUD_PLAY=1. */
  allowMaincloudPlay: boolean;
  /** Host is spacetimedb.com or any non-loopback host (default-deny for game reducers). */
  isMaincloud: boolean;
  /** Host is 127.0.0.1 / localhost / ::1. */
  isLocal: boolean;
  toString(): string;
  toJSON(): Record<string, unknown>;
}

export interface LoadConfigOptions {
  /** .env file to read. When omitted, no file is read at all. */
  envPath?: string;
  /** Environment object (default process.env). Its values win over the file. */
  env?: Record<string, string | undefined>;
  /** Directory holding `.token-<BOT_NAME>` (default process.cwd()). */
  tokenDir?: string;
  /** Policy registry probe for the BOT_POLICY default ('bawt' if registered else 'starter'). */
  isPolicyRegistered?: (name: string) => boolean;
}

/** Repo root (two levels above src/client). */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** <repo>/.env — only entrypoints should pass this to loadConfig(). */
export function defaultEnvPath(): string {
  return join(repoRoot(), '.env');
}

/** Minimal .env parser: KEY=VALUE, `export` prefix, quotes, comments. No variable expansion. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2) {
      const end = value.indexOf(q, 1);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
      if (q === '"') value = value.replace(/\\n/g, '\n');
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export interface HostClass {
  isLocal: boolean;
  isMaincloud: boolean;
  hostname: string;
}

/** Classify a host URI. Anything unparseable or non-loopback counts as maincloud (default-deny). */
export function classifyHost(host: string): HostClass {
  let hostname = '';
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(host) ? host : `http://${host}`;
    hostname = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return { isLocal: false, isMaincloud: true, hostname: '' };
  }
  const bare = hostname.replace(/^\[|\]$/g, '');
  const isLocal =
    bare === 'localhost' || bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
  const isSpacetimeCom = /(^|\.)spacetimedb\.com$/.test(bare);
  return { isLocal, isMaincloud: isSpacetimeCom || !isLocal, hostname: bare };
}

function parseBool(v: string | undefined): boolean {
  if (v === undefined) return false;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function parseLevel(v: string | undefined): LogLevel {
  const s = (v ?? 'info').toLowerCase();
  return s === 'debug' || s === 'warn' || s === 'error' ? s : 'info';
}

function parsePositiveInt(name: string, v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`config: ${name} must be a non-negative integer`);
  return n;
}

function readTokenFile(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const t = readFileSync(path, 'utf8').trim();
    return t || undefined;
  } catch {
    return undefined;
  }
}

/** Load the client configuration. Never logs or prints the token. */
export function loadConfig(opts: LoadConfigOptions = {}): ClientConfig {
  const env = opts.env ?? process.env;
  const file: Record<string, string> = opts.envPath && existsSync(opts.envPath)
    ? parseDotEnv(readFileSync(opts.envPath, 'utf8'))
    : {};
  const get = (k: string): string | undefined => {
    const v = env[k];
    if (v !== undefined && v !== '') return v;
    const f = file[k];
    return f !== undefined && f !== '' ? f : undefined;
  };

  const botName = get('BOT_NAME') ?? 'bot';
  if (!/^[A-Za-z0-9_.-]+$/.test(botName)) throw new Error('config: BOT_NAME may only contain [A-Za-z0-9_.-]');
  const tokenFile = join(opts.tokenDir ?? process.cwd(), `.token-${botName}`);
  let botToken = get('BOT_TOKEN');
  let tokenSource: TokenSource = botToken ? 'env' : 'none';
  if (!botToken) {
    botToken = readTokenFile(tokenFile);
    if (botToken) tokenSource = 'file';
  }

  const host = get('STDB_HOST') ?? DEFAULT_HOST;
  const hc = classifyHost(host);
  const registered = opts.isPolicyRegistered ?? (() => false);
  const policy = get('BOT_POLICY') ?? (registered('bawt') ? 'bawt' : 'starter');

  let params: Record<string, unknown> = {};
  const rawParams = get('BOT_PARAMS');
  if (rawParams) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawParams);
    } catch {
      throw new Error('config: BOT_PARAMS must be a JSON object');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config: BOT_PARAMS must be a JSON object');
    }
    params = parsed as Record<string, unknown>;
  }

  let tournamentId: number | 'auto' | undefined;
  const rawTid = get('TOURNAMENT_ID');
  if (rawTid !== undefined) {
    if (rawTid.toLowerCase() === 'auto') tournamentId = 'auto';
    else {
      const n = Number(rawTid);
      if (!Number.isInteger(n) || n <= 0) throw new Error("config: TOURNAMENT_ID must be a positive id or 'auto'");
      tournamentId = n;
    }
  }

  // Only the real environment may enable maincloud play.
  const allowMaincloudPlay = env.ALLOW_MAINCLOUD_PLAY === '1';

  const cfg = {
    botName,
    tokenSource,
    tokenFile,
    host,
    db: get('STDB_DB') ?? DEFAULT_DB,
    policy,
    params,
    tournamentId,
    noLadder: parseBool(get('NO_LADDER')),
    maxMatches: parsePositiveInt('MAX_MATCHES', get('MAX_MATCHES')),
    shadow: parseBool(get('SHADOW')),
    logDir: get('LOG_DIR') ?? DEFAULT_LOG_DIR,
    logLevel: parseLevel(get('LOG_LEVEL')),
    allowMaincloudPlay,
    isMaincloud: hc.isMaincloud,
    isLocal: hc.isLocal,
  } as Omit<ClientConfig, 'botToken' | 'toString' | 'toJSON'>;

  const describe = (): Record<string, unknown> => ({
    ...cfg,
    botToken: botToken ? `<redacted len=${botToken.length}>` : undefined,
  });
  Object.defineProperties(cfg, {
    botToken: { value: botToken, enumerable: false, writable: false },
    toJSON: { value: describe, enumerable: false },
    toString: {
      value: () =>
        `ClientConfig(bot=${botName} host=${host} db=${cfg.db} policy=${policy} token=${
          botToken ? `len ${botToken.length} from ${tokenSource}` : 'none'
        } maincloud=${hc.isMaincloud} allowPlay=${allowMaincloudPlay})`,
      enumerable: false,
    },
    [Symbol.for('nodejs.util.inspect.custom')]: { value: describe, enumerable: false },
  });
  return cfg as ClientConfig;
}
