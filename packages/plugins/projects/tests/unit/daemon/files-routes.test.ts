import { describe, expect, test } from 'bun:test';
import type { CallContext } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import {
  ProjectFilesAnswerSchema,
  ProjectFilesStatusSchema,
  ProjectIndexSummarySchema,
} from '../../../contract/index.ts';
import { type ProjectIndex, ProjectFolderRefused } from '../../../daemon/features/files/build.ts';
import { ProjectIndexCache } from '../../../daemon/features/files/cache.ts';
import { filesRescanRoute, filesRoute, filesStatusRoute } from '../../../daemon/features/files/routes.ts';
import { fakeMachine, registryOver } from './support.ts';

const callWith = (params: Record<string, string>, query: Record<string, string> = {}): CallContext =>
  ({
    request: { query: new Map(Object.entries(query).map(([name, value]) => [name, [value]])), text: async () => '' },
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
    return error as { status: number; code: string };
  }
  throw new Error('the route answered');
};

const entry = (path: string) => ({ path, name: path.split('/').at(-1) ?? path });
const READY: ProjectIndex = {
  files: ['README.md', 'src/app.ts', 'src/readme.ts'].map(entry),
  summary: {
    builtAt: '2026-11-22T00:00:00.000Z' as Instant,
    indexed: 3,
    coverage: 'complete',
    skipped: [{ reason: 'denied', count: 2 }],
    biggestFolders: [{ folder: 'src', files: 2 }],
    nestedWorktrees: [],
  },
};

const setup = async (build: (path: string) => Promise<ProjectIndex> = async () => READY) => {
  const world = registryOver(fakeMachine(['/work/alpha']));
  const made = await world.registry.register({ kind: 'existing-folder', path: '/work/alpha' });
  if (!made.ok) throw new Error('not registered');
  const cache = new ProjectIndexCache(build, () => 0);
  return { ...world, id: made.value.id, cache };
};

describe('GET /v1/projects/:id/files', () => {
  test('answers the best matches with the coverage block, and the answer is the contract’s', async () => {
    const { registry, cache, id } = await setup();

    const got = answer(await filesRoute(registry, cache)(callWith({ id }, { q: 'readme', limit: '5' })));

    expect(got.status).toBe(200);
    expect(ProjectFilesAnswerSchema.parse(got.json)).toEqual({
      files: [entry('README.md'), entry('src/readme.ts')],
      total: 2,
      rebuilding: false,
      index: READY.summary,
    });
  });

  test('no q lists the top of the index; a blank q is the same; the default limit is 50', async () => {
    const { registry, cache, id } = await setup();

    const none = ProjectFilesAnswerSchema.parse(answer(await filesRoute(registry, cache)(callWith({ id }))).json);
    const blank = ProjectFilesAnswerSchema.parse(
      answer(await filesRoute(registry, cache)(callWith({ id }, { q: '   ' }))).json,
    );

    expect(none.files).toHaveLength(3);
    expect(blank).toEqual(none);
  });

  test('refuses what it cannot read: an unknown parameter, a bad limit, a control character, a bad or unknown project', async () => {
    const { registry, cache, id } = await setup();
    const route = filesRoute(registry, cache);

    expect((await failure(() => route(callWith({ id }, { hidden: '1' })))).code).toBe('unknown_parameter');
    for (const limit of ['0', '201', '-1', 'x', '1.5'])
      expect((await failure(() => route(callWith({ id }, { limit })))).code).toBe('invalid_limit');
    expect((await failure(() => route(callWith({ id }, { q: 'a\u0001b' })))).code).toBe('invalid_query');
    expect((await failure(() => route(callWith({ id: 'nope' })))).code).toBe('invalid_project_id');
    expect((await failure(() => route(callWith({ id: crypto.randomUUID() })))).status).toBe(404);
  });

  test('a project folder that cannot be indexed is told apart: private is 403, not there is 404, and nothing else is said', async () => {
    const privateOne = await setup(async () => {
      throw new ProjectFolderRefused('private');
    });
    const missing = await setup(async () => {
      throw new ProjectFolderRefused('unavailable');
    });
    const broken = await setup(async () => {
      throw new Error('boom');
    });

    const denied = await failure(() =>
      filesRoute(privateOne.registry, privateOne.cache)(callWith({ id: privateOne.id })),
    );
    const gone = await failure(() => filesRoute(missing.registry, missing.cache)(callWith({ id: missing.id })));
    const other = await failure(() => filesRoute(broken.registry, broken.cache)(callWith({ id: broken.id })));

    expect([denied.status, denied.code]).toEqual([403, 'project_folder_private']);
    expect([gone.status, gone.code]).toEqual([404, 'project_folder_unavailable']);
    expect(other).toBeInstanceOf(Error);
    expect(other.status).toBeUndefined();
  });
});

describe('the status and rescan routes', () => {
  test('status answers none yet and starts the first build; once built it answers the coverage block alone', async () => {
    const { registry, cache, id } = await setup();
    const route = filesStatusRoute(registry, cache);

    const first = ProjectFilesStatusSchema.parse(answer(await route(callWith({ id }))).json);
    await Promise.resolve();
    await Promise.resolve();
    const second = ProjectFilesStatusSchema.parse(answer(await route(callWith({ id }))).json);

    expect(first).toEqual({ rebuilding: true });
    expect(second).toEqual({ rebuilding: false, index: READY.summary });
    expect(JSON.stringify(second)).not.toContain('README');
  });

  test('rescan answers at once that a rebuild is running, with the index there is', async () => {
    const { registry, cache, id } = await setup();
    await filesRoute(registry, cache)(callWith({ id }));

    const got = ProjectFilesStatusSchema.parse(answer(await filesRescanRoute(registry, cache)(callWith({ id }))).json);

    expect(got.rebuilding).toBe(true);
    expect(got.index).toEqual(READY.summary);
  });
});

describe('the summary schema', () => {
  test('refuses a complete index that names a bound that bit, and a partial one that names none', () => {
    const base = READY.summary;

    expect(ProjectIndexSummarySchema.safeParse({ ...base, skipped: [{ reason: 'truncated', count: 1 }] }).success).toBe(
      false,
    );
    expect(ProjectIndexSummarySchema.safeParse({ ...base, coverage: 'partial' }).success).toBe(false);
    expect(
      ProjectIndexSummarySchema.safeParse({
        ...base,
        coverage: 'partial',
        skipped: [{ reason: 'unreadable', count: 1 }],
      }).success,
    ).toBe(true);
  });
});
