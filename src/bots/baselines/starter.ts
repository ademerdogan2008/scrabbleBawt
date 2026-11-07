// Exact port of the official bot-starter (clockworklabs/scrabblebot bot-starter/src).
//
// Bid (strategy.ts decideBid), computed when the auction row is inserted, i.e. from the
// PRE-word balance and rack:  min(have == 0 ? value + 2 : max(1, value), max(0, balance)).
// It bids on every auction, the final one included.
//
// Words (index.ts tryPlayWord): the bot tries one word (longest, then lexicographically first,
// min length 2) on every my_rack insert/update, debounced by WORD_RETRY_MS = 500 ms. Rack
// changes come from the deal (match start) and from its own wins; the update caused by its own
// word removal lands inside the 500 ms debounce and never triggers another attempt. So: one
// attempt after the deal, one after each own win, nothing else.
import { VALUE, idx } from '../../core/letters.js';
import type { Policy, PolicyFactory } from '../../core/types.js';
import { getEngine } from '../../engine/index.js';

export const createStarter: PolicyFactory = () => {
  const { index } = getEngine();
  let pendingAttempt = false;
  let myId = -1;
  const policy: Policy = {
    name: 'starter',
    onMatchStart(view) {
      myId = view.config.myId;
      pendingAttempt = true;
    },
    decide(view, auction) {
      const li = idx(auction.letter);
      const value = VALUE[li] ?? 1;
      const have = view.me.rack[li] ?? 0;
      const want = have === 0 ? value + 2 : Math.max(1, value);
      const bid = Math.min(want, Math.max(0, view.me.balance));
      const words: string[] = [];
      if (pendingAttempt) {
        pendingAttempt = false;
        const w = index.findBestPlayable(view.me.rack, 2);
        if (w !== undefined) words.push(w);
      }
      return { words, bid };
    },
    onAuctionClosed(_view, outcome) {
      if (outcome.winnerId === myId) pendingAttempt = true;
    },
  };
  return policy;
};
