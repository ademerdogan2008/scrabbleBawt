// Loss diagnosis: from one finished, lost match summary, explain who won and how, and map the
// evidence to hypothesis categories. Each category is a direction in knob space (candidates.ts).
//
// Signals (all from public match events plus our own decision/submit records):
//   winner: score, bingos (7+ words), letters won, average price paid per letter vs ours;
//   money left unspent at the end; unplayed rack value;
//   near misses: auctions we bid on and lost by <= NEAR_MISS coins (Vickrey: we set the price);
//   overpays: our wins priced far above the reference price of that letter;
//   uncontested cheap wins of the winner while we had cash (denial).
import type { BookEntry } from '../store.js';
import type { AuctionRow, MatchSummary, PlayerSummary } from './ingest.js';

export type Category =
  | 'overspent-early'
  | 'underspent-hoarded-cash'
  | 'lost-key-letters-to-X'
  | 'words-not-cashed'
  | 'denial-missing'
  | 'opponent-mispriced';

export const CATEGORIES: readonly Category[] = [
  'overspent-early',
  'underspent-hoarded-cash',
  'lost-key-letters-to-X',
  'words-not-cashed',
  'denial-missing',
  'opponent-mispriced',
];

export interface Finding {
  category: Category;
  /** 0..1, how strongly the evidence points this way. */
  strength: number;
  /** Opponent name for lost-key-letters-to-X / opponent-mispriced. */
  target?: string;
  evidence: string;
}

export interface NearMiss {
  index: number;
  letter: string;
  myBid: number;
  paid: number;
  winner: string;
}

export interface Overpay {
  index: number;
  letter: string;
  paid: number;
  reference: number;
}

export interface Diagnosis {
  matchId: number;
  armId: string;
  players: number;
  realPlayers: number;
  rank: number;
  reward: number;
  me: PlayerSummary;
  winner: PlayerSummary;
  scoreGap: number;
  unspent: number;
  unplayedValue: number;
  unplayedTiles: number;
  minBalanceFirstHalf: number;
  nearMisses: NearMiss[];
  overpays: Overpay[];
  uncontestedCheap: number;
  findings: Finding[];
  primary: Category | 'unexplained';
}

/** Thresholds (documented in .planning/LEARNING.md). */
export const DIAG = Object.freeze({
  highValue: 4, // letter face value counted as "key"
  nearMiss: 2, // lost by at most this many coins
  nearMissKey: 3, // >= this many key near misses ...
  keyMissRatio: 1.5, // ... and >= ratio x key letters we won => lost-key-letters-to-X
  brokeBalance: 10, // balance at or below this in the first half => overspent-early
  unspentFrac: 0.25, // final balance >= this x starting balance => underspent
  unplayedValue: 8, // unplayed face value >= this => words-not-cashed
  unplayedTiles: 4,
  cheapPrice: 3, // winner's win at <= this price ...
  cashForDenial: 20, // ... while we held >= this balance and did not contest
  uncontested: 5, // >= this many => denial-missing (<= 4 real seats only)
  maxRealForDenial: 4,
  overpayRatio: 1.6, // our win priced >= ratio x reference and >= overpayMin
  overpayMin: 6,
  overpays: 3,
  paidRatio: 1.3, // our avg price/letter >= ratio x winner's => opponent-mispriced
  minLettersForRatio: 3,
});

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function referencePrice(letter: string, rows: readonly AuctionRow[], myId: number, book: Record<string, BookEntry> | undefined, fallback: number): number {
  const others = rows.filter((r) => r.letter === letter && r.winnerId !== null && r.winnerId !== myId && r.paid > 0);
  if (others.length >= 2) return others.reduce((s, r) => s + r.paid, 0) / others.length;
  if (book) {
    let n = 0;
    let sum = 0;
    for (const e of Object.values(book)) {
      const p = e.pricesByLetter?.[letter];
      if (p && p.n > 0) {
        n += p.n;
        sum += p.n * p.mean;
      }
    }
    if (n >= 3) return sum / n;
  }
  return fallback;
}

export function diagnose(s: MatchSummary, book?: Record<string, BookEntry>): Diagnosis {
  const myId = s.config.myId;
  const nameOf = new Map<number, string>(s.config.players.map((p) => [p.id, p.name]));
  const start = s.config.startingBalance;
  const half = Math.floor(s.config.totalAuctions / 2);
  const realPlayers = s.config.players.filter((p) => !p.isSim).length;
  const findings: Finding[] = [];

  // ---- near misses (lost-key-letters-to-X)
  const nearMisses: NearMiss[] = [];
  for (const r of s.auctions) {
    if (r.winnerId === null || r.winnerId === myId || r.myBid === undefined || r.myBid <= 0) continue;
    const gap = r.paid - r.myBid;
    if (gap >= 0 && gap <= DIAG.nearMiss) nearMisses.push({ index: r.index, letter: r.letter, myBid: r.myBid, paid: r.paid, winner: nameOf.get(r.winnerId) ?? String(r.winnerId) });
  }
  const keyMisses = nearMisses.filter((m) => {
    const row = s.auctions.find((r) => r.index === m.index);
    return !!row && row.value >= DIAG.highValue;
  });
  // In Vickrey we are the runner-up (paid == our bid) on many auctions in any busy table, so only
  // key-letter near misses in excess of our own key-letter wins count as evidence.
  const keyWins = s.auctions.filter((r) => r.winnerId === myId && r.value >= DIAG.highValue).length;
  if (keyMisses.length >= DIAG.nearMissKey && keyMisses.length >= DIAG.keyMissRatio * keyWins) {
    const by = new Map<string, number>();
    for (const m of keyMisses) by.set(m.winner, (by.get(m.winner) ?? 0) + 1);
    const target = [...by.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    findings.push({
      category: 'lost-key-letters-to-X',
      strength: clamp01((keyMisses.length - keyWins) / 4),
      target,
      evidence: `${keyMisses.length} key-letter near misses (<= ${DIAG.nearMiss} coins: ${keyMisses.map((m) => `${m.letter}@${m.paid} vs ${m.myBid}`).join(', ')}) vs ${keyWins} key letters won; mostly to ${target}`,
    });
  }

  // ---- overspent early
  let minBalanceFirstHalf = start;
  for (const r of s.auctions) if (r.index < half) minBalanceFirstHalf = Math.min(minBalanceFirstHalf, r.myBalance);
  if (minBalanceFirstHalf <= DIAG.brokeBalance) {
    findings.push({
      category: 'overspent-early',
      strength: clamp01(0.5 + (DIAG.brokeBalance - minBalanceFirstHalf) / (2 * DIAG.brokeBalance)),
      evidence: `balance fell to ${minBalanceFirstHalf} before auction ${half} of ${s.config.totalAuctions}`,
    });
  }

  // ---- unspent cash
  const unspent = s.me.balance;
  if (unspent >= DIAG.unspentFrac * start) {
    findings.push({
      category: 'underspent-hoarded-cash',
      strength: clamp01(unspent / (2 * DIAG.unspentFrac * start)),
      evidence: `${unspent} coins unspent at the end (>= ${DIAG.unspentFrac * start})`,
    });
  }

  // ---- unplayed rack
  if (s.unplayedValue >= DIAG.unplayedValue || s.unplayedTiles >= DIAG.unplayedTiles) {
    findings.push({
      category: 'words-not-cashed',
      strength: clamp01(Math.max(s.unplayedValue / (2 * DIAG.unplayedValue), s.unplayedTiles / (2 * DIAG.unplayedTiles))),
      evidence: `unplayed rack '${s.finalRack}' (${s.unplayedTiles} tiles, value ${s.unplayedValue})`,
    });
  }

  // ---- denial
  let uncontestedCheap = 0;
  if (!s.won && s.winner.id !== myId) {
    for (const r of s.auctions) {
      if (r.winnerId !== s.winner.id || r.paid > DIAG.cheapPrice || r.myBalance < DIAG.cashForDenial) continue;
      if ((r.myBid ?? 0) <= r.paid) uncontestedCheap++;
    }
  }
  if (realPlayers <= DIAG.maxRealForDenial && uncontestedCheap >= DIAG.uncontested) {
    findings.push({
      category: 'denial-missing',
      strength: clamp01(uncontestedCheap / (2 * DIAG.uncontested)),
      target: s.winner.name,
      evidence: `${s.winner.name} took ${uncontestedCheap} letters at <= ${DIAG.cheapPrice} while we held >= ${DIAG.cashForDenial}`,
    });
  }

  // ---- overpays and relative price
  const othersWins = s.auctions.filter((r) => r.winnerId !== null && r.winnerId !== myId && r.paid > 0);
  const fallback = othersWins.length > 0 ? othersWins.reduce((a, r) => a + r.paid, 0) / othersWins.length : 0;
  const overpays: Overpay[] = [];
  for (const r of s.auctions) {
    if (r.winnerId !== myId) continue;
    const ref = referencePrice(r.letter, s.auctions, myId, book, fallback);
    if (ref > 0 && r.paid >= DIAG.overpayMin && r.paid >= DIAG.overpayRatio * ref) overpays.push({ index: r.index, letter: r.letter, paid: r.paid, reference: Math.round(ref * 10) / 10 });
  }
  const ratio = s.winner.avgPaid > 0 ? s.me.avgPaid / s.winner.avgPaid : 0;
  const ratioHit = s.me.lettersWon >= DIAG.minLettersForRatio && s.winner.lettersWon >= DIAG.minLettersForRatio && ratio >= DIAG.paidRatio;
  const bookEntry = book?.[s.winner.name];
  const bookNote =
    bookEntry && bookEntry.matches >= 5 && bookEntry.avgPricePaid > 0
      ? `; ${s.winner.name} paid ${s.winner.avgPaid.toFixed(1)}/letter vs ${bookEntry.avgPricePaid.toFixed(1)} in the book`
      : '';
  if (overpays.length >= DIAG.overpays || ratioHit) {
    findings.push({
      category: 'opponent-mispriced',
      strength: clamp01(Math.max(overpays.length / (2 * DIAG.overpays), ratioHit ? (ratio - 1) / (2 * (DIAG.paidRatio - 1)) : 0)),
      target: s.winner.name,
      evidence: `we paid ${s.me.avgPaid.toFixed(1)}/letter vs winner ${s.winner.avgPaid.toFixed(1)} (x${ratio.toFixed(2)}); ${overpays.length} overpays${bookNote}`,
    });
  }

  findings.sort((a, b) => b.strength - a.strength || CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category));
  return {
    matchId: s.matchId,
    armId: s.armId,
    players: s.config.players.length,
    realPlayers,
    rank: s.rank,
    reward: s.reward,
    me: s.me,
    winner: s.winner,
    scoreGap: s.winner.score - s.me.score,
    unspent,
    unplayedValue: s.unplayedValue,
    unplayedTiles: s.unplayedTiles,
    minBalanceFirstHalf,
    nearMisses,
    overpays,
    uncontestedCheap,
    findings,
    primary: findings[0]?.category ?? 'unexplained',
  };
}

function who(p: PlayerSummary): string {
  return `${p.name}${p.isSim ? ' (sim)' : ''}: ${p.score} pts, ${p.bingos} bingos, ${p.lettersWon} letters @ ${p.avgPaid.toFixed(1)}, ${p.balance} left, words ${p.words.join(' ') || '-'}`;
}

/** Markdown entry for .planning/LEARNING.md. */
export function renderDiagnosis(d: Diagnosis): string {
  const lines = [
    `#### Loss ${d.matchId} (arm ${d.armId}): rank ${d.rank}/${d.players}, ${d.realPlayers} real, reward ${d.reward.toFixed(2)}`,
    '',
    `- winner ${who(d.winner)}`,
    `- us ${who(d.me)}; gap ${d.scoreGap}`,
    `- unspent ${d.unspent}, unplayed ${d.unplayedTiles} tiles / value ${d.unplayedValue}, min balance 1st half ${d.minBalanceFirstHalf}`,
    `- near misses ${d.nearMisses.length}${d.nearMisses.length ? ` (${d.nearMisses.slice(0, 8).map((m) => `${m.letter}#${m.index} ${m.myBid}->${m.paid} ${m.winner}`).join(', ')})` : ''}; overpays ${d.overpays.length}${d.overpays.length ? ` (${d.overpays.slice(0, 6).map((o) => `${o.letter}#${o.index} ${o.paid} vs ~${o.reference}`).join(', ')})` : ''}; winner's uncontested cheap wins ${d.uncontestedCheap}`,
  ];
  if (d.findings.length === 0) lines.push('- hypothesis: unexplained (no rule fired; random perturbation only)');
  for (const f of d.findings) {
    const cat = f.category === 'lost-key-letters-to-X' && f.target ? `lost-key-letters-to-${f.target}` : f.category;
    lines.push(`- hypothesis **${cat}** (strength ${f.strength.toFixed(2)}): ${f.evidence}`);
  }
  return lines.join('\n') + '\n';
}
