/** kernel.contract: a plugin reads its OWN contract hash and nothing about any other package (§9.6). */
import { describe, expect, test } from 'bun:test';
import { definePlugin, implementDaemon, memberRoute } from '../../../manifest/index.ts';
import { testHost } from '../../../testing/index.ts';

type Reader = { hash(surface?: 'member'): string };
const ports: Record<string, Reader> = {};

const plain = (id: string) => definePlugin({ id, title: id, version: '5.0.0', api: 5, core: false, kinds: [] });
const withMembers = (id: string) =>
  definePlugin({
    id,
    title: id,
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    actions: {
      memberRoutes: [
        memberRoute('GET /v1/shared/ping', {
          member: 'unlocked',
          noStore: true,
          audit: { skip: 'a read' },
          guard: { none: 'no pane or vault text' },
        }),
      ],
    },
  });

const noMemberAnswer = {
  'GET /v1/shared/ping': async () => ({ status: 200, headers: new Map<string, string>(), body: '' }),
};

const half = (id: string, seen: Record<string, () => string>, members = false) => {
  const note = (ctx: { kernel: { contract: Reader } }): void => {
    seen[id] = () => ctx.kernel.contract.hash();
    ports[id] = ctx.kernel.contract;
  };
  return members
    ? implementDaemon(withMembers(id), {
        build: ctx => {
          note(ctx);
          return { memberRoutes: noMemberAnswer };
        },
      })
    : implementDaemon(plain(id), {
        build: ctx => {
          note(ctx);
          return {};
        },
      });
};

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
    // One optional argument, the surface — never an id: a package name passed in its place is not read as one.
    expect(ports['alpha']?.hash.length).toBeLessThanOrEqual(1);
    expect(ports['alpha']?.hash('beta' as never)).toBe('hash-of-alpha');
    await host.stop();
  });

  test('a host given no hashes answers `unhashed`, as GET /v1/plugins does', async () => {
    const seen: Record<string, () => string> = {};
    const host = await testHost({ plugins: [half('alpha', seen)] });
    expect(seen['alpha']?.()).toBe('unhashed');
    await host.stop();
  });

  test('hash(`member`) asks for the member surface of its own plugin, and only that, still with no id', async () => {
    const asked: Array<[string, string | undefined]> = [];
    const seen: Record<string, () => string> = {};
    const host = await testHost({
      plugins: [half('alpha', seen, true), half('beta', seen, true)],
      contractHash: (id, surface) => {
        asked.push([id, surface]);
        return surface === 'member' ? `member-of-${id}` : `effective-of-${id}`;
      },
    });
    expect(ports['alpha']?.hash('member')).toBe('member-of-alpha');
    expect(ports['beta']?.hash('member')).toBe('member-of-beta');
    expect(ports['alpha']?.hash()).toBe('effective-of-alpha');
    expect(asked.at(-3)).toEqual(['alpha', 'member']);
    await host.stop();
  });

  test('a plugin with no member routes has no member hash: the call throws rather than answer another surface', async () => {
    const seen: Record<string, () => string> = {};
    const host = await testHost({ plugins: [half('alpha', seen)], contractHash: id => `hash-of-${id}` });
    expect(() => ports['alpha']?.hash('member')).toThrow('alpha declares no member routes');
    await host.stop();
  });

  test('a member plugin on a host given no hashes answers `unhashed` for the member surface too', async () => {
    const seen: Record<string, () => string> = {};
    const host = await testHost({ plugins: [half('alpha', seen, true)] });
    expect(ports['alpha']?.hash('member')).toBe('unhashed');
    await host.stop();
  });
});
