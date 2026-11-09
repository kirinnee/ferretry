/**
 * The skills routes as the host runs them, with Runtimes and Projects bound (fakes): the machine inventory lists the
 * account homes and registered projects, the file route serves only a path an inventory lists, and every route says
 * `no-store`. The shadowing rules are the service's (`inventory.test.ts`); this proves the wiring around them.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { fakeProjects } from '@ferretry/plugin-projects/contract/testing';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import type { RuntimeHome, RuntimeHomeReader, RuntimeId } from '@ferretry/plugin-runtimes/contract';
import manifest from '../../manifest.ts';
import skills from '../../daemon/index.ts';

const HOME: RuntimeHome = {
  id: 'a',
  harness: 'claude-code',
  runtimes: ['claude-a' as RuntimeId],
  home: '/fy/fleet/homes/a',
  wrapper: '/fy/fleet/bin/claude-a',
};
const MINE = `${HOME.home}/skills/mine/SKILL.md`;
const OURS = `${HOME.home}/skills/ours/SKILL.md`;
const ASSET = '/fy/fleet/assets/skills/tool/SKILL.md';
const doc = (name: string): string => `---\nname: ${name}\ndescription: does ${name}\n---\n# ${name}\n`;

const reader = (): RuntimeHomeReader => ({
  document: async () => null,
  skills: async () => [
    { name: 'mine', manifest: MINE, managed: false },
    { name: 'ours', manifest: OURS, managed: true },
  ],
  skillManifest: async name => (name === 'mine' || name === 'ours' ? doc(name) : undefined),
  skillTree: async () => undefined,
  skillFile: async () => ({ ok: false, reason: 'unreadable' }),
});

const as = (...capabilities: string[]) => ({ kind: 'device', holder: 'dev_a', capabilities }) as const;
const route = (key: string) => manifest.actions.routes.find(candidate => candidate.key === key);

async function host(options: { runtimes?: boolean; projects?: boolean } = {}) {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app', runtime: 'claude-a' });
  const runtimes = fakeRuntimes();
  runtimes.setHomes([HOME], { a: reader() });
  runtimes.setAssetSkills({
    skills: async () => [{ name: 'tool', manifest: ASSET, managed: true }],
    skillManifest: async name => (name === 'tool' ? doc('tool') : undefined),
  });
  runtimes.setProfiles([], [{ runtime: 'claude-a' as RuntimeId, profile: 'p', mcp: [], skills: ['picked'] }]);
  const projects = fakeProjects();
  await projects.register({ kind: 'existing-folder', path: '/work/app', name: 'App' });
  const uses: Record<string, unknown> = {
    ...(options.runtimes === false ? {} : { runtimes }),
    ...(options.projects === false ? {} : { projects }),
  };
  return await testHost({
    plugins: [skills],
    fakes: { ferrets },
    uses,
    config: { skills: { picked: { items: ['absent-from-store'] } } },
  });
}

describe('the skills routes with homes and projects bound', () => {
  test('R-0197 GET /v1/skills lists every account home and registered project, no-store', async () => {
    expect(route('GET /v1/skills')?.noStore).toBe(true);
    const h = await host();
    const res = await h.request('GET', '/v1/skills');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = res.json<{
      homes: { runtime: string; home: string; skills: { name: string; scope: string; path: string }[] }[];
      projects: { id: string; name: string; root: string }[];
    }>();
    expect(body.homes).toHaveLength(1);
    expect(body.homes[0]).toMatchObject({ runtime: 'claude-a', home: HOME.home });
    expect(body.homes[0]!.skills.map(skill => [skill.name, skill.scope, skill.path])).toEqual([
      ['mine', 'user', MINE],
      ['ours', 'ferretry', OURS],
      ['tool', 'ferretry', ASSET],
    ]);
    expect(body.projects.map(project => [project.name, project.root])).toEqual([['App', '/work/app']]);
  });

  test('R-0197 with Runtimes and Projects off the machine inventory answers empty, not an error', async () => {
    const h = await host({ runtimes: false, projects: false });
    const res = await h.request('GET', '/v1/skills');
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ homes: [], projects: [], truncated: false });
  });

  test('R-0197 a device without fleet.use is refused', async () => {
    expect(route('GET /v1/skills')?.capability).toMatchObject({ capability: 'fleet', axis: 'use' });
    const h = await host();
    expect((await h.request('GET', '/v1/skills', { as: as('filesystem.use') })).status).toBe(403);
    expect((await h.request('GET', '/v1/skills', { as: as('fleet.use') })).status).toBe(200);
  });

  test('R-0198 the file route serves a listed home skill, a Ferretry asset, and says no-store', async () => {
    const h = await host();
    for (const path of [MINE, OURS, ASSET]) {
      const res = await h.request('GET', '/v1/skills/file', { query: { path } });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.json()).toEqual({ path, content: doc(path.split('/').at(-2)!) });
    }
  });

  test('R-0198 an unlisted file inside a registered root, a traversal and a missing path answer 404 or 400', async () => {
    const h = await host();
    const ask = async (path: string) => await h.request('GET', '/v1/skills/file', { query: { path } });
    for (const path of [
      '/work/app/.claude/skills/notes/readme.md',
      '/work/app/.claude/skills/notes/SKILL.md',
      `${HOME.home}/skills/mine/../../../../etc/passwd`,
      `${HOME.home}/skills/unlisted/SKILL.md`,
      '/fy/fleet/assets/skills/planted/SKILL.md',
      '/etc/passwd',
    ]) {
      const res = await ask(path);
      expect(res.status).toBe(404);
      expect(res.json()).toMatchObject({ code: 'not-found' });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect((await h.request('GET', '/v1/skills/file')).status).toBe(400);
  });

  test('R-0198 filesystem.use is demanded: fleet.use alone is refused, filesystem.use alone reads', async () => {
    expect(route('GET /v1/skills/file')?.capability).toMatchObject({ capability: 'filesystem', axis: 'use' });
    const h = await host();
    const query = { path: MINE };
    expect((await h.request('GET', '/v1/skills/file', { query, as: as('fleet.use') })).status).toBe(403);
    expect((await h.request('GET', '/v1/skills/file', { query, as: as('filesystem.use') })).status).toBe(200);
  });

  test('R-0175 a ferret’s skills are its runtime home’s plus the Ferretry skills, and an unknown ferret is 404', async () => {
    expect(route('GET /v1/ferrets/:ferretId/skills')?.noStore).toBe(true);
    const h = await host();
    const res = await h.request('GET', '/v1/ferrets/f1/skills');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(
      res.json<{ skills: { name: string; scope: string }[] }>().skills.map(skill => [skill.name, skill.scope]),
    ).toEqual([
      ['mine', 'global'],
      ['ours', 'global'],
      ['tool', 'global'],
    ]);
    const nobody = await h.request('GET', '/v1/ferrets/nobody/skills');
    expect(nobody.status).toBe(404);
    expect(nobody.headers.get('cache-control')).toBe('no-store');
  });

  test('R-0176 a ferret’s inventory names its runtime and each skill’s source, and serves a listed file of its own view', async () => {
    expect(route('GET /v1/ferrets/:ferretId/skills/inventory')?.noStore).toBe(true);
    const h = await host();
    const res = await h.request('GET', '/v1/ferrets/f1/skills/inventory');
    expect(res.status).toBe(200);
    const body = res.json<{ runtime: string; folder: string; skills: { name: string; scope: string }[] }>();
    expect(body).toMatchObject({ runtime: 'claude-a', folder: '/work/app' });
    expect(body.skills.map(skill => [skill.name, skill.scope])).toEqual([
      ['mine', 'user'],
      ['ours', 'ferretry'],
      ['tool', 'ferretry'],
    ]);
    const listed = await h.request('GET', '/v1/skills/file', { query: { path: MINE, ferretId: 'f1' } });
    expect(listed.status).toBe(200);
    const unlisted = await h.request('GET', '/v1/skills/file', {
      query: { path: '/work/app/.claude/skills/x/SKILL.md', ferretId: 'f1' },
    });
    expect(unlisted.status).toBe(404);
    expect((await h.request('GET', '/v1/ferrets/nobody/skills/inventory')).status).toBe(404);
    expect((await h.request('GET', '/v1/skills/file', { query: { path: MINE, ferretId: 'nobody' } })).status).toBe(404);
  });

  test('a ferret with no published runtime lists nothing from any home, and its selected-but-uninstalled items nothing', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f2'), folder: '/work/app', runtime: 'not-published' });
    const runtimes = fakeRuntimes();
    runtimes.setHomes([HOME], { a: reader() });
    const h = await testHost({ plugins: [skills], fakes: { ferrets }, uses: { runtimes } });
    const res = await h.request('GET', '/v1/ferrets/f2/skills/inventory');
    expect(res.json<{ skills: unknown[]; runtime?: string }>()).toMatchObject({ skills: [] });
    expect(res.json<{ runtime?: string }>().runtime).toBeUndefined();
  });
});
