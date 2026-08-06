import { describe, expect, it } from 'bun:test';

import {
  alreadyRegistered,
  PROJECT_REGISTRY_PATH,
  registerProject,
} from '../../../src/features/projects/projects-api.ts';
import { daemonConnection } from '../../../src/lib/daemon-connection.ts';
import { DaemonResponseError } from '../../../src/lib/runtime-models.ts';

const connection = daemonConnection({
  daemonId: 'daemon/a',
  baseUrl: 'https://a.example.test',
  deviceToken: 'token-a',
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const record = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
  git: { commonDirectory: '/work/ferretry/.git' },
};

describe('registerProject', () => {
  it('POSTs the parsed request to the paired daemon and answers with the record', async () => {
    const seen: { url: string; method?: string; body?: unknown; headers: Headers }[] = [];
    const project = await registerProject(
      connection,
      { kind: 'existing-folder', path: '/work/ferretry' },
      async (url, init) => {
        seen.push({
          url: String(url),
          method: init?.method,
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        });
        return json(record);
      },
    );

    expect(seen[0]?.url).toBe(`https://a.example.test${PROJECT_REGISTRY_PATH}`);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer token-a');
    expect(seen[0]?.headers.get('content-type')).toBe('application/json');
    expect(seen[0]?.body).toEqual({ kind: 'existing-folder', path: '/work/ferretry' });
    expect(project.id).toBe(record.id);
    expect(project.git?.commonDirectory).toBe('/work/ferretry/.git');
  });

  it('sends the new-folder arm with its Git flag, and the clone arm with its URL', async () => {
    const bodies: unknown[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      bodies.push(JSON.parse(String(init?.body)));
      return json({ ...record, source: 'new-folder' });
    };

    await registerProject(connection, { kind: 'new-folder', path: '/work/fresh', initializeGit: true }, fetcher);
    await registerProject(
      connection,
      { kind: 'clone', url: 'https://github.com/you/p.git', path: '/work/p', name: 'p' },
      fetcher,
    );
    await registerProject(connection, { kind: 'confirmed-discovery', path: '/work/seen' }, fetcher);

    expect(bodies).toEqual([
      { kind: 'new-folder', path: '/work/fresh', initializeGit: true },
      { kind: 'clone', url: 'https://github.com/you/p.git', path: '/work/p', name: 'p' },
      { kind: 'confirmed-discovery', path: '/work/seen' },
    ]);
  });

  it('applies the schema default so a new-folder request always states its Git intent', async () => {
    let body: { initializeGit?: unknown } = {};
    await registerProject(connection, { kind: 'new-folder', path: '/work/fresh' } as never, async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return json({ ...record, source: 'new-folder' });
    });

    expect(body.initializeGit).toBe(false);
  });

  it('refuses to send a request the protocol rejects, without touching the network', async () => {
    let called = false;
    await expect(
      registerProject(connection, { kind: 'clone', url: 'git@github.com:you/p.git', path: '/work/p' }, async () => {
        called = true;
        return json(record);
      }),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('turns a daemon refusal into a DaemonResponseError carrying its message and code', async () => {
    const failure = registerProject(
      connection,
      { kind: 'new-folder', path: '/a/b/c', initializeGit: false },
      async () => json({ error: 'ENOENT: no such file or directory', code: 'project_registration_failed' }, 422),
    );

    await expect(failure).rejects.toBeInstanceOf(DaemonResponseError);
    await failure.catch((reason: unknown) => {
      const error = reason as DaemonResponseError;
      expect(error.status).toBe(422);
      expect(error.message).toBe('ENOENT: no such file or directory');
      expect(error.code).toBe('project_registration_failed');
    });
  });

  it('falls back to the status when a refusal carries no readable body', async () => {
    const failure = registerProject(
      connection,
      { kind: 'existing-folder', path: '/work/ferretry' },
      async () => new Response('not json', { status: 503 }),
    );

    await failure.catch((reason: unknown) => {
      const error = reason as DaemonResponseError;
      expect(error.message).toBe('HTTP 503');
      expect(error.code).toBeUndefined();
    });
    await expect(failure).rejects.toBeInstanceOf(DaemonResponseError);
  });

  it('rejects an answer that is not a project record rather than returning it', async () => {
    await expect(
      registerProject(connection, { kind: 'existing-folder', path: '/work/ferretry' }, async () =>
        json({ name: 'ferretry', path: '/work/ferretry' }),
      ),
    ).rejects.toThrow();
  });
});

describe('alreadyRegistered', () => {
  it('is true only when the answered record id was already known', () => {
    const known = [{ name: 'ferretry', path: '/work/ferretry', id: record.id }];

    expect(alreadyRegistered(known, { ...record, source: 'existing-folder' } as never)).toBe(true);
    expect(alreadyRegistered(known, { ...record, id: '22222222-2222-4222-8222-222222222222' } as never)).toBe(false);
    expect(alreadyRegistered([], { ...record } as never)).toBe(false);
  });

  it('does not treat a matching path under a different record as already registered', () => {
    // A path is not an identity: the same folder can be answered with a NEW
    // record when the previous spelling resolved elsewhere, and calling that
    // "already registered" would hide the dedupe that did not happen.
    const known = [{ name: 'ferretry', path: '/work/ferretry', id: '33333333-3333-4333-8333-333333333333' }];

    expect(alreadyRegistered(known, { ...record } as never)).toBe(false);
  });
});
