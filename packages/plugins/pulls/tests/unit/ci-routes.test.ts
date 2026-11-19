import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { device, ferret, fixedClock, owner, testHost } from '@ferretry/kernel/testing';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import { CiRunSchema, PULLS_CODES } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { FAKE_ACCOUNT, FakeGithub } from '../fixtures/fake-github/index.ts';
import { SHA, T0, ghCheck, ghJob, ghRun, ghStep, seedCi } from '../fixtures/fake-github/ci.ts';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const REPO = 'octo~hello';
const NOW = new Date(T0 + 300_000).toISOString();

const info = (patch: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    id: PROJECT,
    name: 'hello',
    path: '/work/hello',
    source: 'existing-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    accounts: [FAKE_ACCOUNT],
    repos: [{ path: '.', remote: 'https://github.com/octo/hello.git', provider: 'github' }],
    ...patch,
  }) as ProjectInfo;

async function boot(github: FakeGithub, project: ProjectInfo | undefined = info()) {
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    clock: fixedClock(NOW),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: {
        list: async () => (project === undefined ? [] : [project]),
        find: async (id: string) => (project?.id === id ? project : undefined),
      },
    },
  });
}

const runsPath = `/v1/pulls/${PROJECT}/${REPO}/runs`;

function passing(github: FakeGithub) {
  seedCi(github, {
    pr: 7,
    branch: 'feature/x',
    runs: [ghRun({ id: 100 }), ghRun({ id: 101, name: 'Lint', created: 20, started: 22, updated: 60 })],
    jobs: {
      100: [
        ghJob({
          id: 1001,
          name: 'build',
          start: 10,
          end: 70,
          steps: [
            ghStep(1, { name: 'Set up', start: 10, end: 20 }),
            ghStep(2, { name: 'Compile', start: 20, end: 70 }),
          ],
        }),
      ],
      101: [ghJob({ id: 1011, name: 'lint', start: 23, end: 55 })],
    },
    checks: [
      ghCheck({ id: 900, name: 'ci/other', start: 15, end: 80 }),
      ghCheck({ id: 901, name: 'build', app: 'github-actions', start: 10, end: 70 }),
    ],
  });
}

describe('GET …/runs', () => {
  test('a pull request’s runs: Actions runs with jobs and steps, then other CI as one bar; newest first; contract-valid', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await boot(github);
    const answer = await host.request('GET', runsPath, { query: { pr: '7' }, as: owner() });
    expect(answer.status).toBe(200);
    const runs = answer.json<unknown[]>().map(run => CiRunSchema.parse(run));
    expect(runs.map(run => [run.id, run.name, run.jobs.length])).toEqual([
      [101, 'Lint', 1],
      [900, 'ci/other', 0],
      [100, 'CI', 1],
    ]);
    expect(runs[2]?.jobs[0]?.steps.map(step => step.name)).toEqual(['Set up', 'Compile']);
    // The GitHub Actions job's own check run is not listed a second time.
    expect(runs.some(run => run.id === 901)).toBe(false);
  });

  test('a branch is read by its head commit; the branch name is encoded', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await boot(github);
    const answer = await host.request('GET', runsPath, { query: { branch: 'feature/x' }, as: owner() });
    expect(answer.status).toBe(200);
    expect(github.seen.some(call => call.path === '/repos/octo/hello/branches/feature%2Fx')).toBe(true);
  });

  test('a second read sends If-None-Match and costs no rate limit (304 from the cache)', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await boot(github);
    await host.request('GET', runsPath, { query: { pr: '7' }, as: owner() });
    const spent = github.remaining;
    const before = github.seen.length;
    const again = await host.request('GET', runsPath, { query: { pr: '7' }, as: owner() });
    expect(again.status).toBe(200);
    expect(github.remaining).toBe(spent);
    expect(github.seen.slice(before).every(call => call.ifNoneMatch !== undefined)).toBe(true);
  });

  test('exactly one of pr and branch, a whole number, a usable branch, and no other parameter', async () => {
    const host = await boot(new FakeGithub());
    const bad = async (query: Record<string, string>) =>
      (await host.request('GET', runsPath, { query, as: owner() })).status;
    expect(await bad({})).toBe(400);
    expect(await bad({ pr: '7', branch: 'main' })).toBe(400);
    expect(await bad({ pr: 'seven' })).toBe(400);
    expect(await bad({ pr: '0' })).toBe(400);
    expect(await bad({ branch: 'has space' })).toBe(400);
    expect(await bad({ branch: 'x'.repeat(256) })).toBe(400);
    expect(await bad({ pr: '7', other: '1' })).toBe(400);
  });

  test('a blank branch is refused here, never sent to GitHub; a repeated parameter is refused, not read as its first', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await boot(github);
    const get = async (path: string, query: Record<string, string | string[]>) =>
      await host.request('GET', path, { query, as: owner() });
    const blank = await get(runsPath, { branch: '' });
    expect(blank.status).toBe(400);
    expect(github.seen).toHaveLength(0);
    expect((await get(runsPath, { branch: '   ' })).status).toBe(400);
    const twice = await get(runsPath, { pr: ['7', '8'] });
    expect(twice.status).toBe(400);
    expect(twice.json<{ error: string }>().error).toContain('only once');
    expect((await get(runsPath, { branch: ['main', 'other'] })).status).toBe(400);
    expect((await get(`${runsPath}/100`, { attempt: ['1', '2'] })).status).toBe(400);
    expect(github.seen).toHaveLength(0);
  });

  test('a repository the project does not list, a bad repo word and an unknown project are refused before GitHub is asked', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await boot(github);
    const get = async (path: string) => await host.request('GET', path, { query: { pr: '7' }, as: owner() });
    expect((await get(`/v1/pulls/${PROJECT}/octo~other/runs`)).status).toBe(404);
    expect((await get(`/v1/pulls/${PROJECT}/octo-hello/runs`)).status).toBe(400);
    expect((await get(`/v1/pulls/${PROJECT}/octo~..%2Fx/runs`)).status).toBe(400);
    expect((await get(`/v1/pulls/22222222-2222-4222-8222-222222222222/${REPO}/runs`)).status).toBe(404);
    expect((await get(`/v1/pulls/not-a-uuid/${REPO}/runs`)).status).toBe(400);
    expect(github.seen).toEqual([]);
  });

  test('the repo’s own account wins over the project’s first; no account says so; a gone account says so', async () => {
    const github = new FakeGithub();
    passing(github);
    const own = await boot(
      github,
      info({
        accounts: ['gha_1'],
        repos: [{ path: '.', remote: 'https://github.com/OCTO/Hello', provider: 'github', account: FAKE_ACCOUNT }],
      }),
    );
    expect((await own.request('GET', runsPath, { query: { pr: '7' }, as: owner() })).status).toBe(200);
    expect(github.seen.every(call => call.account === FAKE_ACCOUNT)).toBe(true);

    const none = await boot(github, info({ accounts: [] }));
    const noAccount = await none.request('GET', runsPath, { query: { pr: '7' }, as: owner() });
    expect(noAccount.status).toBe(409);
    expect(noAccount.json<{ code: string }>().code).toBe(PULLS_CODES.noAccount);

    const gone = await boot(github, info({ accounts: ['gha_99'] }));
    const removed = await gone.request('GET', runsPath, { query: { pr: '7' }, as: owner() });
    expect(removed.status).toBe(409);
    expect(removed.json<{ code: string }>().code).toBe(PULLS_CODES.noAccount);
  });

  test('a pull request GitHub does not have is a 404 that carries none of GitHub’s text', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await boot(github);
    const answer = await host.request('GET', runsPath, { query: { pr: '99' }, as: owner() });
    expect(answer.status).toBe(404);
    expect(answer.body).not.toContain('Not Found');
  });

  test('below 10 % of the allowance it answers paused with the instant polling resumes, and makes no further call', async () => {
    const github = new FakeGithub();
    passing(github);
    github.rate(100, Math.floor(T0 / 1000) + 300 + 1800);
    const host = await boot(github);
    await host.request('GET', runsPath, { query: { pr: '7' }, as: owner() });
    const seen = github.seen.length;
    const answer = await host.request('GET', runsPath, { query: { pr: '7' }, as: owner() });
    expect(answer.status).toBe(503);
    expect(answer.json<{ code: string; pausedUntil?: string }>()).toMatchObject({ code: PULLS_CODES.paused });
    expect(answer.json<{ pausedUntil?: string }>().pausedUntil).toBe(
      new Date((Math.floor(T0 / 1000) + 2100) * 1000).toISOString(),
    );
    expect(github.seen.length).toBe(seen);
  });

  test('a person only: a ferret is refused', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await testHost({
      plugins: [daemon],
      clock: fixedClock(NOW),
      fakes: {
        gitAccounts: {
          ...github.accounts,
          run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
          recordKeys: async () => undefined,
        },
        projects: { list: async () => [info()], find: async () => info() },
      },
    });
    const asFerret = await host.request('GET', runsPath, { query: { pr: '7' }, as: ferret('f1') });
    expect(asFerret.status).toBeGreaterThanOrEqual(400);
    expect(asFerret.status).toBeLessThan(500);
    expect(github.seen).toEqual([]);
    expect([401, 403]).toContain(
      (await host.request('GET', runsPath, { query: { pr: '7' }, as: device('d1', []) })).status,
    );
  });
});

describe('GET …/runs/:runId', () => {
  test('one run with its jobs and steps; the latest attempt by default', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await boot(github);
    const answer = await host.request('GET', `${runsPath}/100`, { as: owner() });
    expect(answer.status).toBe(200);
    const run = CiRunSchema.parse(answer.json());
    expect(run).toMatchObject({ id: 100, status: 'passed', attempt: 1, headSha: SHA });
    expect(run.jobs[0]?.steps).toHaveLength(2);
  });

  test('an earlier attempt reads that attempt’s run and its jobs, and the timeline starts at that attempt', async () => {
    const github = new FakeGithub();
    github.set(
      '/repos/octo/hello/actions/runs/200/attempts/1',
      ghRun({ id: 200, attempt: 1, created: 0, started: 2, updated: 50, conclusion: 'failure' }),
    );
    github.set('/repos/octo/hello/actions/runs/200/attempts/1/jobs', {
      total_count: 1,
      jobs: [ghJob({ id: 2001, name: 'build', conclusion: 'failure', start: 5, end: 40 })],
    });
    github.set(
      '/repos/octo/hello/actions/runs/200/attempts/2',
      ghRun({ id: 200, attempt: 2, created: 0, started: 3600, updated: 3700 }),
    );
    github.set('/repos/octo/hello/actions/runs/200/attempts/2/jobs', {
      total_count: 1,
      jobs: [ghJob({ id: 2002, name: 'build', start: 3610, end: 3690 })],
    });
    const host = await boot(github);
    const first = CiRunSchema.parse(
      (await host.request('GET', `${runsPath}/200`, { query: { attempt: '1' }, as: owner() })).json(),
    );
    expect(first).toMatchObject({ status: 'failed', attempt: 1, wallMs: 40_000 });
    const second = CiRunSchema.parse(
      (await host.request('GET', `${runsPath}/200`, { query: { attempt: '2' }, as: owner() })).json(),
    );
    expect(second).toMatchObject({ status: 'passed', attempt: 2, queuedMs: 10_000, wallMs: 90_000 });
  });

  test('a run id or attempt that is not a positive whole number, a run GitHub does not have, and paged jobs', async () => {
    const github = new FakeGithub();
    const jobs = Array.from({ length: 5 }, (_, index) =>
      ghJob({ id: 300 + index, name: `shard ${index}`, start: 10 + index, end: 40 }),
    );
    github.set('/repos/octo/hello/actions/runs/300', ghRun({ id: 300 }));
    // GitHub pages {jobs: [...]} two to a page here, with `Link: rel="next"` between pages.
    github.on('GET', '/repos/octo/hello/actions/runs/300/jobs', ({ query }) => {
      const page = Number(query.get('page') ?? '1');
      const next = new URLSearchParams(query);
      next.set('page', String(page + 1));
      const headers: Record<string, string> = {};
      if (page * 2 < jobs.length)
        headers.link = `<https://api.github.com/repos/octo/hello/actions/runs/300/jobs?${next.toString()}>; rel="next"`;
      return { status: 200, body: { total_count: jobs.length, jobs: jobs.slice((page - 1) * 2, page * 2) }, headers };
    });
    const host = await boot(github);
    const get = async (id: string, query: Record<string, string> = {}) =>
      await host.request('GET', `${runsPath}/${id}`, { query, as: owner() });
    expect((await get('abc')).status).toBe(400);
    expect((await get('0')).status).toBe(400);
    expect((await get('300', { attempt: '0' })).status).toBe(400);
    expect((await get('300', { attempt: '1001' })).status).toBe(400);
    expect((await get('300', { nope: '1' })).status).toBe(400);
    expect((await get('999')).status).toBe(404);
    const paged = await get('300');
    expect(paged.status).toBe(200);
    expect(CiRunSchema.parse(paged.json()).jobs).toHaveLength(5);
  });

  test('a running run is live at the clock’s now', async () => {
    const github = new FakeGithub();
    github.set('/repos/octo/hello/actions/runs/400', ghRun({ id: 400, status: 'in_progress', conclusion: null }));
    github.set('/repos/octo/hello/actions/runs/400/jobs?filter=latest', {
      jobs: [
        ghJob({
          id: 4001,
          name: 'build',
          status: 'in_progress',
          conclusion: null,
          start: 10,
          steps: [ghStep(1, { name: 'Compile', status: 'in_progress', conclusion: null, start: 10 })],
        }),
      ],
    });
    const host = await boot(github);
    const run = CiRunSchema.parse((await host.request('GET', `${runsPath}/400`, { as: owner() })).json());
    expect(run).toMatchObject({ status: 'running', live: true, wallMs: 300_000 });
    expect(run.jobs[0]).toMatchObject({ live: true, end: NOW });
    expect(run.jobs[0]?.steps[0]).toMatchObject({ live: true, end: NOW });
  });

  test('no token anywhere in an answer', async () => {
    const github = new FakeGithub();
    passing(github);
    const host = await boot(github);
    const body = (await host.request('GET', runsPath, { query: { pr: '7' }, as: owner() })).body;
    expect(body).not.toMatch(/token|bearer|authorization/iu);
  });
});
