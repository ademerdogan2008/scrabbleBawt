// Policy registry: name -> PolicyFactory, merged from each bots/* directory's own index so that
// later plans only edit their own directory. Spec grammar:
//   policy seat : <name>            e.g. "greedy", "clone:lucent" (names may contain ':')
//                 <name>:<json>     e.g. 'hoarder:{"lateFactor":2}'   (JSON object = factory opts)
//                 <family>:<arg>    e.g. "profile:Waupus" -> the 'profile:*' factory with opts.arg
//                 oracle:<spec>     same, with SIMULATOR-ONLY oracle racks (threat modelling)
//   sim seat    : sim:<Strategy>    e.g. "sim:Aggressive" (Cheapskate|ValueBidder|Aggressive|Human)
import { parseSimStrategy } from '../core/simbots.js';
import type { Policy, PolicyFactory } from '../core/types.js';
import type { SeatSpec } from '../sim/match.js';
import { policies as baselines } from './baselines/index.js';
import { policies as bawt } from './bawt/index.js';
import { policies as clones } from './clones/index.js';
import { policies as tricks } from './tricks/index.js';

/** SeatSpec without its id (distributes over the policy/sim union). */
export type SeatTemplate = SeatSpec extends infer S ? (S extends SeatSpec ? Omit<S, 'id'> : never) : never;

const REGISTRY: ReadonlyMap<string, PolicyFactory> = (() => {
  const m = new Map<string, PolicyFactory>();
  const groups: Array<[string, Record<string, PolicyFactory>]> = [
    ['baselines', baselines],
    ['bawt', bawt],
    ['clones', clones],
    ['tricks', tricks],
  ];
  for (const [group, entries] of groups) {
    for (const [name, factory] of Object.entries(entries)) {
      if (m.has(name)) throw new Error(`registry: duplicate policy name '${name}' (in ${group})`);
      m.set(name, factory);
    }
  }
  return m;
})();

/** Concrete policy names (wildcard families such as 'profile:*' are listed by listFamilies). */
export function listPolicies(): string[] {
  return [...REGISTRY.keys()].filter((k) => !k.endsWith(':*')).sort();
}

/** Wildcard families: '<prefix>:*' resolves '<prefix>:<arg>' with opts.arg = <arg>. */
export function listFamilies(): string[] {
  return [...REGISTRY.keys()].filter((k) => k.endsWith(':*')).sort();
}

/** Params start at the first ':' followed by '{' (names themselves may contain ':'). */
function splitSpec(spec: string): { name: string; opts?: Record<string, unknown> } {
  const s = spec.trim();
  const m = /:\s*\{/.exec(s);
  const colon = m ? m.index : -1;
  if (colon < 0) {
    if (s.endsWith(':')) throw new Error(`registry: params of '${s.slice(0, -1)}' must be a JSON object, got ''`);
    return { name: s };
  }
  const name = s.slice(0, colon).trim();
  const raw = s.slice(colon + 1).trim();
  let opts: unknown;
  try {
    opts = JSON.parse(raw);
  } catch {
    throw new Error(`registry: params of '${name}' must be a JSON object, got '${raw}'`);
  }
  if (typeof opts !== 'object' || opts === null || Array.isArray(opts)) {
    throw new Error(`registry: params of '${name}' must be a JSON object, got '${raw}'`);
  }
  return { name, opts: opts as Record<string, unknown> };
}

/** Build a policy from `name` or `name:{json params}`. */
export function createPolicy(spec: string, seed: number): Policy {
  const { name, opts } = splitSpec(spec);
  const factory = REGISTRY.get(name);
  if (factory && !name.endsWith(':*')) return factory(seed, opts);
  const colon = name.lastIndexOf(':');
  if (colon > 0) {
    const family = REGISTRY.get(`${name.slice(0, colon)}:*`);
    const arg = name.slice(colon + 1).trim();
    if (family && arg.length > 0) return family(seed, { ...opts, arg });
  }
  throw new Error(
    `registry: unknown policy '${name}' (known: ${listPolicies().join(', ')}; families: ${listFamilies().join(', ')})`,
  );
}

/** Parse a lineup entry into a seat template (add an `id` to get a SeatSpec). */
export function parseSeat(spec: string, seed = 0): SeatTemplate {
  const s = spec.trim();
  if (s.toLowerCase().startsWith('sim:')) {
    const tag = s.slice(4).trim();
    const strategy = parseSimStrategy(tag);
    if (!strategy) throw new Error(`registry: unknown sim strategy '${tag}'`);
    return { name: `${strategy}-sim`, kind: 'sim', simStrategy: strategy };
  }
  if (s.toLowerCase().startsWith('oracle:')) {
    const inner = s.slice(7).trim();
    const policy = createPolicy(inner, seed);
    return { name: `oracle-${policy.name}`, kind: 'policy', policy, oracle: true };
  }
  const policy = createPolicy(s, seed);
  return { name: policy.name, kind: 'policy', policy };
}
