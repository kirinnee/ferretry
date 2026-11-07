import { describe, expect, test } from 'bun:test';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import { device, ferret, owner, testHost } from '@ferretry/kernel/testing';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { DAEMON_UPDATE_CODES, DaemonUpdateViewSchema, UPDATE_HOST_CODES } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import type { ConfigDoor, DoorResult } from '../../daemon/lib/config-door.ts';
import { fakeHost } from './host.ts';
import { updateRoutes } from '../../daemon/lib/routes.ts';
import { DaemonUpdateService } from '../../daemon/lib/service.ts';

const call = (body?: unknown, standing: object = {}): CallContext =>
  ({
    request: { text: async () => JSON.stringify(body ?? {}) } as unknown as ApiRequest,
    params: new Map(),
    ...standing,
  }) as CallContext;
const json = (response: { body: string }): any => JSON.parse(response.body);

const LATEST = { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' };

function serviceWith(launched: string[], midTurn = 0, checks = true): DaemonUpdateService {
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

  test('with the kernel update host the view is built from its release, and the install facts come from its executable (a start is refused as not self-updatable, not as an unavailable host)', async () => {
    const { port } = fakeHost({ release: '4.28.0' });
    const host = await testHost({ plugins: [daemon], updateHost: port, fakes: { ferrets: { list: async () => [] } } });
    const read = await host.request('GET', '/v1/daemon/update', { as: device('phone') });
    expect(read.status).toBe(200);
    expect(read.json<{ current: string }>().current).toBe('4.28.0');
    const body = { target: '4.29.0', when: 'now' };
    const start = await host.request('POST', '/v1/daemon/update', { body, as: owner() });
    expect([start.status, start.json<{ code: string }>().code]).toEqual([409, DAEMON_UPDATE_CODES.notSelfUpdatable]);
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
    const none = await updateRoutes(service, undefined)['PATCH /v1/daemon/update/settings'](
      call({ autoInstall: true }),
    );
    expect([none.status, json(none).code]).toEqual([503, UPDATE_HOST_CODES.configUnavailable]);
  });
});

/**
 * A remote device as Gate admits it: governed, holding a fresh passkey proof until a route spends it. Each request reads
 * the standing again, as Gate stamps a new one per call, so a spent proof is gone on the next.
 */
function remoteDevice(fresh: boolean) {
  const state = { fresh, spent: 0 };
  const standing = () => {
    const base = deviceStanding('phone');
    return {
      ...base,
      governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
      presentation: { local: false, adminToken: false, actor: 'device:phone', stepUp: false, freshStepUp: state.fresh },
      spendFreshStepUp: () => {
        state.spent += 1;
        state.fresh = false;
      },
    };
  };
  return { state, standing };
}

/** The owner at the machine: ungoverned, and a spend would be a bug. */
function atMachine() {
  const state = { spent: 0 };
  return {
    state,
    standing: {
      ...ownerStanding(),
      spendFreshStepUp: () => {
        state.spent += 1;
      },
    },
  };
}

function recordingDoor(result: DoorResult = { kind: 'applied' }) {
  const writes: unknown[] = [];
  const door: ConfigDoor = {
    write: async (_def, _name, edit) => {
      writes.push(edit);
      return result;
    },
    remove: async () => result,
  };
  return { writes, door };
}

const START = { target: '4.29.0', when: 'now' };

describe('starting an update is the owner’s act (G22)', () => {
  async function ready(launched: string[]) {
    const service = serviceWith(launched);
    await service.tick();
    return updateRoutes(service, undefined)['POST /v1/daemon/update'];
  }

  test('G22 a ferret is refused 403 and no update starts', async () => {
    const launched: string[] = [];
    const start = await ready(launched);
    await expect(start(call(START, ferretStanding('F1' as never)))).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(launched).toEqual([]);
  });

  test('G22 a remote device without a fresh passkey is asked for one (fleet.configure) and no update starts', async () => {
    const launched: string[] = [];
    const start = await ready(launched);
    const answer = await start(call(START, remoteDevice(false).standing()));
    expect([answer.status, json(answer)]).toEqual([
      403,
      {
        error: 'to update this machine from this device, confirm with a passkey',
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'fleet', axis: 'configure' },
      },
    ]);
    expect(launched).toEqual([]);
  });

  test('G22 with a fresh passkey the update starts and the proof is spent, so the next call is asked again', async () => {
    const launched: string[] = [];
    const start = await ready(launched);
    const phone = remoteDevice(true);
    const first = await start(call(START, phone.standing()));
    expect([first.status, launched, phone.state.spent]).toEqual([202, ['4.29.0'], 1]);
    const second = await start(call(START, phone.standing()));
    expect([second.status, json(second).code, launched]).toEqual([403, STEP_UP_REQUIRED_CODE, ['4.29.0']]);
  });

  test('G22 the owner at the machine starts an update with no passkey, and nothing is spent', async () => {
    const launched: string[] = [];
    const start = await ready(launched);
    const owner = atMachine();
    const answer = await start(call(START, owner.standing));
    expect([answer.status, launched, owner.state.spent]).toEqual([202, ['4.29.0'], 0]);
  });

  test('G22 a refused update does not spend the passkey proof', async () => {
    const launched: string[] = [];
    const start = await ready(launched);
    const phone = remoteDevice(true);
    const stale = await start(call({ target: '4.28.5', when: 'now' }, phone.standing()));
    expect([stale.status, json(stale).code, phone.state.spent]).toEqual([409, DAEMON_UPDATE_CODES.staleTarget, 0]);
  });
});

describe('turning automatic install on is the owner’s act; turning it off is never gated (G22)', () => {
  const patch = (door: ConfigDoor) => updateRoutes(serviceWith([]), door)['PATCH /v1/daemon/update/settings'];

  test('G22 a ferret is refused 403 either way, and nothing is written', async () => {
    const { writes, door } = recordingDoor();
    for (const autoInstall of [true, false])
      await expect(patch(door)(call({ autoInstall }, ferretStanding('F1' as never)))).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    expect(writes).toEqual([]);
  });

  test('G22 a remote device without a fresh passkey cannot turn it on, and nothing is written', async () => {
    const { writes, door } = recordingDoor();
    const answer = await patch(door)(call({ autoInstall: true }, remoteDevice(false).standing()));
    expect([answer.status, json(answer).code, json(answer).demand]).toEqual([
      403,
      STEP_UP_REQUIRED_CODE,
      { capability: 'fleet', axis: 'configure' },
    ]);
    expect(writes).toEqual([]);
  });

  test('G22 with a fresh passkey it turns on and the proof is spent, so the next call is asked again', async () => {
    const { writes, door } = recordingDoor();
    const phone = remoteDevice(true);
    const first = await patch(door)(call({ autoInstall: true }, phone.standing()));
    expect([first.status, writes, phone.state.spent]).toEqual([200, [{ patch: { autoInstall: true } }], 1]);
    const second = await patch(door)(call({ autoInstall: true }, phone.standing()));
    expect([second.status, json(second).code, writes.length]).toEqual([403, STEP_UP_REQUIRED_CODE, 1]);
  });

  test('G22 turning it off needs no passkey and spends nothing', async () => {
    const { writes, door } = recordingDoor();
    const phone = remoteDevice(false);
    const answer = await patch(door)(call({ autoInstall: false }, phone.standing()));
    expect([answer.status, writes, phone.state.spent]).toEqual([200, [{ patch: { autoInstall: false } }], 0]);
  });

  test('G22 the owner at the machine turns it on with no passkey, and nothing is spent', async () => {
    const { writes, door } = recordingDoor();
    const owner = atMachine();
    const answer = await patch(door)(call({ autoInstall: true }, owner.standing));
    expect([answer.status, writes.length, owner.state.spent]).toEqual([200, 1, 0]);
  });

  test('G22 a refused write does not spend the passkey proof', async () => {
    const { door } = recordingDoor({ kind: 'refused', reason: 'not allowed', issues: [] });
    const phone = remoteDevice(true);
    const answer = await patch(door)(call({ autoInstall: true }, phone.standing()));
    expect([answer.status, phone.state.spent]).toEqual([422, 0]);
  });
});
