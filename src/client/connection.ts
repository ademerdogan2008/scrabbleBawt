// DbConnection lifecycle: build with token, persist refreshed tokens (non-anonymous, not from env),
// reconnect with backoff (0.5, 1, 2, 5, 10 s) and a resubscribe hook. Errors are logged through
// log.ts (redacted); the token itself is never logged (length only).
import { chmodSync, writeFileSync } from 'node:fs';
import { setGlobalLogLevel, type Identity } from 'spacetimedb';
import { DbConnection } from './module_bindings/index';
import type { ClientConfig } from './config.js';
import type { Logger } from './log.js';

export const RECONNECT_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 5000, 10000];

/** Delay before reconnect attempt `attempt` (0-based); saturates at the last step. */
export function backoffDelay(attempt: number): number {
  const i = Math.max(0, Math.min(RECONNECT_BACKOFF_MS.length - 1, Math.floor(attempt)));
  return RECONNECT_BACKOFF_MS[i]!;
}

export interface PersistOptions {
  /** Anonymous connections (shadow, whoami-anon) never persist their server-minted token. */
  anonymous: boolean;
}

/**
 * Persist a (refreshed) token to cfg.tokenFile with mode 600, only when the token was NOT given via
 * BOT_TOKEN and the connection is not anonymous. Returns true when written.
 */
export function persistToken(
  cfg: Pick<ClientConfig, 'tokenSource' | 'tokenFile'>,
  token: string,
  opts: PersistOptions,
): boolean {
  if (opts.anonymous || cfg.tokenSource === 'env' || !token) return false;
  writeFileSync(cfg.tokenFile, token, { encoding: 'utf8', mode: 0o600 });
  chmodSync(cfg.tokenFile, 0o600);
  return true;
}

export interface ConnectedInfo {
  conn: DbConnection;
  identity: Identity;
  identityHex: string;
  /** 0 for the first connection of this supervisor, then 1, 2, ... */
  generation: number;
}

export interface SupervisorOptions {
  cfg: ClientConfig;
  log: Logger;
  /** Connect without a token (fresh server-minted identity, never persisted). */
  anonymous?: boolean;
  /** Called on every (re)connect; subscribe here (resubscribe hook). */
  onConnected(info: ConnectedInfo): void;
  /** Called when a connection is lost (before the backoff timer). */
  onLost?(generation: number, err?: Error): void;
  /** Give up after this many consecutive failures (default: never). */
  maxAttempts?: number;
  /** Called when the supervisor gives up. */
  onGiveUp?(err?: Error): void;
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Owns at most one live DbConnection. A fresh connection is built for every reconnect, so callers
 * must re-subscribe in onConnected and rebuild per-match state from the subscription snapshots.
 */
export class ConnectionSupervisor {
  private conn: DbConnection | undefined;
  private attempt = 0;
  private generation = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private token: string | undefined;

  constructor(private readonly opts: SupervisorOptions) {
    this.token = opts.anonymous ? undefined : opts.cfg.botToken;
    opts.log.addSecret(this.token);
  }

  get connection(): DbConnection | undefined {
    return this.conn;
  }

  start(): void {
    this.stopped = false;
    setGlobalLogLevel('warn');
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const c = this.conn;
    this.conn = undefined;
    try {
      c?.disconnect();
    } catch {
      /* already closed */
    }
  }

  /** Force a rebuild (e.g. in-match liveness watchdog). */
  rebuild(reason: string): void {
    this.opts.log.warn('connection rebuild', { reason });
    const c = this.conn;
    this.conn = undefined;
    try {
      c?.disconnect();
    } catch {
      /* ignore */
    }
    this.scheduleReconnect();
  }

  private open(): void {
    const { cfg, log } = this.opts;
    const gen = this.generation;
    log.info('connecting', { host: cfg.host, db: cfg.db, anonymous: !!this.opts.anonymous, tokenLen: this.token?.length ?? 0 });
    const conn = DbConnection.builder()
      .withUri(cfg.host)
      .withDatabaseName(cfg.db)
      .withToken(this.token)
      .withCompression('none')
      .withConfirmedReads(false)
      .onConnect((c, identity, token) => {
        if (this.stopped || gen !== this.generation) return;
        this.attempt = 0;
        log.addSecret(token);
        if (!this.opts.anonymous) {
          this.token = token;
          try {
            if (persistToken(cfg, token, { anonymous: false })) log.info('token persisted', { file: cfg.tokenFile, tokenLen: token.length });
          } catch (e) {
            log.warn('token persist failed', { error: errText(e) });
          }
        }
        const identityHex = identity.toHexString();
        log.info('connected', { identity: identityHex, generation: gen });
        this.opts.onConnected({ conn: c, identity, identityHex, generation: gen });
      })
      .onConnectError((_ctx, err) => {
        log.warn('connect error', { error: errText(err) });
        if (gen === this.generation) this.handleLoss(err);
      })
      .onDisconnect((_ctx, err) => {
        log.warn('disconnected', { error: err ? errText(err) : undefined });
        if (gen === this.generation) this.handleLoss(err ?? undefined);
      })
      .build();
    this.conn = conn;
  }

  private handleLoss(err?: Error): void {
    if (this.stopped) return;
    this.opts.onLost?.(this.generation, err);
    this.conn = undefined;
    this.scheduleReconnect(err);
  }

  private scheduleReconnect(err?: Error): void {
    if (this.stopped || this.timer) return;
    const max = this.opts.maxAttempts;
    if (max !== undefined && this.attempt >= max) {
      this.opts.log.error('giving up reconnecting', { attempts: this.attempt });
      this.opts.onGiveUp?.(err);
      return;
    }
    const delay = backoffDelay(this.attempt++);
    this.generation++;
    this.opts.log.info('reconnect scheduled', { delayMs: delay, attempt: this.attempt });
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.stopped) this.open();
    }, delay);
  }
}
