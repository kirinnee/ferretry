import { describe, expect, test } from 'bun:test';
import { BodyTooLargeError, MAX_REQUEST_BODY_BYTES, type Redaction } from '@ferretry/kernel/contract';
import { packRoutes, type PackSubsystem } from '../../../daemon/lib/routes.ts';

/** Every body-taking route records what reached the subsystem, so a refusal can prove nothing did. */
function stand() {
  const reached: string[] = [];
  const subsystem = {
    service: {
      recommend: async () => {
        reached.push('recommend');
        throw new Error('stand-in');
      },
    },
    routing: {
      cleanUp: {
        start: async () => {
          reached.push('clean-up');
          return { outcome: 'refused', message: 'no runtime is ready' };
        },
      },
      file: {
        accept: async () => {
          reached.push('accept');
          throw new Error('stand-in');
        },
      },
    },
    setSwitch: async (ferret: string, enabled: boolean) => {
      reached.push(`switch ${ferret} ${String(enabled)}`);
      return undefined;
    },
  } as unknown as PackSubsystem;
  return { reached, routes: packRoutes(subsystem, {} as Redaction) };
}

/** A call carrying exactly `text`, read the way every arrival reads one: over the route's bound is a 413. */
const rawCall = (text: string) =>
  ({
    request: {
      text: async (limit?: number) => {
        if (limit !== undefined && new TextEncoder().encode(text).byteLength > limit)
          throw new BodyTooLargeError(limit);
        return text;
      },
    },
    params: new Map([['ferretId', 'f1']]),
  }) as never;

const refused = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  return error as { status: number; code?: string; message?: string };
};

type Name =
  | 'POST /v1/pack/routing/clean-up'
  | 'POST /v1/pack/routing/accept'
  | 'POST /v1/pack/recommend'
  | 'PATCH /v1/ferrets/:ferretId/pack';

/** Each route, a body its schema refuses (carrying a value that must never come back out), and a body it takes. */
const ROUTES: readonly [Name, unknown][] = [
  ['POST /v1/pack/routing/clean-up', { mode: 'SECRET-VALUE' }],
  ['POST /v1/pack/routing/accept', { prompt: 'SECRET-VALUE' }],
  ['POST /v1/pack/recommend', { task: 42, extra: 'SECRET-VALUE' }],
  ['PATCH /v1/ferrets/:ferretId/pack', { enabled: 'SECRET-VALUE' }],
];

/** Packs reads its bodies the way today's `pack` mount does: through the shared bounded parser, refused with its codes. */
describe.each(ROUTES)('%s reads its body as today', (name, wrong) => {
  test('a body over the transport bound is 413 body_too_large, read with that bound', async () => {
    const { reached, routes } = stand();
    const limits: (number | undefined)[] = [];
    const oversize = {
      request: {
        text: async (limit?: number) => {
          limits.push(limit);
          throw new BodyTooLargeError(limit ?? 0);
        },
      },
      params: new Map([['ferretId', 'f1']]),
    } as never;

    const error = await refused(routes[name](oversize));

    expect(error).toMatchObject({ status: 413, code: 'body_too_large' });
    expect(limits).toEqual([MAX_REQUEST_BODY_BYTES]);
    expect(reached).toEqual([]);
  });

  test('an empty body is 400 invalid_json, not an empty object', async () => {
    const { reached, routes } = stand();

    expect(await refused(routes[name](rawCall('')))).toMatchObject({ status: 400, code: 'invalid_json' });
    expect(reached).toEqual([]);
  });

  test('a body that is not JSON is 400 invalid_json', async () => {
    const { reached, routes } = stand();

    expect(await refused(routes[name](rawCall('{nope')))).toMatchObject({ status: 400, code: 'invalid_json' });
    expect(reached).toEqual([]);
  });

  test('a body that is not the schema is 400 invalid_request and never echoes its values', async () => {
    const { reached, routes } = stand();

    const error = await refused(routes[name](rawCall(JSON.stringify(wrong))));

    expect(error).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(error.message ?? '').not.toContain('SECRET-VALUE');
    expect(reached).toEqual([]);
  });
});

describe('a valid Packs body is read as before', () => {
  test('a clean-up request reaches the subsystem and its refusal is served as 200', async () => {
    const { reached, routes } = stand();

    const response = (await routes['POST /v1/pack/routing/clean-up'](rawCall('{}'))) as { status: number };

    expect(response.status).toBe(200);
    expect(reached).toEqual(['clean-up']);
  });

  test('a switch request reaches the subsystem with its parsed value', async () => {
    const { reached, routes } = stand();

    const error = await refused(routes['PATCH /v1/ferrets/:ferretId/pack'](rawCall('{"enabled":true}')));

    expect(error).toMatchObject({ status: 404, code: 'not-found' });
    expect(reached).toEqual(['switch f1 true']);
  });
});

describe('the routes that answer from the subsystem', () => {
  const routing = { text: 'Use the cheapest model that can do it.', source: 'default' as const };
  const subsystem = {
    service: {
      inventory: async () => ({ at: '2026-11-07T10:00:00.000Z', runtimes: [], models: [], routing }),
      recommend: async () => ({ routing, available: [] }),
    },
    routing: {
      file: { undo: async () => ({ outcome: 'nothing', message: 'There was no earlier prompt to go back to.' }) },
    },
    result: async () => undefined,
  } as unknown as PackSubsystem;
  const routes = packRoutes(subsystem, {} as Redaction);
  const person = { request: { text: async () => '{}' }, params: new Map() } as never;
  const ferret = {
    request: { text: async () => '{}' },
    params: new Map(),
    credential: { tokenClass: 'ferret', ferret: 'f9' },
  } as never;
  const bodyOf = async (promise: Promise<unknown>) => JSON.parse(((await promise) as { body: string }).body);

  test('GET /v1/pack/inventory answers the inventory the service read', async () => {
    expect(await bodyOf(routes['GET /v1/pack/inventory']())).toMatchObject({ runtimes: [], models: [], routing });
  });

  test('POST /v1/pack/recommend answers the recommendation for a request body it takes', async () => {
    const call = { request: { text: async () => '{"task":"fix it"}' }, params: new Map() } as never;
    expect(await bodyOf(routes['POST /v1/pack/recommend'](call))).toEqual({ routing, available: [] });
  });

  test('POST /v1/pack/routing/undo answers what the undo did for a person', async () => {
    expect(await bodyOf(routes['POST /v1/pack/routing/undo'](person))).toEqual({
      outcome: 'nothing',
      message: 'There was no earlier prompt to go back to.',
    });
  });

  test('POST /v1/pack/routing/undo is refused to a ferret’s own credential', async () => {
    expect(await refused(routes['POST /v1/pack/routing/undo'](ferret))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  test('a ferret id in the path that is empty or cannot be decoded is 400 invalid_ferret_id', async () => {
    for (const id of ['', '%E0%A4%A'])
      expect(
        await refused(routes['GET /v1/ferrets/:ferretId/result']({ params: new Map([['ferretId', id]]) } as never)),
      ).toMatchObject({ status: 400, code: 'invalid_ferret_id' });
  });
});
