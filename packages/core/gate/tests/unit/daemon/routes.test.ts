import { describe, expect, test } from 'bun:test';
import type { CallContext } from '@ferretry/kernel/contract';
import manifest from '../../../manifest.ts';
import { gateRoutes, grantRoutes } from '../../../daemon/lib/routes.ts';
import { GrantError, type GrantFailure, type GrantService } from '../../../daemon/lib/grants/service.ts';
import { SecuritySettingsService } from '../../../daemon/lib/security/service.ts';
import { carried, local, request } from './support.ts';

const damaged = gateRoutes({
  audit: { recent: async () => ({ records: [], kept: [], keptTotal: 0, unreadable: 0 }) },
  security: new SecuritySettingsService({
    document: { read: () => ({ kind: 'damaged' }), write: async () => undefined },
    history: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
    clock: { now: () => '2026-11-07T12:00:00.000Z' },
    widenCommand: 'fy daemon security set',
  }),
});

const routes = gateRoutes({
  audit: { recent: async () => ({ records: [], kept: [], keptTotal: 0, unreadable: 3 }) },
  security: new SecuritySettingsService({
    document: { read: () => ({ kind: 'defaults' }), write: async () => undefined },
    history: { record: async () => undefined, recent: async () => ({ entries: [], unreadable: 0, truncated: false }) },
    clock: { now: () => '2026-11-07T12:00:00.000Z' },
    widenCommand: 'fy daemon security set',
  }),
});

const call = (
  query: Record<string, string> = {},
  body?: unknown,
  onHost = true,
  text: () => Promise<string> = async () => JSON.stringify(body),
): CallContext => {
  const base = request({ arrival: onHost ? local(true) : carried() });
  return {
    request: { ...base, query: new Map(Object.entries(query).map(([name, value]) => [name, [value]])), text },
    params: {},
    actor: onHost ? 'admin-cli' : 'device:phone',
    ...(onHost ? { credential: { tokenClass: 'admin' } } : {}),
  } as unknown as CallContext;
};
const json = (response: { readonly body: string }) => JSON.parse(response.body) as Record<string, unknown>;
const routeOf = (key: string) => manifest.actions.routes.find(route => route.key === key);

describe('Gate routes', () => {
  test('R-0048 GET /v1/audit is a no-store person read and reports unreadable lines', async () => {
    expect(routeOf('GET /v1/audit')).toMatchObject({ minimum: 'operator', caller: 'person', noStore: true });
    const response = await routes['GET /v1/audit'](call({ limit: '5' }));
    expect(response.status).toBe(200);
    expect(json(response)).toEqual({ records: [], kept: [], keptTotal: 0, unreadable: 3 });
    await expect(routes['GET /v1/audit'](call({ limit: 'many' }))).rejects.toMatchObject({ status: 400 });
  });

  test('R-0048 GET /v1/audit pages the security changes from the offset it is asked for, and refuses one that is not a whole number', async () => {
    const asked: Array<{ limit: number; keptOffset: number }> = [];
    const paged = gateRoutes({
      audit: {
        recent: async (limit, keptOffset) => {
          asked.push({ limit, keptOffset });
          return { records: [], kept: [], keptTotal: 40, unreadable: 0 };
        },
      },
      security: new SecuritySettingsService({
        document: { read: () => ({ kind: 'defaults' }), write: async () => undefined },
        history: {
          record: async () => undefined,
          recent: async () => ({ entries: [], unreadable: 0, truncated: false }),
        },
        clock: { now: () => '2026-11-07T12:00:00.000Z' },
        widenCommand: 'fy daemon security set',
      }),
    });
    const response = await paged['GET /v1/audit'](call({ limit: '5', keptOffset: '20' }));
    expect(response.status).toBe(200);
    expect(asked).toEqual([{ limit: 5, keptOffset: 20 }]);
    await expect(paged['GET /v1/audit'](call({ keptOffset: '-1' }))).rejects.toMatchObject({ status: 400 });
    await expect(paged['GET /v1/audit'](call({ keptOffset: 'later' }))).rejects.toMatchObject({ status: 400 });
    expect(asked).toHaveLength(1);
  });

  test('R-0133 GET /v1/security is readable while locked, and says who may widen', async () => {
    expect(routeOf('GET /v1/security')).toMatchObject({ unlockExempt: true, noStore: true });
    expect(json(await routes['GET /v1/security'](call()))).toMatchObject({ source: 'defaults', mayWiden: true });
    expect(json(await routes['GET /v1/security'](call({}, undefined, false)))).toMatchObject({ mayWiden: false });
  });

  test('R-0224 PATCH /v1/security refuses a remote loosening with the machine command and an unparsable body as 422', async () => {
    expect(routeOf('PATCH /v1/security')).toMatchObject({ minimum: 'operator', caller: 'person' });
    await expect(routes['PATCH /v1/security'](call({}, { nope: 1 }))).rejects.toMatchObject({ status: 422 });
    const refused = routes['PATCH /v1/security'](call({}, { idleExpiryDays: 90 }, false));
    await expect(refused).rejects.toMatchObject({ status: 403 });
    await expect(refused).rejects.toThrow('fy daemon security set');
  });

  test('V-0238 the security verb group is declared beside show and set', () => {
    expect(manifest.actions.cli.map(verb => verb.verb)).toContain('daemon security');
  });
});

describe('Gate routes refuse a body before they read it into a change', () => {
  test('a body over the bound is 413, and one that is not JSON is 400', async () => {
    const tooLarge = call({}, undefined, true, async () => {
      throw new Error('the body is past the bound');
    });
    await expect(routes['PATCH /v1/security'](tooLarge)).rejects.toMatchObject({ status: 413, code: 'body_too_large' });
    const notJson = call({}, undefined, true, async () => 'this is not json');
    await expect(routes['PATCH /v1/security'](notJson)).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
  });

  test('R-0224 a remote caller is told a damaged security document is the machine’s to repair (503)', async () => {
    await expect(damaged['PATCH /v1/security'](call({}, { idleExpiryDays: 1 }, false))).rejects.toMatchObject({
      status: 503,
      code: 'security_unavailable',
    });
  });
});

describe('Gate grant routes answer each refusal the service raises with its own status', () => {
  const failing = (failure: GrantFailure): GrantService =>
    ({
      history: async () => {
        throw new GrantError(failure, `the ${failure} words`);
      },
      patch: async () => {
        throw new GrantError(failure, `the ${failure} words`);
      },
      view: () => ({ capabilities: [] }),
    }) as unknown as GrantService;
  const withPresentation = (): CallContext =>
    ({
      ...call({}, { fleet: { use: false } }),
      presentation: { local: true, adminToken: true, actor: 'admin-cli', stepUp: false },
    }) as unknown as CallContext;
  const expected: Readonly<Record<GrantFailure, readonly [number, string]>> = {
    invalid: [400, 'invalid_request'],
    forbidden: [403, 'grant_forbidden'],
    'device-not-granted': [403, 'grant_device_not_granted'],
    'step-up-required': [403, 'grant_step_up_required'],
    unavailable: [503, 'grants_undetermined'],
  };

  for (const [failure, [status, code]] of Object.entries(expected) as [GrantFailure, readonly [number, string]][])
    test(`G123 a ${failure} refusal is ${String(status)} ${code}, on the history and on a change`, async () => {
      const routes = grantRoutes(failing(failure));
      await expect(routes['GET /v1/grants/audit']()).rejects.toMatchObject({ status, code });
      await expect(routes['PATCH /v1/grants'](withPresentation())).rejects.toMatchObject({
        status,
        code,
        message: `the ${failure} words`,
      });
    });

  test('a failure that is not a grant refusal is not dressed up as one', async () => {
    const broken = grantRoutes({
      history: async () => {
        throw new TypeError('the journal exploded');
      },
    } as unknown as GrantService);
    await expect(broken['GET /v1/grants/audit']()).rejects.toThrow('the journal exploded');
  });

  test('a call that admission gave no presentation is refused, never guessed at', async () => {
    const routes = grantRoutes(failing('invalid'));
    await expect(routes['GET /v1/grants'](call())).rejects.toMatchObject({ status: 500 });
  });
});
