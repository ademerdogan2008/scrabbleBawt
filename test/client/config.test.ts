import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyHost, defaultEnvPath, loadConfig, parseDotEnv } from '../../src/client/config.js';
import { backoffDelay, persistToken, RECONNECT_BACKOFF_MS } from '../../src/client/connection.js';

// Record every path the code under test touches through node:fs (passthrough).
const touched: string[] = vi.hoisted(() => []);
vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  const wrap =
    <F extends (...a: any[]) => any>(f: F): F =>
    ((...a: any[]) => {
      touched.push(String(a[0]));
      return f(...a);
    }) as F;
  const readFileSync = wrap(orig.readFileSync);
  const existsSync = wrap(orig.existsSync);
  return { ...orig, readFileSync, existsSync, default: { ...orig, readFileSync, existsSync } };
});

const FIXTURE = join(__dirname, 'fixtures', 'sample.env');
// Built at runtime so no token-looking literal is ever committed.
const KEY = ['BOT', 'TOKEN'].join('_');
const FAKE_TOKEN = ['tok', 'secret', 'value', '0123456789'].join('-');

const tmps: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'bawt-cfg-'));
  tmps.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('parseDotEnv', () => {
  it('parses quotes, export prefix, inline comments and skips junk', () => {
    const m = parseDotEnv(readFileSync(FIXTURE, 'utf8'));
    expect(m.BOT_NAME).toBe('fixture-bot');
    expect(m.STDB_HOST).toBe('http://127.0.0.1:3000');
    expect(m.STDB_DB).toBe('scrabblebot-local');
    expect(m.BOT_POLICY).toBe('greedy');
    expect(m.BOT_PARAMS).toBe('{"aggr":0.5,"name":"x y"}');
    expect(Object.keys(m)).not.toContain('not a line');
    expect(Object.keys(m)).not.toContain('');
  });
});

describe('loadConfig', () => {
  it('parses the fixture with an empty env', () => {
    const cfg = loadConfig({ envPath: FIXTURE, env: {}, tokenDir: tmp() });
    expect(cfg.botName).toBe('fixture-bot');
    expect(cfg.host).toBe('http://127.0.0.1:3000');
    expect(cfg.db).toBe('scrabblebot-local');
    expect(cfg.policy).toBe('greedy');
    expect(cfg.params).toEqual({ aggr: 0.5, name: 'x y' });
    expect(cfg.tournamentId).toBe('auto');
    expect(cfg.noLadder).toBe(true);
    expect(cfg.maxMatches).toBe(3);
    expect(cfg.logDir).toBe('runs/test');
    expect(cfg.logLevel).toBe('debug');
    expect(cfg.isLocal).toBe(true);
    expect(cfg.isMaincloud).toBe(false);
    expect(cfg.botToken).toBeUndefined();
    expect(cfg.tokenSource).toBe('none');
  });

  it('ALLOW_MAINCLOUD_PLAY in a .env file is ignored; only the real env enables it', () => {
    expect(loadConfig({ envPath: FIXTURE, env: {}, tokenDir: tmp() }).allowMaincloudPlay).toBe(false);
    expect(loadConfig({ envPath: FIXTURE, env: { ALLOW_MAINCLOUD_PLAY: '1' }, tokenDir: tmp() }).allowMaincloudPlay).toBe(true);
  });

  it('already-set env wins over the file', () => {
    const cfg = loadConfig({
      envPath: FIXTURE,
      env: { BOT_NAME: 'envbot', STDB_HOST: 'wss://maincloud.spacetimedb.com', BOT_POLICY: 'random' },
      tokenDir: tmp(),
    });
    expect(cfg.botName).toBe('envbot');
    expect(cfg.host).toBe('wss://maincloud.spacetimedb.com');
    expect(cfg.policy).toBe('random');
    expect(cfg.isMaincloud).toBe(true);
    expect(cfg.isLocal).toBe(false);
  });

  it('never reads any .env file when envPath is omitted, and never reads the repo .env when envPath is given', () => {
    const repoEnv = defaultEnvPath();
    touched.length = 0;
    loadConfig({ env: {}, tokenDir: tmp() });
    expect(touched.filter((p) => p.endsWith('.env'))).toEqual([]);
    loadConfig({ envPath: FIXTURE, env: {}, tokenDir: tmp() });
    expect(touched).toContain(FIXTURE);
    expect(touched).not.toContain(repoEnv);
  });

  it('defaults: maincloud host, scrabblebot db, starter policy (bawt when registered)', () => {
    const cfg = loadConfig({ env: {}, tokenDir: tmp() });
    expect(cfg.host).toBe('https://maincloud.spacetimedb.com');
    expect(cfg.db).toBe('scrabblebot');
    expect(cfg.policy).toBe('starter');
    expect(cfg.logDir).toBe('runs/live');
    expect(cfg.isMaincloud).toBe(true);
    expect(loadConfig({ env: {}, tokenDir: tmp(), isPolicyRegistered: (n) => n === 'bawt' }).policy).toBe('bawt');
  });

  it('token from env, else from .token-<BOT_NAME>; never printed', () => {
    const dir = tmp();
    const fromEnv = loadConfig({ env: { [KEY]: FAKE_TOKEN, BOT_NAME: 'b1' }, tokenDir: dir });
    expect(fromEnv.botToken).toBe(FAKE_TOKEN);
    expect(fromEnv.tokenSource).toBe('env');
    writeFileSync(join(dir, '.token-b2'), FAKE_TOKEN + '\n');
    const fromFile = loadConfig({ env: { BOT_NAME: 'b2' }, tokenDir: dir });
    expect(fromFile.botToken).toBe(FAKE_TOKEN);
    expect(fromFile.tokenSource).toBe('file');
    for (const s of [String(fromEnv), JSON.stringify(fromEnv), inspect(fromEnv), JSON.stringify({ ...fromEnv })]) {
      expect(s).not.toContain(FAKE_TOKEN);
    }
    expect(String(fromEnv)).toContain(`len ${FAKE_TOKEN.length}`);
  });

  it('rejects malformed values', () => {
    expect(() => loadConfig({ env: { BOT_PARAMS: '[1]' }, tokenDir: tmp() })).toThrow(/BOT_PARAMS/);
    expect(() => loadConfig({ env: { BOT_PARAMS: '{' }, tokenDir: tmp() })).toThrow(/BOT_PARAMS/);
    expect(() => loadConfig({ env: { TOURNAMENT_ID: 'x' }, tokenDir: tmp() })).toThrow(/TOURNAMENT_ID/);
    expect(() => loadConfig({ env: { MAX_MATCHES: '-1' }, tokenDir: tmp() })).toThrow(/MAX_MATCHES/);
    expect(() => loadConfig({ env: { BOT_NAME: '../evil' }, tokenDir: tmp() })).toThrow(/BOT_NAME/);
    expect(loadConfig({ env: { TOURNAMENT_ID: '7' }, tokenDir: tmp() }).tournamentId).toBe(7);
  });
});

describe('classifyHost', () => {
  it.each([
    ['https://maincloud.spacetimedb.com', false, true],
    ['wss://maincloud.spacetimedb.com', false, true],
    ['https://foo.spacetimedb.com:443/x', false, true],
    ['https://example.org', false, true],
    ['http://10.0.0.5:3000', false, true],
    ['not a url at all ::', false, true],
    ['http://127.0.0.1:3000', true, false],
    ['ws://localhost:3000', true, false],
    ['http://[::1]:3000', true, false],
    ['127.0.0.1:3000', true, false],
  ])('%s -> local=%s maincloud=%s', (host, local, main) => {
    const c = classifyHost(host);
    expect(c.isLocal).toBe(local);
    expect(c.isMaincloud).toBe(main);
  });
  it('a spacetimedb.com look-alike suffix is not loopback', () => {
    expect(classifyHost('http://127.0.0.1.spacetimedb.com').isMaincloud).toBe(true);
    expect(classifyHost('http://localhost.evil.com').isMaincloud).toBe(true);
  });
});

describe('token persistence (connection.ts)', () => {
  it('persists with mode 600 only for file/none sources and non-anonymous connections', () => {
    const dir = tmp();
    const file = join(dir, '.token-x');
    expect(persistToken({ tokenSource: 'env', tokenFile: file }, FAKE_TOKEN, { anonymous: false })).toBe(false);
    expect(persistToken({ tokenSource: 'none', tokenFile: file }, FAKE_TOKEN, { anonymous: true })).toBe(false);
    expect(() => statSync(file)).toThrow();
    expect(persistToken({ tokenSource: 'none', tokenFile: file }, FAKE_TOKEN, { anonymous: false })).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(FAKE_TOKEN);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reconnect backoff is 0.5, 1, 2, 5, 10 s and saturates', () => {
    expect(RECONNECT_BACKOFF_MS).toEqual([500, 1000, 2000, 5000, 10000]);
    expect([0, 1, 2, 3, 4, 5, 50].map(backoffDelay)).toEqual([500, 1000, 2000, 5000, 10000, 10000, 10000]);
  });
});
