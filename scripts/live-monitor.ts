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

/** MONITOR_TABS="default:<chromeTabId>,key1:<chromeTabId>": pin each variant to its own Chrome tab. */
const TAB_OF = new Map(
  (process.env.MONITOR_TABS ?? '')
    .split(',')
    .map((x) => x.trim().split(':'))
    .filter((kv) => kv.length === 2 && /^\d+$/.test(kv[1]!))
    .map(([arm, id]) => [arm!, id!] as const),
);

/** Point a Chrome tab at the match page (no new tabs): the variant's pinned tab when MONITOR_TABS is
 *  set, else the first tab already on the ScrabbleBot site. */
function openInBrowser(matchId: number, arm?: string): void {
  if (!BROWSER || !Number.isInteger(matchId)) return;
  const url = `${SITE}/matches/${matchId}`;
  const pinned = arm ? TAB_OF.get(arm) : undefined;
  if (TAB_OF.size > 0 && !pinned) return;
  const match = pinned ? `(id of t) is ${pinned}` : `URL of t starts with "${SITE}"`;
  const script = `tell application "Google Chrome"
  if it is running then
    repeat with w in windows
      repeat with t in tabs of w
        if ${match} then
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

/** Matches whose variant was not known yet when they started (armStart not written yet). */
const pendingOpen = new Set<number>();
function openWhenKnown(matchId: number): void {
  const arm = armId(matchId);
  if (TAB_OF.size > 0 && !arm) {
    pendingOpen.add(matchId);
    return;
  }
  pendingOpen.delete(matchId);
  openInBrowser(matchId, arm);
}
/** matchId -> learning arm (LOG_DIR/learn.jsonl: armStart at match start, learn at match end). */
function armId(matchId: number): string | undefined {
  try {
    for (const l of readFileSync(join(dir, 'learn.jsonl'), 'utf8').split('\n').reverse()) {
      if (!l.includes(`"matchId":${matchId},`)) continue;
      const d = JSON.parse(l);
      const a = d?.learn ?? d?.armStart;
      if (a?.matchId === matchId) return String(a.armId);
    }
  } catch {
    /* no learner log */
  }
  return undefined;
}
const tag = (matchId: number): string => `[${(armId(matchId) ?? '?').padEnd(10)}]`;

/** Per-arm live record from learn.jsonl match-end lines: wins | top2 | top3.
 *  MONITOR_ARMS=a,b limits the table to those variants; MONITOR_SINCE=<matchId> counts only
 *  matches from that id on (e.g. the start of a head-to-head trial). */
const BOARD_ARMS = (process.env.MONITOR_ARMS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const BOARD_SINCE = Number(process.env.MONITOR_SINCE ?? 0);
function armBoard(): string {
  const agg = new Map<string, { n: number; w: number; top2: number; top3: number }>();
  try {
    for (const l of readFileSync(join(dir, 'learn.jsonl'), 'utf8').split('\n')) {
      if (!l.startsWith('{"learn"')) continue;
      const a = JSON.parse(l).learn;
      if (a.matchId < BOARD_SINCE) continue;
      if (BOARD_ARMS.length && !BOARD_ARMS.includes(a.armId)) continue;
      const r = agg.get(a.armId) ?? { n: 0, w: 0, top2: 0, top3: 0 };
      r.n++;
      if (a.rank === 1) r.w++;
      if (a.rank <= 2) r.top2++;
      if (a.rank <= 3) r.top3++;
      agg.set(a.armId, r);
    }
  } catch {
    return '';
  }
  const pct = (x: number, n: number) => `${String(x).padStart(2)} (${((100 * x) / n).toFixed(0).padStart(3)}%)`;
  const head = `           ${'variant'.padEnd(12)} ${'games'.padStart(5)}   ${'wins'.padEnd(10)}| ${'top2'.padEnd(10)}| top3` +
    (BOARD_SINCE ? `   (since match ${BOARD_SINCE})` : '');
  const rows = [...agg.entries()].sort((x, y) => y[1].w / y[1].n - x[1].w / x[1].n || y[1].top3 / y[1].n - x[1].top3 / x[1].n);
  return [head, ...rows.map(([id, r]) => `           ${id.padEnd(12)} ${String(r.n).padStart(5)}   ${pct(r.w, r.n).padEnd(10)}| ${pct(r.top2, r.n).padEnd(10)}| ${pct(r.top3, r.n)}`)].join('\n');
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
      console.log(`\n${tag(c.matchId)} [${ts()}] ▶ START match ${c.matchId} (${c.auctionType}, ${c.totalAuctions} auctions) vs ${opp}`);
      if (n < c.totalAuctions && !firstScan) openWhenKnown(c.matchId);
    }
    if (n >= c.totalAuctions) {
      st.done = true;
      played++;
      rankSum += rank;
      if (rank === 1) wins++;
      console.log(
        `${tag(c.matchId)} [${ts()}] ■ END   match ${c.matchId}: ${ME} #${rank}/${list.length} with ${me.score} (${me.won} letters, ${me.words.join(' ') || '-'})\n` +
          `           ${board}\n` +
          `           session: ${wins} wins / ${played} matches, avg rank ${(rankSum / played).toFixed(2)}`,
      );
      if (!firstScan) console.log(`           — live record per variant —\n${armBoard()}`);
    } else if (n - st.lastProgress >= 17) {
      st.lastProgress = n;
      console.log(`${tag(c.matchId)} [${ts()}]   ${c.matchId} ${n}/${c.totalAuctions}: ${ME} #${rank} bal ${me.bal} letters ${me.won} | ${board}`);
    }
  }
}

console.log(`live-game-monitor: watching ${dir} (Ctrl-C to quit)${BROWSER ? '; following matches in Chrome' : ''}`);
console.log(`           — live record per variant —\n${armBoard()}`);
let firstScan = true;
scan();
firstScan = false;
// at startup: each pinned tab shows its variant's latest match, then the running match
for (const arm of TAB_OF.keys()) {
  try {
    const last = readFileSync(join(dir, 'learn.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.includes('"armStart"') && l.includes(`"armId":"${arm}"`))
      .pop();
    if (last) openInBrowser(JSON.parse(last).armStart.matchId, arm);
  } catch {
    /* no learner log */
  }
}
openLatestRunning();
setInterval(() => {
  for (const id of [...pendingOpen]) openWhenKnown(id);
  scan();
}, 3000);

function openLatestRunning(): void {
  if (!existsSync(dir)) return;
  const f = readdirSync(dir).filter((x) => x.startsWith('match-') && x.endsWith('.jsonl')).sort().pop();
  if (!f || seen.get(f)?.done) return;
  const id = Number(f.slice(6, -6));
  openWhenKnown(id);
}
