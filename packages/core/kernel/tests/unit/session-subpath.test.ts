import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const subpath = '@ferretry/kernel/session';

describe('@ferretry/kernel/session', () => {
  test('resolves the real package subpath and exports the existing sealed-session codec', async () => {
    const resolved = import.meta.resolve(subpath);
    expect(resolved).toBe(new URL('../../session.ts', import.meta.url).href);
    const session = await import(subpath);
    for (const name of [
      'startClientHandshake',
      'completeClientHandshake',
      'answerClientHandshake',
      'openChannel',
      'sealRecord',
      'openRecord',
      'encodeFrame',
      'decodeFrame',
      'encodeDaemonRecord',
      'decodeClientRecord',
      'deviceAuthMessage',
      'memberAuthMessage',
      'WebCryptoSessionCrypto',
    ])
      expect(typeof session[name]).toBe('function');
    expect(session.createSessionLayer).toBeUndefined();
    expect(session.createIdentitySigner).toBeUndefined();
  });

  test('the complete runtime import graph is browser safe, including external dependencies', async () => {
    const entry = import.meta.resolve(subpath);
    const seen = new Set<string>();
    const scanner = new Bun.Transpiler({ loader: 'ts' });
    const visit = async (url: string): Promise<void> => {
      expect(url.startsWith('file:')).toBe(true);
      if (seen.has(url)) return;
      seen.add(url);
      const source = await Bun.file(fileURLToPath(url)).text();
      // Inspect executable code only: comments and type-only references do not load a host into the browser.
      const executable = scanner.transformSync(source);
      expect(executable).not.toMatch(/\b(?:Bun|process|Buffer|Deno)\s*(?:\?\.|\.)|\brequire\s*\(/u);
      for (const { path } of scanner.scanImports(source)) {
        expect(path).not.toMatch(/^(?:node:|bun:)/u);
        const dependency = import.meta.resolve(path, url);
        await visit(dependency);
      }
    };
    await visit(entry);
    expect(seen.size).toBeGreaterThan(20);
    for (const url of seen) {
      const path = fileURLToPath(url);
      if (path.includes('/packages/core/kernel/')) {
        expect(
          path.endsWith('/kernel/session.ts') ||
            path.includes('/kernel/host/session/wire/') ||
            path.endsWith('/kernel/host/session/adapters/web-crypto.ts') ||
            path.includes('/kernel/contract/'),
        ).toBe(true);
      }
    }
    const bundle = await Bun.build({ entrypoints: [fileURLToPath(entry)], target: 'browser' });
    expect(bundle.success).toBe(true);
  });
});
