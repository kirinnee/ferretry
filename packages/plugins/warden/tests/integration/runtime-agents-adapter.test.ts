import { describe, expect, test } from 'bun:test';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import { runtimesWardenAgents } from '../../daemon/adapters/runtime-agents.ts';

type Catalog = Awaited<ReturnType<RuntimesApi['catalog']>>;
type Name = Awaited<ReturnType<RuntimesApi['default']>>;

const runtime = (name: string, extra: { agent?: boolean; off?: boolean } = {}): Catalog[number] =>
  ({
    id: `${name}-id`,
    name,
    wrapper: name,
    agent: extra.agent ?? true,
    ...(extra.off === true ? { disabled: { reason: 'off' } } : {}),
  }) as unknown as Catalog[number];

const CATALOG = [
  runtime('claude-default'),
  runtime('shell-helper', { agent: false }),
  runtime('claude-old', { off: true }),
];

const api = (
  catalog: () => Promise<Catalog>,
  fallback: () => Promise<Name>,
): Pick<RuntimesApi, 'catalog' | 'default'> => ({
  catalog,
  default: fallback,
});

describe('the logins the Warden may investigate on, read from Runtimes (the real adapter)', () => {
  test('lists the agent runtimes by name, a switched-off one still named but not available', async () => {
    const agents = runtimesWardenAgents(() =>
      api(
        async () => CATALOG,
        async () => 'claude-default' as Name,
      ),
    );
    expect(await agents.installed()).toEqual(['claude-default']);
    expect(await agents.defaultRuntime()).toBe('claude-default');
    expect(await agents.currentName('claude-default-id')).toBe('claude-default');
  });

  test('says nothing, and offers no default, while Runtimes is not there', async () => {
    const agents = runtimesWardenAgents(() => undefined);
    expect(await agents.installed()).toEqual([]);
    expect(await agents.defaultRuntime()).toBeUndefined();
  });

  test('offers no default that is a human runtime, switched off, unknown, unset, or unreadable', async () => {
    const of = (fallback: () => Promise<Name>, catalog: () => Promise<Catalog> = async () => CATALOG) =>
      runtimesWardenAgents(() => api(catalog, fallback)).defaultRuntime();
    expect(await of(async () => 'shell-helper' as Name)).toBeUndefined();
    expect(await of(async () => 'claude-old' as Name)).toBeUndefined();
    expect(await of(async () => 'elsewhere' as Name)).toBeUndefined();
    expect(await of(async () => undefined)).toBeUndefined();
    expect(
      await of(async () => {
        throw new Error('the default could not be read');
      }),
    ).toBeUndefined();
    expect(
      await of(
        async () => 'claude-default' as Name,
        async () => {
          throw new Error('the catalog was refused');
        },
      ),
    ).toBeUndefined();
  });
});
