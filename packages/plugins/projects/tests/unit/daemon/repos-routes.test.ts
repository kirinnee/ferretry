import { describe, expect, test } from 'bun:test';
import type { CallContext } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { accountsRoute, cloneRoute, reposRoute } from '../../../daemon/features/repos/routes.ts';
import type { FolderBrowser } from '../../../daemon/features/folders/port.ts';
import { fakeMachine, listingBrowser, registryOver } from './support.ts';

type Decision = { allowed: boolean; refusal: string; steppedUp?: boolean };
/** What Gate's `governance` answers for `filesystem.configure` (the route's own `filesystem.use` is already admitted). */
const governed = (configure: Decision) => ({
  governed: true,
  decide: (demand: { capability: string; axis: string }) =>
    demand.axis === 'configure' ? configure : { allowed: true, refusal: 'granted' },
});
const OWNER = { governed: false, decide: () => ({ allowed: true, refusal: 'granted' }) };

const callWith = (
  body: unknown,
  params: Record<string, string> = {},
  governance: { governed: boolean; decide: (demand: never) => Decision } | undefined = undefined,
): CallContext =>
  ({
    request: { text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) },
    params: new Map(Object.entries(params)),
    ...(governance === undefined ? {} : { governance }),
  }) as unknown as CallContext;
const answer = (response: { readonly status: number; readonly body: unknown }) => ({
  status: response.status,
  json: JSON.parse(String(response.body)) as Record<string, unknown>,
});
const failure = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error as { status: number; code: string };
  }
  throw new Error('the route answered');
};

const at = '2026-11-19T00:00:00.000Z' as Instant;
/** A machine whose only folder is `root`, holding one repository `app`. */
const browserAt = (root: string): FolderBrowser => ({
  home: async () => '/home/me',
  holdsSignIn: async () => false,
  leaf: async () => 'present',
  realPaths: async paths => [...paths],
  open: async (path, verdict) => {
    if ((await verdict(path)) !== undefined) return { ok: false, reason: 'refused' };
    return {
      ok: true,
      folder: {
        real: path,
        entries: async () => ({
          entries: path === root ? [{ name: 'app', kind: 'directory' as const, modified: at }] : [],
          more: false,
        }),
        lookup: async () => 'missing',
        readText: async () => '[remote "origin"]\n\turl = https://tok:en@github.com/o/app.git\n',
        hasGit: async name => name === 'app',
        device: async () => 'd1',
        makeLeaf: async () => ({ kind: 'failed' }),
        close: async () => undefined,
      },
    };
  },
});
const browser = browserAt('/home/me/work/alpha');

const setup = async (root = '/home/me/work/alpha') => {
  const world = registryOver(fakeMachine([root]));
  const made = await world.registry.register({ kind: 'existing-folder', path: root });
  if (!made.ok) throw new Error('not registered');
  const scan = { browser: browserAt(root) };
  return { ...world, id: made.value.id, scan };
};

describe('GET /v1/projects/:id/repos', () => {
  test('answers what a scan finds, keeps it on the record, and never shows a credential in a remote', async () => {
    const { registry, id, scan, store } = await setup();
    const got = answer(await reposRoute(registry, scan)(callWith(undefined, { id })));
    expect(got.status).toBe(200);
    expect(got.json).toEqual({
      repos: [{ path: 'app', remote: 'https://github.com/o/app', provider: 'github' }],
      truncated: false,
    });
    expect(JSON.stringify(store.file)).not.toContain('tok');
    expect(store.file.projects[0]?.repos?.[0]?.path).toBe('app');
  });
  test('a scan that could not see everything keeps a stored repository and its account link', async () => {
    const { registry, id, store } = await setup();
    await registry.recordRepos(id, [{ path: 'gone', remote: 'https://github.com/o/gone', provider: 'github' }], true);
    await store.update(file => ({
      ...file,
      projects: file.projects.map(project => ({
        ...project,
        repos: project.repos?.map(repo => ({ ...repo, account: 'work' })),
      })),
    }));
    // the project folder is not there this time (an unmounted disk): the scan answers nothing and says it saw nothing
    const missing: FolderBrowser = { ...browser, leaf: async () => 'missing' };
    const got = answer(await reposRoute(registry, { browser: missing })(callWith(undefined, { id })));
    expect(got.json).toEqual({
      repos: [{ path: 'gone', remote: 'https://github.com/o/gone', provider: 'github', account: 'work' }],
      truncated: true,
    });
    expect(store.file.projects[0]?.repos?.[0]?.account).toBe('work');
  });
  test('a folder too wide to read to the end is truncated, never silently dropped: what was stored, and its account link, stay', async () => {
    const { registry, id, store } = await setup();
    await registry.recordRepos(id, [{ path: 'wide-one' }], true);
    await store.update(file => ({
      ...file,
      projects: file.projects.map(project => ({
        ...project,
        repos: project.repos?.map(repo => ({ ...repo, account: 'work' })),
      })),
    }));
    const base = browserAt('/home/me/work/alpha');
    const wide: FolderBrowser = {
      ...base,
      open: async (path, verdict) => {
        const held = await base.open(path, verdict);
        if (!held.ok) return held;
        return { ok: true, folder: { ...held.folder, entries: async () => ({ entries: [], more: true }) } };
      },
    };
    const got = answer(await reposRoute(registry, { browser: wide })(callWith(undefined, { id })));
    expect(got.json).toEqual({ repos: [{ path: 'wide-one', account: 'work' }], truncated: true });
    expect(store.file.projects[0]?.repos).toEqual([{ path: 'wide-one', account: 'work' }]);
  });
  test('a child whose names the sign-in look could not read to the end (R3) is not indexed and truncates the answer: what was stored, and its account link, stay', async () => {
    const { registry, id, store } = await setup();
    await registry.recordRepos(id, [{ path: 'stored' }], true);
    await store.update(file => ({
      ...file,
      projects: file.projects.map(project => ({
        ...project,
        repos: project.repos?.map(repo => ({ ...repo, account: 'work' })),
      })),
    }));
    // `app` holds more names than the look reads: no marker was seen, and a differently spelled one past the bound is not ruled out
    const unseen: FolderBrowser = {
      ...browserAt('/home/me/work/alpha'),
      holdsSignIn: async path => (path.endsWith('/app') ? 'partial' : false),
    };
    const got = answer(await reposRoute(registry, { browser: unseen })(callWith(undefined, { id })));
    expect(got.json).toEqual({ repos: [{ path: 'stored', account: 'work' }], truncated: true });
    expect(store.file.projects[0]?.repos).toEqual([{ path: 'stored', account: 'work' }]);
  });
  test('a project folder outside the home folder is scanned, and the answer has no field about the home', async () => {
    const { registry, id, store } = await setup('/srv/alpha');
    const elsewhere: FolderBrowser = { ...browserAt('/srv/alpha'), home: async () => '/home/me' };
    const got = answer(await reposRoute(registry, { browser: elsewhere })(callWith(undefined, { id }, OWNER)));
    expect(got.json).toEqual({
      repos: [{ path: 'app', remote: 'https://github.com/o/app', provider: 'github' }],
      truncated: false,
    });
    expect(store.file.projects[0]?.repos?.[0]?.path).toBe('app');
  });

  describe('a registered project OUTSIDE the home (LEAD DECISION R1: reading saved results is use; STARTING a scan is filesystem.configure)', () => {
    /** A project at `/srv/alpha` with one repository already saved, and a browser that writes down every folder it is asked to open. */
    const outside = async () => {
      const world = await setup('/srv/alpha');
      await world.registry.recordRepos(world.id, [{ path: 'saved', remote: 'https://github.com/o/saved' }], true);
      const opened: string[] = [];
      const base = browserAt('/srv/alpha');
      const scan = {
        browser: {
          ...base,
          open: async (path: string, verdict: Parameters<FolderBrowser['open']>[1]) => {
            opened.push(path);
            return base.open(path, verdict);
          },
        } as FolderBrowser,
      };
      return { ...world, scan, opened };
    };
    const SAVED = { repos: [{ path: 'saved', remote: 'https://github.com/o/saved' }], truncated: true };

    test('a use-only device reads what was saved, starts no scan and touches nothing outside the home', async () => {
      const { registry, id, scan, opened, store } = await outside();
      const before = JSON.stringify(store.file);
      const got = answer(
        await reposRoute(
          registry,
          scan,
        )(callWith(undefined, { id }, governed({ allowed: false, refusal: 'device-not-granted' }))),
      );
      expect([got.status, got.json]).toEqual([200, SAVED]);
      expect(opened).toEqual([]);
      expect(JSON.stringify(store.file)).toBe(before);
    });
    test('a device that holds configure but has not stepped up is held to saved results too', async () => {
      const { registry, id, scan, opened } = await outside();
      const got = answer(
        await reposRoute(
          registry,
          scan,
        )(callWith(undefined, { id }, governed({ allowed: false, refusal: 'step-up-required' }))),
      );
      expect(got.json).toEqual(SAVED);
      expect(opened).toEqual([]);
    });
    test('a device that holds configure and has stepped up starts the scan, persists it and spends the step-up', async () => {
      const { registry, id, scan, opened, store } = await outside();
      let spent = 0;
      const call = {
        ...callWith(undefined, { id }, governed({ allowed: true, refusal: 'granted', steppedUp: true })),
        spendStepUp: () => {
          spent++;
        },
      } as unknown as CallContext;
      const got = answer(await reposRoute(registry, scan)(call));
      expect(got.json).toEqual({
        repos: [{ path: 'app', remote: 'https://github.com/o/app', provider: 'github' }],
        truncated: false,
      });
      expect(opened.length).toBeGreaterThan(0);
      expect(spent).toBe(1);
      expect(store.file.projects[0]?.repos?.[0]?.path).toBe('app');
    });
    test('the owner at the machine (ungoverned) scans', async () => {
      const { registry, id, scan, opened } = await outside();
      const got = answer(await reposRoute(registry, scan)(callWith(undefined, { id }, OWNER)));
      expect(got.json.truncated).toBe(false);
      expect(opened.length).toBeGreaterThan(0);
    });
    test('a call with no standing is refused, never read on a guess', async () => {
      const { registry, id, scan, opened } = await outside();
      const refused = await failure(() => reposRoute(registry, scan)(callWith(undefined, { id })));
      expect(refused.code).toBe('folder_gate_unavailable');
      expect(opened).toEqual([]);
    });
    describe('a stored spelling INSIDE the home that resolves OUTSIDE it (R2 item 3: the decision is on the resolved, held location)', () => {
      /** A project registered at `/home/me/work/alpha` that really is `/srv/real`, one repository already saved. */
      const linked = async () => {
        const world = await setup();
        await world.registry.recordRepos(world.id, [{ path: 'saved', remote: 'https://github.com/o/saved' }], true);
        const opened: string[] = [];
        const base = browserAt('/srv/real');
        const scan = {
          browser: {
            ...base,
            // only the project's own spelling resolves elsewhere (the private spellings stay where they are)
            realPaths: async (paths: readonly string[]) =>
              paths.map(path => (path === '/home/me/work/alpha' ? '/srv/real' : path)),
            open: async (path: string, verdict: Parameters<FolderBrowser['open']>[1]) => {
              opened.push(path);
              return base.open(path, verdict);
            },
          } as FolderBrowser,
        };
        return { ...world, scan, opened };
      };
      test('a use-only device reads what was saved, starts no walk, and nothing is written', async () => {
        const { registry, id, scan, opened, store } = await linked();
        const before = JSON.stringify(store.file);
        const got = answer(
          await reposRoute(
            registry,
            scan,
          )(callWith(undefined, { id }, governed({ allowed: false, refusal: 'device-not-granted' }))),
        );
        expect([got.status, got.json]).toEqual([200, SAVED]);
        expect(opened).toEqual([]);
        expect(JSON.stringify(store.file)).toBe(before);
      });
      test('a device that has not stepped up is held to saved results too', async () => {
        const { registry, id, scan, opened } = await linked();
        const got = answer(
          await reposRoute(
            registry,
            scan,
          )(callWith(undefined, { id }, governed({ allowed: false, refusal: 'step-up-required' }))),
        );
        expect(got.json).toEqual(SAVED);
        expect(opened).toEqual([]);
      });
      test('a stepped-up device walks it and spends the step-up exactly once; the owner at the machine walks it', async () => {
        const { registry, id, scan, opened } = await linked();
        let spent = 0;
        const call = {
          ...callWith(undefined, { id }, governed({ allowed: true, refusal: 'granted', steppedUp: true })),
          spendStepUp: () => {
            spent++;
          },
        } as unknown as CallContext;
        expect(answer(await reposRoute(registry, scan)(call)).json.truncated).toBe(false);
        expect(spent).toBe(1);
        expect(opened.length).toBeGreaterThan(0);
        const owner = await linked();
        expect(
          answer(await reposRoute(owner.registry, owner.scan)(callWith(undefined, { id: owner.id }, OWNER))).json
            .truncated,
        ).toBe(false);
      });
      test('a call with no standing is refused and walks nothing', async () => {
        const { registry, id, scan, opened } = await linked();
        const refused = await failure(() => reposRoute(registry, scan)(callWith(undefined, { id })));
        expect(refused.code).toBe('folder_gate_unavailable');
        expect(opened).toEqual([]);
      });
    });
    test('a project INSIDE the home needs only use: a use-only device scans it, and the configure decision is never asked', async () => {
      const { registry, id, scan } = await setup();
      let asked = 0;
      const governance = {
        governed: true,
        decide: () => {
          asked++;
          return { allowed: false, refusal: 'device-not-granted' };
        },
      };
      const got = answer(await reposRoute(registry, scan)(callWith(undefined, { id }, governance)));
      expect(got.json.truncated).toBe(false);
      expect(asked).toBe(0);
    });
  });
  test('a project folder the skip list refuses answers truncated and keeps the stored repositories and their accounts', async () => {
    const { registry, id, store } = await setup();
    await registry.recordRepos(id, [{ path: 'kept' }], true);
    await store.update(file => ({
      ...file,
      projects: file.projects.map(project => ({
        ...project,
        repos: project.repos?.map(repo => ({ ...repo, account: 'work' })),
      })),
    }));
    // the owner's home is somewhere else and this project sits in ANOTHER user's home: refused on principle
    const other: FolderBrowser = { ...browser, home: async () => '/home/someone' };
    const got = answer(await reposRoute(registry, { browser: other })(callWith(undefined, { id }, OWNER)));
    expect(got.json).toEqual({ repos: [{ path: 'kept', account: 'work' }], truncated: true });
    expect(store.file.projects[0]?.repos).toEqual([{ path: 'kept', account: 'work' }]);
  });
  test('an unknown project is 404 and a bad id is 400', async () => {
    const { registry, scan } = await setup();
    expect(
      (
        await failure(() =>
          reposRoute(registry, scan)(callWith(undefined, { id: '00000000-0000-4000-8000-0000000000ff' })),
        )
      ).status,
    ).toBe(404);
    expect((await failure(() => reposRoute(registry, scan)(callWith(undefined, { id: 'nope' })))).code).toBe(
      'invalid_project_id',
    );
  });
});

describe('PUT /v1/projects/:id/accounts', () => {
  test('replaces the list and answers the project', async () => {
    const { registry, id } = await setup();
    const put = answer(await accountsRoute(registry)(callWith({ accounts: ['work', 'me'] }, { id })));
    expect(put.status).toBe(200);
    expect(put.json.accounts).toEqual(['work', 'me']);
  });
  test('an unknown project is 404; a malformed body is 400', async () => {
    const { registry, id } = await setup();
    expect(
      (
        await failure(() =>
          accountsRoute(registry)(callWith({ accounts: ['a'] }, { id: '00000000-0000-4000-8000-0000000000ff' })),
        )
      ).status,
    ).toBe(404);
    expect((await failure(() => accountsRoute(registry)(callWith({ accounts: 'a' }, { id })))).status).toBe(400);
  });
});

describe('POST /v1/projects/:id/repos (clone into an existing project)', () => {
  const ROOT = '/home/me/work/alpha';
  const URL = 'https://github.com/you/cloned.git';
  const clone = async (fenced: readonly string[] = [], repositories: Record<string, string> = {}) => {
    const machine = fakeMachine([ROOT], repositories, fenced);
    const world = registryOver(machine);
    const made = await world.registry.register({ kind: 'existing-folder', path: ROOT });
    if (!made.ok) throw new Error('not registered');
    const names = () =>
      [...machine.repositories.keys()]
        .filter(path => path.startsWith(`${ROOT}/`))
        .map(path => path.slice(ROOT.length + 1));
    const scan = { browser: listingBrowser(ROOT, names) };
    const run = async (url: string) =>
      await cloneRoute(world.registry, machine, scan)(callWith({ url }, { id: made.value.id }));
    return { ...world, machine, run };
  };
  const clones = (calls: readonly string[]) => calls.filter(call => call.startsWith('git clone'));

  test('clones as a folder named after the repository and answers the repositories the project now holds', async () => {
    const { run, machine, store } = await clone();
    const got = answer(await run(URL));
    expect(got.status).toBe(200);
    expect(got.json).toEqual({
      repos: [{ path: 'cloned', remote: 'https://github.com/o/cloned', provider: 'github' }],
      truncated: false,
    });
    expect(clones(machine.calls)).toEqual([`git clone ${URL} ${ROOT}/cloned`]);
    expect(store.file.projects[0]?.repos?.map(repo => repo.path)).toEqual(['cloned']);
  });
  test('refuses a folder that already exists in the project, cloning nothing', async () => {
    const { run, machine } = await clone();
    machine.directories.add(`${ROOT}/cloned`);
    const refused = await failure(() => run(URL));
    expect(refused).toMatchObject({ status: 422, code: 'project_clone_failed' });
    expect(clones(machine.calls)).toEqual([]);
  });
  test('refuses a project that is itself a repository, where a clone would never be listed', async () => {
    const { run, machine } = await clone([], { [ROOT]: `${ROOT}/.git` });
    expect(await failure(() => run(URL))).toMatchObject({ status: 422, code: 'project_clone_failed' });
    expect(clones(machine.calls)).toEqual([]);
  });
  test('refuses a folder Ferretry keeps for itself, an address that names no repository, and says why git failed', async () => {
    const fenced = await clone([`${ROOT}/cloned`]);
    expect(await failure(() => fenced.run(URL))).toMatchObject({ status: 422, code: 'project_clone_failed' });
    const nameless = await clone();
    expect(await failure(() => nameless.run('https://github.com/'))).toMatchObject({ status: 422 });
    const broken = await clone();
    broken.machine.gitClone = async () => {
      throw new Error('git clone failed');
    };
    expect(await failure(() => broken.run(URL))).toMatchObject({ status: 422, message: 'git clone failed' });
  });
  test('refuses an address git must not be handed, and an unknown project', async () => {
    const { run, registry, machine } = await clone();
    expect(await failure(() => run('ext::sh -c touch /tmp/x'))).toMatchObject({ status: 400 });
    const stray = '00000000-0000-4000-8000-0000000000ff';
    const scan = { browser };
    expect(
      (await failure(() => cloneRoute(registry, machine, scan)(callWith({ url: URL }, { id: stray })))).status,
    ).toBe(404);
    expect(clones(machine.calls)).toEqual([]);
  });
});
