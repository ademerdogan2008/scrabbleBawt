// Word-cashing policy (STRATEGY §5, COMPETITORS §3.1/§5.4).
//
// rules (default, measured in §5):
//   - cash 7+ letter words as soon as they exist (3× is the cap; waiting cannot raise them), using
//     the best 7+-only packing of the rack (reward-maximal set of 7+ words);
//   - Nijello rule: hold when the open letter L, if we likely win it, makes a strictly better 7+
//     partition than "play now + use L later" (gain >= holdGain);
//   - liquidity: no 7+ word and balance < poorBelow with > poorMinAuctions left: cash the best
//     single word of length >= poorMinLen;
//   - never cash 4-6 letter words for score (−19 to −34 measured).
// scenario (ablation / K-13 play-vs-hold): for candidate w compare on the decision's scenarios
//   play = r(w)·(1 + coinBonus·λ) + E[Pack(R − w + F)]  vs  hold = E[Pack(R + F)]; play when
//   play − hold > playMargin; repeat on the remainder (<= maxPlays words).
import { wordReward } from '../../core/letters.js';
import { rackClone, rackFromWord, rackSub, type Rack } from '../../core/rack.js';
import type { AnagramIndex } from '../../engine/anagram.js';
import type { Packer } from '../../engine/packer.js';
import { meanPack, packOpts, type PackLimits } from './valuation.js';

export interface WordInput {
  packer: Packer;
  index: AnagramIndex;
  rack: Rack;
  /** Open letter index and our win probability for it. */
  li: number;
  pWinOpen: number;
  balance: number;
  /** Auctions remaining after the open one (remainingAfter). */
  remainingAfter: number;
  minCashLen: number;
  holdGain: number;
  poorBelow: number;
  poorMinLen: number;
  poorMinAuctions: number;
  lim: PackLimits;
}

export interface WordChoice {
  words: string[];
  reward: number;
  reason: 'none' | 'cash7' | 'hold' | 'liquidity' | 'scenario';
}

const sumRewards = (ws: readonly string[]) => ws.reduce((s, w) => s + wordReward(w), 0);

function removeWords(rack: Rack, words: readonly string[]): Rack {
  const r = rackClone(rack);
  for (const w of words) rackSub(r, rackFromWord(w));
  return r;
}

export function chooseWordsRules(inp: WordInput): WordChoice {
  const lim7 = { ...inp.lim, minLen: inp.minCashLen };
  const p7 = inp.packer.packExact(inp.rack, packOpts(lim7));
  if (p7.words.length > 0) {
    if (inp.pWinOpen >= 0.5 && inp.remainingAfter > 0) {
      const withL = rackClone(inp.rack);
      withL[inp.li]!++;
      const best = inp.packer.packExact(withL, packOpts(lim7)).score;
      const rest = removeWords(inp.rack, p7.words);
      rest[inp.li]!++;
      const alt = p7.score + inp.packer.packExact(rest, packOpts(lim7)).score;
      if (best - alt >= inp.holdGain) return { words: [], reward: 0, reason: 'hold' };
    }
    return { words: p7.words, reward: sumRewards(p7.words), reason: 'cash7' };
  }
  if (inp.balance < inp.poorBelow && inp.remainingAfter > inp.poorMinAuctions) {
    const w = inp.index.bestSingleWord(inp.rack, inp.poorMinLen);
    if (w) return { words: [w.word], reward: w.reward, reason: 'liquidity' };
  }
  return { words: [], reward: 0, reason: 'none' };
}

export interface ScenarioWordInput extends WordInput {
  futures: readonly Rack[];
  /** Points per coin. */
  lambda: number;
  coinBonus: number;
  playMargin: number;
  maxPlays: number;
}

/** K-13 style play-vs-hold on shared futures. */
export function chooseWordsScenario(inp: ScenarioWordInput): WordChoice {
  const words: string[] = [];
  let rack = rackClone(inp.rack);
  for (let k = 0; k < inp.maxPlays; k++) {
    const hold = meanPack(inp.packer, rack, inp.futures, inp.lim);
    const cands = new Set<string>(inp.packer.packExact(rack, packOpts(inp.lim)).words);
    const single = inp.index.bestSingleWord(rack, 2);
    if (single) cands.add(single.word);
    let bestW: string | undefined;
    let bestGain = inp.playMargin;
    for (const w of cands) {
      if (w.length < 2) continue;
      const rest = removeWords(rack, [w]);
      const play = wordReward(w) * (1 + inp.coinBonus * inp.lambda) + meanPack(inp.packer, rest, inp.futures, inp.lim);
      if (play - hold > bestGain) {
        bestGain = play - hold;
        bestW = w;
      }
    }
    if (!bestW) break;
    words.push(bestW);
    rack = removeWords(rack, [bestW]);
  }
  return { words, reward: sumRewards(words), reason: words.length ? 'scenario' : 'none' };
}
