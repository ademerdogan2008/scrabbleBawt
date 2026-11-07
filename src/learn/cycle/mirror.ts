// "Live mirror" lineup: the opponents we actually met in recent live matches, mapped onto registry
// specs (fitted clones for known bots, sim strategies for sims, profile clones for profiled bots,
// clone:fieldVolume for anything unknown).
import { parseSimStrategy } from '../../core/simbots.js';
import { parseSeat } from '../../bots/registry.js';
import { loadProfiles } from '../../bots/clones/profile.js';
import { FOCAL } from '../../bots/lineups.js';
import type { PlayerInfo } from '../../core/types.js';

/** Known live names -> fitted / data clones. */
export const NAME_TO_CLONE: Readonly<Record<string, string>> = Object.freeze({
  LUCENT: 'clone:lucent',
  Bron: 'clone:bron',
  'maverick-bot': 'clone:maverick',
  'K-13': 'clone:k13',
  Lionel: 'clone:lionel',
  Nijello: 'clone:nijello',
  Lala: 'clone:lala',
  SookraBot: 'clone:sookra',
  'Lambi Lambiii': 'clone:lambi',
  BlackSwan: 'clone:blackswan',
});

export const UNKNOWN_BOT_SPEC = 'clone:fieldVolume';

let profiled: Set<string> | undefined;
function profiledNames(): Set<string> {
  if (!profiled) {
    try {
      profiled = new Set(loadProfiles().bots.filter((b) => !b.isSim).map((b) => b.name));
    } catch {
      profiled = new Set();
    }
  }
  return profiled;
}

const specOk = new Map<string, boolean>();
function constructs(spec: string): boolean {
  let ok = specOk.get(spec);
  if (ok === undefined) {
    try {
      parseSeat(spec, 1);
      ok = true;
    } catch {
      ok = false;
    }
    specOk.set(spec, ok);
  }
  return ok;
}

/** Registry spec for one live opponent. */
export function specForPlayer(p: Pick<PlayerInfo, 'name' | 'isSim' | 'simStrategy'>): string {
  if (p.isSim || /-sim$/i.test(p.name)) {
    const tag = p.simStrategy ?? p.name.replace(/-sim$/i, '').trim();
    const s = parseSimStrategy(tag);
    return `sim:${s ?? 'ValueBidder'}`;
  }
  const clone = NAME_TO_CLONE[p.name];
  if (clone) return clone;
  if (!/[:{}]/.test(p.name) && profiledNames().has(p.name)) {
    const spec = `profile:${p.name}`;
    if (constructs(spec)) return spec;
  }
  return UNKNOWN_BOT_SPEC;
}

export interface MirrorInput {
  players: ReadonlyArray<Pick<PlayerInfo, 'id' | 'name' | 'isSim' | 'simStrategy'>>;
  myId: number;
}

/**
 * Focal + the most frequent opponent specs over `matches` (most recent first is not required).
 * Seat count = the most common table size (ties: the larger). Each spec appears at most as many
 * times as it ever did in a single match. Undefined when there are no matches.
 */
export function mirrorLineup(matches: readonly MirrorInput[]): string[] | undefined {
  if (matches.length === 0) return undefined;
  const sizes = new Map<number, number>();
  const freq = new Map<string, number>();
  const maxPer = new Map<string, number>();
  for (const m of matches) {
    sizes.set(m.players.length, (sizes.get(m.players.length) ?? 0) + 1);
    const local = new Map<string, number>();
    for (const p of m.players) {
      if (p.id === m.myId) continue;
      const spec = specForPlayer(p);
      local.set(spec, (local.get(spec) ?? 0) + 1);
      freq.set(spec, (freq.get(spec) ?? 0) + 1);
    }
    for (const [s, c] of local) maxPer.set(s, Math.max(maxPer.get(s) ?? 0, c));
  }
  const seats = [...sizes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
  const lineup: string[] = [FOCAL];
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [spec] of ranked) {
    for (let j = 0; j < maxPer.get(spec)! && lineup.length < seats; j++) lineup.push(spec);
    if (lineup.length >= seats) break;
  }
  while (lineup.length < Math.max(2, seats)) lineup.push(UNKNOWN_BOT_SPEC);
  return lineup;
}
