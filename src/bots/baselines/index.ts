// Phase 3 (03-02) extends these baselines; do not recreate.
// ZOO-01 = starter (exact official bot-starter replica) + greedy; hoarder and random are simple
// baselines that the trick bots in src/bots/tricks wrap or parametrize.
import type { PolicyFactory } from '../../core/types.js';
import { createGreedy } from './greedy.js';
import { createHoarder } from './hoarder.js';
import { createRandom } from './random.js';
import { createStarter } from './starter.js';

export { createGreedy, GREEDY_DEFAULTS, type GreedyParams } from './greedy.js';
export { createHoarder, HOARDER_DEFAULTS, type HoarderParams } from './hoarder.js';
export { createRandom, RANDOM_DEFAULTS, type RandomParams } from './random.js';
export { createStarter } from './starter.js';

export const policies: Record<string, PolicyFactory> = {
  starter: createStarter,
  greedy: createGreedy,
  hoarder: createHoarder,
  random: createRandom,
};
