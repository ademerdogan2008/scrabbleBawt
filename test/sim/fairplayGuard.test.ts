// Fair-play guard (T-02-01-01): host-RNG reconstruction is for simulator verification only.
// No file under src/bots/** or src/client/** may import src/sim/hostRng, src/sim/hostReplay or
// the src/sim barrel (src/sim/index), and the barrel must not re-export the host modules.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SIM_DIR = join(ROOT, 'src', 'sim');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(m|c)?[jt]sx?$/.test(e)) out.push(p);
  }
  return out;
}

/** Every module specifier in a source text (static/dynamic import, export-from, require). */
export function specifiers(src: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
    /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[1]!);
  return out;
}

/** Why a specifier imported from `file` is forbidden, or undefined if allowed. */
export function violation(file: string, spec: string): string | undefined {
  if (/sim\/(hostRng|hostReplay)(\.[cm]?[jt]s)?$/.test(spec) || /sim\/(hostRng|hostReplay)\b/.test(spec)) {
    return 'imports host RNG reconstruction';
  }
  if (spec.startsWith('.')) {
    const target = resolve(dirname(file), spec).replace(/\.[cm]?[jt]s$/, '');
    if (target === SIM_DIR || target === join(SIM_DIR, 'index')) return 'imports the src/sim barrel';
    const rel = relative(SIM_DIR, target);
    if (!rel.startsWith('..') && /^(hostRng|hostReplay)$/.test(rel.split(sep).join('/'))) {
      return 'imports host RNG reconstruction';
    }
    return undefined;
  }
  if (/(^|\/)src\/sim(\/index(\.[cm]?[jt]s)?)?$/.test(spec)) return 'imports the src/sim barrel';
  return undefined;
}

describe('fair-play guard', () => {
  it('detector catches every forbidden form', () => {
    const f = join(ROOT, 'src', 'bots', 'bawt', 'x.ts');
    const c = join(ROOT, 'src', 'client', 'deep', 'y.ts');
    expect(violation(f, '../../sim/hostRng.js')).toBeDefined();
    expect(violation(f, '../../sim/hostReplay')).toBeDefined();
    expect(violation(f, '../../sim/index.js')).toBeDefined();
    expect(violation(f, '../../sim')).toBeDefined();
    expect(violation(f, '../../sim/')).toBeDefined();
    expect(violation(c, '../../sim/index.ts')).toBeDefined();
    expect(violation(f, 'src/sim/index.js')).toBeDefined();
    expect(violation(f, 'scrabblebawt/src/sim')).toBeDefined();
    expect(violation(f, '../../sim/match.js')).toBeUndefined();
    expect(violation(f, '../../engine/index.js')).toBeUndefined();
    const src = [
      "import { x } from '../../sim/hostRng.js';",
      "import type { Y } from \"../../sim\";",
      "export * from '../../sim/index.js';",
      "const m = await import('../../sim/hostReplay.js');",
      "import '../../sim/index.js';",
      "const r = require('../../sim/hostRng');",
    ].join('\n');
    const specs = specifiers(src);
    expect(specs.length).toBe(6);
    expect(specs.every((s) => violation(f, s) !== undefined)).toBe(true);
  });

  it('no file under src/bots or src/client imports host RNG modules or the sim barrel', () => {
    const files = [...walk(join(ROOT, 'src', 'bots')), ...walk(join(ROOT, 'src', 'client'))];
    expect(files.length).toBeGreaterThan(5);
    const bad: string[] = [];
    for (const file of files) {
      for (const spec of specifiers(readFileSync(file, 'utf8'))) {
        const why = violation(file, spec);
        if (why) bad.push(`${relative(ROOT, file)}: '${spec}' ${why}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('src/sim/index.ts does not re-export hostRng or hostReplay', () => {
    const src = readFileSync(join(SIM_DIR, 'index.ts'), 'utf8');
    for (const spec of specifiers(src)) expect(spec).not.toMatch(/hostRng|hostReplay/);
  });
});
