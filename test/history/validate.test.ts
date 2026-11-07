// Historical E2E checks on the committed sample: every check must report 0 mismatches, every check
// must actually run, and injected corruptions must be caught.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getEngine } from '../../src/engine/index.js';
import { loadMatches, resolveBot } from '../../src/history/load.js';
import type { HistDataset } from '../../src/history/types.js';
import { CHECKS, formatReport, totalMismatches, validateDataset } from '../../src/history/validate.js';

const SAMPLE = path.join(__dirname, '..', '..', 'data', 'history-sample');

function clone(D: HistDataset): HistDataset {
  return { ...D, matches: structuredClone(D.matches) };
}

describe('validation suite on data/history-sample', async () => {
  const D = await loadMatches(SAMPLE);
  const { dict, index } = getEngine();
  const report = validateDataset(D, { dict, index });

  it('sample composition: lobby, six-real, tournament, all-sim, deleted bots, incomplete', () => {
    expect(D.matches.length).toBeGreaterThanOrEqual(290);
    expect(D.matches.filter((m) => m.tournament !== null)).toHaveLength(51);
    const bron = resolveBot(D.bots, 'Bron')!.id;
    expect(D.matches.filter((m) => m.participants.some((p) => p.botId === bron)).length).toBeGreaterThanOrEqual(120);
    expect(D.matches.filter((m) => m.complete && m.nReal === 6).length).toBeGreaterThanOrEqual(120);
    expect(D.matches.filter((m) => m.nReal === 0).length).toBeGreaterThanOrEqual(5);
    const missing = new Set([...D.bots.values()].filter((b) => b.missing).map((b) => b.id));
    expect(missing.size).toBeGreaterThan(0);
    expect(D.matches.some((m) => m.participants.some((p) => missing.has(p.botId)))).toBe(true);
    expect(D.matches.filter((m) => !m.complete)).toHaveLength(1);
  });

  it('reports 0 mismatches on every check, with the incomplete match excluded', () => {
    if (totalMismatches(report) !== 0) console.log(formatReport(report));
    expect(report.excludedIncomplete).toBe(1);
    expect(report.matchesComplete).toBe(D.matches.length - 1);
    expect(report.nonVickrey).toBe(0);
    expect(report.checks.map((c) => c.id)).toEqual(CHECKS.map(([id]) => id));
    for (const c of report.checks) {
      expect(c.mismatches, `${c.id}: ${c.examples.join('; ')}`).toBe(0);
      expect(c.checked, c.id).toBeGreaterThan(0);
    }
    expect(report.trackerSeats).toBe(D.matches.filter((m) => m.complete).reduce((s, m) => s + m.participants.length, 0));
    expect(report.simBestWordCoverage.reconstructible).toBeGreaterThan(100);
  });

  it('catches injected corruptions', () => {
    const X = clone(D);
    const m = X.matches.find((x) => x.complete && x.words.length > 3)!;
    m.words[0]!.reward += 1; // reward, bonus, score sum, balance identity, tracker resync
    m.auctions[5]!.topBid = m.auctions[5]!.paid - 1; // top < paid
    const simMatch = X.matches.find((x) => x.complete && x.nSim > 0 && x !== m)!;
    const simWin = simMatch.auctions.find((a) => a.winnerId !== null && X.bots.get(a.winnerId)!.isSim)!;
    simWin.topBid = 99; // impossible sim bid
    const r = validateDataset(X, { dict, index });
    const by = new Map(r.checks.map((c) => [c.id, c.mismatches]));
    expect(by.get('word.reward')).toBe(1);
    expect(by.get('word.bonus')).toBe(1);
    expect(by.get('score.sum')).toBe(1);
    expect(by.get('balance.identity')).toBe(1);
    expect(by.get('auction.topGePaid')).toBe(1);
    expect(by.get('sim.winBid')).toBeGreaterThanOrEqual(1);
    expect(by.get('tracker.seat')).toBeGreaterThan(0);
    expect(by.get('word.dictionary')).toBe(0);
  });

  it('catches a mis-ordered sim word and a non-dictionary word', () => {
    const X = clone(D);
    const m = X.matches.find((x) => x.complete && x.words.some((w) => w.inClose))!;
    const w = m.words.find((x) => x.inClose)!;
    w.inClose = false; // as if the sim had played before its win
    const m2 = X.matches.find((x) => x.complete && x !== m && x.words.length > 0)!;
    m2.words[0]!.word = 'QZXQ';
    const r = validateDataset(X, { dict, index, skipTracker: true });
    const by = new Map(r.checks.map((c) => [c.id, c.mismatches]));
    expect(by.get('sim.wordAfterWin')).toBeGreaterThanOrEqual(1);
    expect(by.get('word.dictionary')).toBe(1);
    expect(r.trackerSeats).toBe(0);
  });
});
