/**
 * `context-imports` over the real workspace's resolution: the kernel's pure wire (`@ferretry/kernel/wire`) and its
 * browser-safe session codec (`@ferretry/kernel/session`) are contract surface any package may import, while
 * `@ferretry/kernel/host` stays the shells' and the test host's.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type ImportEdge, areaOf, resolveSpecifier } from '../lib/imports.ts';
import { loadWorkspace } from '../lib/workspace.ts';
import { refusal } from '../../validate/context-imports.ts';

const ws = loadWorkspace(join(import.meta.dir, '..', '..', '..'));

function edge(fromPackage: string, fromFile: string, specifier: string): ImportEdge {
  const fromPkg = ws.byId(fromPackage);
  if (fromPkg === undefined) throw new Error(`no package ${fromPackage}`);
  const from = join(fromPkg.dir, fromFile);
  return {
    from,
    fromPkg,
    fromArea: areaOf(fromPkg, from),
    specifier,
    line: 1,
    typeOnly: false,
    kind: 'import',
    ...resolveSpecifier(ws, from, specifier),
  };
}

describe('context-imports: the kernel wire and session subpaths', () => {
  test('a plugin half imports @ferretry/kernel/wire and @ferretry/kernel/session as it imports the contract', () => {
    for (const specifier of ['@ferretry/kernel/wire', '@ferretry/kernel/session', '@ferretry/kernel/contract']) {
      expect(refusal(edge('connections', 'daemon/lib/relay/link.ts', specifier))).toBeUndefined();
      expect(refusal(edge('connections', 'app/index.ts', specifier))).toBeUndefined();
    }
  });

  test('a plugin contract may import them too (they are pure)', () => {
    expect(refusal(edge('connections', 'contract/index.ts', '@ferretry/kernel/wire'))).toBeUndefined();
  });

  test('@ferretry/kernel/host is still refused to a plugin half', () => {
    expect(refusal(edge('connections', 'daemon/lib/relay/link.ts', '@ferretry/kernel/host'))).toBe(
      '@ferretry/kernel/host is imported only by the shells and the test host',
    );
  });
});
