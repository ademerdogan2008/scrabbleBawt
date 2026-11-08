// Live game monitor: follows the live client's match logs (runs/live/match-*.jsonl) and prints one
// line per match start (opponents), progress every 17 auctions, and one line per match end
// (rank, scores, running session record). Read-only; never touches the network or the token.
//
//   npm run monitor            (LOG_DIR overrides runs/live)
// On each new match it also points the open ScrabbleBot tab in Google Chrome at
// https://scrabblebot.spacetimedb.com/matches/<id> (macOS, visuals only; MONITOR_BROWSER=0 disables).
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { eventsFromLog } from '../src/client/log.js';

const dir = process.env.LOG_DIR ?? 'runs/live';
const ME = process.env.BOT_NAME_DISPLAY ?? 'Malicious';
const seen = new Map<string, { started: boolean; done: boolean; lastProgress: number }>();
let wins = 0;
let played = 0;
let rankSum = 0;
const ts = (): string => new Date().toLocaleTimeString();
const SITE = 'https://scrabblebot.spacetimedb.com';
const BROWSER = process.env.MONITOR_BROWSER !== '0' && process.platform === 'darwin';

/** Point the first Chrome tab already on the ScrabbleBot site at the match page (no new tabs). */
function openInBrowser(matchId: number): void {
  if (!BROWSER || !Number.isInteger(matchId)) return;
  const url = `${SITE}/matches/${matchId}`;
  const script = `tell application "Google Chrome"
  if it is running then
    repeat with w in windows
      repeat with t in tabs of w
        if URL of t starts with "${SITE}" then
          set URL of t to "${url}"
          return "ok"
        end if
      end repeat
    end repeat
  end if
  return "none"
end tell`;
  execFile('osascript', ['-e', script], { timeout: 5000 }, () => undefined);
}
/** matchId -> learning arm played (from LOG_DIR/learn.jsonl, written by the live client at match end). */
function armOf(matchId: number): string {
  try {
    for (const l of readFileSync(join(dir, 'learn.jsonl'), 'utf8').split('\n').reverse()) {
      if (!l.includes(`"matchId":${matchId},`)) continue;
      const a = JSON.parse(l)?.learn;
      if (a?.matchId === matchId) return ` [arm ${a.armId}]`;
    }
  } catch {
    /* no learner log */
  }
  return '';
}

interface Row { id: number; name: string; score: number; bal: number; won: number; words: string[] }

function scan(): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((x) => x.startsWith('match-') && x.endsWith('.jsonl')).sort()) {
    const st = seen.get(f) ?? { started: false, done: false, lastProgress: 0 };
    seen.set(f, st);
    if (st.done) continue;
    let evs: any[];
    try {
      evs = eventsFromLog(readFileSync(join(dir, f), 'utf8')) as any[];
    } catch {
      continue;
    }
    const start = evs.find((e) => e.t === 'start');
    if (!start) continue;
    const c = start.config;
    const rows = new Map<number, Row>(
      (c.players as any[]).map((p) => [p.id, { id: p.id, name: p.name, score: 0, bal: 0, won: 0, words: [] }]),
    );
    let n = 0;
    for (const e of evs) {
      if (e.t === 'result') {
        n++;
        const r = rows.get(e.outcome.winnerId);
        if (r) r.won++;
      } else if (e.t === 'balance') {
        const r = rows.get(e.id);
        if (r) Object.assign(r, { score: e.score, bal: e.balance });
      } else if (e.t === 'word') {
        const r = rows.get(e.ev.playerId);
        if (r) r.words.push(e.ev.word);
      }
    }
    const list = [...rows.values()].sort((a, b) => b.score - a.score);
    const me = rows.get(c.myId)!;
    const rank = 1 + list.filter((r) => r.score > me.score).length;
    const board = list.map((r) => `${r.id === c.myId ? '*' : ''}${r.name}=${r.score}`).join(' ');
    if (!st.started) {
      st.started = true;
      const opp = list.filter((r) => r.id !== c.myId).map((r) => r.name).join(', ');
      console.log(`\n[${ts()}] ▶ START match ${c.matchId} (${c.auctionType}, ${c.totalAuctions} auctions) vs ${opp}`);
      if (n < c.totalAuctions && !firstScan) openInBrowser(c.matchId);
    }
    if (n >= c.totalAuctions) {
      st.done = true;
      played++;
      rankSum += rank;
      if (rank === 1) wins++;
      console.log(
        `[${ts()}] ■ END   match ${c.matchId}${armOf(c.matchId)}: ${ME} #${rank}/${list.length} with ${me.score} (${me.won} letters, ${me.words.join(' ') || '-'})\n` +
          `           ${board}\n` +
          `           session: ${wins} wins / ${played} matches, avg rank ${(rankSum / played).toFixed(2)}`,
      );
    } else if (n - st.lastProgress >= 17) {
      st.lastProgress = n;
      console.log(`[${ts()}]   ${c.matchId} ${n}/${c.totalAuctions}: ${ME} #${rank} bal ${me.bal} letters ${me.won} | ${board}`);
    }
  }
}

console.log(`live-game-monitor: watching ${dir} (Ctrl-C to quit)${BROWSER ? '; following matches in Chrome' : ''}`);
let firstScan = true;
scan();
firstScan = false;
// the newest unfinished match at startup: open it too
openLatestRunning();
setInterval(scan, 3000);

function openLatestRunning(): void {
  if (!existsSync(dir)) return;
  const f = readdirSync(dir).filter((x) => x.startsWith('match-') && x.endsWith('.jsonl')).sort().pop();
  if (!f || seen.get(f)?.done) return;
  const id = Number(f.slice(6, -6));
  openInBrowser(id);
}
