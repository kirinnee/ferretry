import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, ferretStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { ProjectInfoSchema } from '@ferretry/plugin-projects/contract';
import type { ApiRequest, CallContext } from '@ferretry/kernel/contract';
import daemon from '../../daemon/index.ts';
import { worktreeRoutes } from '../../daemon/lib/worktrees/routes.ts';
import { TidyWorktreesService } from '../../daemon/lib/worktrees/service.ts';

const project = ProjectInfoSchema.parse({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Test',
  path: '/synthetic/project',
  source: 'existing-folder',
  createdAt: '2026-11-01T00:00:00.000Z',
  git: { commonDirectory: '/synthetic/project/.git' },
});
const base = `/v1/tidy/worktrees/${project.id}`;

describe('worktree routes and optional ports', () => {
  test('without Projects the route is unavailable and existing scratch routes still work', async () => {
    const h = await testHost({ plugins: [daemon], fakes: { ferrets: new FakeFerrets(), asks: new FakeAsks() } });
    try {
      expect((await h.request('GET', base)).status).toBe(503);
      expect((await h.request('GET', '/v1/gc')).status).toBe(200);
    } finally {
      await h.stop();
    }
  });

  test('validates project and exact paths before invoking services; rejects all force flags', async () => {
    const h = await testHost({ plugins: [daemon], fakes: { ferrets: new FakeFerrets(), asks: new FakeAsks() } });
    try {
      expect((await h.request('GET', '/v1/tidy/worktrees/not-an-id')).status).toBe(400);
      expect((await h.request('GET', `${base}?unknown=x`)).status).toBe(400);
      for (const body of [
        {},
        { paths: [] },
        { paths: ['relative'] },
        { paths: ['/synthetic'], overrides: ['discard_worktree_changes'] },
        { paths: ['/synthetic'], confirmations: ['delete_unpushed_branch'] },
      ])
        expect((await h.request('POST', `${base}/clean-merged`, { body })).status).toBe(422);
    } finally {
      await h.stop();
    }
  });

  test('wire routes expose unknown evidence as kept, and bulk lists skipped paths', async () => {
    const ferrets = new FakeFerrets();
    const unknown = {
      path: '/synthetic/tree',
      main: false,
      bare: false,
      tracked: 'none' as const,
      live: { detached: false, branch: 'feature', undetermined: ['not readable'] },
    };
    const h = await testHost({
      plugins: [daemon],
      gate: new StandInAdmission(() => ownerStanding()),
      fakes: {
        asks: new FakeAsks(),
        ferrets: Object.assign(ferrets, {
          repoWorktrees: async () => ({
            commonDirectory: '/synthetic/project/.git',
            worktrees: [unknown],
            total: 1,
            truncated: false,
          }),
        }),
      },
      uses: { projects: { find: async () => project } },
    });
    try {
      const response = await h.request('GET', base);
      expect(response.status).toBe(200);
      expect(response.json<{ rows: { verdict: { removable: boolean } }[] }>().rows[0]?.verdict.removable).toBe(false);
      const applied = await h.request('POST', `${base}/remove`, { body: { paths: [unknown.path] } });
      expect(applied.status).toBe(200);
      expect(applied.json()).toMatchObject({ removed: [], skipped: [{ path: unknown.path }] });
    } finally {
      await h.stop();
    }
  });

  test('a ferret cannot hide its own folder with a caller-declared cwd', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('self'), folder: '/synthetic/own' });
    const service = {
      remove: async (_id: string, _paths: string[], cwd?: string) => {
        expect(cwd).toBe('/synthetic/own');
        return { removed: [], skipped: [] };
      },
    } as unknown as TidyWorktreesService;
    const r = worktreeRoutes(service, ferrets);
    const context = {
      request: {
        text: async () => JSON.stringify({ paths: ['/synthetic/own'], currentWorkingDirectory: '/elsewhere' }),
      } as unknown as ApiRequest,
      params: new Map([['project', project.id]]),
      ...ferretStanding(ferretId('self')),
    } as unknown as CallContext;
    // CallContext carries the admission's standing, as testHost does in real dispatch.
    const h = await testHost({
      plugins: [daemon],
      gate: new StandInAdmission(() => ferretStanding(ferretId('self'))),
      fakes: { asks: new FakeAsks(), ferrets },
    });
    try {
      expect(
        (
          await h.request('POST', `${base}/remove`, {
            body: { paths: ['/synthetic/own'], currentWorkingDirectory: '/elsewhere' },
          })
        ).status,
      ).toBe(200);
      // No Projects: apply keeps it. The handler above separately pins the effective folder.
      await r['POST /v1/tidy/worktrees/:project/remove'](context);
    } finally {
      await h.stop();
    }
  });

  test('unreadable JSON and a caller whose own folder is missing are refused', async () => {
    const service = new TidyWorktreesService({ ferrets: {}, projects: () => undefined, pulls: () => undefined });
    const r = worktreeRoutes(service, new FakeFerrets());
    const context = {
      params: new Map([['project', project.id]]),
      request: { text: async () => '{' },
    } as unknown as CallContext;
    await expect(r['POST /v1/tidy/worktrees/:project/remove'](context)).rejects.toMatchObject({ status: 400 });
    const h = await testHost({
      plugins: [daemon],
      gate: new StandInAdmission(() => ferretStanding(ferretId('missing'))),
      fakes: { asks: new FakeAsks(), ferrets: new FakeFerrets() },
    });
    try {
      expect((await h.request('GET', base)).status).toBe(503);
    } finally {
      await h.stop();
    }
  });

  test('missing optional listings, unknown projects and unreadable repositories never offer removal', async () => {
    const subject = (ferrets = {}, find = async () => project) =>
      new TidyWorktreesService({
        ferrets,
        projects: () => ({ find }),
        pulls: () => undefined,
      });
    await expect(subject().list(project.id)).rejects.toMatchObject({ status: 503 });
    await expect(
      subject(
        {
          repoWorktrees: async () => {
            throw new Error('unused');
          },
        },
        async () => undefined as never,
      ).list(project.id),
    ).rejects.toMatchObject({ status: 404 });
    const result = await subject({
      repoWorktrees: async () => {
        throw new Error('synthetic Git failure');
      },
    }).list(project.id);
    expect(result.rows).toEqual([]);
    expect(result.unavailable).toHaveLength(1);
  });
});
