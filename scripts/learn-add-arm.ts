// Add (or replace) a learning arm in the live state file, picked up at the next match start.
//   npx tsx scripts/learn-add-arm.ts <id> '<params json>' ['<gate json>']
import { loadState, saveState, defaultStatePath } from '../src/learn/store.js';
import { clampParams } from '../src/learn/arms.js';

const [id, paramsJson, gateJson] = process.argv.slice(2);
if (!id || !paramsJson) throw new Error('usage: learn-add-arm <id> <params json> [gate json]');
const path = defaultStatePath();
const { state } = loadState(path) as { state: any };
const params = JSON.parse(paramsJson);
const clamped = clampParams(params as never);
const arm = {
  id,
  params: clamped,
  origin: 'manual' as const,
  createdAt: new Date().toISOString(),
  alpha: 1,
  beta: 1,
  plays: 0,
  gate: gateJson ? JSON.parse(gateJson) : undefined,
};
state.arms = state.arms.filter((a: { id: string }) => a.id !== id);
state.arms.push(arm);
saveState(state, path);
console.log(`arm ${id} -> ${path}: ${JSON.stringify(clamped)}; arms now ${state.arms.map((a: { id: string }) => a.id).join(', ')}`);
