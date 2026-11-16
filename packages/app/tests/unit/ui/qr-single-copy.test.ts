import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * S14 (m6, m5): ONE `qrcode-generator` in the lockfile graph. The shell's `localQr` is the encoder every app half
 * draws a code with; Onboarding and Access hold no dependency of their own, and Catalogs keeps one only for its CLI's
 * terminal QR (`cli/adapters/qr.ts`, a pending line names it). Whatever package asks for it, the lockfile resolves a
 * single version, so the workspace has one copy of the encoder.
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

  it('m5 only the shell and the Catalogs CLI depend on it: Onboarding and Access draw with the shell’s localQr or their own encoder', () => {
    expect(dependsOn('packages/app/package.json')).toBe(true);
    expect(dependsOn('packages/plugins/catalogs/package.json')).toBe(true);
    for (const plugin of ['onboarding', 'access', 'connections', 'runtimes'])
      expect(dependsOn(`packages/plugins/${plugin}/package.json`)).toBe(false);
  });
});
