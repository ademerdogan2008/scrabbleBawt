// Named opponent lineups for benchmarks (Phase 4). Each lineup is an array of registry specs
// (src/bots/registry.ts); '*' marks the focal seat (the policy under test). Some lineups carry a
// MatchSpec override (FirstPrice). Seat counts follow the module: totalAuctions = 98 - 5 x seats.
//
//   lobbyNow      the live lobby today: LUCENT + Bron + maverick clones and two sims (§2.2)
//   lobbySims     focal + 5 lobby sims (the most common padding mix)
//   fullTable     tournament-like six real bots: K-13, Lionel, Nijello, Lala clones + Waupus profile
//   bigTable      7 seats (63 auctions): fullTable + SookraBot
//   headsUpK13    2-player final against the tournament #1 champion (88 auctions)
//   tricks        spoiler + price-pusher + bottom-feeder + 2 sims
//   oracle        deal-aware denier (SIMULATOR-ONLY true racks) in a strong full table
//   firstPrice    fullTable with auctionType FirstPrice
//   starterFlood  HackUTD day-0 field: five starter-kit copies
// Coverage lineups (every other zoo policy at least once; used by scripts/zoo-sanity.ts):
//   tricksLate, tricksMixed, spiteHeadsUp, community, fieldFamilies, profiles
import type { MatchSpec } from '../sim/match.js';

export const FOCAL = '*';

export interface NamedLineup {
  readonly seats: readonly string[];
  readonly spec?: Readonly<Partial<MatchSpec>>;
  readonly note: string;
}

const FULL_TABLE = ['*', 'clone:k13', 'clone:lionel', 'clone:nijello', 'clone:lala', 'profile:Waupus'] as const;

export const LINEUPS = {
  lobbyNow: {
    seats: ['*', 'clone:lucent', 'clone:bron', 'clone:maverick', 'sim:Aggressive', 'sim:ValueBidder'],
    note: 'live lobby: the three active top bots (data-fitted clones) + 2 sims',
  },
  lobbySims: {
    seats: ['*', 'sim:Aggressive', 'sim:Aggressive', 'sim:ValueBidder', 'sim:ValueBidder', 'sim:Cheapskate'],
    note: 'focal + 5 lobby sims',
  },
  fullTable: { seats: [...FULL_TABLE], note: 'tournament-like table of strong real-bot clones' },
  bigTable: { seats: [...FULL_TABLE, 'clone:sookra'], note: '7 seats (63 auctions)' },
  headsUpK13: { seats: ['*', 'clone:k13'], note: 'heads-up final vs the tournament #1 champion (88 auctions)' },
  tricks: {
    seats: ['*', 'trick:allin', 'trick:shadow', 'trick:bottomFeeder', 'sim:Aggressive', 'sim:ValueBidder'],
    note: 'spoiler, price-pusher and bottom-feeder',
  },
  oracle: {
    seats: ['*', 'oracle:trick:oracleDenier', 'clone:k13', 'clone:lionel', 'clone:lala', 'clone:nijello'],
    note: 'RNG-exploiting denier (simulator-only true racks) in a strong table',
  },
  firstPrice: { seats: [...FULL_TABLE], spec: { auctionType: 'FirstPrice' }, note: 'fullTable, first-price auctions' },
  starterFlood: { seats: ['*', 'starter', 'starter', 'starter', 'starter', 'starter'], note: 'HackUTD day-0 field' },
  // ---- coverage
  tricksLate: {
    seats: ['*', 'trick:late', 'trick:jitter', 'trick:sniper', 'trick:endgameDumper', 'sim:Aggressive'],
    note: 'late money: hoard-then-dominate, end-game dumper, sniper, jitter',
  },
  tricksMixed: {
    seats: ['*', 'trick:spite', 'trick:hoarder', 'trick:random', 'clone:lucent', 'sim:ValueBidder'],
    note: 'spite, hoarder and random tricks with a top-bot clone',
  },
  spiteHeadsUp: { seats: ['*', 'trick:spite'], note: 'heads-up spite / drain bidder (88 auctions)' },
  community: {
    seats: ['*', 'clone:lambi', 'clone:blackswan', 'clone:fieldShark', 'clone:fieldVolume', 'clone:ramp'],
    note: 'other community clones',
  },
  fieldFamilies: {
    seats: ['*', 'clone:fieldGrinder', 'clone:fieldSpender', 'clone:fieldNibbler', 'clone:flat', 'clone:hunter'],
    note: 'Karthik FieldBot presets and fitted families',
  },
  profiles: {
    seats: ['*', 'profile:LUCENT', 'profile:Bron', 'profile:K-13', 'profile:Lionel', 'profile:Lala'],
    note: 'profile-driven clones (data/profiles.json KM curves)',
  },
} as const satisfies Record<string, NamedLineup>;

export type LineupName = keyof typeof LINEUPS;

export const LINEUP_NAMES = Object.keys(LINEUPS) as LineupName[];

/** The plan's named lineups for Phase 4 (coverage lineups excluded). */
export const BENCH_LINEUPS: readonly LineupName[] = [
  'lobbyNow',
  'lobbySims',
  'fullTable',
  'bigTable',
  'headsUpK13',
  'tricks',
  'oracle',
  'firstPrice',
  'starterFlood',
];

export function getLineup(name: string): NamedLineup {
  const l = (LINEUPS as Record<string, NamedLineup>)[name];
  if (!l) throw new Error(`lineups: unknown lineup '${name}' (known: ${LINEUP_NAMES.join(', ')})`);
  return l;
}

/** Seat specs with every '*' replaced by the focal spec. */
export function resolveLineup(lineup: NamedLineup | string, focal: string): string[] {
  const l = typeof lineup === 'string' ? getLineup(lineup) : lineup;
  if (!l.seats.includes(FOCAL)) throw new Error('lineups: lineup has no focal seat');
  return l.seats.map((s) => (s === FOCAL ? focal : s));
}
