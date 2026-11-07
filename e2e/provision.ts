// Provision N real bots on the LOCAL E2E server through the module's real team/credential flow:
//   human_i (fresh anonymous identity) -> create_team({teamName, botName}) -> mint_credential_nonce({})
//   -> read my_nonces -> bot_i (fresh anonymous identity) -> claim_credential({code})
//   -> bot_i's token saved to .cache/e2e/tokens/<bot>.token (git-ignored, mode 600).
// Every reducer goes through the 02-03 guard (loopback passes). Refuses any non-loopback host.
//
//   npx tsx e2e/provision.ts --bots 6 [--prefix e2e]
// Existing token files are reused when their identity is still a credential on the server.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { call, connect, E2E_DB, E2E_HOST, requireLoopback, subscribeAll, TOKEN_DIR, type Connected } from './lib.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : def;
}

const identityQuery = (hex: string): string =>
  `SELECT * FROM "bot_credential" WHERE "bot_credential"."identity" = 0x${hex.replace(/^0x/, '').toLowerCase()}`;

async function credentialOf(c: Connected): Promise<bigint | undefined> {
  await subscribeAll(c, [identityQuery(c.identityHex)]);
  const row = [...c.conn.db.botCredential.iter()].find((r) => r.identity.toHexString() === c.identityHex);
  return row?.botId;
}

async function provisionOne(botName: string): Promise<{ botId: bigint; reused: boolean }> {
  const file = join(TOKEN_DIR, `${botName}.token`);
  if (existsSync(file)) {
    const c = await connect(E2E_HOST, E2E_DB, readFileSync(file, 'utf8').trim());
    try {
      const id = await credentialOf(c);
      if (id !== undefined) return { botId: id, reused: true };
    } finally {
      c.conn.disconnect();
    }
  }
  // human: fresh identity, team + bot, nonce
  const human = await connect(E2E_HOST, E2E_DB);
  let code: string;
  try {
    await call(human, E2E_HOST, 'create_team', { teamName: `team-${botName}`, botName });
    await call(human, E2E_HOST, 'mint_credential_nonce', {});
    await subscribeAll(human, ['SELECT * FROM "my_nonces"']);
    const nonce = [...human.conn.db.myNonces.iter()].at(-1);
    if (!nonce) throw new Error(`no nonce visible for ${botName}`);
    code = nonce.code;
  } finally {
    human.conn.disconnect();
  }
  // bot: fresh identity claims the nonce
  const bot = await connect(E2E_HOST, E2E_DB);
  try {
    await call(bot, E2E_HOST, 'claim_credential', { code });
    const id = await credentialOf(bot);
    if (id === undefined) throw new Error(`claim for ${botName} not visible`);
    writeFileSync(file, bot.token, { mode: 0o600 });
    chmodSync(file, 0o600);
    return { botId: id, reused: false };
  } finally {
    bot.conn.disconnect();
  }
}

async function main(): Promise<number> {
  requireLoopback(E2E_HOST);
  const n = Number(arg('bots', '6'));
  const prefix = arg('prefix', 'e2e');
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error('--bots must be 1..12');
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  console.log(`provision: ${n} bots on ${E2E_HOST} db=${E2E_DB}`);
  for (let i = 1; i <= n; i++) {
    const name = `${prefix}${i}`;
    const r = await provisionOne(name);
    console.log(`  ${name}: bot id ${r.botId} ${r.reused ? '(reused token)' : '(created, token saved mode 600)'}`);
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 200).unref();
  },
  (e: unknown) => {
    console.error(`provision failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
