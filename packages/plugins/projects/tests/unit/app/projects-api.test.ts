import { describe, expect, test } from 'bun:test';
import type { ProjectsClient } from '../../../app/lib/client.ts';
import {
  alreadyRegistered,
  fetchProjects,
  LIST_ROUTE,
  REGISTER_ROUTE,
  REMOVE_ROUTE,
  registerProject,
  removeProject,
} from '../../../app/lib/projects-api.ts';
import type { ProjectInfo } from '../../../contract/index.ts';

const record: Record<string, unknown> = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
  git: { commonDirectory: '/work/ferretry/.git' },
};

/** A client that records every call and answers with `answer(route)`. */
function client(answer: (route: string) => unknown) {
  const calls: { route: string; init?: unknown }[] = [];
  const fake: ProjectsClient = {
    call: (async (route: string, init?: unknown) => {
      calls.push({ route, init });
      const out = answer(route);
      if (out instanceof Error) throw out;
      return out;
    }) as ProjectsClient['call'],
  };
  return { fake, calls };
}

describe('registerProject', () => {
  test('POSTs the parsed request through the guarded client and answers with the record', async () => {
    const { fake, calls } = client(() => record);

    const project = await registerProject(fake, { kind: 'existing-folder', path: '/work/ferretry' });

    expect(calls).toEqual([
      { route: REGISTER_ROUTE, init: { body: { kind: 'existing-folder', path: '/work/ferretry' } } },
    ]);
    expect(project.id as string).toBe(record.id as string);
    expect(project.git?.commonDirectory).toBe('/work/ferretry/.git');
  });

  test('sends the new-folder arm with its git flag, the clone arm with its URL, and the confirmation with a path only', async () => {
    const { fake, calls } = client(() => ({ ...record, source: 'new-folder' }));

    await registerProject(fake, { kind: 'new-folder', path: '/work/fresh', initializeGit: true });
    await registerProject(fake, { kind: 'clone', url: 'https://github.com/you/p.git', path: '/work/p', name: 'p' });
    await registerProject(fake, { kind: 'confirmed-discovery', path: '/work/seen' });

    expect(calls.map(call => (call.init as { body: unknown }).body)).toEqual([
      { kind: 'new-folder', path: '/work/fresh', initializeGit: true },
      { kind: 'clone', url: 'https://github.com/you/p.git', path: '/work/p', name: 'p' },
      { kind: 'confirmed-discovery', path: '/work/seen' },
    ]);
  });

  test('applies the schema default so a new-folder request always states its git intent', async () => {
    const { fake, calls } = client(() => ({ ...record, source: 'new-folder' }));

    await registerProject(fake, { kind: 'new-folder', path: '/work/fresh' } as never);

    expect((calls[0]?.init as { body: { initializeGit: unknown } } | undefined)?.body.initializeGit).toBe(false);
  });

  test('refuses to send a request the contract rejects, without calling the daemon', async () => {
    const { fake, calls } = client(() => record);

    await expect(
      registerProject(fake, { kind: 'clone', url: 'git@github.com:you/p.git', path: '/work/p' }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test('lets a daemon refusal through with its status, code and the daemon’s own sentence', async () => {
    const refusal = Object.assign(new Error('ENOENT: no such file or directory'), {
      status: 422,
      code: 'project_registration_failed',
    });
    const { fake } = client(() => refusal);

    const failure = await registerProject(fake, { kind: 'new-folder', path: '/a/b/c', initializeGit: false }).then(
      () => new Error('no refusal') as Error & { status: number; code: string },

      (reason: unknown) => reason as Error & { status: number; code: string },
    );

    expect(failure.message).toBe('ENOENT: no such file or directory');
    expect(failure.status).toBe(422);
    expect(failure.code).toBe('project_registration_failed');
  });

  test('rejects an answer that is not a project record rather than returning it', async () => {
    const { fake } = client(() => ({ name: 'ferretry', path: '/work/ferretry' }));

    await expect(registerProject(fake, { kind: 'existing-folder', path: '/work/ferretry' })).rejects.toThrow();
  });
});

describe('the registry reads and the removal', () => {
  test('lists the whole record of each row', async () => {
    const { fake, calls } = client(() => [record]);

    const rows = await fetchProjects(fake);

    expect(calls[0]?.route).toBe(LIST_ROUTE);
    expect(rows[0]).toMatchObject({ source: 'existing-folder', git: { commonDirectory: '/work/ferretry/.git' } });
  });

  test('a removal names the project in the path and answers the record removed', async () => {
    const { fake, calls } = client(() => record);

    const gone = await removeProject(fake, record.id as string);

    expect(calls[0]).toEqual({ route: REMOVE_ROUTE, init: { params: { id: record.id as string } } });
    expect(gone.id as string).toBe(record.id as string);
  });
});

describe('alreadyRegistered', () => {
  test('is true only when the answered record id was already known', () => {
    const known = [record as unknown as ProjectInfo];

    expect(alreadyRegistered(known, record as unknown as ProjectInfo)).toBe(true);
    expect(alreadyRegistered(known, { ...record, id: '22222222-2222-4222-8222-222222222222' } as never)).toBe(false);
    expect(alreadyRegistered([], record as unknown as ProjectInfo)).toBe(false);
  });

  test('does not treat a matching path under a different record as already registered', () => {
    // A path is not an identity: the same folder can be answered with a NEW record when the previous spelling resolved
    // elsewhere, and calling that "already registered" would hide the dedupe that did not happen.
    const known = [{ ...record, id: '33333333-3333-4333-8333-333333333333' } as unknown as ProjectInfo];

    expect(alreadyRegistered(known, record as unknown as ProjectInfo)).toBe(false);
  });
});
