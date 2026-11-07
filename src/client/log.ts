// Structured JSONL logging for the live client. Every line passes through redact(): JWT-looking
// strings, `token=` query params and any registered secret (the configured BOT_TOKEN) are replaced
// with <redacted> (PITFALLS C6). Writes are buffered and flushed off the hot path.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MatchEvent } from '../state/events.js';
import type { LogLevel } from './config.js';

const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const TOKEN_PARAM_RE = /token=[^&\s"']+/gi;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;

/** Redact secrets from a string. `secrets` are exact values (e.g. the configured token). */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join('<redacted>');
  }
  return out.replace(JWT_RE, '<redacted>').replace(TOKEN_PARAM_RE, 'token=<redacted>').replace(BEARER_RE, '$1<redacted>');
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Line sink (file, line) — injectable for tests. Lines are already redacted. */
export type LogSink = (file: string, line: string) => void;

export interface LoggerOptions {
  /** Directory for JSONL files (created lazily). Ignored when `sink` is given. */
  dir?: string;
  level?: LogLevel;
  /** Exact secret values to scrub (e.g. the token). */
  secrets?: readonly string[];
  sink?: LogSink;
  /** Also echo info+ lines to the console (redacted). */
  console?: boolean;
  /** Wall clock for `ts` fields (default Date.now). */
  now?: () => number;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Uint8Array) return Array.from(v);
    if (v instanceof Error) return { name: v.name, message: v.message };
    return v;
  });
}

export class Logger {
  private readonly level: number;
  private readonly secrets: string[];
  private readonly sink: LogSink;
  private readonly echo: boolean;
  private readonly now: () => number;
  private readonly buffers = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly dir: string | undefined;
  private dirReady = false;
  private readonly direct: boolean;

  constructor(opts: LoggerOptions = {}) {
    this.level = LEVELS[opts.level ?? 'info'];
    this.secrets = [...(opts.secrets ?? [])].filter((s) => s.length > 0);
    this.echo = opts.console ?? false;
    this.now = opts.now ?? Date.now;
    this.dir = opts.dir;
    this.direct = !!opts.sink;
    this.sink =
      opts.sink ??
      ((file, line) => {
        if (!this.dir) return;
        if (!this.dirReady) {
          mkdirSync(this.dir, { recursive: true });
          this.dirReady = true;
        }
        appendFileSync(join(this.dir, file), line);
      });
  }

  /** Register another secret value to scrub (e.g. a token learned at connect). */
  addSecret(secret: string | undefined): void {
    if (secret && secret.length >= 8 && !this.secrets.includes(secret)) this.secrets.push(secret);
  }

  redact(text: string): string {
    return redact(text, this.secrets);
  }

  /** Write one JSON record to `file` (redacted). */
  write(file: string, record: Record<string, unknown>): void {
    const line = this.redact(safeJson({ ts: this.now(), ...record })) + '\n';
    if (this.direct) {
      this.sink(file, line);
      return;
    }
    let buf = this.buffers.get(file);
    if (!buf) this.buffers.set(file, (buf = []));
    buf.push(line);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 200);
      this.timer.unref?.();
    }
  }

  log(level: LogLevel, msg: string, data: Record<string, unknown> = {}): void {
    if (LEVELS[level] < this.level) return;
    this.write('client.jsonl', { level, msg, ...data });
    if (this.echo) {
      const text = this.redact(`[${level}] ${msg}${Object.keys(data).length ? ' ' + safeJson(data) : ''}`);
      if (level === 'error' || level === 'warn') console.error(text);
      else console.log(text);
    }
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log('debug', msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.log('info', msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log('warn', msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.log('error', msg, data);
  }

  /** Per-match JSONL log (`match-<id>.jsonl`). */
  match(matchId: number): MatchLog {
    return new MatchLog(this, matchId);
  }

  /** Synchronously write all buffered lines. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const [file, lines] of this.buffers) {
      if (lines.length === 0) continue;
      this.sink(file, lines.join(''));
      lines.length = 0;
    }
  }
}

/** Record kinds in a match log. `event` lines replay through src/state (see eventsFromLog). */
export type MatchLogRecord =
  | { k: 'event'; e: MatchEvent }
  | { k: 'decision'; auctionId: number; index: number; pass: string; bid: number; words: string[]; decideMs: number; budgetMs: number; late: boolean }
  | { k: 'submit'; what: 'bid' | 'word'; auctionId?: number; value: number | string; outcome: string; rttMs?: number; error?: string }
  | { k: 'timing'; [key: string]: unknown }
  | { k: 'error'; msg: string; [key: string]: unknown }
  | { k: 'info'; msg: string; [key: string]: unknown };

export class MatchLog {
  readonly file: string;
  constructor(
    private readonly logger: Logger,
    readonly matchId: number,
  ) {
    this.file = `match-${matchId}.jsonl`;
  }

  record(rec: MatchLogRecord): void {
    this.logger.write(this.file, { matchId: this.matchId, ...rec });
  }

  event(e: MatchEvent): void {
    this.record({ k: 'event', e });
  }

  flush(): void {
    this.logger.flush();
  }
}

/** Extract the MatchEvent stream from parsed match-log lines (for replay()). */
export function eventsFromLog(lines: readonly string[] | string): MatchEvent[] {
  const arr = typeof lines === 'string' ? lines.split('\n') : lines;
  const out: MatchEvent[] = [];
  for (const l of arr) {
    if (!l.trim()) continue;
    const rec = JSON.parse(l) as { k?: string; e?: MatchEvent };
    if (rec.k === 'event' && rec.e) out.push(rec.e);
  }
  return out;
}
