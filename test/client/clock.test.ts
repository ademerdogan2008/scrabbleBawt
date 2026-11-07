import { describe, expect, it } from 'vitest';
import { ClientClock, percentile } from '../../src/client/clock.js';

const OPEN = 1_700_000_000_000;
const DUR = 1000;
const auction = (opensAtMs: number) => ({ opensAtMs, closesAtMs: opensAtMs + DUR });

/** Clock with an established offset (lag 40 ms) and RTT p90 = 80 ms (16 x 60 ms, 4 x 80 ms). */
function warmClock(): ClientClock {
  const c = new ClientClock({ marginMs: 120, now: () => 0 });
  for (let i = 0; i < 20; i++) c.recordArrival(OPEN - 10_000 + i * 1000, OPEN - 10_000 + i * 1000 + 40 + (i % 5));
  for (let i = 0; i < 20; i++) c.recordRtt(i < 16 ? 60 : 80);
  return c;
}

describe('percentile', () => {
  it('nearest-rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 0.1)).toBe(1);
    expect(percentile([5, 1, 3, 2, 4], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});

describe('ClientClock estimators', () => {
  it('RTT EWMA and p90 over the window; defaults before samples', () => {
    const c = new ClientClock({ defaultRttMs: 100, rttWindow: 10 });
    expect(c.rttP90).toBe(100);
    expect(c.rttEwma).toBe(100);
    for (let i = 1; i <= 10; i++) c.recordRtt(i * 10);
    expect(c.rttP90).toBe(90);
    expect(c.rttEwma).toBeGreaterThan(10);
    expect(c.rttEwma).toBeLessThan(100);
    for (let i = 0; i < 10; i++) c.recordRtt(5); // window slides
    expect(c.rttP90).toBe(5);
    c.recordRtt(NaN);
    c.recordRtt(-1);
    expect(c.rttSamples).toBe(10);
  });

  it('offsetEst is the p10 of arrival lags (robust to slow outliers)', () => {
    const c = new ClientClock();
    expect(c.offsetEst).toBeUndefined();
    const lags = [40, 41, 42, 43, 44, 45, 46, 47, 300, 500];
    lags.forEach((l, i) => c.recordArrival(OPEN + i * 1000, OPEN + i * 1000 + l));
    expect(c.offsetEst).toBe(40);
  });

  it('observeLiveOpen flags stalls as late and does not record them', () => {
    const c = warmClock();
    const n = c.lagSamples;
    expect(c.observeLiveOpen(OPEN, OPEN + 45)).toBe(false);
    expect(c.lagSamples).toBe(n + 1);
    expect(c.observeLiveOpen(OPEN, OPEN + 400)).toBe(true);
    expect(c.lagSamples).toBe(n + 1);
  });
});

describe('deadlineFor', () => {
  it('a delivery 400 ms after opens_at leaves at least 400 ms less time than an on-time one', () => {
    const c = warmClock();
    const a = auction(OPEN);
    // On time = at the steady-state lag (offset 40 ms); the late copy arrives 400 ms after that.
    const onTimeRecv = OPEN + c.offsetEst!;
    const lateRecv = onTimeRecv + 400;
    const onTime = c.deadlineFor(a, onTimeRecv);
    const lateLive = c.deadlineFor(a, lateRecv); // not tagged: the recv branch is capped by the offset branch
    const lateTagged = c.deadlineFor(a, lateRecv, { late: true });
    expect(lateLive - lateRecv).toBeLessThanOrEqual(onTime - onTimeRecv - 400 + 1e-9);
    expect(lateTagged - lateRecv).toBeLessThanOrEqual(onTime - onTimeRecv - 400 + 1e-9);
    // Absolute deadline never moves later because the delivery was late.
    expect(lateTagged).toBeLessThanOrEqual(onTime);
  });

  it('a late (snapshot) auction never gets a deadline after closesAt + offsetEst - rttP90 - margin', () => {
    const c = warmClock();
    const a = auction(OPEN);
    const cap = a.closesAtMs + c.offsetEst! - c.rttP90 - c.marginMs;
    for (const recv of [OPEN - 500, OPEN, OPEN + 40, OPEN + 999, OPEN + 5000]) {
      expect(c.deadlineFor(a, recv, { late: true })).toBeLessThanOrEqual(cap);
      expect(c.deadlineFor(a, recv)).toBeLessThanOrEqual(cap);
    }
  });

  it('without an offset estimate: recv branch, minus an extra 250 ms when late', () => {
    const c = new ClientClock({ marginMs: 120, defaultRttMs: 100 });
    const a = auction(OPEN);
    expect(c.deadlineFor(a, OPEN + 50)).toBe(OPEN + 50 + DUR - 100 - 120);
    expect(c.deadlineFor(a, OPEN + 50, { late: true })).toBe(OPEN + 50 + DUR - 100 - 120 - 250);
  });

  it('on-time deadline = min(recv + duration, closesAt + offset) - rttP90 - margin', () => {
    const c = warmClock();
    const a = auction(OPEN);
    const expected = Math.min(OPEN + 30 + DUR, a.closesAtMs + c.offsetEst!) - c.rttP90 - 120;
    expect(c.deadlineFor(a, OPEN + 30)).toBe(expected);
    expect(c.rttP90).toBe(80);
  });

  it('respects variable auction durations (250 ms auctions)', () => {
    const c = warmClock();
    const short = { opensAtMs: OPEN, closesAtMs: OPEN + 250 };
    const d = c.deadlineFor(short, OPEN + 40);
    expect(d).toBeLessThan(OPEN + 250 + 40);
  });

  it('budgetFor = deadline - now - submitCost', () => {
    let t = 1000;
    const c = new ClientClock({ submitCostMs: 5, now: () => t });
    expect(c.budgetFor(1500)).toBe(495);
    t = 1600;
    expect(c.budgetFor(1500)).toBeLessThan(0);
    expect(c.budgetFor(1500, 1400, 0)).toBe(100);
  });
});
