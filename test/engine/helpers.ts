// Shared test helpers for engine tests.
import { BAG, NUM_LETTERS } from '../../src/core/letters.js';
import { emptyRack, type Rack } from '../../src/core/rack.js';
import type { Rng } from '../../src/core/rng.js';

const BAG_TILES: number[] = [];
for (let i = 0; i < NUM_LETTERS; i++) for (let k = 0; k < BAG[i]!; k++) BAG_TILES.push(i);

/** `n` tiles drawn without replacement from the standard 98-tile bag. */
export function randomBagRack(rng: Rng, n: number): Rack {
  const tiles = rng.shuffle([...BAG_TILES]);
  const r = emptyRack();
  for (let k = 0; k < n && k < tiles.length; k++) r[tiles[k]!]!++;
  return r;
}
