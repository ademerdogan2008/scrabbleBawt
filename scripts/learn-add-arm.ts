// Add (or replace) a learning arm in the live state file, picked up at the next match start.
//   npx tsx scripts/learn-add-arm.ts <id> '<params json>' ['<gate json>']
// Locked read-modify-write (src/learn/store.ts updateState): safe while the live client and the
// learn-cycle watcher run; a corrupt state file aborts instead of being replaced.
// Without a gate JSON the arm is stored but never played (live eligibility needs gate.matches > 0).
import { DEFAULT_ARM_ID, defaultStatePath, updateState, type Arm } from '../src/learn/store.js';
import { clampParams } from '../src/learn/arms.js';

const [id, paramsJson, gateJson] = process.argv.slice(2);
if (!id || !paramsJson) throw new Error('usage: learn-add-arm <id> <params json> [gate json]');
if (id === DEFAULT_ARM_ID) throw new Error(`learn-add-arm: '${DEFAULT_ARM_ID}' is reserved`);
const path = defaultStatePath();
const params = JSON.parse(paramsJson);
const clamped = clampParams(params as never);
const arm: Arm = {
  id,
  params: clamped,
  origin: 'manual' as const,
  createdAt: new Date().toISOString(),
  alpha: 1,
  beta: 1,
  plays: 0,
  ...(gateJson ? { gate: JSON.parse(gateJson) as Arm['gate'] } : {}),
};
const state = updateState(path, (s) => {
  s.arms = s.arms.filter((a) => a.id !== id);
  s.arms.push(arm);
});
console.log(`arm ${id} -> ${path}: ${JSON.stringify(clamped)}; arms now ${state.arms.map((a) => a.id).join(', ')}`);
