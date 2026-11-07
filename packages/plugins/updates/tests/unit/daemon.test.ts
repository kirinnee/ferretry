import { describe, expect, test } from 'bun:test';
import { type ApiRequest, BodyTooLargeError, type CallContext } from '@ferretry/kernel/contract';
import { device, ferret, owner, testHost } from '@ferretry/kernel/testing';
import { STEP_UP_REQUIRED_CODE } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { DAEMON_UPDATE_CODES, DaemonUpdateViewSchema, UPDATE_HOST_CODES } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import type { ConfigDoor, DoorResult } from '../../daemon/lib/config-door.ts';
import { updateHostUsable } from '../../daemon/lib/host.ts';
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
/** A call carrying exactly `text`, read the way every arrival reads one: over the route's bound is a 413. */
const rawCall = (text: string): CallContext =>
  ({
    request: {
      text: async (limit?: number) => {
        if (limit !== undefined && new TextEncoder().encode(text).byteLength > limit)
          throw new BodyTooLargeError(limit);
        return text;
      },
    } as unknown as ApiRequest,
    params: new Map(),
  }) as CallContext;

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
    ).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  test('both bodies answer today’s refusals: 413 body_too_large, 400 invalid_json, 400 invalid_request', async () => {
    const launched: string[] = [];
    const { writes, door } = recordingDoor();
    const routes = updateRoutes(serviceWith(launched), door);
    for (const route of [routes['POST /v1/daemon/update'], routes['PATCH /v1/daemon/update/settings']]) {
      await expect(route(rawCall(JSON.stringify({ target: 'x'.repeat(5 * 1024) })))).rejects.toMatchObject({
        status: 413,
        code: 'body_too_large',
      });
      await expect(route(rawCall('not json'))).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
      await expect(route(rawCall(''))).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
      await expect(route(rawCall('{"autoInstall":"yes","target":1}'))).rejects.toMatchObject({
        status: 400,
        code: 'invalid_request',
      });
    }
    expect([launched, writes]).toEqual([[], []]);
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
 * A remote device as Gate admits it: governed, holding a fresh passkey proof until a route claims it. Each request
 * reads the standing again, as Gate stamps a new one per call — and `freshStepUp` is that admission's SNAPSHOT, so two
 * standings taken before either request runs both say fresh, as two requests racing on one proof would. The claim is
 * atomic, as Access's is: of two claims on one proof exactly one is answered `true`. `spent` counts every claim and
 * every spend, so a route that took the proof twice would show 2.
 */
function remoteDevice(fresh: boolean) {
  const state = { fresh, spent: 0 };
  const standing = () => {
    const base = deviceStanding('phone');
    return {
      ...base,
      governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) },
      presentation: { local: false, adminToken: false, actor: 'device:phone', stepUp: false, freshStepUp: state.fresh },
      claimFreshStepUp: () => {
        if (!state.fresh) return false;
        state.fresh = false;
        state.spent += 1;
        return true;
      },
      spendFreshStepUp: () => {
        state.spent += 1;
        state.fresh = false;
      },
    };
  };
  return { state, standing };
}

/** The owner at the machine: ungoverned, and a claim or a spend would be a bug. */
function atMachine() {
  const state = { spent: 0 };
  return {
    state,
    standing: {
      ...ownerStanding(),
      claimFreshStepUp: () => {
        state.spent += 1;
        return true;
      },
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

  test('G22 a refused update has used the proof up, so a retry with the same proof is refused', async () => {
    // Claim-first, no restore (today's claim-first routes): one proof admits one act, and the person confirms again.
    const launched: string[] = [];
    const start = await ready(launched);
    const phone = remoteDevice(true);
    const stale = await start(call({ target: '4.28.5', when: 'now' }, phone.standing()));
    expect([stale.status, json(stale).code, phone.state.spent]).toEqual([409, DAEMON_UPDATE_CODES.staleTarget, 1]);
    const retry = await start(call(START, phone.standing()));
    expect([retry.status, json(retry).code, launched]).toEqual([403, STEP_UP_REQUIRED_CODE, []]);
  });

  test('G22 two requests racing on one fresh proof: exactly one update starts, the other is asked again', async () => {
    const launched: string[] = [];
    const start = await ready(launched);
    const phone = remoteDevice(true);
    // Both standings are taken before either request runs: each admission saw the proof fresh.
    const [a, b] = [phone.standing(), phone.standing()];
    const answers = await Promise.all([start(call(START, a)), start(call(START, b))]);
    expect(answers.map(answer => answer.status).sort()).toEqual([202, 403]);
    expect(json(answers.find(answer => answer.status === 403)!).code).toBe(STEP_UP_REQUIRED_CODE);
    expect([launched, phone.state.spent]).toEqual([['4.29.0'], 1]);
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

  test('G22 a refused write has used the proof up, so a retry with the same proof is refused', async () => {
    const { writes, door } = recordingDoor({ kind: 'refused', reason: 'not allowed', issues: [] });
    const phone = remoteDevice(true);
    const answer = await patch(door)(call({ autoInstall: true }, phone.standing()));
    expect([answer.status, phone.state.spent]).toEqual([422, 1]);
    const retry = await patch(door)(call({ autoInstall: true }, phone.standing()));
    expect([retry.status, json(retry).code, writes.length]).toEqual([403, STEP_UP_REQUIRED_CODE, 1]);
  });

  test('G22 two requests racing on one fresh proof: exactly one write happens, the other is asked again', async () => {
    const { writes, door } = recordingDoor();
    const phone = remoteDevice(true);
    const [a, b] = [phone.standing(), phone.standing()];
    const route = patch(door);
    const answers = await Promise.all([route(call({ autoInstall: true }, a)), route(call({ autoInstall: true }, b))]);
    expect(answers.map(answer => answer.status).sort()).toEqual([200, 403]);
    expect(json(answers.find(answer => answer.status === 403)!).code).toBe(STEP_UP_REQUIRED_CODE);
    expect([writes.length, phone.state.spent]).toEqual([1, 1]);
  });

  test('G22 a held write spends the proof', async () => {
    // Lead ruling: the proof is claimed before the write, and a write held for the owner's confirmation keeps it
    // claimed — a live proof left behind could carry a different owner-only act inside its freshness window.
    const { writes, door } = recordingDoor({ kind: 'held', sentences: ['updates install automatically when idle'] });
    const phone = remoteDevice(true);
    const first = await patch(door)(call({ autoInstall: true }, phone.standing()));
    expect([first.status, json(first).held, writes.length, phone.state.spent]).toEqual([
      202,
      ['updates install automatically when idle'],
      1,
      1,
    ]);
    const second = await patch(door)(call({ autoInstall: true }, phone.standing()));
    expect([second.status, json(second).code, writes.length]).toEqual([403, STEP_UP_REQUIRED_CODE, 1]);
  });

  test('G22 a missing door or host is a 503 that has used the claimed proof up', async () => {
    // Lead ruling (claim-first, no restore): the 503 comes after the claim, so the person confirms again.
    const { writes, door } = recordingDoor();
    // No host is the kernel's undeclared stub: its facts refuse, so the plugin's own readiness answer is "unavailable".
    const undeclared = {
      release: '5.0.0',
      compiled: false,
      executable: async () => {
        throw new Error('updates did not declare permissions.updateHost.');
      },
      launchUpdate: async () => ({
        kind: 'failed' as const,
        reason: 'updates did not declare permissions.updateHost.',
      }),
    };
    const noHost = updateRoutes(serviceWith([]), door, () => updateHostUsable(undeclared));
    const cases = [
      [
        updateRoutes(serviceWith([]), undefined)['PATCH /v1/daemon/update/settings'],
        { autoInstall: true },
        'configUnavailable',
      ],
      [noHost['PATCH /v1/daemon/update/settings'], { autoInstall: true }, 'hostUnavailable'],
      [noHost['POST /v1/daemon/update'], START, 'hostUnavailable'],
    ] as const;
    for (const [route, body, code] of cases) {
      const phone = remoteDevice(true);
      const answer = await route(call(body, phone.standing()));
      expect([answer.status, json(answer).code, phone.state.spent]).toEqual([503, UPDATE_HOST_CODES[code], 1]);
      const retry = await route(call(body, phone.standing()));
      expect([retry.status, json(retry).code]).toEqual([403, STEP_UP_REQUIRED_CODE]);
    }
    expect(writes).toEqual([]);
  });
});
