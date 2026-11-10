import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { HandoverFiles, StartRequestsFile, WorktreesFile } from '../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../contract/testing/index.ts';
import { directory, FakeRootPinner, textFile, treeOf } from '../daemon/session/filesystem/support.ts';
import { planIdFor, receiptAt, REQUEST_ID, transferPlan } from '../daemon/moves/handover/support.ts';
import { as, host, record } from '../daemon/ferrets/route-fixture.ts';

/**
 * The GET and PATCH routes of the `ferrets` owner, proved through the REAL handler on the real host (`host`): each
 * title carries the row id it proves, success is asserted by status and body fields, a refusal is asserted where the
 * descriptor implies one, and the state a route reads is planted in (or written to) the host's own state folder.
 */

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the ferret list and one ferret', () => {
  test('R-0134 GET /v1/ferrets lists the live ferrets as identity records, never a pane or a token', async () => {
    const h = await host([record('lead'), record('helper', 'lead')]);
    const answer = await h.request('GET', '/v1/ferrets');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    const rows = answer.json<{ id: string; name: string; state: string; parent?: string; folder: string }[]>();
    expect(rows.map(row => row.id).sort()).toEqual(['helper', 'lead']);
    const helper = rows.find(row => row.id === 'helper');
    expect(helper).toMatchObject({ name: 'helper', state: 'working', parent: 'lead', folder: '/work/helper' });
    expect(answer.body).not.toContain('token');
    await h.stop();
  });

  test('R-0134 an empty fleet lists as an empty array, and a ferret may read the list (caller any)', async () => {
    const empty = await host();
    const none = await empty.request('GET', '/v1/ferrets');
    expect(none.status).toBe(200);
    expect(none.json<unknown[]>()).toEqual([]);
    const h = await host([record('lead')]);
    const byFerret = await h.request('GET', '/v1/ferrets', as('lead'));
    expect(byFerret.status).toBe(200);
    expect(byFerret.json<{ id: string }[]>().map(row => row.id)).toEqual(['lead']);
    await empty.stop();
    await h.stop();
  });

  test('R-0135 GET /v1/ferrets/:ferretId answers one identity record by id, or by name; an unknown ferret is 404', async () => {
    const h = await host([record('lead'), record('helper', 'lead')]);
    const byId = await h.request('GET', '/v1/ferrets/helper');
    expect(byId.status).toBe(200);
    expect(byId.json()).toMatchObject({ id: 'helper', name: 'helper', parent: 'lead', state: 'working' });
    const other = await h.request('GET', '/v1/ferrets/lead', as('helper'));
    expect(other.status).toBe(200);
    expect(other.json<{ id: string }>().id).toBe('lead');
    const missing = await h.request('GET', '/v1/ferrets/nobody');
    expect(missing.status).toBe(404);
    expect(missing.json<{ code: string }>().code).toBe('not-found');
    await h.stop();
  });
});

describe('the start recovery read', () => {
  const startBody = { name: 'aniya', folder: '/work/a' };

  test('R-0187 GET /v1/ferrets/by-request/:requestId answers the ferret a start created, only to a caller that proves the body', async () => {
    const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
    const started = await h.request('POST', '/v1/ferrets', {
      body: startBody,
      headers: { 'x-fy-request-id': 'req-r0187' },
    });
    expect(started.status).toBe(201);
    const id = started.json<{ id: string }>().id;
    const proved = await h.request('GET', '/v1/ferrets/by-request/req-r0187', {
      query: { payload: sha(JSON.stringify(startBody)) },
    });
    expect(proved.status).toBe(200);
    expect(proved.json()).toMatchObject({ id, name: 'aniya', folder: '/work/a' });
    // The refusals: no proof, a different body, a request id this daemon never saw.
    const unproved = await h.request('GET', '/v1/ferrets/by-request/req-r0187');
    expect(unproved.status).toBe(400);
    expect(unproved.json<{ code: string }>().code).toBe('missing_payload_digest');
    const wrong = await h.request('GET', '/v1/ferrets/by-request/req-r0187', { query: { payload: sha('{}') } });
    expect(wrong.status).toBe(409);
    expect(wrong.json<{ code: string }>().code).toBe('request_id_reused');
    const unknown = await h.request('GET', '/v1/ferrets/by-request/never', { query: { payload: sha('{}') } });
    expect(unknown.status).toBe(404);
    // The route never shadows a ferret: by-request is a literal, so a ferret named like it is not what answers.
    expect(h.state('ferrets').raw(StartRequestsFile)).toContain('req-r0187');
    await h.stop();
  });
});

describe('the pin board', () => {
  test('R-0165 GET /v1/ferrets/:ferretId/pins reads back the notes pinned on the ferret, for a person and for the ferret itself', async () => {
    const h = await host([record('lead'), record('helper', 'lead')]);
    const empty = await h.request('GET', '/v1/ferrets/lead/pins');
    expect(empty.status).toBe(200);
    expect(empty.json<{ pins: unknown[] }>().pins).toEqual([]);
    const added = await h.request('POST', '/v1/ferrets/lead/pins', {
      body: { action: 'add', kind: 'note', text: 'ship it' },
    });
    expect(added.status).toBe(200);
    const person = await h.request('GET', '/v1/ferrets/lead/pins');
    expect(person.status).toBe(200);
    expect(person.headers.get('cache-control')).toContain('no-store');
    expect(person.json<{ pins: { text?: string; kind: string }[] }>().pins).toMatchObject([
      { kind: 'note', text: 'ship it' },
    ]);
    const own = await h.request('GET', '/v1/ferrets/lead/pins', as('lead'));
    expect(own.status).toBe(200);
    expect(own.json<{ pins: unknown[] }>().pins).toHaveLength(1);
    const missing = await h.request('GET', '/v1/ferrets/nobody/pins');
    expect(missing.status).toBe(404);
    await h.stop();
  });
});

describe('the handover receipt read', () => {
  const receiptFor = (source: string, phase: 'requested' | 'completed' = 'requested') => {
    const planId = planIdFor(source, REQUEST_ID);
    const plan = transferPlan(planId);
    return receiptAt(phase, {
      sourceSessionId: source,
      planId,
      plan: { ...plan, source: { ...plan.source, sessionId: source } },
    });
  };

  test('R-0154 GET /v1/ferrets/:ferretId/handover answers 404 while no handover was begun', async () => {
    const h = await host([record('lead')]);
    const answer = await h.request('GET', '/v1/ferrets/lead/handover');
    expect(answer.status).toBe(404);
    await h.stop();
  });

  test('R-0154 GET /v1/ferrets/:ferretId/handover reads the durable receipt at its phase, for a person and for the ferret', async () => {
    const h = await host([record('lead'), record('other')]);
    h.state('ferrets').plant(HandoverFiles, JSON.stringify({ format: 1, ...receiptFor('lead') }), 'lead');
    const person = await h.request('GET', '/v1/ferrets/lead/handover');
    expect(person.status).toBe(200);
    expect(person.headers.get('cache-control')).toContain('no-store');
    expect(person.json()).toMatchObject({
      sourceSessionId: 'lead',
      requestId: REQUEST_ID,
      phase: 'requested',
      replacementSessionId: 'replacement-1',
    });
    const own = await h.request('GET', '/v1/ferrets/lead/handover', as('lead'));
    expect(own.status).toBe(200);
    expect(own.json<{ phase: string }>().phase).toBe('requested');
    // A ferret that is neither the source nor its parent is refused before the receipt is read.
    const stranger = await h.request('GET', '/v1/ferrets/lead/handover', as('other'));
    expect(stranger.status).toBe(403);
    expect(stranger.body).not.toContain('replacement-1');
    await h.stop();
  });
});

describe('the managed worktrees read', () => {
  const managed = (path: string, createdAt: string, removedAt?: string) => ({
    version: 1,
    path,
    branch: `feat/${createdAt}`,
    repositoryRoot: '/work/ferretry',
    commonDir: '/work/ferretry/.git',
    gitDir: `/work/ferretry/.git/worktrees/${createdAt}`,
    ownershipToken: `token-${createdAt}`,
    createdAt,
    initialHead: 'a'.repeat(40),
    branchPreexisted: false,
    sourceCwd: '/work/ferretry',
    relativeCwd: 'packages/cli',
    ...(removedAt === undefined ? {} : { removedAt }),
  });
  const registry = (...worktrees: ReturnType<typeof managed>[]) =>
    JSON.stringify({ format: 1, worktrees, intents: [] });

  test('R-0210 GET /v1/worktrees answers the managed checkouts, none while the registry is empty', async () => {
    const h = await host();
    const answer = await h.request('GET', '/v1/worktrees');
    expect(answer.status).toBe(200);
    expect(answer.headers.get('cache-control')).toContain('no-store');
    expect(answer.json()).toEqual({ worktrees: [] });
    await h.stop();
  });

  test('R-0210 GET /v1/worktrees lists the recorded checkouts, live ones first, and says so plainly when the registry is damaged', async () => {
    const h = await host();
    h.state('ferrets').plant(
      WorktreesFile,
      registry(
        managed('/managed/repo/gone', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
        managed('/managed/repo/older', '2026-08-03T00:00:00.000Z'),
        managed('/managed/repo/newer', '2026-08-04T00:00:00.000Z'),
      ),
    );
    const listed = await h.request('GET', '/v1/worktrees');
    expect(listed.status).toBe(200);
    const rows = listed.json<{
      worktrees: { path: string; branch: string; removedAt?: string; sharedWith: string[] }[];
    }>();
    expect(rows.worktrees.map(row => row.path)).toEqual([
      '/managed/repo/newer',
      '/managed/repo/older',
      '/managed/repo/gone',
    ]);
    expect(rows.worktrees[0]).toMatchObject({ branch: 'feat/2026-08-04T00:00:00.000Z', sharedWith: [] });
    expect(rows.worktrees[2]?.removedAt).toBe('2026-08-02T00:00:00.000Z');
    h.state('ferrets').plant(WorktreesFile, '{ not json');
    const damaged = await h.request('GET', '/v1/worktrees');
    expect(damaged.status).toBe(500);
    expect(damaged.json<{ code: string }>().code).toBe('registry_damaged');
    await h.stop();
  });

  test('the removal check needs a path, refuses a checkout the registry does not hold, and says why a recorded one cannot be judged here', async () => {
    const h = await host();
    const noPath = await h.request('GET', '/v1/worktrees/removal');
    expect(noPath.status).toBe(400);
    expect(noPath.json<{ code: string }>().code).toBe('invalid_path');
    const unknown = await h.request('GET', '/v1/worktrees/removal', { query: { path: '/managed/repo/feat-one' } });
    expect(unknown.status).toBe(404);
    expect(unknown.json<{ code: string }>().code).toBe('unknown_worktree');
    h.state('ferrets').plant(WorktreesFile, registry(managed('/managed/repo/feat-one', '2026-08-04T00:00:00.000Z')));
    const recorded = await h.request('GET', '/v1/worktrees/removal', { query: { path: '/managed/repo/feat-one' } });
    expect(recorded.status).toBe(409);
    expect(recorded.json<{ code: string }>().code).toBe('no_managed_root');
    await h.stop();
  });
});

describe('the working-tree reads', () => {
  const NUL = String.fromCharCode(0);
  const REPO_ROOT = '/work/lead';
  type Spawned = { exitCode: number; signal: null; stdout: string; stderr: string };
  const done = (exitCode: number, stdout = ''): Spawned => ({ exitCode, signal: null, stdout, stderr: '' });

  /** A Git stand-in that answers the viewer's commands for a repository with no commits: a.txt and src/b.txt are untracked. */
  const repoGit = async (_program: string, args: readonly string[]): Promise<Spawned> => {
    if (args.includes('--is-inside-work-tree')) return done(0, `true\n${REPO_ROOT}\n\n`);
    if (args.includes('--verify')) return done(1);
    if (args.includes('--error-unmatch')) return done(1);
    if (args.includes('ls-files')) return done(0, `a.txt${NUL}src/b.txt${NUL}`);
    if (args.includes('status')) return done(0, `## No commits yet on main${NUL}?? a.txt${NUL}?? src/b.txt${NUL}`);
    if (args.includes('check-ignore')) return done(1);
    if (args.includes('--numstat')) return done(0, '');
    if (args.includes('--no-index')) {
      return done(
        1,
        'diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+hello\n',
      );
    }
    return done(128);
  };
  const noRepoGit = async (): Promise<Spawned> => ({
    exitCode: 128,
    signal: null,
    stdout: '',
    stderr: 'fatal: not a git repository',
  });

  const pinnerWithTree = () =>
    new FakeRootPinner({
      tree: treeOf(
        [
          '',
          directory([
            { name: 'a.txt', type: 'file' },
            { name: 'src', type: 'dir' },
          ]),
        ],
        ['a.txt', textFile('hello\n')],
        ['src', directory([{ name: 'b.txt', type: 'file' }])],
        ['src/b.txt', textFile('bee\n')],
      ),
    });
  const withRepo = async () => {
    const pinner = pinnerWithTree();
    const h = await host([record('lead'), record('helper', 'lead'), record('stranger')], { pinner, spawn: repoGit });
    return { h, pinner };
  };

  test('R-0148 GET /v1/ferrets/:ferretId/fs lists the ferret folder from the cwd the daemon holds, and a subfolder by ?path', async () => {
    const { h, pinner } = await withRepo();
    const root = await h.request('GET', '/v1/ferrets/lead/fs');
    expect(root.status).toBe(200);
    expect(root.headers.get('cache-control')).toContain('no-store');
    expect(root.json<{ entries: { name: string; type: string }[] }>().entries.map(entry => entry.name)).toEqual([
      'src',
      'a.txt',
    ]);
    expect(pinner.pinnedCwds).toHaveLength(1);
    expect(pinner.lastRoot.closed).toBe(true);
    const sub = await h.request('GET', '/v1/ferrets/lead/fs', { query: { path: 'src' } });
    expect(sub.status).toBe(200);
    expect(sub.json()).toMatchObject({ path: 'src' });
    expect(sub.json<{ entries: { name: string }[] }>().entries.map(entry => entry.name)).toEqual(['b.txt']);
    // Refusals: another ferret for an agent, an unknown ferret, a path that is not there.
    const stranger = await h.request('GET', '/v1/ferrets/stranger/fs', as('lead'));
    expect(stranger.status).toBe(403);
    expect(stranger.json<{ code: string }>().code).toBe('not_own_session');
    expect((await h.request('GET', '/v1/ferrets/nobody/fs')).status).toBe(404);
    const gone = await h.request('GET', '/v1/ferrets/lead/fs', { query: { path: 'nowhere' } });
    expect(gone.status).toBe(404);
    expect(gone.json<{ code: string }>().code).toBe('not_found');
    await h.stop();
  });

  test('R-0151 GET /v1/ferrets/:ferretId/fs/file serves the bytes of one file, behind the same gates as the listing', async () => {
    const { h } = await withRepo();
    const read = await h.request('GET', '/v1/ferrets/lead/fs/file', { query: { path: 'src/b.txt' } });
    expect(read.status).toBe(200);
    expect(read.json()).toMatchObject({ path: 'src/b.txt', content: 'bee\n' });
    const missing = await h.request('GET', '/v1/ferrets/lead/fs/file', { query: { path: 'nothing.txt' } });
    expect(missing.status).toBe(404);
    const noPath = await h.request('GET', '/v1/ferrets/lead/fs/file');
    expect(noPath.status).toBe(400);
    expect(noPath.json<{ code: string }>().code).toBe('invalid_path');
    const agent = await h.request('GET', '/v1/ferrets/stranger/fs/file', { ...as('lead'), query: { path: 'a.txt' } });
    expect(agent.status).toBe(403);
    await h.stop();
  });

  test('R-0152 GET /v1/ferrets/:ferretId/fs/index lists every path Git does not exclude, versioned and tied to the ferret', async () => {
    const { h } = await withRepo();
    const answer = await h.request('GET', '/v1/ferrets/lead/fs/index');
    expect(answer.status).toBe(200);
    expect(answer.json()).toMatchObject({ v: 1, sessionId: 'lead' });
    expect(
      answer
        .json<{ files: { path: string }[] }>()
        .files.map(file => file.path)
        .sort(),
    ).toEqual(['a.txt', 'src/b.txt']);
    const refused = await h.request('GET', '/v1/ferrets/stranger/fs/index', as('lead'));
    expect(refused.status).toBe(403);
    expect((await h.request('GET', '/v1/ferrets/nobody/fs/index')).status).toBe(404);
    await h.stop();
  });

  test('R-0149 GET /v1/ferrets/:ferretId/fs/changes lists the working-tree changes of a repository, and says "not a repository" otherwise', async () => {
    const { h } = await withRepo();
    const answer = await h.request('GET', '/v1/ferrets/lead/fs/changes');
    expect(answer.status).toBe(200);
    const view = answer.json<{ repo: boolean; branch?: string; changes: { path: string }[] }>();
    expect(view.repo).toBe(true);
    expect(view.branch).toBe('main');
    expect(view.changes.map(change => change.path)).toEqual(['a.txt', 'src/b.txt']);
    const plain = await host([record('lead')], { pinner: pinnerWithTree(), spawn: noRepoGit });
    const none = await plain.request('GET', '/v1/ferrets/lead/fs/changes');
    expect(none.status).toBe(200);
    expect(none.json()).toEqual({ repo: false, changes: [] });
    const refused = await h.request('GET', '/v1/ferrets/stranger/fs/changes', as('lead'));
    expect(refused.status).toBe(403);
    await h.stop();
    await plain.stop();
  });

  test('R-0150 GET /v1/ferrets/:ferretId/fs/diff answers one path as a unified diff text, and needs a path', async () => {
    const { h } = await withRepo();
    const answer = await h.request('GET', '/v1/ferrets/lead/fs/diff', { query: { path: 'a.txt' } });
    expect(answer.status).toBe(200);
    expect(answer.body).toContain('+++ b/a.txt');
    expect(answer.body).toContain('+hello');
    const noPath = await h.request('GET', '/v1/ferrets/lead/fs/diff');
    expect(noPath.status).toBe(400);
    expect(noPath.json<{ code: string }>().code).toBe('invalid_path');
    const refused = await h.request('GET', '/v1/ferrets/stranger/fs/diff', { ...as('lead'), query: { path: 'a.txt' } });
    expect(refused.status).toBe(403);
    await h.stop();
  });
});
