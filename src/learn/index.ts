// Live learning loop: a policy-factory wrapper that turns every finished match into a bandit and
// opponent-book update, so the bot keeps adjusting to what loses (and wins) against the field.
//
//   match start (onMatchStart, before the first auction):
//     load .cache/learn/state.json -> Thompson-sample an eligible arm with Rng(hash(match id, my id))
//     -> inner policy = create(seed, clampParams(arm.params) as BawtParams overrides)
//     -> the field model picks up the opponent book as calibration priors (opponents.ts hook)
//   decide / onAuctionClosed: pure pass-through (no learning work, no I/O inside a decision)
//   match end (onMatchEnd): reward from the final rank -> discounted bandit update, book update,
//     match record, atomic save; one `{"learn":{...}}` line per match.
//
// Safety: every learning step is wrapped. Any failure (unreadable / unwritable / corrupt state,
// bad arm params) falls back to the 'default' arm (= the plain policy with the spec params) and
// is reported through `warn`; it never throws into the client. Arm 'default' with an empty book
// makes decisions bit-identical to the plain policy.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Rng, hashSeed } from '../core/rng.js';
import type { AuctionInfo, AuctionOutcome, DecideContext, MatchConfig, MatchView, Policy, PolicyFactory } from '../core/types.js';
import { setFieldModelHook, type FieldModel, type FieldModelHook } from '../bots/bawt/opponents.js';
import type { BawtParams } from '../bots/bawt/params.js';
import { armOverrides } from './arms.js';
import { GAMMA, posteriorMeans, selectArm, updateArm } from './bandit.js';
import { bookPrior, factsFromView, updateBook, type ScaleObservation } from './book.js';
import { standingFromView } from './reward.js';
import { DEFAULT_ARM_ID, defaultStatePath, loadState, saveState, withStateLock, type BookEntry, type LearnState, type MatchRecord } from './store.js';

export * from './arms.js';
export * from './bandit.js';
export * from './book.js';
export * from './reward.js';
export * from './store.js';

/** Learning is on for policy 'bawt' unless LEARN is 0 / false / off / no. */
export function learningEnabled(env: Record<string, string | undefined>, policy: string): boolean {
  const v = env.LEARN?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'off' || v === 'no') return false;
  return policy.trim() === 'bawt';
}

/** Arm-selection seed: reproducible from the match log (match id + our bot id). */
export function armSeed(config: Pick<MatchConfig, 'matchId' | 'myId'>): number {
  return hashSeed('learn', config.matchId, config.myId);
}

export interface LearnOptions {
  /** Build the inner policy with extra BawtParams overrides ({} = the plain spec policy). */
  create: (seed: number, overrides: Partial<BawtParams>) => Policy;
  /** The spec's own params (resolves the profile for denyScale). */
  baseParams?: Partial<BawtParams>;
  statePath?: string;
  /** Policy name reported by the wrapper (default 'bawt'). */
  name?: string;
  /** One JSON line per learned match. */
  log?: (line: string) => void;
  /** Append the same line to this JSONL file (errors ignored). */
  logFile?: string;
  /** Non-fatal learning problems. */
  warn?: (msg: string) => void;
  now?: () => Date;
  gamma?: number;
}

export interface LearnHandle {
  factory: PolicyFactory;
  statePath: string;
  /** Remove the field-model hook (restores the previous one). */
  dispose(): void;
}

interface Session {
  key: string;
  matchId: number;
  armId: string;
  overrides: Partial<BawtParams>;
  book: Record<string, BookEntry>;
  field?: FieldModel;
  decisions: number;
}

const MAX_SESSIONS = 32;
const keyOf = (c: Pick<MatchConfig, 'matchId' | 'myId'>) => `${c.matchId}:${c.myId}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface LearnLine {
  learn: {
    matchId: number;
    armId: string;
    rank: number;
    players: number;
    reward: number;
    posteriorMeans: Record<string, number>;
  };
}

export function createLearningFactory(opts: LearnOptions): LearnHandle {
  const statePath = opts.statePath ?? defaultStatePath();
  const base = opts.baseParams ?? {};
  const name = opts.name ?? 'bawt';
  const now = opts.now ?? (() => new Date());
  const gamma = opts.gamma ?? GAMMA;
  const warn = (m: string) => {
    try {
      opts.warn?.(`learn: ${m}`);
    } catch {
      // ignore
    }
  };
  const sessions = new Map<string, Session>();

  const hook: FieldModelHook = (config) => {
    const s = sessions.get(keyOf(config));
    if (!s) return undefined;
    return {
      prior: (rival, kind) => bookPrior(s.book[rival], kind),
      attach: (field) => {
        s.field = field;
      },
    };
  };
  const prevHook = setFieldModelHook(hook);

  const begin = (config: MatchConfig): Session => {
    const s: Session = { key: keyOf(config), matchId: config.matchId, armId: DEFAULT_ARM_ID, overrides: {}, book: {}, decisions: 0 };
    try {
      const { state, status, backup } = loadState(statePath);
      if (status === 'corrupt') warn(`corrupt state file${backup ? ` moved to ${backup}` : ''}; starting fresh`);
      const sel = selectArm(state, new Rng(armSeed(config)));
      s.book = state.book;
      s.armId = sel.arm.id;
      s.overrides = sel.arm.id === DEFAULT_ARM_ID ? {} : armOverrides(sel.arm.params, config, base);
    } catch (e) {
      warn(`state load failed (${errMsg(e)}); using the default arm`);
      s.armId = DEFAULT_ARM_ID;
      s.overrides = {};
      s.book = {};
    }
    // announce the arm at match start (live monitor shows it before the match ends)
    if (opts.logFile) {
      try {
        mkdirSync(dirname(opts.logFile), { recursive: true });
        appendFileSync(opts.logFile, `${JSON.stringify({ armStart: { matchId: s.matchId, armId: s.armId } })}\n`);
      } catch {
        // visuals only
      }
    }
    sessions.delete(s.key);
    sessions.set(s.key, s);
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    return s;
  };

  /** Fold one finished match into the state file (caller holds the state lock). */
  const learnMatch = (view: MatchView, s: Session, st: ReturnType<typeof standingFromView>): LearnState | undefined => {
    const { state, status, backup } = loadState(statePath);
    if (status === 'corrupt') warn(`corrupt state file${backup ? ` moved to ${backup}` : ''}; starting fresh`);
    // exact dedupe only (not trimmedThrough): a live match is recorded right away, never trimmed first
    if (state.matches.some((m) => m.matchId === s.matchId)) return undefined;
    if (st.players >= 2) updateArm(state, s.armId, st.reward, gamma);
    const scales = new Map<string, ScaleObservation>();
    for (const o of s.field?.opponents ?? []) {
      if (o.kind === 'sim') continue;
      scales.set(o.name, { logScale: o.logScale, kind: o.kind, observed: o.observed });
    }
    const t = now();
    updateBook(state, factsFromView(view), t, scales);
    const rec: MatchRecord = {
      matchId: s.matchId,
      armId: s.armId,
      endedAt: t.toISOString(),
      players: st.players,
      realPlayers: st.realPlayers,
      rank: st.rank,
      score: st.score,
      bestOtherScore: st.bestOtherScore,
      won: st.won,
      reward: st.reward,
      opponents: view.config.players.filter((p) => p.id !== view.config.myId).map((p) => p.name),
    };
    state.matches.push(rec);
    saveState(state, statePath);
    return state;
  };

  const end = (view: MatchView, s: Session | undefined): void => {
    if (!s) return;
    sessions.delete(s.key);
    if (s.decisions === 0) return; // never played (e.g. picked up an already-ended match)
    try {
      const st = standingFromView(view);
      // Locked re-read-modify-write: the learn-cycle watcher may have written since match start.
      // Short wait only (this runs on the client's event loop); a wedged lock is taken over.
      const state = withStateLock(statePath, () => learnMatch(view, s, st), { timeoutMs: 500 });
      if (!state) return; // already learned
      const line: LearnLine = {
        learn: { matchId: s.matchId, armId: s.armId, rank: st.rank, players: st.players, reward: st.reward, posteriorMeans: posteriorMeans(state) },
      };
      const text = JSON.stringify(line);
      try {
        opts.log?.(text);
      } catch {
        // ignore
      }
      if (opts.logFile) {
        try {
          mkdirSync(dirname(opts.logFile), { recursive: true });
          appendFileSync(opts.logFile, `${text}\n`);
        } catch (e) {
          warn(`learn log append failed (${errMsg(e)})`);
        }
      }
    } catch (e) {
      warn(`match-end update failed (${errMsg(e)}); state unchanged`);
    }
  };

  const factory: PolicyFactory = (seed) => {
    let inner: Policy | undefined;
    let session: Session | undefined;
    const makeInner = (overrides: Partial<BawtParams>): Policy => {
      try {
        return opts.create(seed, overrides);
      } catch (e) {
        if (Object.keys(overrides).length === 0) throw e;
        warn(`arm params rejected (${errMsg(e)}); using the default arm`);
        if (session) {
          session.armId = DEFAULT_ARM_ID;
          session.overrides = {};
        }
        return opts.create(seed, {});
      }
    };
    const policy: Policy = {
      name,
      onMatchStart(view: MatchView) {
        let overrides: Partial<BawtParams> = {};
        try {
          session = begin(view.config);
          overrides = session.overrides;
        } catch (e) {
          warn(`match start failed (${errMsg(e)}); using the default arm`);
          session = undefined;
        }
        inner = makeInner(overrides);
        inner.onMatchStart(view);
      },
      decide(view: MatchView, auction: AuctionInfo, ctx: DecideContext) {
        if (!inner) {
          inner = opts.create(seed, {});
          inner.onMatchStart(view);
        }
        if (session) session.decisions++;
        return inner.decide(view, auction, ctx);
      },
      onAuctionClosed(view: MatchView, outcome: AuctionOutcome) {
        inner?.onAuctionClosed?.(view, outcome);
      },
      onMatchEnd(view: MatchView) {
        const s = session;
        session = undefined;
        try {
          inner?.onMatchEnd?.(view);
        } finally {
          end(view, s);
        }
      },
    };
    return policy;
  };

  return {
    factory,
    statePath,
    dispose() {
      setFieldModelHook(prevHook);
      sessions.clear();
    },
  };
}
