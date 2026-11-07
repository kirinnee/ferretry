import { describe, expect, test } from 'bun:test';
import { owner, testHost } from '@ferretry/kernel/testing';
import { PROJECTS_STATE, type ProjectInfo } from '../../../contract/index.ts';
import { implementProjects } from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import { fakeMachine } from '../daemon/support.ts';

describe('storage parity', () => {
  test('F-0286 the registry is one state file of this plugin, projects.json, format 1 first', async () => {
    expect(manifest.data.state.map(file => [file.name, file.path, file.store, file.format])).toEqual([
      ['projects', 'projects.json', 'json', 1],
    ]);
    // The daemon half reads and writes through the contract's definition of that same declaration.
    const declared = manifest.data.state[0];
    expect([declared?.name, declared?.path, declared?.store, declared?.format]).toEqual([
      PROJECTS_STATE.name,
      PROJECTS_STATE.path,
      PROJECTS_STATE.store,
      PROJECTS_STATE.format,
    ]);

    const host = await testHost({ plugins: [implementProjects(fakeMachine(['/work/ferretry']))] });
    const record = (
      await host.request('POST', '/v1/projects', {
        body: { kind: 'existing-folder', path: '/work/ferretry' },
        as: owner(),
      })
    ).json<ProjectInfo>();
    const stored = JSON.parse(host.state('projects').raw(PROJECTS_STATE) as string) as Record<string, unknown>;

    expect(Object.keys(stored)[0]).toBe('format');
    expect(stored).toEqual({ format: 1, projects: [record] });
  });

  test('F-0286 a registry that is today’s bare array is damaged, never read as empty or converted', async () => {
    const host = await testHost({ plugins: [implementProjects(fakeMachine())] });
    host.state('projects').files.set('projects.json', '[]');

    const response = await host.request('GET', '/v1/projects', { as: owner() });

    expect(response.status).toBeGreaterThanOrEqual(500);
  });
});

describe('route parity', () => {
  test('R-0123 R-0318 the registry routes keep today’s descriptors', () => {
    const route = (key: string) => manifest.actions.routes.find(candidate => candidate.key === key);
    expect(route('GET /v1/projects')).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true });
    expect(route('GET /v1/projects')?.capability).toBeUndefined();
    expect(route('POST /v1/projects')).toMatchObject({ minimum: 'operator', caller: 'any', noStore: true });
    expect(route('POST /v1/projects')?.capability).toMatchObject({ axis: 'configure' });
  });
});
