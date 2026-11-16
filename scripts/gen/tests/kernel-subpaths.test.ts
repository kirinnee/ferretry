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

  test('the push envelope is contract surface by its own subpath: the signed worker and a plugin contract import it', () => {
    const specifier = '@ferretry/kernel/contract/push-envelope';
    expect(edge('access', 'contract/push.ts', specifier).toArea).toBe('kernel-contract');
    expect(refusal(edge('access', 'contract/push.ts', specifier))).toBeUndefined();
  });

  test('the notification filter document is contract surface by its own subpath, like the envelope', () => {
    const specifier = '@ferretry/kernel/contract/notification-filter';
    expect(edge('agenda', 'app/lib/notification-filter.ts', specifier).toArea).toBe('kernel-contract');
    expect(refusal(edge('agenda', 'app/lib/notification-filter.ts', specifier))).toBeUndefined();
    expect(refusal(edge('access', 'app/lib/push-clear.ts', '@ferretry/kernel/contract/push-envelope'))).toBeUndefined();
  });

  test('the hosted app origin is contract surface by its own subpath, for the app build config Node loads', () => {
    const specifier = '@ferretry/kernel/contract/hosted-app';
    expect(edge('connections', 'contract/hosted-directory.ts', specifier).toArea).toBe('kernel-contract');
    expect(refusal(edge('connections', 'contract/hosted-directory.ts', specifier))).toBeUndefined();
  });

  test('the home port reader is contract surface by its own subpath, for the CLI that dials what the daemon binds', () => {
    const specifier = '@ferretry/kernel/contract/home-port';
    expect(edge('connections', 'contract/home-port.ts', specifier).toArea).toBe('kernel-contract');
    expect(refusal(edge('connections', 'contract/home-port.ts', specifier))).toBeUndefined();
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

describe('context-imports: a plugin’s halves share pure code through their own contract folder', () => {
  test('a half imports its own contract folder by relative path; another plugin’s non-contract path is refused', () => {
    expect(refusal(edge('accounts', 'daemon/lib/defaults.ts', '../../contract/shared.ts'))).toBeUndefined();
    expect(refusal(edge('accounts', 'app/screens/defaults.ts', '../../contract/shared.ts'))).toBeUndefined();
    expect(refusal(edge('accounts', 'daemon/lib/defaults.ts', '@ferretry/plugin-runtimes/contract'))).toBeUndefined();
    expect(refusal(edge('accounts', 'daemon/lib/defaults.ts', '@ferretry/plugin-runtimes/daemon'))).toContain(
      'another package is reached only through its contract',
    );
    expect(refusal(edge('accounts', 'daemon/lib/defaults.ts', '../../../runtimes/daemon/lib/x.ts'))).toContain(
      'another package is reached only through its contract',
    );
    // and its own other half stays refused: halves share only the manifest and the contract
    expect(refusal(edge('accounts', 'daemon/lib/defaults.ts', '../../app/screens/x.ts'))).toContain(
      'halves share only',
    );
  });
});

describe('context-imports: @ferretry/kernel/worker', () => {
  test('a daemon half (its worker module) imports it; an app half or a contract does not', () => {
    expect(refusal(edge('asks', 'daemon/lib/archive/worker.ts', '@ferretry/kernel/worker'))).toBeUndefined();
    expect(refusal(edge('asks', 'app/index.ts', '@ferretry/kernel/worker'))).toBe(
      "@ferretry/kernel/worker is imported only by a daemon half's worker module",
    );
    expect(refusal(edge('asks', 'contract/index.ts', '@ferretry/kernel/worker'))).toBeDefined();
  });
});

describe('context-imports: the app shell public API', () => {
  test('an app half imports @ferretry/app, /ui and /worker; its tests also /testing', () => {
    for (const specifier of ['@ferretry/app', '@ferretry/app/ui', '@ferretry/app/worker'])
      expect(refusal(edge('connections', 'app/index.ts', specifier))).toBeUndefined();
    expect(refusal(edge('connections', 'tests/unit/app/x.test.ts', '@ferretry/app/testing'))).toBeUndefined();
  });

  test('a daemon half, a contract, or an app half reaching for the fakes is refused', () => {
    expect(refusal(edge('connections', 'daemon/index.ts', '@ferretry/app'))).toContain('only by app halves');
    expect(refusal(edge('connections', 'app/index.ts', '@ferretry/app/testing'))).toContain('only by tests');
    expect(refusal(edge('connections', 'contract/index.ts', '@ferretry/app'))).toBeDefined();
  });

  test('tests import the public API and /testing only: a private or unknown subpath of the shell is refused', () => {
    for (const specifier of ['@ferretry/app', '@ferretry/app/ui', '@ferretry/app/worker', '@ferretry/app/testing'])
      expect(refusal(edge('connections', 'tests/unit/app/x.test.ts', specifier))).toBeUndefined();
    for (const specifier of [
      '@ferretry/app/src/main.tsx',
      '@ferretry/app/src/session/session-client.ts',
      '@ferretry/app/internal',
    ])
      expect(refusal(edge('connections', 'tests/unit/app/x.test.ts', specifier))).toContain(
        "not the app shell's public API",
      );
  });
});
