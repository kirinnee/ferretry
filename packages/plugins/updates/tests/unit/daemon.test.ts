import { describe, expect, test } from 'bun:test';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import { device, ferret, testHost } from '@ferretry/kernel/testing';
import { DAEMON_UPDATE_CODES, DaemonUpdateViewSchema, UPDATE_HOST_CODES } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import type { ConfigDoor, DoorResult } from '../../daemon/lib/config-door.ts';
import { updateRoutes } from '../../daemon/lib/routes.ts';
import { DaemonUpdateService } from '../../daemon/lib/service.ts';

const call = (body?: unknown): CallContext =>
  ({
    request: { text: async () => JSON.stringify(body ?? {}) } as unknown as ApiRequest,
    params: new Map(),
  }) as CallContext;
const json = (response: { body: string }): any => JSON.parse(response.body);

const LATEST = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };

function serviceWith(
  launched: string[],
  midTurn = 0,
  checks = true,
): DaemonUpdateService {
  const store = new Map<string, unknown>();
  return new DaemonUpdateService({
    current: '4.28.0',
    product: 'ferretry',
    clientName: 'fy',
    install: {
      facts: async () => ({
        product: 'ferretry',
        compiled: true,
        launchedPath: '/home/kirin/.local/bin/fyd',
        resolvedPath: '/home/kirin/.local/bin/fyd',
        homeDirectory: '/home/kirin',
        platform: 'linux',
      }),
    },
    releases: { latest: async () => ({ kind: 'ok', release: LATEST as never }) },
    documents: {
      readLatest: async () => store.get('latest') as never,
      writeLatest: async check => void store.set('latest', check),
      readReport: async () => undefined,
      removeReport: async () => undefined,
    },
    autoInstall: { current: () => false },
    launcher: {
      launch: async target => {
        launched.push(target);
        return { kind: 'started' };
      },
    },
    activity: { midTurn: async () => midTurn },
    clock: { now: () => Date.parse('2026-10-18T10:00:00.000Z') },
    checks,
  });
}

describe('updates on the test host', () => {
  test('without the host seam the routes say why, instead of guessing a version', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { ferrets: { list: async () => [] } } });
    const read = await host.request('GET', '/v1/daemon/update', { as: device('phone') });
    expect([read.status, read.json<{ code: string }>().code]).toEqual([503, UPDATE_HOST_CODES.hostUnavailable]);
    await host.stop();
  });

  test('a ferret cannot start an update or change how the machine updates', async () => {
    const host = await testHost({ plugins: [daemon], fakes: { ferrets: { list: async () => [] } } });
    const body = { target: '4.29.0', when: 'now' };
    expect((await host.request('POST', '/v1/daemon/update', { body, as: ferret('F1') })).status).toBe(403);
    expect(
      (await host.request('PATCH', '/v1/daemon/update/settings', { body: { autoInstall: true }, as: ferret('F1') }))
        .status,
    ).toBe(403);
    await host.stop();
  });
});

describe('update routes', () => {
  test('the view parses, and starting an update answers 202 with it', async () => {
    const launched: string[] = [];
    const service = serviceWith(launched);
    await service.tick();
    const routes = updateRoutes(service, undefined);
    const view = json(await routes['GET /v1/daemon/update']());
    expect(DaemonUpdateViewSchema.parse(view).available).toBe(true);
    const started = await routes['POST /v1/daemon/update'](call({ target: '4.29.0', when: 'now' }));
    expect([started.status, json(started).job.state]).toEqual([202, 'running']);
    expect(launched).toEqual(['4.29.0']);
  });

  test('a refusal is a 409 carrying its code', async () => {
    const service = serviceWith([]);
    await service.tick();
    const routes = updateRoutes(service, undefined);
    const stale = await routes['POST /v1/daemon/update'](call({ target: '4.28.5', when: 'now' }));
    expect([stale.status, json(stale).code]).toEqual([409, DAEMON_UPDATE_CODES.staleTarget]);
  });

  test('a body that is not the start request is refused, whatever else it carries', async () => {
    const routes = updateRoutes(serviceWith([]), undefined);
    await expect(
      routes['POST /v1/daemon/update'](call({ target: '4.29.0', when: 'now', confirmMidTurn: true })),
    ).rejects.toMatchObject({ status: 422 });
  });

  test('turning installing on goes through the config door: applied is 200, held is 202 with the sentences', async () => {
    const calls: unknown[] = [];
    const door = (result: DoorResult): ConfigDoor => ({
      write: async (_def, _name, edit) => {
        calls.push(edit);
        return result;
      },
      remove: async () => result,
    });
    const service = serviceWith([]);
    const applied = await updateRoutes(service, door({ kind: 'applied' }))['PATCH /v1/daemon/update/settings'](
      call({ autoInstall: true }),
    );
    expect([applied.status, calls]).toEqual([200, [{ patch: { autoInstall: true } }]]);
    const held = await updateRoutes(
      service,
      door({ kind: 'held', sentences: ['updates install automatically when idle'] }),
    )['PATCH /v1/daemon/update/settings'](call({ autoInstall: true }));
    expect([held.status, json(held).held]).toEqual([202, ['updates install automatically when idle']]);
    const none = await updateRoutes(service, undefined)['PATCH /v1/daemon/update/settings'](call({ autoInstall: true }));
    expect([none.status, json(none).code]).toEqual([503, UPDATE_HOST_CODES.configUnavailable]);
  });
});
