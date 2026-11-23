import { describe, expect, test } from 'bun:test';
import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import type { FerretPaneLimit } from '@ferretry/core-ferrets/contract';
import { WardenFleetFacts } from '../../daemon/adapters/fleet-facts.ts';
import type { LoginFactsApi, UsageHeadroomApi } from '../../contract/others.ts';

type Runtimes = Pick<RuntimesApi, 'catalog' | 'tools' | 'resolve'>;
type Catalog = Awaited<ReturnType<RuntimesApi['catalog']>>;

const row = (name: string, extra: { login?: string } = {}): Catalog[number] =>
  ({
    name,
    wrapper: `${name}-wrapper`,
    credential: { id: extra.login ?? `${name}-login`, store: 'ferretry' },
  }) as unknown as Catalog[number];

const NOW = '2026-11-14T10:00:00.000Z';

function facts(
  parts: {
    readonly runtimes?: Runtimes | undefined;
    readonly logins?: LoginFactsApi | undefined;
    readonly usage?: UsageHeadroomApi | undefined;
    readonly ferrets?: () => Promise<readonly FerretPaneLimit[]>;
  } = {},
) {
  const runtimes: Runtimes | undefined =
    'runtimes' in parts
      ? parts.runtimes
      : {
          catalog: async () => [row('alpha'), row('beta', { login: 'shared' }), row('delta')],
          tools: async () => [],
          resolve: async () => ({ ok: true }) as never,
        };
  return new WardenFleetFacts(
    () => runtimes,
    () => parts.logins,
    () => parts.usage,
    parts.ferrets ?? (async () => []),
    () => NOW,
  ).facts();
}

describe('the fleet facts the Warden moves a ferret from (the real adapter)', () => {
  test('refuses to choose a login blind when Runtimes is not there', async () => {
    await expect(facts({ runtimes: undefined })).rejects.toThrow('no login can be chosen');
  });

  test('reads the runtimes, the tools and the logins, and stamps the time', async () => {
    const result = await facts({
      logins: { list: async () => ({ logins: [{ id: 'alpha-login', status: { word: 'ready' } }] }) },
    });
    expect(result.runtimes.map(runtime => runtime.name)).toEqual(['alpha', 'beta', 'delta']);
    expect(result.credentials).toEqual([{ id: 'alpha-login', status: { word: 'ready' } }] as never);
    expect(result.tools).toEqual([]);
    expect(result.unlaunchable).toEqual({});
    expect(result.paneLimits?.size).toBe(0);
    expect(result.now).toBe(NOW);
  });

  test('a login that cannot be read is no login, never a ready one', async () => {
    const result = await facts({
      logins: {
        list: async () => {
          throw new Error('logins is down');
        },
      },
    });
    expect(result.credentials).toEqual([]);
  });

  test('a limit is the login’s: named directly, or through the runtime that hit it, first word kept', async () => {
    const result = await facts({
      usage: {
        headroomPercent: async () => undefined,
        paneLimits: async () => [
          { runtime: 'alpha', notice: 'usage window', spend: false, retryAt: 5 },
          { login: 'shared', notice: 'budget', spend: true },
          { runtime: 'nowhere', notice: 'lost', spend: false },
          { notice: 'nameless', spend: false },
        ],
      },
      ferrets: async () => [{ ferret: 'f1', login: 'alpha-login', notice: 'ferret saw it', spend: false } as never],
    });
    expect([...(result.paneLimits ?? [])]).toEqual([
      ['alpha-login', { notice: 'ferret saw it', spend: false }],
      ['shared', { notice: 'budget', spend: true }],
    ]);
  });

  test('a pane limit that cannot be read, or a usage provider without one, only ever adds nothing', async () => {
    const broken = await facts({
      usage: {
        headroomPercent: async () => undefined,
        paneLimits: async () => {
          throw new Error('usage is down');
        },
      },
      ferrets: async () => {
        throw new Error('ferrets is down');
      },
    });
    expect(broken.paneLimits?.size).toBe(0);
    const bare = await facts({ usage: { headroomPercent: async () => undefined } });
    expect(bare.paneLimits?.size).toBe(0);
  });

  test('a runtime the start would refuse is named unlaunchable with the start’s own sentence', async () => {
    const result = await facts({
      runtimes: {
        catalog: async () => [row('alpha'), row('beta'), row('gamma'), row('Not A Name'), row('delta')],
        tools: async () => [],
        resolve: async id =>
          id === 'alpha'
            ? ({ ok: false, refusal: 'unknown', sentence: 'no runtime alpha' } as never)
            : id === 'beta'
              ? ({ ok: false, refusal: 'not_signed_in', sentence: 'signed out' } as never)
              : ({ ok: true } as never),
      },
    });
    expect(result.unlaunchable).toEqual({
      'alpha-wrapper': 'no runtime alpha',
      'Not A Name-wrapper': 'Not A Name is not a runtime name',
    });
  });
});
