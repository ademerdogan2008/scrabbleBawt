// Row and record types for the public ScrabbleBot history (maincloud `scrabblebot`, HTTP SQL API).
//
// Raw rows are exactly what src/history/fetch.ts writes to NDJSON after schema-driven decoding:
//   Option (sum some/none)  -> value | null
//   unit-only sum (enum)    -> variant name as the schema spells it ("ended", "vickrey", "swiss", ...)
//   Timestamp               -> integer microseconds since the Unix epoch
// Column names are the server's (snake_case). See .planning/research/RULES.md §3.
import type { AuctionType, MatchKind, PlayerId, SimStrategy } from '../core/types.js';

// ---------------------------------------------------------------------------------------------
// Raw rows (one per NDJSON line)
// ---------------------------------------------------------------------------------------------

export interface BotRow {
  id: number;
  name: string;
  team_id: number;
  is_simulated: boolean;
  strategy: string; // "human" for real bots; "cheapskate" | "valueBidder" | "aggressive" for sims
  created_at: number;
}

export interface MatchStateRow {
  id: number;
  status: string; // "lobby" | "running" | "ended"
  current_round: number;
  current_auction_id: number | null;
  bag_total: number;
  auction_type: string; // "vickrey" | "firstPrice"
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  auction_duration_ms: number;
  starting_rack_size: number;
}

export interface MatchParticipantRow {
  id: number; // autoinc, roster order
  match_id: number;
  bot_id: number;
  balance: number;
  score: number;
}

export interface AuctionResultRow {
  auction_id: number;
  match_id: number;
  letter: string;
  winner_bot_id: number | null;
  paid: number;
  closed_at: number;
}

export interface AuctionTopBidRow {
  auction_id: number;
  match_id: number;
  top_bid: number;
}

export interface WordPlayRow {
  id: number;
  match_id: number;
  bot_id: number;
  word: string;
  base_score: number;
  bonus: number;
  total_reward: number;
  played_at: number;
}

export interface BotVersionRow {
  id: number;
  bot_id: number;
  version: number;
  started_at: number;
}

export interface TournamentMatchRow {
  id: number;
  tournament_id: number;
  match_id: number;
  round: number;
  phase: string; // "swiss" | "bracket" | "final"
}

// ---------------------------------------------------------------------------------------------
// Loaded per-match records (src/history/load.ts)
// ---------------------------------------------------------------------------------------------

export interface HistBot {
  id: PlayerId;
  name: string;
  isSim: boolean;
  simStrategy?: SimStrategy;
  /** True when the participant's bot row no longer exists (PITFALLS m6: deleted teams). */
  missing: boolean;
}

export interface HistParticipant {
  rowId: number; // match_participant.id (roster order)
  botId: PlayerId;
  /** Final balance (snapshot taken after the match ended). */
  balance: number;
  /** Final score. */
  score: number;
}

export interface HistAuction {
  /** 0-based position in the match (auction_id order). */
  index: number;
  auctionId: number;
  letter: string;
  winnerId: PlayerId | null;
  paid: number;
  /** Archived top bid; null when the archive row is missing (incomplete match). */
  topBid: number | null;
  closedAtUs: number;
}

export interface HistWord {
  id: number;
  botId: PlayerId;
  word: string;
  baseScore: number;
  bonus: number;
  reward: number;
  playedAtUs: number;
  /** Number of the match's auctions with closedAtUs < playedAtUs (strict). See load.ts. */
  auctionIndex: number;
  /** True when some auction closed in the same transaction (closedAtUs == playedAtUs): a sim word. */
  inClose: boolean;
}

export interface HistTournamentInfo {
  tournamentId: number;
  round: number;
  phase: string;
}

export interface HistMatch {
  id: number;
  status: string; // raw variant name, e.g. "ended"
  auctionType: AuctionType | 'Unknown';
  rawAuctionType: string;
  auctionDurationMs: number;
  startingRackSize: number;
  createdAtUs: number;
  startedAtUs: number | null;
  endedAtUs: number | null;
  /** Roster order (match_participant.id ascending). */
  participants: HistParticipant[];
  /** auction_id order; `index` is the 0-based position. */
  auctions: HistAuction[];
  /** Canonical order (see load.ts): by auctionIndex, inClose last, then playedAtUs, then id. */
  words: HistWord[];
  tournament: HistTournamentInfo | null;
  kind: MatchKind;
  /** 98 - startingRackSize * participants. */
  expectedAuctions: number;
  /** Number of participants whose bot is a sim. */
  nSim: number;
  /** Number of participants that are real (non-sim) bots, including missing bot rows. */
  nReal: number;
  /**
   * status == ended && auctions.length == expectedAuctions && every auction has a top-bid row
   * (HISTORICAL.md §0). Validation, profiles and replay use complete matches only.
   */
  complete: boolean;
}

/** Light per-match header available before the big tables are streamed (used by load filters). */
export interface HistMatchHeader {
  state: MatchStateRow;
  participants: HistParticipant[];
  tournament: HistTournamentInfo | null;
}

export interface HistDataset {
  dir: string;
  bots: Map<PlayerId, HistBot>;
  /** bot_version rows per bot, ascending started_at (bots without rows are on version 1). */
  versions: Map<PlayerId, BotVersionRow[]>;
  /** Ascending match id. */
  matches: HistMatch[];
  /** Rows dropped because their match was filtered out or unknown. */
  skippedRows: number;
  /** top-bid rows whose auction_id was not found among the kept auction rows. */
  orphanTopBids: number;
}
