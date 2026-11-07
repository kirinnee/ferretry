/** kernel.contract: a plugin reads its OWN effective contract hash and nothing about any other package (§9.6). */
import { describe, expect, test } from 'bun:test';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

const ports: Record<string, { hash(): string }> = {};
const half = (id: string, seen: Record<string, () => string>) =>
  implementDaemon(definePlugin({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: [] }), {
    build: ctx => {
      seen[id] = () => ctx.kernel.contract.hash();
      ports[id] = ctx.kernel.contract;
      return {};
    },
  });

describe('kernel.contract.hash()', () => {
  test('each plugin reads only its own hash: the port takes no id, so another package’s hash is out of reach', async () => {
    const seen: Record<string, () => string> = {};
    const host = await testHost({
      plugins: [half('alpha', seen), half('beta', seen)],
      contractHash: id => `hash-of-${id}`,
    });
    expect(seen['alpha']?.()).toBe('hash-of-alpha');
    expect(seen['beta']?.()).toBe('hash-of-beta');
    expect(Object.keys(ports['alpha'] ?? {})).toEqual(['hash']);
    expect(ports['alpha']?.hash.length).toBe(0);
    await host.stop();
  });

  test('a host given no hashes answers `unhashed`, as GET /v1/plugins does', async () => {
    const seen: Record<string, () => string> = {};
    const host = await testHost({ plugins: [half('alpha', seen)] });
    expect(seen['alpha']?.()).toBe('unhashed');
    await host.stop();
  });
});
