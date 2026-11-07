import { describe, expect, test } from 'bun:test';
import type { CallContext } from '@ferretry/kernel/contract';
import manifest from '../../../manifest.ts';
import { gateRoutes } from '../../../daemon/lib/routes.ts';
import { SecuritySettingsService } from '../../../daemon/lib/security/service.ts';
import { carried, local, request } from './support.ts';

const routes = gateRoutes({
  audit: { recent: async () => ({ records: [], kept: [], keptTotal: 0, unreadable: 3 }) },
  security: new SecuritySettingsService({
    document: { read: () => ({ kind: 'defaults' }), write: async () => undefined },
    audit: async () => undefined,
    clock: { now: () => '2026-11-07T12:00:00.000Z' },
    widenCommand: 'fy daemon security set',
  }),
});

const call = (query: Record<string, string> = {}, body?: unknown, onHost = true): CallContext => {
  const base = request({ arrival: onHost ? local(true) : carried() });
  return {
    request: { ...base, query: new Map(Object.entries(query)), text: async () => JSON.stringify(body) },
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
