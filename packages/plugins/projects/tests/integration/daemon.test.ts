import { describe, expect, test } from 'bun:test';
import { device, ferret, owner, testHost } from '@ferretry/kernel/testing';
import { PROJECTS_STATE, ProjectsPort, type ProjectInfo } from '../../contract/index.ts';
import { implementProjects } from '../../daemon/index.ts';
import { fakeMachine, listingBrowser } from '../unit/daemon/support.ts';

const start = async (machine = fakeMachine(['/work/alpha', '/work/beta'])) =>
  await testHost({ plugins: [implementProjects(machine)] });

describe('projects daemon half', () => {
  test('an empty registry lists nothing', async () => {
    const host = await start();
    const response = await host.request('GET', '/v1/projects', { as: device('d1') });
    expect(response.status).toBe(200);
    expect(response.json()).toEqual([]);
  });

  test('registering writes format 1 first, announces after the write, and lists the record', async () => {
    const host = await start();
    const response = await host.request('POST', '/v1/projects', {
      body: { kind: 'existing-folder', path: '/work/alpha' },
      as: owner(),
    });
    const record = response.json<ProjectInfo>();

    expect(response.status).toBe(200);
    expect(record).toMatchObject({ name: 'alpha', path: '/work/alpha', source: 'existing-folder' });
    const stored = JSON.parse(host.state('projects').raw(PROJECTS_STATE) as string);
    expect(Object.keys(stored)[0]).toBe('format');
    expect(stored).toMatchObject({ format: 1, projects: [record] });
    expect(host.published.map(event => event.event)).toEqual(['projects.registered']);
    expect((await host.request('GET', '/v1/projects', { as: owner() })).json()).toEqual([record]);
  });

  test('registering the same folder again answers the record already held and announces nothing new', async () => {
    const host = await start();
    const body = { kind: 'existing-folder', path: '/work/alpha' };
    const first = (await host.request('POST', '/v1/projects', { body, as: owner() })).json<ProjectInfo>();
    const again = (
      await host.request('POST', '/v1/projects', { body: { ...body, name: 'other' }, as: owner() })
    ).json<ProjectInfo>();

    expect(again.id).toBe(first.id);
    expect(host.published).toHaveLength(1);
  });

  test('a relative path is a 422 with the registration code; a malformed body is a 400', async () => {
    const host = await start();
    const relative = await host.request('POST', '/v1/projects', {
      body: { kind: 'existing-folder', path: 'alpha' },
      as: owner(),
    });
    const malformed = await host.request('POST', '/v1/projects', { body: { kind: 'nonsense' }, as: owner() });
    const missing = await host.request('POST', '/v1/projects', {
      body: { kind: 'existing-folder', path: '/work/absent' },
      as: owner(),
    });

    expect(relative.status).toBe(422);
    expect(relative.json<{ code: string }>().code).toBe('project_registration_failed');
    expect(malformed.status).toBe(400);
    expect(missing.status).toBe(422);
    expect(missing.json<{ error: string }>().error).toBe('project path is not an existing directory');
  });

  test('removing is a person’s act: a ferret is refused, the owner forgets the project and the folder stays', async () => {
    const machine = fakeMachine(['/work/alpha']);
    const host = await start(machine);
    const record = (
      await host.request('POST', '/v1/projects', {
        body: { kind: 'existing-folder', path: '/work/alpha' },
        as: owner(),
      })
    ).json<ProjectInfo>();

    const byFerret = await host.request('DELETE', `/v1/projects/${record.id}`, { as: ferret('f1') });
    const byOwner = await host.request('DELETE', `/v1/projects/${record.id}`, { as: owner() });
    const again = await host.request('DELETE', `/v1/projects/${record.id}`, { as: owner() });
    const unusable = await host.request('DELETE', '/v1/projects/not-an-id', { as: owner() });

    expect(byFerret.status).toBe(403);
    expect(byOwner.status).toBe(200);
    expect(byOwner.json<ProjectInfo>().id).toBe(record.id);
    expect(again.status).toBe(404);
    expect(unusable.status).toBe(400);
    expect(machine.directories.has('/work/alpha')).toBe(true);
    expect(host.published.map(event => event.event)).toEqual(['projects.registered', 'projects.removed']);
  });

  test('the projects port answers what the routes hold, and a restart keeps the registry', async () => {
    const host = await start();
    const port = host.provided(ProjectsPort);
    const added = await port.register({ kind: 'existing-folder', path: '/work/beta' });
    if (!added.ok) throw new Error('setup');

    const restarted = await host.restart();

    expect((await restarted.provided(ProjectsPort).find(added.value.id))?.path).toBe('/work/beta');
    expect((await restarted.request('GET', '/v1/projects', { as: owner() })).json<ProjectInfo[]>()).toHaveLength(1);
  });

  test('a damaged registry is never read as empty', async () => {
    const host = await start();
    host.state('projects').files.set('projects.json', '{ not json');

    const response = await host.request('GET', '/v1/projects', { as: owner() });

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});

describe('cloning another repository into a registered project (F-101)', () => {
  const ROOT = '/home/me/work/alpha';
  const URL_ONE = 'https://github.com/you/cloned.git';
  const world = async () => {
    const machine = fakeMachine([ROOT]);
    const names = () =>
      [...machine.repositories.keys()]
        .filter(path => path.startsWith(`${ROOT}/`))
        .map(path => path.slice(ROOT.length + 1));
    const host = await testHost({ plugins: [implementProjects(machine, { browser: listingBrowser(ROOT, names) })] });
    const made = (
      await host.request('POST', '/v1/projects', { body: { kind: 'existing-folder', path: ROOT }, as: owner() })
    ).json<ProjectInfo>();
    return { machine, host, id: made.id };
  };

  test('clones into the project, lists the repository on the record and keeps what was there', async () => {
    const { machine, host, id } = await world();
    const response = await host.request('POST', `/v1/projects/${id}/repos`, { body: { url: URL_ONE }, as: owner() });

    expect(response.status).toBe(200);
    expect(response.json<{ repos: { path: string }[] }>().repos.map(repo => repo.path)).toEqual(['cloned']);
    expect(machine.calls).toContain(`git clone ${URL_ONE} ${ROOT}/cloned`);
    const listed = (await host.request('GET', '/v1/projects', { as: owner() })).json<ProjectInfo[]>();
    expect(listed[0]?.repos?.map(repo => repo.path)).toEqual(['cloned']);
  });

  test('a second repository is added beside the first; the same one again is refused and not cloned twice', async () => {
    const { machine, host, id } = await world();
    await host.request('POST', `/v1/projects/${id}/repos`, { body: { url: URL_ONE }, as: owner() });
    const second = await host.request('POST', `/v1/projects/${id}/repos`, {
      body: { url: 'https://github.com/you/other.git' },
      as: owner(),
    });
    const again = await host.request('POST', `/v1/projects/${id}/repos`, { body: { url: URL_ONE }, as: owner() });

    expect(second.json<{ repos: { path: string }[] }>().repos.map(repo => repo.path)).toEqual(['cloned', 'other']);
    expect(again.status).toBe(422);
    expect(machine.calls.filter(call => call.startsWith('git clone'))).toHaveLength(2);
  });

  test('refuses an address that is not a clone address, an unknown project and a ferret caller, cloning nothing', async () => {
    const { machine, host, id } = await world();
    const bad = await host.request('POST', `/v1/projects/${id}/repos`, { body: { url: 'ext::sh -c x' }, as: owner() });
    const unknown = await host.request('POST', '/v1/projects/00000000-0000-4000-8000-0000000000ff/repos', {
      body: { url: URL_ONE },
      as: owner(),
    });
    const byFerret = await host.request('POST', `/v1/projects/${id}/repos`, {
      body: { url: URL_ONE },
      as: ferret('f1'),
    });

    expect(bad.status).toBe(400);
    expect(unknown.status).toBe(404);
    expect(byFerret.status).toBe(403);
    expect(machine.calls.filter(call => call.startsWith('git clone'))).toHaveLength(0);
  });
});
