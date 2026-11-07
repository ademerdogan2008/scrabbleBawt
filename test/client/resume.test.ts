// CLI-05 / PITFALLS M9: reconnect into a Running match. The tracker rebuilt from the per-match
// snapshot (delivered in shuffled order) must deep-equal the uninterrupted tracker, with all
// diagnostics 0, and the bid for the still-open auction must be resubmitted exactly once.
import { describe, expect, it } from 'vitest';
import { Harness } from './fixtures/harness.js';

const ZERO = { balanceMismatches: 0, rackMismatches: 0, hiddenOverflow: 0, unseenNegative: 0 };

async function uninterrupted(seed: number, k: number) {
  const h = new Harness({ seed });
  h.start();
  for (let i = 0; i < k; i++) await h.step(opponentWords(i));
  await h.settle();
  h.server.advanceMs(300);
  opponentWords(k)(h);
  await h.settle();
  const a = h.server.current!;
  h.server.serverUs = a.closesAtUs;
  h.server.closeTx();
  // Same point as the resumed driver: close tx k (and open k+1) applied, before any echo of the
  // words we send in reaction to it.
  const atResume = h.driver.tracker!.snapshot();
  await h.settle();
  await h.runToEnd((hh, i) => opponentWords(i)(hh));
  return { h, atResume, final: h.driver.tracker!.snapshot() };
}

/** Deterministic mid-auction opponent word plays (exercise word attribution). */
function opponentWords(i: number) {
  return (h: Harness) => {
    if (i % 7 !== 3) return;
    const w = h.server.opponentBestWord(150, 3);
    if (w) h.server.opponentWordTx(150, w);
  };
}

describe('resume from snapshot', () => {
  it.each([
    [101, 5],
    [202, 17],
    [303, 40],
    [404, 76], // resume at the final auction (bag_total == 0)
  ])('seed %i, disconnect after auction %i', async (seed, k) => {
    const ref = await uninterrupted(seed, k);

    const h = new Harness({ seed });
    h.start();
    for (let i = 0; i < k; i++) await h.step(opponentWords(i));
    // Auction k: we bid live, then the connection drops right before the close transaction.
    await h.settle();
    if (opponentWords(k)) {
      h.server.advanceMs(300);
      opponentWords(k)(h);
      await h.settle();
    }
    const old = h.driver;
    old.dispose();
    h.server.connected = false;
    const a = h.server.current!;
    h.server.serverUs = a.closesAtUs;
    h.server.closeTx(); // missed while disconnected
    h.server.advanceMs(80); // reconnect + resubscribe delay
    h.server.connected = true;

    // New driver from the shuffled snapshot (resume=true).
    const resumed = h.newDriver(true);
    h.driver = resumed;
    const subsBefore = h.submissions.length;
    resumed.applySnapshot(h.server.snapshot(seed + 1), h.localMs());
    const view = resumed.tracker!.snapshot();
    expect(view).toEqual(ref.atResume);
    expect(resumed.tracker!.diagnostics).toEqual(ZERO);

    // Exactly one bid (re)submission for the still-open auction from the resumed driver.
    await h.settle();
    const open = h.server.current;
    if (open) {
      const bids = h.submissions.slice(subsBefore).filter((s) => s.what === 'bid' && s.auctionId === open.id);
      expect(bids.length).toBe(1);
      expect(bids[0]!.pass).toBe('anchor');
      expect(h.server.pendingBid(101)).toBe(bids[0]!.value);
    }

    await h.runToEnd((hh, i) => opponentWords(i)(hh));
    expect(resumed.tracker!.snapshot()).toEqual(ref.final);
    expect(resumed.tracker!.diagnostics).toEqual(ZERO);
    expect(resumed.stats.timingErrors).toBe(0);
  });

  it('a bid of 0 is still resubmitted on resume (the old pending bid is unreadable)', async () => {
    const { scriptedFactory } = await import('./fixtures/harness.js');
    const h = new Harness({ seed: 9, policyFactory: scriptedFactory({ words: () => [], bid: (_v, a) => (a.index === 3 ? 0 : 4) }) });
    h.start();
    for (let i = 0; i < 2; i++) await h.step();
    // Auction 2 open; drop before its close, so we resume into auction 3 whose decision is 0.
    h.driver.dispose();
    h.server.connected = false;
    h.server.serverUs = h.server.current!.closesAtUs;
    h.server.closeTx();
    h.server.connected = true;
    const resumed = h.newDriver(true);
    h.driver = resumed;
    const n = h.submissions.length;
    resumed.applySnapshot(h.server.snapshot(1), h.localMs());
    await h.settle();
    const bids = h.submissions.slice(n).filter((s) => s.what === 'bid');
    expect(bids.map((b) => b.value)).toEqual([0]);
  });

  it('a fresh (non-resume) start does not send a 0 bid', async () => {
    const { scriptedFactory } = await import('./fixtures/harness.js');
    const h = new Harness({ seed: 9, policyFactory: scriptedFactory({ words: () => [], bid: () => 0 }) });
    h.start();
    await h.settle();
    expect(h.submissions.filter((s) => s.what === 'bid')).toEqual([]);
  });

  it('snapshot of an already-Ended match finishes without decisions', async () => {
    const h = new Harness({ seed: 12 });
    h.start();
    await h.runToEnd();
    const late = h.newDriver(true);
    let ended = false;
    const d = new (late.constructor as typeof import('../../src/client/adapter.js').MatchDriver)({
      ...(late as unknown as { o: object }).o,
      onEnded: () => (ended = true),
    } as never);
    d.applySnapshot(h.server.snapshot(3), h.localMs());
    expect(ended).toBe(true);
    expect(d.stats.decisions).toBe(0);
    expect(d.tracker!.snapshot()).toEqual(h.driver.tracker!.snapshot());
  });
});
