import { describe, expect, test } from 'bun:test';
import type { CallContext } from '@ferretry/kernel/contract';
import { type ProjectInfo, ProjectPathMustBeAbsoluteMessage } from '../../../contract/index.ts';
import { listRoute, registerRoute, removeRoute } from '../../../daemon/lib/routes.ts';
import { fakeMachine, registryOver } from './support.ts';

const callWith = (body: unknown, params: Record<string, string> = {}): CallContext =>
  ({
    request: { text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) },
    params: new Map(Object.entries(params)),
  }) as unknown as CallContext;

const answer = (response: { readonly status: number; readonly body: unknown }) => ({
  status: response.status,
  json: JSON.parse(String(response.body)) as unknown,
});

const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error as { status: number; code: string; message: string };
  }
  throw new Error('the route answered');
};

const over = (directories: readonly string[] = ['/work/alpha']) => registryOver(fakeMachine(directories));

describe('GET /v1/projects', () => {
  test('answers the registered folders, oldest first', async () => {
    const { registry } = over(['/work/alpha', '/work/beta']);
    await registry.register({ kind: 'existing-folder', path: '/work/alpha' });
    await registry.register({ kind: 'existing-folder', path: '/work/beta' });
    const listed = answer(await listRoute(registry)(callWith(undefined)));
    expect(listed.status).toBe(200);
    expect((listed.json as ProjectInfo[]).map(project => project.path)).toEqual(['/work/alpha', '/work/beta']);
  });
});

describe('POST /v1/projects', () => {
  test('registers the folder and answers its record', async () => {
    const { registry, said } = over();
    const registered = answer(
      await registerRoute(registry)(callWith({ kind: 'existing-folder', path: '/work/alpha' })),
    );
    expect(registered.status).toBe(200);
    expect(registered.json).toMatchObject({ name: 'alpha', path: '/work/alpha', source: 'existing-folder' });
    expect(said).toHaveLength(1);
  });

  test('a sole relative-path failure is a request the daemon refuses: 422 with the registration code', async () => {
    const { registry, machine } = over();
    const refusal = await failure(() => registerRoute(registry)(callWith({ kind: 'existing-folder', path: 'alpha' })));
    expect(refusal).toMatchObject({
      status: 422,
      code: 'project_registration_failed',
    });
    expect(refusal.message).toContain(ProjectPathMustBeAbsoluteMessage);
    expect(machine.calls).toEqual([]);
  });

  test('any other malformed body stays a 400, even with a relative path in it', async () => {
    const { registry } = over();
    const route = registerRoute(registry);
    expect(await failure(() => route(callWith({ kind: 'nonsense' })))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(await failure(() => route(callWith({ kind: 'nonsense', path: 'alpha' })))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(await failure(() => route(callWith({ kind: 'existing-folder', path: 7 })))).toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(await failure(() => route(callWith('{not json')))).toMatchObject({ status: 400, code: 'invalid_json' });
  });

  test('a registration the daemon refuses (no such directory) is a 422 with its own sentence', async () => {
    const { registry, store } = over();
    const refusal = await failure(() =>
      registerRoute(registry)(callWith({ kind: 'existing-folder', path: '/work/absent' })),
    );
    expect(refusal).toMatchObject({
      status: 422,
      code: 'project_registration_failed',
      message: 'project path is not an existing directory',
    });
    expect(store.file.projects).toEqual([]);
  });
});

describe('DELETE /v1/projects/:id', () => {
  test('forgets the project and answers the record it removed', async () => {
    const { registry, store, said } = over();
    const added = await registry.register({ kind: 'existing-folder', path: '/work/alpha' });
    if (!added.ok) throw new Error('setup');
    const removed = answer(
      await removeRoute(registry)(callWith(undefined, { id: encodeURIComponent(added.value.id) })),
    );
    expect(removed.status).toBe(200);
    expect(removed.json).toEqual(added.value);
    expect(store.file.projects).toEqual([]);
    expect(said.at(-1)).toBe(`removed ${added.value.id}`);
  });

  test('an id that is not a project id is 400, before the registry is asked', async () => {
    const { registry, machine } = over();
    const route = removeRoute(registry);
    expect(await failure(() => route(callWith(undefined, { id: 'not-an-id' })))).toMatchObject({
      status: 400,
      code: 'invalid_project_id',
    });
    expect(await failure(() => route(callWith(undefined)))).toMatchObject({ status: 400, code: 'invalid_project_id' });
    expect(machine.calls).toEqual([]);
  });

  test('a well-formed id nobody holds is 404 not-found', async () => {
    const { registry } = over();
    expect(
      await failure(() => removeRoute(registry)(callWith(undefined, { id: '00000000-0000-4000-8000-0000000000ff' }))),
    ).toMatchObject({ status: 404, code: 'not-found', message: 'no project 00000000-0000-4000-8000-0000000000ff' });
  });
});
