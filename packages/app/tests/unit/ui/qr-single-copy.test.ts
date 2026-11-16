import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * S14 (m6, m5): ONE `qrcode-generator` in the lockfile graph, and ONE package that depends on it: `@ferretry/std`, whose
 * `qr` is the encoder every half draws a code with (the app halves through the shell's `localQr`, the Catalogs CLI's
 * terminal blocks directly, since a CLI half may not import the shell). Access, Onboarding and Catalogs hold no
 * dependency or encoder of their own, so the workspace has one copy.
 */

const root = (relative: string): string => fileURLToPath(new URL(`../../../../../${relative}`, import.meta.url));
const lock = readFileSync(root('bun.lock'), 'utf8');

/** Every resolved `qrcode-generator@<version>` the lockfile records (a package entry, not a dependency range). */
const resolved = [...lock.matchAll(/"qrcode-generator@([^"]+)"/g)].map(match => match[1]);

const dependsOn = (manifest: string): boolean =>
  'qrcode-generator' in
  ((JSON.parse(readFileSync(root(manifest), 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {});

describe('S14 one qrcode-generator', () => {
  it('m5 the lockfile resolves exactly one version of it', () => {
    expect(resolved.length).toBeGreaterThan(0);
    expect(new Set(resolved).size).toBe(1);
  });

  it('m5 only the shared package depends on it: the shell, Access, Onboarding and Catalogs draw with its one encoder', () => {
    expect(dependsOn('packages/std/package.json')).toBe(true);
    expect(dependsOn('packages/app/package.json')).toBe(false);
    for (const plugin of ['catalogs', 'onboarding', 'access', 'connections', 'runtimes'])
      expect(dependsOn(`packages/plugins/${plugin}/package.json`)).toBe(false);
  });

  it('m6 neither Access nor the shell keeps an encoder of its own: the one is the shared package’s', () => {
    expect(existsSync(root('packages/plugins/access/app/lib/qr-code.ts'))).toBe(false);
    expect(existsSync(root('packages/app/src/ui/local-qr.ts'))).toBe(false);
    expect(existsSync(root('packages/std/src/qr.ts'))).toBe(true);
  });
});
