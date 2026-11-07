// Simulator barrel. Fair-play guard: this file must NEVER re-export hostRng or hostReplay
// (server-RNG reconstruction is for simulator verification only; see test/sim/fairplayGuard.test.ts).
export * from './match.js';
export * from './stats.js';
export * from './tournament.js';
