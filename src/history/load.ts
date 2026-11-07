// Streaming loaders for the history NDJSON dump (plain `<table>.ndjson` or gzipped `<table>.ndjson.gz`)
// into per-match records. Memory-conscious: the big tables (auction_result, auction_top_bid_archive,
// word_play; ~1.74M + 1.74M + 0.4M rows, NOT sorted by match_id) are streamed line by line and
// grouped per match; rows of matches rejected by the filter are dropped while streaming.
//
// Word attribution (ONE rule shared with the 02-01 simulator runMatch and the 02-03 live adapter):
//   auctionIndex = number of the match's auctions with closedAtUs <  playedAtUs   (strict)
//   inClose      = some auction of the match has      closedAtUs == playedAtUs
// Sim words are played inside the close transaction and share its timestamp (e.g. match 1 'ACHY'
// played_at 1792795760065667 == auction 1 closed_at). They therefore get the index of the auction
// that JUST closed and MUST be applied AFTER that auction's result (the sim plays the letter it
// just won). Real-bot words are separate transactions between closes: they get the index of the
// auction open at that time and are applied BEFORE its result.
//
// Canonical event order per auction k (used by validation, the tracker check and replay):
//   open(k) -> words with auctionIndex k and !inClose (by playedAtUs, then id)
//           -> result(k)
//           -> words with auctionIndex k and inClose (by playedAtUs, then id)
// Words with auctionIndex == number of auctions (after the final close) come last; real bots never
// produce them (HISTORICAL.md §G), the validation suite asserts that.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { BAG_SIZE, NUM_LETTERS, STARTING_BALANCE } from '../core/letters.js';
import { emptyRack, type Rack } from '../core/rack.js';
import { parseSimStrategy } from '../core/simbots.js';
import type { AuctionInfo, AuctionType, MatchConfig, MatchKind, PlayerId, PlayerInfo } from '../core/types.js';
import type {
  AuctionResultRow,
  AuctionTopBidRow,
  BotRow,
  BotVersionRow,
  HistAuction,
  HistBot,
  HistDataset,
  HistMatch,
  HistMatchHeader,
  HistParticipant,
  HistTournamentInfo,
  HistWord,
  MatchParticipantRow,
  MatchStateRow,
  TournamentMatchRow,
  WordPlayRow,
} from './types.js';

// ---------------------------------------------------------------------------------------------
// NDJSON streaming
// ---------------------------------------------------------------------------------------------

/** Path of `<table>.ndjson` or `<table>.ndjson.gz` inside dir (plain preferred), or undefined. */
export function tableFile(dir: string, table: string): string | undefined {
  const plain = path.join(dir, `${table}.ndjson`);
  if (fs.existsSync(plain)) return plain;
  const gz = `${plain}.gz`;
  if (fs.existsSync(gz)) return gz;
  return undefined;
}

/** Async iterator over parsed NDJSON lines (gz-transparent). Blank lines are skipped. */
export async function* readNdjson<T>(file: string): AsyncGenerator<T> {
  const raw = fs.createReadStream(file);
  const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      yield JSON.parse(line) as T;
    }
  } finally {
    rl.close();
    raw.destroy();
  }
}

/** All rows of a table, or [] when the table file is absent. */
export async function readTable<T>(dir: string, table: string): Promise<T[]> {
  const f = tableFile(dir, table);
  if (!f) return [];
  const out: T[] = [];
  for await (const r of readNdjson<T>(f)) out.push(r);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Small converters
// ---------------------------------------------------------------------------------------------

export function toAuctionType(raw: string): AuctionType | 'Unknown' {
  const s = String(raw).toLowerCase().replace(/[_\s]/g, '');
  if (s === 'vickrey') return 'Vickrey';
  if (s === 'firstprice') return 'FirstPrice';
  return 'Unknown';
}

export function toMatchKind(t: HistTournamentInfo | null): MatchKind {
  if (!t) return 'lobby';
  const p = t.phase.toLowerCase();
  return p === 'swiss' || p === 'bracket' || p === 'final' ? p : 'unknown';
}

export function toHistBot(row: BotRow): HistBot {
  const strat = row.is_simulated ? parseSimStrategy(row.strategy) : undefined;
  const b: HistBot = { id: row.id, name: row.name, isSim: !!row.is_simulated, missing: false };
  if (strat) b.simStrategy = strat;
  return b;
}

/** Placeholder for a participant whose bot row was deleted (PITFALLS m6). */
export function missingBot(id: PlayerId): HistBot {
  return { id, name: `#${id}`, isSim: false, missing: true };
}

export function isEnded(status: string): boolean {
  return String(status).toLowerCase() === 'ended';
}

// ---------------------------------------------------------------------------------------------
// Dataset loader
// ---------------------------------------------------------------------------------------------

export interface LoadOptions {
  /** Keep only matches accepted here (decided before the big tables are streamed). */
  filter?: (h: HistMatchHeader) => boolean;
  /** Skip word_play (faster when only auctions are needed). Default false. */
  skipWords?: boolean;
}

/** Index of the first auction with closedAtUs >= t (auctions sorted ascending by closedAtUs). */
function lowerBoundClose(auctions: readonly HistAuction[], t: number): number {
  let lo = 0;
  let hi = auctions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (auctions[mid]!.closedAtUs < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function findAuctionById(auctions: readonly HistAuction[], auctionId: number): HistAuction | undefined {
  let lo = 0;
  let hi = auctions.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const a = auctions[mid]!;
    if (a.auctionId === auctionId) return a;
    if (a.auctionId < auctionId) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** Comparator implementing the canonical word order (see file header). */
export function compareWords(a: HistWord, b: HistWord): number {
  return (
    a.auctionIndex - b.auctionIndex ||
    Number(a.inClose) - Number(b.inClose) ||
    a.playedAtUs - b.playedAtUs ||
    a.id - b.id
  );
}

/** (Re)compute auctionIndex / inClose for every word of `m` and sort words canonically. */
export function attributeWords(m: HistMatch): void {
  // Close times are non-decreasing in auction_id order for every historical match (validated);
  // sort a copy defensively so the binary search is always correct.
  const byClose = [...m.auctions].sort((a, b) => a.closedAtUs - b.closedAtUs);
  for (const w of m.words) {
    const lb = lowerBoundClose(byClose, w.playedAtUs);
    w.auctionIndex = lb;
    w.inClose = lb < byClose.length && byClose[lb]!.closedAtUs === w.playedAtUs;
  }
  m.words.sort(compareWords);
}

function finishMatch(m: HistMatch, bots: Map<PlayerId, HistBot>): void {
  m.auctions.sort((a, b) => a.auctionId - b.auctionId);
  m.auctions.forEach((a, i) => (a.index = i));
  attributeWords(m);
  let nSim = 0;
  for (const p of m.participants) if (bots.get(p.botId)?.isSim) nSim++;
  m.nSim = nSim;
  m.nReal = m.participants.length - nSim;
  m.expectedAuctions = Math.max(0, BAG_SIZE - m.startingRackSize * m.participants.length);
  m.complete =
    isEnded(m.status) &&
    m.auctions.length === m.expectedAuctions &&
    m.auctions.every((a) => a.topBid !== null);
}

/**
 * Load a dataset directory. Small tables are read whole; auction_result, auction_top_bid_archive
 * and word_play are streamed. Matches are returned in ascending id order.
 */
export async function loadMatches(dir: string, opts: LoadOptions = {}): Promise<HistDataset> {
  const stateFile = tableFile(dir, 'match_state');
  if (!stateFile) throw new Error(`loadMatches: no match_state.ndjson(.gz) in ${dir}`);

  const bots = new Map<PlayerId, HistBot>();
  for (const r of await readTable<BotRow>(dir, 'bot')) bots.set(r.id, toHistBot(r));

  const versions = new Map<PlayerId, BotVersionRow[]>();
  for (const v of await readTable<BotVersionRow>(dir, 'bot_version')) {
    let arr = versions.get(v.bot_id);
    if (!arr) versions.set(v.bot_id, (arr = []));
    arr.push(v);
  }
  for (const arr of versions.values()) arr.sort((a, b) => a.started_at - b.started_at || a.version - b.version);

  const tourn = new Map<number, HistTournamentInfo>();
  for (const t of await readTable<TournamentMatchRow>(dir, 'tournament_match')) {
    tourn.set(t.match_id, { tournamentId: t.tournament_id, round: t.round, phase: String(t.phase) });
  }

  const states = new Map<number, MatchStateRow>();
  for await (const s of readNdjson<MatchStateRow>(stateFile)) states.set(s.id, s);

  const parts = new Map<number, HistParticipant[]>();
  const partFile = tableFile(dir, 'match_participant');
  if (partFile) {
    for await (const p of readNdjson<MatchParticipantRow>(partFile)) {
      if (!states.has(p.match_id)) continue;
      let arr = parts.get(p.match_id);
      if (!arr) parts.set(p.match_id, (arr = []));
      arr.push({ rowId: p.id, botId: p.bot_id, balance: p.balance, score: p.score });
    }
  }

  const matches = new Map<number, HistMatch>();
  for (const s of states.values()) {
    const participants = (parts.get(s.id) ?? []).sort((a, b) => a.rowId - b.rowId);
    const tournament = tourn.get(s.id) ?? null;
    if (opts.filter && !opts.filter({ state: s, participants, tournament })) continue;
    for (const p of participants) if (!bots.has(p.botId)) bots.set(p.botId, missingBot(p.botId));
    matches.set(s.id, {
      id: s.id,
      status: String(s.status),
      auctionType: toAuctionType(s.auction_type),
      rawAuctionType: String(s.auction_type),
      auctionDurationMs: s.auction_duration_ms,
      startingRackSize: s.starting_rack_size,
      createdAtUs: s.created_at,
      startedAtUs: s.started_at,
      endedAtUs: s.ended_at,
      participants,
      auctions: [],
      words: [],
      tournament,
      kind: toMatchKind(tournament),
      expectedAuctions: 0,
      nSim: 0,
      nReal: 0,
      complete: false,
    });
  }
  states.clear();
  parts.clear();

  let skippedRows = 0;
  const arFile = tableFile(dir, 'auction_result');
  if (arFile) {
    for await (const r of readNdjson<AuctionResultRow>(arFile)) {
      const m = matches.get(r.match_id);
      if (!m) {
        skippedRows++;
        continue;
      }
      m.auctions.push({
        index: -1,
        auctionId: r.auction_id,
        letter: r.letter,
        winnerId: r.winner_bot_id ?? null,
        paid: r.paid,
        topBid: null,
        closedAtUs: r.closed_at,
      });
    }
  }
  for (const m of matches.values()) m.auctions.sort((a, b) => a.auctionId - b.auctionId);

  let orphanTopBids = 0;
  const tbFile = tableFile(dir, 'auction_top_bid_archive');
  if (tbFile) {
    for await (const r of readNdjson<AuctionTopBidRow>(tbFile)) {
      const m = matches.get(r.match_id);
      if (!m) {
        skippedRows++;
        continue;
      }
      const a = findAuctionById(m.auctions, r.auction_id);
      if (a) a.topBid = r.top_bid;
      else orphanTopBids++;
    }
  }

  const wpFile = opts.skipWords ? undefined : tableFile(dir, 'word_play');
  if (wpFile) {
    for await (const w of readNdjson<WordPlayRow>(wpFile)) {
      const m = matches.get(w.match_id);
      if (!m) {
        skippedRows++;
        continue;
      }
      m.words.push({
        id: w.id,
        botId: w.bot_id,
        word: w.word,
        baseScore: w.base_score,
        bonus: w.bonus,
        reward: w.total_reward,
        playedAtUs: w.played_at,
        auctionIndex: -1,
        inClose: false,
      });
    }
  }

  const list = [...matches.values()].sort((a, b) => a.id - b.id);
  for (const m of list) finishMatch(m, bots);
  return { dir, bots, versions, matches: list, skippedRows, orphanTopBids };
}

// ---------------------------------------------------------------------------------------------
// Per-match helpers
// ---------------------------------------------------------------------------------------------

export interface AuctionStep {
  auction: HistAuction;
  /** Words with auctionIndex == k and !inClose: applied after open(k), before result(k). */
  before: HistWord[];
  /** Words with auctionIndex == k and inClose (sim words): applied right after result(k). */
  after: HistWord[];
}

export interface Schedule {
  steps: AuctionStep[];
  /** Words after the final close (auctionIndex >= number of auctions). Empty for valid data. */
  trailing: HistWord[];
}

/** Group a match's words into the canonical per-auction schedule (see file header). */
export function canonicalSchedule(m: HistMatch): Schedule {
  const steps: AuctionStep[] = m.auctions.map((a) => ({ auction: a, before: [], after: [] }));
  const trailing: HistWord[] = [];
  for (const w of m.words) {
    const s = steps[w.auctionIndex];
    if (!s) trailing.push(w);
    else (w.inClose ? s.after : s.before).push(w);
  }
  return { steps, trailing };
}

/** Public AuctionInfo for auction k (open time = previous close, or match start). */
export function auctionInfo(m: HistMatch, k: number): AuctionInfo {
  const a = m.auctions[k];
  if (!a) throw new Error(`auctionInfo: match ${m.id} has no auction ${k}`);
  const prevClose = k === 0 ? (m.startedAtUs ?? m.createdAtUs) : m.auctions[k - 1]!.closedAtUs;
  const opensAtMs = Math.floor(prevClose / 1000);
  const total = Math.max(m.expectedAuctions, m.auctions.length);
  return {
    auctionId: a.auctionId,
    index: k,
    letter: a.letter,
    opensAtMs,
    closesAtMs: opensAtMs + m.auctionDurationMs,
    remainingAfter: Math.max(0, total - k - 1),
  };
}

export function playerInfo(bot: HistBot): PlayerInfo {
  const p: PlayerInfo = { id: bot.id, name: bot.name, isSim: bot.isSim };
  if (bot.isSim && bot.simStrategy) p.simStrategy = bot.simStrategy;
  return p;
}

/** MatchConfig for the seat `myId` (roster order = match_participant order). */
export function matchConfig(m: HistMatch, bots: ReadonlyMap<PlayerId, HistBot>, myId: PlayerId): MatchConfig {
  if (m.auctionType === 'Unknown') throw new Error(`match ${m.id}: unknown auction type '${m.rawAuctionType}'`);
  return {
    matchId: m.id,
    kind: m.kind,
    auctionType: m.auctionType,
    auctionDurationMs: m.auctionDurationMs,
    startingRackSize: m.startingRackSize,
    startingBalance: STARTING_BALANCE,
    players: m.participants.map((p) => playerInfo(bots.get(p.botId) ?? missingBot(p.botId))),
    myId,
    totalAuctions: m.expectedAuctions,
  };
}

/**
 * Starting tiles of every participant that are PROVEN by play: walking the canonical schedule,
 * each word letter beyond the player's current known holdings (won + revealed - played) must be a
 * starting tile. `overdraw` counts players whose proven tiles exceed startingRackSize (0 on valid
 * data; HISTORICAL.md §G "starting-rack overdraw").
 */
export function revealStartTiles(m: HistMatch): { revealed: Map<PlayerId, Rack>; overdraw: number } {
  const held = new Map<PlayerId, Int16Array>();
  const revealed = new Map<PlayerId, Rack>();
  for (const p of m.participants) {
    held.set(p.botId, new Int16Array(NUM_LETTERS));
    revealed.set(p.botId, emptyRack());
  }
  const playWord = (w: HistWord) => {
    const h = held.get(w.botId);
    const r = revealed.get(w.botId);
    if (!h || !r) return;
    for (let k = 0; k < w.word.length; k++) {
      const i = w.word.charCodeAt(k) - 65;
      if (i < 0 || i >= NUM_LETTERS) continue;
      if (h[i]! > 0) h[i]!--;
      else r[i]!++;
    }
  };
  const sched = canonicalSchedule(m);
  for (const s of sched.steps) {
    for (const w of s.before) playWord(w);
    const a = s.auction;
    if (a.winnerId !== null) {
      const h = held.get(a.winnerId);
      const i = a.letter.charCodeAt(0) - 65;
      if (h && i >= 0 && i < NUM_LETTERS) h[i]!++;
    }
    for (const w of s.after) playWord(w);
  }
  for (const w of sched.trailing) playWord(w);
  let overdraw = 0;
  for (const r of revealed.values()) {
    let t = 0;
    for (let i = 0; i < NUM_LETTERS; i++) t += r[i]!;
    if (t > m.startingRackSize) overdraw++;
  }
  return { revealed, overdraw };
}

/** Start time (µs) of the bot's current version (0 when it never bumped its version). */
export function currentVersionStart(versions: ReadonlyMap<PlayerId, BotVersionRow[]>, botId: PlayerId): number {
  const arr = versions.get(botId);
  return arr && arr.length > 0 ? arr[arr.length - 1]!.started_at : 0;
}

/** Current version number (1 when the bot has no bot_version rows). */
export function currentVersion(versions: ReadonlyMap<PlayerId, BotVersionRow[]>, botId: PlayerId): number {
  const arr = versions.get(botId);
  return arr && arr.length > 0 ? arr[arr.length - 1]!.version : 1;
}

/** Rank = 1 + number of other participants with a strictly higher score (ties share). */
export function rankOf(scores: readonly number[], own: number): number {
  let r = 1;
  for (const s of scores) if (s > own) r++;
  return r;
}

/** Find a bot id by exact name (case-insensitive) or numeric id string. */
export function resolveBot(bots: ReadonlyMap<PlayerId, HistBot>, nameOrId: string): HistBot | undefined {
  if (/^\d+$/.test(nameOrId)) return bots.get(Number(nameOrId));
  const lower = nameOrId.toLowerCase();
  for (const b of bots.values()) if (b.name.toLowerCase() === lower) return b;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Subset extraction (sample / fixture builder)
// ---------------------------------------------------------------------------------------------

/** Match-scoped tables copied by extractSubset (column holding the match id). */
export const SUBSET_MATCH_TABLES: Readonly<Record<string, string>> = {
  match_state: 'id',
  match_participant: 'match_id',
  auction_result: 'match_id',
  auction_top_bid_archive: 'match_id',
  word_play: 'match_id',
  tournament_match: 'match_id',
};

/** Small whole tables copied by extractSubset. */
export const SUBSET_WHOLE_TABLES: readonly string[] = ['bot', 'bot_version', 'tournament'];

/**
 * Copy the raw rows of `matchIds` (plus the small whole tables) from srcDir into outDir as
 * `<table>.ndjson.gz` (deterministic: rows kept in source order, fixed gzip level, no mtime in the
 * gzip header). Returns rows written per table.
 */
export async function extractSubset(
  srcDir: string,
  outDir: string,
  matchIds: Iterable<number>,
): Promise<Record<string, number>> {
  const ids = new Set(matchIds);
  fs.mkdirSync(outDir, { recursive: true });
  const counts: Record<string, number> = {};
  const write = (table: string, lines: string[]) => {
    const buf = zlib.gzipSync(Buffer.from(lines.length ? lines.join('\n') + '\n' : '', 'utf8'), { level: 9 });
    fs.writeFileSync(path.join(outDir, `${table}.ndjson.gz`), buf);
    counts[table] = lines.length;
  };
  for (const table of SUBSET_WHOLE_TABLES) {
    const f = tableFile(srcDir, table);
    if (!f) continue;
    const lines: string[] = [];
    for await (const r of readNdjson<unknown>(f)) lines.push(JSON.stringify(r));
    write(table, lines);
  }
  for (const [table, col] of Object.entries(SUBSET_MATCH_TABLES)) {
    const f = tableFile(srcDir, table);
    if (!f) continue;
    const lines: string[] = [];
    for await (const r of readNdjson<Record<string, unknown>>(f)) {
      if (ids.has(r[col] as number)) lines.push(JSON.stringify(r));
    }
    write(table, lines);
  }
  return counts;
}
