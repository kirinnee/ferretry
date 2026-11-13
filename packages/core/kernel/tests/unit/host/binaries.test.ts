/** XX kernel.identity.binaries: the product's two binary names, from the repo's single source, never a literal. */
import { describe, expect, test } from 'bun:test';
import kernelPackage from '../../../package.json' with { type: 'json' };
import { CLIENT_BINARY } from '../../../src/generated/client-binary.ts';
import { PRODUCT_BINARIES } from '../../../host/binaries.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

describe('XX kernel.identity.binaries', () => {
  test('the client is the generated client name (scripts/gen test pins it to packages/cli/package.json), the daemon the first bin of the kernel package', () => {
    expect(PRODUCT_BINARIES.client).toBe(CLIENT_BINARY);
    expect(PRODUCT_BINARIES.daemon).toBe(Object.keys(kernelPackage.bin)[0] ?? '');
    expect(Object.isFrozen(PRODUCT_BINARIES)).toBe(true);
  });

  test('a plugin reads both names off kernel.identity', async () => {
    let seen: unknown;
    const reader = implementDaemon(
      definePlugin({ id: 'reader', title: 'Reader', version: '5.0.0', api: 5, core: false, kinds: [] }),
      {
        build: ({ kernel }) => {
          seen = kernel.identity.binaries;
          return {};
        },
      },
    );
    const host = await testHost({ plugins: [reader] });
    expect(seen).toEqual(PRODUCT_BINARIES);
    await host.stop();
  });
});
