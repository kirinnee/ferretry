/**
 * The setup import's write of an MCP server (`put`): through the real daemon half and the test host's config service, which
 * checks the schema, refuses a raw secret and holds a loosening exactly as the kernel does. No network, no host home.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import type { ProfileComponentSource } from '@ferretry/plugin-runtimes/contract';
import daemon from '../../daemon/index.ts';
import manifest from '../../manifest.ts';

const HOOK = 'runtimes.components.mcp:components';

/** The daemon half unchanged, with the owner's component source kept so a test can call it as Runtimes does. */
async function world(config: Record<string, unknown> = {}) {
  let source: ProfileComponentSource | undefined;
  const spy = implementDaemon(manifest, {
    build(ctx) {
      const half = daemon.build?.(ctx);
      if (half === undefined) throw new Error('the MCP half did not build');
      source = (half.hooks as Record<string, unknown>)[HOOK] as ProfileComponentSource;
      return half;
    },
  });
  const h = await testHost({
    plugins: [spy],
    fakes: { ferrets: new FakeFerrets(), vault: new FakeVault(), sealed: new FakeSealedDocuments() },
    config: { mcp: config },
  });
  const owner = (): ProfileComponentSource => {
    if (source === undefined) throw new Error('no component source');
    return source;
  };
  return { h, owner };
}

const doc = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

describe('MCP owner writes an imported server', () => {
  test('a command server round-trips: put, then the owner reads back what was written', async () => {
    const { owner } = await world();
    const server = { command: 'github-mcp', args: ['--stdio'], env: { MODE: 'fast' } };

    const result = await owner().put?.('github', doc(server));

    expect(result?.ok).toBe(true);
    expect(await owner().list()).toEqual(['github']);
    expect(await owner().read('github')).toEqual(server);
  });

  test('a secret reference is judged by the kernel: with no owner at the call it is held, never in effect', async () => {
    const { owner } = await world();

    const result = await owner().put?.(
      'github',
      doc({ command: 'github-mcp', env: { TOKEN: '${secret:GITHUB_TOKEN}' } }),
    );

    expect(result).toEqual({ ok: true, held: true });
    expect(await owner().read('github')).toBeUndefined();
  });

  test('a url server is written', async () => {
    const { owner } = await world();

    const result = await owner().put?.('docs', doc({ url: 'https://docs.example.test/mcp' }));

    expect(result?.ok).toBe(true);
    expect(await owner().read('docs')).toEqual({ url: 'https://docs.example.test/mcp' });
  });

  test('a server whose program is not on this machine is still written (a missing command is no refusal)', async () => {
    const { owner } = await world();

    const result = await owner().put?.('ghost', doc({ command: '/no/such/program-anywhere' }));

    expect(result?.ok).toBe(true);
    expect(await owner().list()).toEqual(['ghost']);
  });

  test('an existing server is refused and left exactly as it was', async () => {
    const { owner } = await world({ github: { command: 'mine' } });

    const result = await owner().put?.('github', doc({ command: 'theirs', args: ['x'] }));

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain('mcp/github.yaml');
    expect(await owner().read('github')).toEqual({ command: 'mine' });
  });

  test('a second put of the same name is refused: the import never replaces what it just made', async () => {
    const { owner } = await world();
    await owner().put?.('once', doc({ command: 'first' }));

    const again = await owner().put?.('once', doc({ command: 'second' }));

    expect(again?.ok).toBe(false);
    expect(await owner().read('once')).toEqual({ command: 'first' });
  });

  test('a raw secret in the environment is refused by the config service, without echoing it', async () => {
    const { owner } = await world();
    const leaked = 'ghp_0123456789abcdef0123456789abcdef0123';

    const result = await owner().put?.('leaky', doc({ command: 'tool', env: { GITHUB_TOKEN: leaked } }));

    expect(result?.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(leaked);
    expect(await owner().list()).toEqual([]);
  });

  test('a document that is not a server is refused in a sentence and writes nothing', async () => {
    const { owner } = await world();

    const both = await owner().put?.('both', doc({ command: 'a', url: 'https://x.example.test/' }));
    const neither = await owner().put?.('neither', doc({ args: ['x'] }));
    const broken = await owner().put?.('broken', '{ not json');
    const list = await owner().put?.('list', '[]');
    const badName = await owner().put?.('Bad Name', doc({ command: 'a' }));

    for (const result of [both, neither, broken, list, badName]) expect(result?.ok).toBe(false);
    expect(await owner().list()).toEqual([]);
  });
});

describe('the harness id of an imported server', () => {
  test('a Claude-only server in a dual-harness import (Runtimes says "claude") is written with the schema\'s key', async () => {
    const { owner } = await world();

    const result = await owner().put?.('claude-only', doc({ command: 'tool', harness: 'claude' }));

    expect(result).toEqual({ ok: true });
    expect(await owner().read('claude-only')).toEqual({ command: 'tool', harness: 'claude-code' });
  });

  test('a Codex-only server keeps "codex", and the schema\'s own key is accepted as it is', async () => {
    const { owner } = await world();

    await owner().put?.('codex-only', doc({ command: 'tool', harness: 'codex' }));
    await owner().put?.('already-key', doc({ url: 'https://docs.example.test/mcp', harness: 'claude-code' }));

    expect(await owner().read('codex-only')).toEqual({ command: 'tool', harness: 'codex' });
    expect(await owner().read('already-key')).toEqual({
      url: 'https://docs.example.test/mcp',
      harness: 'claude-code',
    });
  });

  test('a harness word nobody knows is refused in a sentence and writes nothing', async () => {
    const { owner } = await world();

    const unknown = await owner().put?.('odd', doc({ command: 'tool', harness: 'vim' }));
    const inherited = await owner().put?.('proto', doc({ command: 'tool', harness: 'constructor' }));
    const notText = await owner().put?.('number', doc({ command: 'tool', harness: 7 }));

    for (const result of [unknown, inherited, notText]) expect(result?.ok).toBe(false);
    expect(await owner().list()).toEqual([]);
  });
});
