// The `mimic` policy: replays a target bot's historical behaviour inside the replay harness.
// It bids exactly the target's archived top bid on the auctions the target won (0 elsewhere, since a
// losing sealed bid is never archived) and submits the target's historical words at the decide()
// of the auction during which they were played. With tieMode "historical" it must reproduce the
// target's original score exactly: that is the harness correctness check.
// Words the target played inside a close transaction (only sims do that) are submitted at the
// next auction's decide(); a sim's word after the FINAL close cannot be replayed.
import type { AuctionInfo, Decision, PlayerId, Policy, PolicyFactory } from '../core/types.js';
import type { HistMatch } from './types.js';

export function mimicFactory(m: HistMatch, targetId: PlayerId): PolicyFactory {
  const words = new Map<number, string[]>();
  for (const w of m.words) {
    if (w.botId !== targetId) continue;
    const k = w.inClose ? w.auctionIndex + 1 : w.auctionIndex;
    let arr = words.get(k);
    if (!arr) words.set(k, (arr = []));
    arr.push(w.word);
  }
  const bids = new Map<number, number>();
  for (const a of m.auctions) if (a.winnerId === targetId && a.topBid !== null) bids.set(a.index, a.topBid);
  return (): Policy => ({
    name: 'mimic',
    onMatchStart(): void {},
    decide(_view, auction: AuctionInfo): Decision {
      return { words: [...(words.get(auction.index) ?? [])], bid: bids.get(auction.index) ?? 0 };
    },
  });
}
