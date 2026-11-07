// whoami: connect with the configured bot token, resolve our bot id + name and its credentials,
// then disconnect. Read-only: NO lobby join and NO reducer call (this script never imports the
// reducer path). Connecting does flip bot_credential.connected through the module's own
// client_connected / client_disconnected lifecycle hooks; that is unavoidable for any connection.
//
//   npx tsx scripts/client-whoami.ts                 (repo .env)
//   ENV_FILE=/path/to/.env npx tsx scripts/client-whoami.ts
//
// Output: bot id, bot name, credential count (and how many are connected now). Never the token.
import { ConnectionSupervisor } from '../src/client/connection.js';
import { Logger } from '../src/client/log.js';
import { loadEntryConfig } from '../src/client/main.js';
import { assertQueriesAllowed, identityLiteral, subscribeQueries } from '../src/client/subscriptions.js';

const TIMEOUT_MS = Number(process.env.WHOAMI_TIMEOUT_MS ?? 20_000);

async function main(): Promise<number> {
  const cfg = loadEntryConfig();
  if (!cfg.botToken) {
    console.error('whoami: no BOT_TOKEN (set it in .env or ENV_FILE)');
    return 1;
  }
  const logger = new Logger({ level: 'warn', secrets: [cfg.botToken], console: true });
  return new Promise<number>((resolve) => {
    let done = false;
    const finish = (code: number, line: string): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sup.stop();
      (code === 0 ? console.log : console.error)(logger.redact(line));
      resolve(code);
    };
    const timer = setTimeout(() => finish(1, `whoami: timed out after ${TIMEOUT_MS} ms`), TIMEOUT_MS);
    const sup = new ConnectionSupervisor({
      cfg,
      log: logger,
      maxAttempts: 0,
      onGiveUp: (err) => finish(1, `whoami: connect failed: ${err?.message ?? 'unknown'}`),
      onConnected: ({ conn, identityHex }) => {
        const stage1 = assertQueriesAllowed([
          `SELECT * FROM "bot_credential" WHERE "bot_credential"."identity" = ${identityLiteral(identityHex)}`,
        ]);
        subscribeQueries(conn as never, stage1, {
          onError: (m) => finish(1, `whoami: subscription failed: ${m}`),
          onApplied: () => {
            const mine = [...conn.db.botCredential.iter()].find((c) => c.identity.toHexString().toLowerCase() === identityHex.toLowerCase());
            if (!mine) return finish(1, 'whoami: this token is not a credential for any bot');
            const botId = mine.botId;
            const stage2 = assertQueriesAllowed([
              `SELECT * FROM "bot" WHERE "bot"."id" = ${botId}`,
              `SELECT * FROM "bot_credential" WHERE "bot_credential"."bot_id" = ${botId}`,
            ]);
            subscribeQueries(conn as never, stage2, {
              onError: (m) => finish(1, `whoami: subscription failed: ${m}`),
              onApplied: () => {
                const bot = [...conn.db.bot.iter()].find((b) => b.id === botId);
                const creds = [...conn.db.botCredential.iter()].filter((c) => c.botId === botId);
                const online = creds.filter((c) => c.connected).length;
                finish(
                  0,
                  `whoami: bot id=${botId} name=${bot?.name ?? '?'} credentials=${creds.length} connected=${online} ` +
                    `(host=${cfg.host} db=${cfg.db}; no reducers called)`,
                );
              },
            });
          },
        });
      },
    });
    sup.start();
  });
}

main().then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 250).unref();
  },
  (e: unknown) => {
    console.error(`whoami failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
