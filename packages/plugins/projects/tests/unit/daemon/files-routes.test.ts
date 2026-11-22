import { describe, expect, test } from 'bun:test';
import type { CallContext } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import {
  ProjectFilesAnswerSchema,
  ProjectFilesStatusSchema,
  ProjectIndexSummarySchema,
} from '../../../contract/index.ts';
import { type ProjectIndex, ProjectFolderRefused } from '../../../daemon/features/files/build.ts';
import { IndexCacheBusy, ProjectIndexCache } from '../../../daemon/features/files/cache.ts';
import {
  type FilePlace,
  filesRescanRoute as rescanOver,
  filesRoute as readOver,
  filesStatusRoute as statusOver,
} from '../../../daemon/features/files/routes.ts';
import { fakeMachine, registryOver } from './support.ts';

/** The fake machine's home is `/work`, so its project `/work/alpha` is INSIDE it: the outside-home gate is never asked. */
const IN_HOME: FilePlace = { home: async () => '/work', resolve: async path => path.replace(/(?<=.)\/+$/u, '') };
const filesRoute = (...args: [Parameters<typeof readOver>[0], Parameters<typeof readOver>[1], FilePlace?]) =>
  readOver(args[0], args[1], args[2] ?? IN_HOME);
const filesStatusRoute = (...args: [Parameters<typeof readOver>[0], Parameters<typeof readOver>[1], FilePlace?]) =>
  statusOver(args[0], args[1], args[2] ?? IN_HOME);
const filesRescanRoute = (...args: [Parameters<typeof readOver>[0], Parameters<typeof readOver>[1], FilePlace?]) =>
  rescanOver(args[0], args[1], args[2] ?? IN_HOME);

type Decision = { allowed: boolean; refusal: string; steppedUp?: boolean };
const callWith = (
  params: Record<string, string>,
  query: Record<string, string> = {},
  standing: object = {},
): CallContext =>
  ({
    request: { query: new Map(Object.entries(query).map(([name, value]) => [name, [value]])), text: async () => '' },
    params: new Map(Object.entries(params)),
    ...standing,
  }) as unknown as CallContext;

/** What Gate's standing answers for `filesystem.configure` (the routes' own `filesystem.use` is already admitted). */
const governed = (configure: Decision) => {
  const asked: string[] = [];
  const spent = { count: 0 };
  return {
    asked,
    spent,
    standing: {
      governance: {
        governed: true,
        decide: (demand: { axis: string }) => {
          asked.push(demand.axis);
          return configure;
        },
      },
      spendStepUp: () => {
        spent.count++;
      },
    },
  };
};

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

describe('a cached index is only answered while the registered path is still the place that was indexed', () => {
  test('all three routes forget the index and refuse when the path no longer resolves to itself', async () => {
    const { registry, cache, id } = await setup();
    let held = true;
    const holds: FilePlace = { home: IN_HOME.home, resolve: async path => (held ? path : '/work/elsewhere') };
    await filesRoute(registry, cache, holds)(callWith({ id }));
    held = false;

    const read = await failure(() => filesRoute(registry, cache, holds)(callWith({ id })));
    const status = await failure(() => filesStatusRoute(registry, cache, holds)(callWith({ id })));
    const rescan = await failure(() => filesRescanRoute(registry, cache, holds)(callWith({ id })));

    for (const refused of [read, status, rescan])
      expect([refused.status, refused.code]).toEqual([404, 'project_folder_unavailable']);
    held = true;
    expect(
      ProjectFilesStatusSchema.parse(answer(await filesStatusRoute(registry, cache, holds)(callWith({ id }))).json)
        .index,
    ).toBeUndefined();
  });

  test('a cache with nowhere to put another project answers 503, not a hang', async () => {
    const { registry, id } = await setup();
    const full = {
      read: async () => {
        throw new IndexCacheBusy();
      },
    } as unknown as ProjectIndexCache;

    const refused = await failure(() => filesRoute(registry, full)(callWith({ id })));

    expect([refused.status, refused.code]).toEqual([503, 'index_busy']);
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

describe('a project folder OUTSIDE the home needs filesystem.configure on all three routes (U4’s gate, D3)', () => {
  /** The fake machine's `/work/alpha` is outside a home at `/home/owner`. */
  const OUTSIDE: FilePlace = { home: async () => '/home/owner', resolve: IN_HOME.resolve };
  const ALL = [
    ['read', filesRoute],
    ['status', filesStatusRoute],
    ['rescan', filesRescanRoute],
  ] as const;

  test('a use-only device is refused (403, Gate’s grant code) before anything is built or answered from memory', async () => {
    for (const [name, route] of ALL) {
      const built: string[] = [];
      const { registry, cache, id } = await setup(async path => {
        built.push(path);
        return READY;
      });
      await cache.read(id, '/work/alpha');
      built.length = 0;
      const { standing, asked } = governed({ allowed: false, refusal: 'device-not-granted' });

      const refused = await failure(() => route(registry, cache, OUTSIDE)(callWith({ id }, {}, standing)));

      expect([name, refused.status, refused.code]).toEqual([name, 403, 'grant_device_not_granted']);
      expect(asked).toEqual(['configure']);
      expect(built).toEqual([]);
    }
  });

  test('a device that has not stepped up is told to, with the demand to satisfy', async () => {
    const { registry, cache, id } = await setup();
    const { standing } = governed({ allowed: false, refusal: 'step-up-required' });

    const refused = (await failure(() => filesRoute(registry, cache, OUTSIDE)(callWith({ id }, {}, standing)))) as {
      status: number;
      code: string;
    };

    expect([refused.status, refused.code]).toEqual([403, 'grant_step_up_required']);
  });

  test('a device holding configure is answered on all three, and a per-act step-up is spent once per request', async () => {
    for (const [, route] of ALL) {
      const { registry, cache, id } = await setup();
      const { standing, asked, spent } = governed({ allowed: true, refusal: 'granted', steppedUp: true });

      const got = answer(await route(registry, cache, OUTSIDE)(callWith({ id }, {}, standing)));

      expect(got.status).toBe(200);
      expect(asked).toEqual(['configure']);
      expect(spent.count).toBe(1);
    }
  });

  test('the caller at the machine (ungoverned) passes', async () => {
    const { registry, cache, id } = await setup();
    const standing = { governance: { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) } };

    expect(answer(await filesRoute(registry, cache, OUTSIDE)(callWith({ id }, {}, standing))).status).toBe(200);
  });

  test('a call with no standing is refused (503), never read on a guess', async () => {
    const { registry, cache, id } = await setup();

    const refused = await failure(() => filesRoute(registry, cache, OUTSIDE)(callWith({ id })));

    expect([refused.status, refused.code]).toEqual([503, 'folder_gate_unavailable']);
  });

  test('a spelling INSIDE the home that resolves OUTSIDE it is decided on where it really is', async () => {
    const { registry, cache, id } = await setup();
    const through: FilePlace = { home: IN_HOME.home, resolve: async () => '/srv/elsewhere' };
    const { standing, asked } = governed({ allowed: false, refusal: 'device-not-granted' });

    const refused = await failure(() => filesRoute(registry, cache, through)(callWith({ id }, {}, standing)));

    expect([refused.status, refused.code]).toEqual([403, 'grant_device_not_granted']);
    expect(asked).toEqual(['configure']);
  });

  test('a project INSIDE the home needs only use: the configure decision is never asked', async () => {
    const { registry, cache, id } = await setup();
    const { standing, asked } = governed({ allowed: false, refusal: 'device-not-granted' });

    expect(answer(await filesRoute(registry, cache)(callWith({ id }, {}, standing))).status).toBe(200);
    expect(asked).toEqual([]);
  });
});
