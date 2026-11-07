// Policies owned by src/bots/tricks (03-02 Task 3); the registry merges this map.
// The trick zoo covers PITFALLS.md "Catalog of opponent tricks" and COMPETITORS.md §4.10 / §7:
//   trick:allin          spoiler, 1.5-2x market on common letters until broke, never words
//   trick:shadow         price-pusher: 0.85x the leader's estimated value, never wants letters
//   trick:baiter         greedybot bait: drains the greediest spender early, then buys cheap
//   trick:late           hoards coins, dominates the last 15 auctions
//   trick:jitter         truthful-ish ±30% noise
//   trick:sniper         sim max + 1 when only sims compete, else low
//   trick:bottomFeeder   bids 1 on every letter, greedy words (greedy baseline, parametrized)
//   trick:endgameDumper  thrifty, spends everything in the last 10
//   trick:oracleDenier   deal-aware denial via onOracle (seat it as oracle:trick:oracleDenier)
//   trick:spite          heads-up: bids just under the opponent's predicted bid on unneeded letters
//   trick:hoarder        hoarder baseline with a bounded flush (ZOO-04)
//   trick:random         random baseline (ZOO-04)
import type { PolicyFactory } from '../../core/types.js';
import { createAllin } from './allin.js';
import { createBaiter } from './baiter.js';
import { createBottomFeeder, createTrickHoarder, createTrickRandom } from './baselineWrappers.js';
import { createEndgameDumper } from './endgameDumper.js';
import { createJitter } from './jitter.js';
import { createLate } from './late.js';
import { createOracleDenier } from './oracleDenier.js';
import { createShadow } from './shadow.js';
import { createSniper } from './sniper.js';
import { createSpite } from './spite.js';

export const policies: Record<string, PolicyFactory> = {
  'trick:allin': createAllin,
  'trick:shadow': createShadow,
  'trick:baiter': createBaiter,
  'trick:late': createLate,
  'trick:jitter': createJitter,
  'trick:sniper': createSniper,
  'trick:bottomFeeder': createBottomFeeder,
  'trick:endgameDumper': createEndgameDumper,
  'trick:oracleDenier': createOracleDenier,
  'trick:spite': createSpite,
  'trick:hoarder': createTrickHoarder,
  'trick:random': createTrickRandom,
};

export const TRICKS: readonly string[] = Object.keys(policies);
