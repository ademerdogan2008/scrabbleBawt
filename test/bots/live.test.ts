// live:<Name> clone family (data/profiles-live.json) and the live-field profile selection flags.
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPolicy, parseSeat } from '../../src/bots/registry.js';
import { LINEUPS, resolveLineup } from '../../src/bots/lineups.js';
import { LIVE_CALIB, LIVE_FIELD_BOTS } from '../../src/bots/clones/live-calib.js';
import { findLiveProfile, liveCalibFor, loadLiveProfiles, quarterOf } from '../../src/bots/clones/live.js';
import { loadMatches } from '../../src/history/load.js';
import { activeBots, buildProfiles, checkProfiles } from '../../src/history/profiles.js';
import { runMatch, type SeatSpec } from '../../src/sim/match.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

describe('live:<Name> clones', () => {
  it('data/profiles-live.json is valid and covers every calibrated / lineup bot', () => {
    const P = loadLiveProfiles();
    expect(checkProfiles(P)).toEqual([]);
    for (const b of LIVE_FIELD_BOTS) expect(findLiveProfile(b).name).toBe(b);
    for (const l of [LINEUPS.liveField, LINEUPS.liveFieldB]) {
      expect(l.seats.length).toBe(6);
      for (const s of l.seats.filter((x) => x !== '*')) expect(s.startsWith('live:')).toBe(true);
    }
    expect(Object.keys(LIVE_CALIB).sort()).toEqual([...LIVE_FIELD_BOTS].sort());
  });

  it('resolves through the registry (name, case-insensitive, JSON opts) and rejects unknown bots', () => {
    expect(createPolicy('live:RackMaw', 1).name).toBe('live:RackMaw');
    expect(createPolicy('live:rackmaw', 1).name).toBe('live:RackMaw');
    expect(createPolicy('live:RackMaw:{"spread":0.3,"scale":1.1}', 1).name).toBe('live:RackMaw');
    expect(() => createPolicy('live:NoSuchBot123', 1)).toThrow(/no bot/);
    expect(liveCalibFor('NoSuchBot123')).toEqual({ scale: 1, qScale: [1, 1, 1, 1] });
  });

  it('quarterOf splits a 68-auction match into 4 quarters', () => {
    expect(quarterOf(0, 68)).toBe(0);
    expect(quarterOf(16, 68)).toBe(0);
    expect(quarterOf(17, 68)).toBe(1);
    expect(quarterOf(51, 68)).toBe(3);
    expect(quarterOf(67, 68)).toBe(3);
  });

  it('plays legal, deterministic matches in liveField and sells most auctions', () => {
    const lineup = resolveLineup('liveField', 'live:GodOfThudner');
    const play = (seed: number) => {
      const seats = lineup.map((s, k) => ({ id: k + 1, ...parseSeat(s, seed * 31 + k) }) as SeatSpec);
      return runMatch({ trace: true }, seats, seed);
    };
    const a = play(3);
    const b = play(3);
    expect(a.seats.map((s) => s.score)).toEqual(b.seats.map((s) => s.score));
    for (const s of a.seats) {
      expect(s.rejectedBids).toBe(0);
      expect(s.rejectedWords).toBe(0);
    }
    const sold = a.trace!.auctions.filter((x) => x.winnerId != null).length;
    expect(sold).toBeGreaterThan(a.trace!.auctions.length * 0.8);
  });
});

describe('live-field profile selection', async () => {
  const D = await loadMatches(path.join(ROOT, 'data', 'history-sample'));
  const complete = D.matches.filter((m) => m.complete);

  it('activeBots is undefined without a window and limited to the last N matches with one', () => {
    expect(activeBots(complete, undefined)).toBeUndefined();
    expect(activeBots(complete, 0)).toBeUndefined();
    const last = complete[complete.length - 1]!;
    expect([...activeBots(complete, 1)!].sort()).toEqual(last.participants.map((p) => p.botId).sort());
  });

  it('minMatches + activeWindow + no finalists restricts the fitted bots', () => {
    const all = buildProfiles(D, { minMatches: 1, finalists: [] });
    const win = buildProfiles(D, { minMatches: 1, finalists: [], activeWindow: 1 });
    const active = activeBots(complete, 1)!;
    expect(win.bots.length).toBeGreaterThan(0);
    expect(win.bots.length).toBeLessThan(all.bots.length);
    for (const b of win.bots) expect(active.has(b.id)).toBe(true);
    const strict = buildProfiles(D, { minMatches: 1_000_000, finalists: [] });
    expect(strict.bots.length).toBe(0);
  });
});
