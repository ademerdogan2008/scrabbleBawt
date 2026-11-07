// Maincloud write guard (PROJECT.md decision, PITFALLS M20): callReducer() is the ONLY way client
// code calls a reducer. Against a maincloud (or any non-loopback) host every reducer is a game
// reducer unless explicitly allow-listed, and it throws MaincloudGuardError before the connection
// is touched — unless the real process environment sets ALLOW_MAINCLOUD_PLAY=1 (Phase 5 only).
import { classifyHost } from './config.js';

/** Every client-callable reducer in src/client/module_bindings (CLI 2.12.0), snake_case. */
export const BINDING_REDUCERS = [
  'add_admin',
  'backfill_elo',
  'backfill_top_bid_archive',
  'bootstrap_admin',
  'cancel_tournament',
  'claim_credential',
  'connect_id',
  'create_team',
  'create_tournament',
  'force_end_tournament',
  'join_lobby',
  'join_team',
  'leave_team',
  'mint_credential_nonce',
  'mint_team_invite',
  'promote_to_owner',
  'register_for_tournament',
  'register_sim_bots',
  'remove_admin',
  'set_matchmaker_config',
  'spawn_simulated_bot',
  'start_new_bot_version',
  'start_next_finals_match',
  'start_tournament',
  'submit_bid',
  'submit_word',
  'unregister_from_tournament',
] as const;

/**
 * Reducers that may run on maincloud without ALLOW_MAINCLOUD_PLAY. Intentionally EMPTY: the module
 * has no read-only reducer (every one writes state that can touch ratings, teams or credentials).
 */
export const MAINCLOUD_SAFE_REDUCERS: ReadonlySet<string> = new Set<string>();

/** Named game reducers (documentation + tests). Default-deny covers everything else too. */
export const GAME_REDUCERS: readonly string[] = [
  'join_lobby',
  'leave_lobby', // not in the 2.12 bindings; listed so a future binding is covered by name
  ...BINDING_REDUCERS.filter((r) => r !== 'join_lobby' && !MAINCLOUD_SAFE_REDUCERS.has(r)),
];

export function isGameReducer(name: string): boolean {
  return !MAINCLOUD_SAFE_REDUCERS.has(name);
}

export class MaincloudGuardError extends Error {
  readonly reducer: string;
  constructor(reducer: string, host: string) {
    super(
      `maincloud guard: refusing reducer '${reducer}' on ${host} (set ALLOW_MAINCLOUD_PLAY=1 only for Phase-5 live play)`,
    );
    this.name = 'MaincloudGuardError';
    this.reducer = reducer;
  }
}

export interface GuardTarget {
  host: string;
  /** Optional precomputed flag; the guard also re-derives it from `host` (either one blocks). */
  isMaincloud?: boolean;
}

/** Anything with a `reducers` accessor map (DbConnection, or a test fake). */
export interface ReducerHost {
  readonly reducers: object;
}

export interface GuardOptions {
  /** Environment to read ALLOW_MAINCLOUD_PLAY from (default process.env). */
  env?: Record<string, string | undefined>;
}

/** A ReducerHost that resolves the current connection lazily (reconnects swap the connection). */
export function lazyReducerHost(current: () => ReducerHost | undefined): ReducerHost {
  return {
    get reducers(): object {
      const c = current();
      if (!c) throw new Error('callReducer: not connected');
      return c.reducers;
    },
  };
}

/** snake_case reducer name -> camelCase accessor used by the SDK (`submit_bid` -> `submitBid`). */
export function reducerAccessor(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

/** True when this reducer would be refused against `target`. */
export function isBlocked(name: string, target: GuardTarget, opts: GuardOptions = {}): boolean {
  const env = opts.env ?? process.env;
  const maincloud = target.isMaincloud === true || classifyHost(target.host).isMaincloud;
  return maincloud && isGameReducer(name) && env.ALLOW_MAINCLOUD_PLAY !== '1';
}

/** Throws MaincloudGuardError when the reducer is blocked for this target. */
export function assertReducerAllowed(name: string, target: GuardTarget, opts: GuardOptions = {}): void {
  if (isBlocked(name, target, opts)) throw new MaincloudGuardError(name, classifyHost(target.host).hostname || target.host);
}

/**
 * Call a reducer by its snake_case name. Throws MaincloudGuardError synchronously (before touching
 * `conn`) when blocked; otherwise returns the SDK promise (resolves on commit, rejects with the
 * module's SenderError message).
 */
export function callReducer(
  conn: ReducerHost,
  name: string,
  args: Record<string, unknown>,
  target: GuardTarget,
  opts: GuardOptions = {},
): Promise<void> {
  assertReducerAllowed(name, target, opts);
  const map = conn.reducers as Record<string, unknown>;
  const fn = map[reducerAccessor(name)];
  if (typeof fn !== 'function') throw new Error(`callReducer: unknown reducer '${name}'`);
  return (fn as (a: Record<string, unknown>) => Promise<void>).call(map, args);
}
