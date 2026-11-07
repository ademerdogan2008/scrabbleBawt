// Endgame (STRATEGY §5.4, RULES §7; COMPETITORS K-13 tricks).
//
// remainingAfter == 0 (final auction; its letter is unusable by real bots because the match ends
//   inside the close transaction): play the exact best packing of the whole rack; bid the whole
//   balance when a sim is seated (free denial: coins are worthless now), else 0.
// remainingAfter == 1 (penultimate): bid the whole balance (coins are worthless afterwards). Hold
//   the words for the final flush, except:
//   - slow link (netRttMs > preFlushRttMs): flush the current packing now;
//   - a rival could outbid us (balance >= ours) and the letter has value: pre-play the words of
//     pack(R + L) that do not need L, which raises our all-in bid at no cost if we win L.
//   Both packings are computed here so the final flush is a memo hit.
import { wordReward } from '../../core/letters.js';
import { rackClone, rackFromWord, rackSub, type Rack } from '../../core/rack.js';
import type { Decision, MatchView } from '../../core/types.js';
import type { Packer } from '../../engine/packer.js';
import { packOpts, type PackLimits } from './valuation.js';

export type FlushLimits = PackLimits;

export function anySimSeated(view: MatchView): boolean {
  return view.config.players.some((p) => p.isSim && p.id !== view.config.myId);
}

export function finalDecision(view: MatchView, packer: Packer, lim: FlushLimits, simDeny: boolean): Decision {
  const words = packer.packExact(view.me.rack, packOpts(lim)).words;
  const bid = simDeny && anySimSeated(view) ? Math.max(0, Math.floor(view.me.balance)) : 0;
  return { words, bid };
}

/**
 * Words of `pack` (a packing of rack + L) that can be played now without L: every word except
 * the one that consumes the extra copy of L (if the packing uses it).
 */
export function wordsWithoutLetter(rack: Rack, packWords: readonly string[], li: number): string[] {
  let used = 0;
  for (const w of packWords) for (let k = 0; k < w.length; k++) if (w.charCodeAt(k) - 65 === li) used++;
  if (used <= rack[li]!) return [...packWords];
  // drop one word containing L (the highest-reward one keeps the most value pending)
  let drop = -1;
  for (let i = 0; i < packWords.length; i++) {
    const w = packWords[i]!;
    if (w.includes(String.fromCharCode(65 + li)) && (drop < 0 || wordReward(w) > wordReward(packWords[drop]!))) drop = i;
  }
  const out = packWords.filter((_, i) => i !== drop);
  // sanity: the remaining words must fit in the rack
  const r = rackClone(rack);
  try {
    for (const w of out) rackSub(r, rackFromWord(w));
  } catch {
    return [];
  }
  return out;
}

export function penultimateDecision(
  view: MatchView,
  li: number,
  packer: Packer,
  lim: FlushLimits,
  opts: { allIn: boolean; prePlay: boolean; preFlushRttMs: number; netRttMs: number | undefined; fallbackBid: number },
): Decision {
  const rack = view.me.rack;
  // split the remaining time between the two packings (the final flush then hits the memo)
  const half: PackLimits =
    lim.deadlineAt !== undefined && lim.now ? { ...lim, deadlineAt: lim.now() + (lim.deadlineAt - lim.now()) / 2 } : lim;
  const base = packer.packExact(rack, packOpts(half));
  const withL = rackClone(rack);
  withL[li]!++;
  const packL = packer.packExact(withL, packOpts(lim));
  const balance = Math.max(0, Math.floor(view.me.balance));
  if (opts.netRttMs !== undefined && opts.netRttMs > opts.preFlushRttMs) {
    const reward = base.words.reduce((s, w) => s + wordReward(w), 0);
    return { words: base.words, bid: opts.allIn ? balance + reward : Math.min(opts.fallbackBid, balance + reward) };
  }
  let words: string[] = [];
  const gain = packL.score - base.score;
  if (opts.prePlay && gain > 0) {
    let richest = 0;
    for (const p of view.opponents) if (!p.info.isSim && p.balance > richest) richest = p.balance;
    if (richest >= balance) words = wordsWithoutLetter(rack, packL.words, li);
  }
  const reward = words.reduce((s, w) => s + wordReward(w), 0);
  const bid = opts.allIn ? balance + reward : Math.min(balance + reward, opts.fallbackBid);
  return { words, bid };
}
