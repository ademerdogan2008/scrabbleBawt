// Thin wrapper: `npx tsx scripts/bench.ts ...` == `npm run bench -- ...` (src/sim/cli.ts).
import { main } from '../src/sim/cli.js';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    process.exit(1);
  },
);
