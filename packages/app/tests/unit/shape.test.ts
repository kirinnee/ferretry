import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The app shell's own shape rules (§10.3, TEAM-RULES): `main.tsx` stays wiring (≤150 lines), and no source file
 * binds a global network function, so every byte to a daemon goes through the sealed session behind the guard.
 */

const SRC = join(import.meta.dir, '../../src');

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(ts|tsx)$/u.test(entry.name) ? [path] : [];
  });

describe('the app shell shape', () => {
  test('main.tsx is at most 150 lines', () => {
    const lines = readFileSync(join(SRC, 'main.tsx'), 'utf8').trimEnd().split('\n').length;
    expect(lines).toBeLessThanOrEqual(150);
  });

  test('main.tsx captures the browser’s install prompt before anything renders (S13)', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    const capture = main.indexOf('createBrowserInstallPrompt(');
    expect(capture).toBeGreaterThan(-1);
    expect(capture).toBeLessThan(main.indexOf('createRoot('));
  });

  test('no source binds a global network function', () => {
    const offenders = sources(SRC).filter(path => /(=|\?\?|:)\s*fetch\b/u.test(readFileSync(path, 'utf8')));
    expect(offenders.map(path => relative(SRC, path))).toEqual([]);
  });

  test('every storage name comes from storage/names.ts (no literal key at a call site)', () => {
    const old = /(getItem|setItem|removeItem|indexedDB\.open|caches\.open)\(\s*['"`]/u;
    const offenders = sources(SRC).filter(path => old.test(readFileSync(path, 'utf8')));
    expect(offenders.map(path => relative(SRC, path))).toEqual([]);
  });
});
