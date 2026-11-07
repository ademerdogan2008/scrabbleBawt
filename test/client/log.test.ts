import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eventsFromLog, Logger, redact } from '../../src/client/log.js';
import { replay, startEvent } from '../../src/state/events.js';
import type { MatchConfig } from '../../src/core/types.js';

// JWT-shaped strings are assembled at runtime so none is ever committed.
const seg = (s: string) => Buffer.from(s).toString('base64url');
const JWT = [seg('{"alg":"ES256","typ":"JWT"}'), seg('{"sub":"abc","iat":1}'), 'c2lnbmF0dXJlLXBhcnQ'].join('.');
const SECRET = ['opaque', 'secret', 'token', 'value', '42'].join('_');

describe('redact', () => {
  it('removes JWTs and token= params', () => {
    const s = `connect ...${JWT}... wss://h/v1?token=XYZ&x=1 and "token=ABC" end`;
    const r = redact(s);
    expect(r).not.toContain(JWT);
    expect(r).not.toContain('XYZ');
    expect(r).not.toContain('ABC');
    expect(r).toContain('&x=1');
    expect(r).toContain('<redacted>');
  });

  it('removes registered exact secrets and bearer headers', () => {
    const r = redact(`Authorization: Bearer ${SECRET} raw=${SECRET}`, [SECRET]);
    expect(r).not.toContain(SECRET);
    const b = redact(`Authorization: Bearer abc.def-ghi`);
    expect(b).not.toContain('abc.def-ghi');
  });

  it('leaves ordinary text alone', () => {
    expect(redact('bid 12 on Q (auction 55) word=QUIZ')).toBe('bid 12 on Q (auction 55) word=QUIZ');
  });
});

describe('Logger', () => {
  it('every written line is redacted (data, messages, errors, nested values)', () => {
    const lines: string[] = [];
    const log = new Logger({ sink: (_f, l) => lines.push(l), secrets: [SECRET], level: 'debug' });
    log.info(`connecting with ${JWT}`, { url: `wss://x/v1/database/db/subscribe?token=${SECRET}&c=1` });
    log.error('boom', { err: new Error(`bad token ${SECRET}`), nested: { deep: [JWT] }, big: 5n });
    log.match(7).record({ k: 'error', msg: `token=${SECRET}` });
    const all = lines.join('');
    expect(all).not.toContain(JWT);
    expect(all).not.toContain(SECRET);
    expect(all).toContain('"big":"5"');
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it('secrets learned later (addSecret) are scrubbed too', () => {
    const lines: string[] = [];
    const log = new Logger({ sink: (_f, l) => lines.push(l) });
    log.addSecret(SECRET);
    log.warn(`x ${SECRET} y`);
    expect(lines.join('')).not.toContain(SECRET);
  });

  it('level filter', () => {
    const lines: string[] = [];
    const log = new Logger({ sink: (_f, l) => lines.push(l), level: 'warn' });
    log.info('no');
    log.debug('no');
    log.warn('yes');
    expect(lines.length).toBe(1);
  });

  it('buffers to JSONL files under dir and the match log replays through src/state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bawt-log-'));
    try {
      const log = new Logger({ dir });
      const config: MatchConfig = {
        matchId: 9,
        auctionType: 'Vickrey',
        auctionDurationMs: 1000,
        startingRackSize: 0,
        startingBalance: 100,
        players: [
          { id: 1, name: 'me', isSim: false },
          { id: 2, name: 'opp', isSim: true, simStrategy: 'Aggressive' },
        ],
        myId: 1,
        totalAuctions: 98,
      };
      const ml = log.match(9);
      ml.event(startEvent(config, ''));
      ml.event({ t: 'open', auction: { auctionId: 1, index: 0, letter: 'A', opensAtMs: 0, closesAtMs: 1000, remainingAfter: 97 } });
      ml.record({ k: 'decision', auctionId: 1, index: 0, pass: 'anchor', bid: 3, words: [], decideMs: 0.1, budgetMs: 15, late: true });
      ml.event({ t: 'result', outcome: { auctionId: 1, index: 0, letter: 'A', winnerId: 1, paid: 2 } });
      log.flush();
      const text = readFileSync(join(dir, 'match-9.jsonl'), 'utf8');
      const tr = replay(eventsFromLog(text));
      expect(tr.me.balance).toBe(98);
      expect(tr.diagnostics).toEqual({ balanceMismatches: 0, rackMismatches: 0, hiddenOverflow: 0, unseenNegative: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
