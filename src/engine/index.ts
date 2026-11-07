// Word engine barrel: dictionary, anagram index, packer, plus a lazily-built shared instance.
import { AnagramIndex } from './anagram.js';
import { loadDictionary, type Dictionary } from './dictionary.js';
import { Packer } from './packer.js';

export * from './anagram.js';
export * from './dictionary.js';
export * from './packer.js';

export interface Engine {
  dict: Dictionary;
  index: AnagramIndex;
  packer: Packer;
}

let shared: Engine | undefined;

/** Shared engine over the vendored wordlist (built on first use, ~0.3 s). */
export function getEngine(): Engine {
  if (!shared) {
    const dict = loadDictionary();
    const index = new AnagramIndex(dict);
    shared = { dict, index, packer: new Packer(index) };
  }
  return shared;
}
