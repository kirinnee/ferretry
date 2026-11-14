import { describe, expect, test } from 'bun:test';
import { fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import { HypermediaResultSchema, HypermediaStateSchema } from '../../../../contract/index.ts';
import daemon from '../../../../daemon/index.ts';
import { SessionHypermediaError } from '../../../../daemon/hypermedia/lib/service.ts';
import { sessionHypermediaRoutes } from '../../../../daemon/hypermedia/lib/mounts/session-hypermedia.ts';
import { refusalOf } from '../../../support/mount-call.ts';

/** The switch a ferret's hypermedia is changed through: the real route, descriptor and state, over fake Ferrets. */

const RUNNING = 'mvuc7tsf-0c3d50df';
const STOPPED = 'mvuc7tsg-11111111';
const AUTO = 'mvuc7tsh-22222222';

const summaries: Record<string, { id: string; state: string; mode?: string }> = {
  [RUNNING]: { id: RUNNING, state: 'working', mode: 'interactive' },
  [STOPPED]: { id: STOPPED, state: 'stopped', mode: 'auto' },
  [AUTO]: { id: AUTO, state: 'idle', mode: 'auto' },
};

async function world() {
  const built: { half?: ReturnType<NonNullable<typeof daemon.build>> } = {};
  const implementation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => (built.half = daemon.build!(ctx)),
  } as typeof daemon;
  const host = await testHost({
    plugins: [implementation],
    fakes: {
      ferrets: { get: async (id: string) => summaries[id], list: async () => [] },
      asks: { get: async () => undefined },
    },
    clock: fixedClock('2026-11-06T09:00:00Z'),
  });
  const patch = (ferret: string, body: unknown) =>
    host.request('PATCH', `/v1/ferrets/${ferret}/hypermedia`, { as: owner(), body });
  /** What a launch of this ferret would say about hypermedia, through the hook Conversation takes. */
  const read = (ferret: string) => host.request('GET', `/v1/ferrets/${ferret}/hypermedia`, { as: owner() });
  const launched = async (ferret: string) => {
    const hooks = built.half?.hooks as unknown as Record<
      string,
      () => readonly { item: { parts(spec: unknown): Promise<unknown> } }[]
    >;
    const [source] = hooks['launch.parts']?.() ?? [];
    return await source?.item.parts({ ferret });
  };
  return { host, patch, read, launched };
}

describe('GET /v1/ferrets/:ferretId/hypermedia', () => {
  test("says the mode default for a ferret nobody set, and the owner's own value once set", async () => {
    const { patch, read } = await world();

    const interactive = await read(RUNNING);
    expect(interactive.status).toBe(200);
    expect(HypermediaStateSchema.parse(interactive.json())).toEqual({ enabled: true });
    expect(HypermediaStateSchema.parse((await read(AUTO)).json())).toEqual({ enabled: false });

    await patch(RUNNING, { enabled: false });
    await patch(AUTO, { enabled: true });
    expect(HypermediaStateSchema.parse((await read(RUNNING)).json())).toEqual({ enabled: false });
    expect(HypermediaStateSchema.parse((await read(AUTO)).json())).toEqual({ enabled: true });
  });

  test('answers 404 with a sentence for a ferret that does not exist', async () => {
    const { read } = await world();

    const gone = await read('ghost-ferret');
    expect(gone.status).toBe(404);
    expect((gone.json() as { code: string }).code).toBe('not-found');
  });
});

describe('PATCH /v1/ferrets/:ferretId/hypermedia', () => {
  test('switches one ferret and answers whether it needs a restart, and why', async () => {
    const { patch } = await world();

    const answer = await patch(RUNNING, { enabled: false });

    expect(answer.status).toBe(200);
    expect(HypermediaResultSchema.parse(answer.json())).toEqual({
      restartRequired: true,
      note: 'Hypermedia is off. This ferret is running, so it takes effect when the ferret restarts.',
    });
  });

  test('an interactive ferret is on by default, so switching it on is no change; an automatic one is off', async () => {
    const { patch } = await world();

    expect((await patch(RUNNING, { enabled: true })).json()).toEqual({
      restartRequired: false,
      note: 'Hypermedia was already on.',
    });
    expect((await patch(AUTO, { enabled: true })).json()).toEqual({
      restartRequired: true,
      note: 'Hypermedia is on. This ferret is running, so it takes effect when the ferret restarts.',
    });
    expect((await patch(STOPPED, { enabled: true })).json()).toEqual({
      restartRequired: false,
      note: 'Hypermedia is on; this ferret is not running, so it takes effect at its next launch.',
    });
  });

  test('refuses a body without the switch, and a ferret that does not exist', async () => {
    const { patch } = await world();

    expect((await patch(RUNNING, { on: true })).status).toBe(400);
    const gone = await patch('ghost-ferret', { enabled: true });
    expect(gone.status).toBe(404);
    expect((gone.json() as { code: string }).code).toBe('not-found');
  });

  test('the next launch says what was set, and a ferret nobody set anything for says nothing', async () => {
    const { patch, launched } = await world();

    expect(await launched(AUTO)).toEqual([{ kind: 'env', env: {} }]);
    await patch(AUTO, { enabled: true });
    await patch(RUNNING, { enabled: false });

    expect(await launched(AUTO)).toEqual([{ kind: 'env', env: { FY_HYPERMEDIA: '1' } }]);
    expect(await launched(RUNNING)).toEqual([{ kind: 'env', env: { FY_HYPERMEDIA: '0' } }]);
    expect(await launched(STOPPED)).toEqual([{ kind: 'env', env: {} }]);
  });
});

describe('the hypermedia mount', () => {
  const PATH = '/v1/ferrets/:ferretId/hypermedia';

  test('passes an unusable ferret id back as a 400 before it reads the body', async () => {
    const routes = sessionHypermediaRoutes({
      read: async () => true,
      set: async () => ({ restartRequired: false, note: 'n' }),
    });
    const refusal = await refusalOf(routes, 'PATCH', PATH, { params: { ferretId: '' }, body: { enabled: true } });
    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('invalid_session_id');
    const read = await refusalOf(routes, 'GET', PATH, { params: { ferretId: '' } });
    expect(read.status).toBe(400);
    expect(read.code).toBe('invalid_session_id');
  });

  test('answers 404 for a ferret the service does not know, and lets any other failure through', async () => {
    const unknown = sessionHypermediaRoutes({
      read: async () => {
        throw new SessionHypermediaError('not-found', 'no such ferret');
      },
      set: async () => {
        throw new SessionHypermediaError('not-found', 'no such ferret');
      },
    });
    const missing = await refusalOf(unknown, 'PATCH', PATH, { params: { ferretId: 'f1' }, body: { enabled: true } });
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('not-found');

    const broken = sessionHypermediaRoutes({
      read: async () => true,
      set: async () => {
        throw new TypeError('boom');
      },
    });
    const error = await refusalOf(broken, 'PATCH', PATH, { params: { ferretId: 'f1' }, body: { enabled: true } });
    expect(error.message).toBe('boom');
  });
});
