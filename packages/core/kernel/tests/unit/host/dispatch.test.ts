import { describe, expect, test } from 'bun:test';
import type { OutputGuard } from '../../../contract/bound.ts';
import { WITHHELD_SENTENCE } from '../../../contract/bound.ts';
import { ApiError, finalised, jsonResponse } from '../../../contract/http.ts';
import type { PluginId } from '../../../contract/ids.ts';
import type { RouteDescriptor } from '../../../contract/route.ts';
import { Dispatcher, type MountedRoute, type Owner, type Serving } from '../../../host/dispatch.ts';
import { recordingAdmission, request } from './fixtures.ts';

const owner = (serving: Serving = { kind: 'serving' }): Owner => ({
  plugin: 'board' as PluginId,
  title: 'Board',
  serving: () => serving,
});

const descriptor = (path: string, extra: Partial<RouteDescriptor> = {}): RouteDescriptor => ({
  method: 'GET',
  path,
  minimum: 'authenticated',
  caller: 'any',
  audit: { skip: 'test' },
  guard: { none: 'test' },
  ...extra,
});

const mounted = (path: string, extra: Partial<MountedRoute> = {}): MountedRoute => ({
  ...descriptor(path),
  owner: owner(),
  handle: async call => jsonResponse({ path: call.request.path, actor: (call as { actor?: string }).actor }),
  ...extra,
});

const dispatcher = (
  routes: readonly MountedRoute[],
  admission: ReturnType<typeof recordingAdmission> | null = recordingAdmission(),
  guard?: OutputGuard,
) =>
  new Dispatcher(
    { admission: () => admission ?? undefined, outputGuard: () => guard, version: '5.0.0' },
    { routes, sockets: [], memberRoutes: [] },
  );

const body = (response: { body: string }): Record<string, unknown> =>
  JSON.parse(response.body) as Record<string, unknown>;

describe('the dispatcher (§7.1, §7.6 step 6)', () => {
  test('admission is asked before every handler, and its standing reaches the handler', async () => {
    const admission = recordingAdmission();
    const response = await dispatcher([mounted('/v1/board')], admission).dispatch(request('GET', '/v1/board'));
    expect(admission.asked).toEqual(['route GET /v1/board']);
    expect(body(response)).toEqual({ path: '/v1/board', actor: 'owner' });
    expect(response.headers.get('x-ferretry-version')).toBe('5.0.0');
  });

  test('a refused call never reaches the handler', async () => {
    let ran = false;
    const route = mounted('/v1/board', {
      handle: async () => {
        ran = true;
        return jsonResponse({});
      },
    });
    const response = await dispatcher(
      [route],
      recordingAdmission(() => false),
    ).dispatch(request('GET', '/v1/board'));
    expect(response.status).toBe(401);
    expect(ran).toBe(false);
  });

  test('an unknown path is answered 404 only after admission, so a stranger cannot map the surface', async () => {
    const strangers = recordingAdmission(() => false);
    const refused = await dispatcher([mounted('/v1/board')], strangers).dispatch(request('GET', '/v1/secret-thing'));
    expect(refused.status).toBe(401);
    expect(strangers.asked).toEqual(['route GET /v1/secret-thing']);
    const known = await dispatcher([mounted('/v1/board')]).dispatch(request('GET', '/v1/nothing'));
    expect(known.status).toBe(404);
    expect(body(known).code).toBe('unknown_route');
  });

  test('without admission bound, only minimum none routes without a remedy are served (fail closed)', async () => {
    const open = mounted('/v1/health', { minimum: 'none' });
    const closed = mounted('/v1/board');
    const table = dispatcher([open, closed], null);
    expect((await table.dispatch(request('GET', '/v1/health'))).status).toBe(200);
    const refused = await table.dispatch(request('GET', '/v1/board'));
    expect(refused.status).toBe(503);
    expect(body(refused).code).toBe('admission_unavailable');
  });

  test('an admission that throws refuses the call', async () => {
    const broken = {
      ...recordingAdmission(),
      admit: () => {
        throw new Error('boom');
      },
    };
    const response = await dispatcher([mounted('/v1/board')], broken).dispatch(request('GET', '/v1/board'));
    expect(response.status).toBe(503);
  });

  test('a skeleton plugin answers 503 plugin_unavailable with the skeleton sentence (D10)', async () => {
    const skeleton = mounted('/v1/board', { owner: owner({ kind: 'skeleton' }) });
    const response = await dispatcher([skeleton]).dispatch(request('GET', '/v1/board'));
    expect(response.status).toBe(503);
    expect(body(response)).toEqual({
      error: 'Board is not built yet in this version of Ferretry.',
      code: 'plugin_unavailable',
    });
  });

  test('a failed plugin answers plugin_failed and a damaged one store_damaged naming the file', async () => {
    const failed = await dispatcher([mounted('/v1/board', { owner: owner({ kind: 'failed' }) })]).dispatch(
      request('GET', '/v1/board'),
    );
    expect(body(failed).code).toBe('plugin_failed');
    const damaged = await dispatcher([
      mounted('/v1/board', { owner: owner({ kind: 'damaged', files: ['board/cards.json'] }) }),
    ]).dispatch(request('GET', '/v1/board'));
    expect(damaged.status).toBe(503);
    expect(body(damaged).code).toBe('store_damaged');
    expect(body(damaged).error).toContain('board/cards.json');
  });

  test('live damage during a handler and after seal refuses the prepared answer at publication', async () => {
    let state: Serving = { kind: 'serving' };
    let damageDuringHandler = false;
    const route = mounted('/v1/board', {
      owner: { ...owner(), serving: () => state },
      handle: async () => {
        await Promise.resolve();
        if (damageDuringHandler) state = { kind: 'damaged', files: ['board/cards.json'] };
        return jsonResponse({ text: 'fixture-content' });
      },
    });
    const table = dispatcher([route]);
    const response = await table.dispatch(request('GET', '/v1/board'));
    const { answerRecords } = await import('../../../host/session/wire/answer.ts');
    const records = answerRecords(1, response);
    state = { kind: 'damaged', files: ['board/cards.json'] };
    expect(records[0]?.permit?.()).toBe(false);
    expect(body(finalised(response)).code).toBe('store_damaged');
    state = { kind: 'serving' };
    damageDuringHandler = true;
    const damaged = finalised(await table.dispatch(request('GET', '/v1/board')));
    expect(body(damaged).code).toBe('store_damaged');
    expect(damaged.body).not.toContain('fixture-content');
  });

  test('a thrown ApiError keeps its status and code; anything else is a bare 500', async () => {
    const named = mounted('/v1/a', {
      handle: async () => {
        throw new ApiError(409, 'That card moved.', 'card_moved');
      },
    });
    const bare = mounted('/v1/b', {
      handle: async () => {
        throw new Error('/home/someone/secret path');
      },
    });
    const table = dispatcher([named, bare]);
    expect(body(await table.dispatch(request('GET', '/v1/a')))).toEqual({
      error: 'That card moved.',
      code: 'card_moved',
    });
    const failure = await table.dispatch(request('GET', '/v1/b'));
    expect(failure.status).toBe(500);
    expect(failure.body).not.toContain('secret');
  });

  test('noStore routes carry cache-control no-store', async () => {
    const response = await dispatcher([mounted('/v1/a', { noStore: true })]).dispatch(request('GET', '/v1/a'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('a member principal is served only from the member table', async () => {
    const memberRequest = {
      ...request('GET', '/v1/board'),
      principal: { kind: 'member' as const, holder: 'm1', session: 's1', leaseUntil: '2026-11-07T10:00:00.000Z' },
    } as unknown as ReturnType<typeof request>;
    const response = await dispatcher([mounted('/v1/board')]).dispatch(memberRequest);
    expect(response.status).toBe(403);
    expect(body(response).code).toBe('member_only');
  });
});

describe('the final check on a guard: secrets route (§7.3)', () => {
  const guardWith = (state: { generation: number; throws?: boolean }): OutputGuard => ({
    stamp: () => ({ generation: state.generation, targets: [] }),
    stillShowable: stamp => {
      if (state.throws === true) throw new Error('vault damaged');
      return stamp.generation === state.generation;
    },
  });
  const secretRoute = mounted('/v1/pane', {
    guard: 'secrets',
    handle: async () => jsonResponse({ text: 'masked ****' }),
  });

  test('late keeps the masked body while nothing changed', async () => {
    const response = await dispatcher([secretRoute], recordingAdmission(), guardWith({ generation: 1 })).dispatch(
      request('GET', '/v1/pane'),
    );
    expect(body(finalised(response))).toEqual({ text: 'masked ****' });
  });

  test('a hold that began after the body was built makes late choose the withheld sentence, synchronously', async () => {
    const state = { generation: 1 };
    const response = await dispatcher([secretRoute], recordingAdmission(), guardWith(state)).dispatch(
      request('GET', '/v1/pane'),
    );
    state.generation = 2;
    const last = finalised(response);
    expect(last.body).toContain(WITHHELD_SENTENCE);
    expect(last.body).not.toContain('masked');
  });

  test('a missing or throwing OutputGuard withholds', async () => {
    const missing = await dispatcher([secretRoute], recordingAdmission(), undefined).dispatch(
      request('GET', '/v1/pane'),
    );
    expect(finalised(missing).body).toContain(WITHHELD_SENTENCE);
    const throwing = await dispatcher(
      [secretRoute],
      recordingAdmission(),
      guardWith({ generation: 1, throws: true }),
    ).dispatch(request('GET', '/v1/pane'));
    expect(finalised(throwing).body).toContain(WITHHELD_SENTENCE);
  });

  test('R516 R517 a thrown ApiError uses the guarded publication path, including its extra content', async () => {
    const state = { generation: 1 };
    const route = mounted('/v1/pane', {
      guard: 'secrets',
      handle: async () => {
        await Promise.resolve();
        state.generation++;
        throw new ApiError(409, 'fixture-content', 'fixture', undefined, { value: 'fixture-content' });
      },
    });
    const response = await dispatcher([route], recordingAdmission(), guardWith(state)).dispatch(
      request('GET', '/v1/pane'),
    );
    expect(response.late).toBeDefined();
    expect(finalised(response).body).toContain(WITHHELD_SENTENCE);
    expect(finalised(response).body).not.toContain('fixture-content');
  });

  test('R515 R516 an allowed guarded error keeps its status and is withheld if a hold starts before publication', async () => {
    const state = { generation: 1 };
    const route = mounted('/v1/pane', {
      guard: 'secrets',
      handle: async () => {
        throw new ApiError(409, 'fixture-content');
      },
    });
    const response = await dispatcher([route], recordingAdmission(), guardWith(state)).dispatch(
      request('GET', '/v1/pane'),
    );
    expect(finalised(response).status).toBe(409);
    expect(finalised(response).body).toContain('fixture-content');
    const { answerRecords } = await import('../../../host/session/wire/answer.ts');
    const records = answerRecords(1, response);
    state.generation++;
    expect(records[0]?.permit?.()).toBe(false);
    expect(finalised(response).body).toContain(WITHHELD_SENTENCE);
  });
});

describe('the actor reaches kernel.act from admission (§4.7)', () => {
  test('a handler runs under the actor Gate stamped', async () => {
    const { currentActor } = await import('../../../host/call-scope.ts');
    let seen = '';
    const route = mounted('/v1/act', {
      handle: async () => {
        seen = currentActor();
        return jsonResponse({});
      },
    });
    await dispatcher([route]).dispatch(request('GET', '/v1/act'));
    expect(seen).toBe('owner-tools');
  });
});

describe('the dispatcher tells Gate about audited calls (Admission.recorded)', () => {
  test('an output guard that stops a route or member handler produces no audit record', async () => {
    for (const table of ['route', 'member'] as const) {
      for (const guard of [
        undefined,
        {
          stamp: () => {
            throw new Error('guard unavailable');
          },
          stillShowable: () => true,
        },
      ]) {
        const admission = recordingAdmission();
        let handled = 0;
        const statuses: number[] = [];
        admission.recorded = call => void statuses.push(call.status);
        const route = mounted('/v1/private', {
          guard: 'secrets',
          audit: { record: 'private.read' as never },
          handle: async () => {
            handled += 1;
            return jsonResponse({ ok: true });
          },
        });
        const d = new Dispatcher(
          { admission: () => admission, outputGuard: () => guard, version: '5.0.0' },
          {
            routes: table === 'route' ? [route] : [],
            sockets: [],
            memberRoutes:
              table === 'member'
                ? [
                    {
                      ...route,
                      member: 'unlocked',
                      noStore: true,
                      handle: async () => {
                        handled += 1;
                        return jsonResponse({ ok: true });
                      },
                    },
                  ]
                : [],
          },
        );
        const input = request('GET', '/v1/private');
        if (table === 'member') Object.assign(input, { principal: { kind: 'member' } });
        expect((await d.dispatch(input)).status).toBe(409);
        expect(handled).toBe(0);
        expect(statuses).toEqual([]);
      }
    }
  });

  test.each(['route', 'member'] as const)(
    'an executed guarded %s handler is recorded once for every outcome',
    async table => {
      const admission = recordingAdmission();
      const statuses: number[] = [];
      admission.recorded = call => void statuses.push(call.status);
      let outcome: 'ok' | 'refused' | 'failed' | 'withheld' = 'ok';
      let handled = 0;
      let showable = true;
      const handle = async () => {
        handled += 1;
        if (outcome === 'refused') throw new ApiError(409, 'conflict', 'conflict');
        if (outcome === 'failed') throw new Error('failed');
        if (outcome === 'withheld') showable = false;
        return jsonResponse({ ok: true });
      };
      const route = mounted('/v1/private', { guard: 'secrets', audit: { record: 'private.read' as never }, handle });
      const d = new Dispatcher(
        {
          admission: () => admission,
          outputGuard: () => ({ stamp: () => ({ generation: 1, targets: [] }), stillShowable: () => showable }),
          version: '5.0.0',
        },
        {
          routes: table === 'route' ? [route] : [],
          sockets: [],
          memberRoutes: table === 'member' ? [{ ...route, member: 'unlocked', noStore: true, handle }] : [],
        },
      );
      const input = request('GET', '/v1/private');
      if (table === 'member') Object.assign(input, { principal: { kind: 'member' } });
      for (const next of ['ok', 'refused', 'failed', 'withheld'] as const) {
        outcome = next;
        await d.dispatch(input);
      }
      expect(handled).toBe(4);
      expect(statuses).toEqual([200, 409, 500, 409]);
    },
  );

  const audited = (handle: MountedRoute['handle']): MountedRoute =>
    mounted('/v1/grants', { method: 'PATCH', audit: { record: 'grants.changed' as never }, handle });

  test('called once per request with the final status and the full call: success and the handler’s own refusal', async () => {
    const admission = recordingAdmission();
    const seen: { status: number; actor?: string; path: string; standing?: object; response?: unknown }[] = [];
    admission.recorded = call =>
      void seen.push({
        status: call.status,
        actor: call.actor,
        path: call.descriptor.path,
        standing: call.standing,
        response: call.response,
      });
    let refuse = false;
    const route = audited(async () => {
      if (refuse) throw new ApiError(409, 'no', 'conflict');
      return jsonResponse({ ok: true });
    });
    const d = dispatcher([route], admission);
    await d.dispatch(request('PATCH', '/v1/grants'));
    refuse = true;
    const refused = await d.dispatch(request('PATCH', '/v1/grants'));
    expect(refused.status).toBe(409);
    expect(seen.map(entry => entry.status)).toEqual([200, 409]);
    expect(seen[0]).toMatchObject({ actor: 'owner-tools', path: '/v1/grants', standing: { actor: 'owner' } });
    expect((seen[0]?.response as { status: number } | undefined)?.status).toBe(200);
  });

  test('a handler failure is recorded as its 500; admission refusals and skip routes are not recorded', async () => {
    const admission = recordingAdmission(path => path !== '/v1/denied');
    const statuses: number[] = [];
    admission.recorded = call => void statuses.push(call.status);
    const d = dispatcher(
      [
        audited(async () => {
          throw new Error('boom');
        }),
        mounted('/v1/denied', { method: 'PATCH', audit: { record: 'grants.changed' as never } }),
        mounted('/v1/plain'),
      ],
      admission,
    );
    expect((await d.dispatch(request('PATCH', '/v1/grants'))).status).toBe(500);
    expect((await d.dispatch(request('PATCH', '/v1/denied'))).status).toBe(401);
    await d.dispatch(request('GET', '/v1/plain'));
    expect(statuses).toEqual([500]);
  });

  test('a recorder that throws never changes the answer', async () => {
    const admission = recordingAdmission();
    admission.recorded = () => {
      throw new Error('audit down');
    };
    const response = await dispatcher([audited(async () => jsonResponse({ ok: true }))], admission).dispatch(
      request('PATCH', '/v1/grants'),
    );
    expect(response.status).toBe(200);
  });
});
