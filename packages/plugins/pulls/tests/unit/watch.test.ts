import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { ProjectRemoved } from '@ferretry/plugin-projects/contract';
import { WATCH_STATE, type WatchOverview } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { FakeGithub } from '../fixtures/fake-github/index.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const BASE = '/repos/octo/widgets';
const LIST = `${BASE}/pulls?state=open&sort=updated&direction=desc&per_page=30`;
const SHA = 'abcdef1234567';

const project = (over: Record<string, unknown> = {}) => ({
  id: P1,
  name: 'widgets',
  path: '/work/widgets',
  source: 'existing-folder',
  createdAt: '2026-01-01T00:00:00.000Z',
  accounts: ['gha_4242'],
  repos: [{ path: '.', provider: 'github', remote: 'https://github.com/octo/widgets' }],
  ...over,
});

interface Seed {
  number?: number;
  author?: string;
  title?: string;
  requested?: string[];
  ci?: { status: string; conclusion: string | null }[];
  reviews?: unknown[];
  comments?: unknown[];
}
/** Serves one open PR (and what the watch reads about it) on the fake GitHub. */
function servePull(github: FakeGithub, seed: Seed = {}, sha = SHA): void {
  const number = seed.number ?? 7;
  github.set(LIST, [
    {
      number,
      title: seed.title ?? 'Fix the thing',
      state: 'open',
      draft: false,
      html_url: `https://github.com/octo/widgets/pull/${number}`,
      user: { login: seed.author ?? 'octo-fake' },
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      head: { sha, ref: 'fix' },
      base: { ref: 'main' },
      requested_reviewers: (seed.requested ?? []).map(login => ({ login })),
    },
  ]);
  github.set(`${BASE}/commits/${sha}/check-runs?per_page=100`, { check_runs: seed.ci ?? [] });
  github.set(`${BASE}/actions/runs?head_sha=${sha}&per_page=50`, { workflow_runs: [] });
  github.set(`${BASE}/pulls/${number}/reviews?per_page=100`, seed.reviews ?? []);
  github.set(`${BASE}/issues/${number}/comments?per_page=100`, seed.comments ?? []);
}

const running = [{ status: 'in_progress', conclusion: null }];
const failed = [{ status: 'completed', conclusion: 'failure' }];
const passed = [{ status: 'completed', conclusion: 'success' }];

async function boot(
  github: FakeGithub,
  options: { projects?: unknown[]; config?: unknown; access?: boolean; buzzes?: unknown[] } = {},
) {
  const buzzes = options.buzzes ?? [];
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => options.projects ?? [project()], find: async () => undefined },
    },
    ...(options.access === false
      ? {}
      : { uses: { access: { buzz: async (buzz: unknown) => (buzzes.push(buzz), 1) } } }),
    config: { 'pulls.yaml': options.config ?? { projects: { [P1]: { watch: true } } } },
  });
}

const looks = (github: FakeGithub) => github.seen.filter(seen => seen.path === LIST).length;
const STEP = 301_000;

describe('watch: what is asked, and when', () => {
  test('watch off asks GitHub for nothing', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: failed });
    const host = await boot(github, { config: { projects: { [P1]: { watch: false } } } });
    await host.runJob('pulls-watch');
    expect(github.seen).toEqual([]);
    expect(host.state('pulls').raw(WATCH_STATE, P1)).toBeUndefined();
  });

  test('a project with no GitHub repository, or no account to read it as, asks nothing and says who is missing', async () => {
    const github = new FakeGithub();
    servePull(github);
    const host = await boot(github, { projects: [project({ accounts: undefined })] });
    await host.runJob('pulls-watch');
    expect(github.seen).toEqual([]);
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(view.projects[0]?.needsAccount).toEqual([{ provider: 'github', owner: 'octo', name: 'widgets' }]);
  });

  test('cadence: not due again before 5 minutes idle; 60 s once a screen has read; 30 s while CI runs', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: passed });
    const host = await boot(github);
    await host.runJob('pulls-watch');
    expect(looks(github)).toBe(1);
    await host.clock.advance(60_000);
    await host.runJob('pulls-watch');
    expect(looks(github)).toBe(1);
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    expect(looks(github)).toBe(2);
    // A screen reads the status: now every minute.
    await host.request('GET', '/v1/pulls/watch');
    await host.clock.advance(61_000);
    await host.runJob('pulls-watch');
    expect(looks(github)).toBe(3);
    // CI running: every 30 s, screen or not.
    servePull(github, { ci: running });
    await host.clock.advance(61_000);
    await host.runJob('pulls-watch');
    expect(looks(github)).toBe(4);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(looks(github)).toBe(5);
  });

  test('a second look sends If-None-Match and costs nothing against the limit when nothing changed', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: passed });
    const host = await boot(github);
    await host.runJob('pulls-watch');
    const spent = github.remaining;
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    const second = github.seen.filter(seen => seen.path === LIST)[1];
    expect(second?.ifNoneMatch).toBeDefined();
    expect(github.remaining).toBe(spent);
  });
});

describe('watch: notifications', () => {
  test('the first look is a silent baseline; CI failing after it is ONE buzz, and the next tick says nothing', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const buzzes: any[] = [];
    const host = await boot(github, { buzzes });
    await host.runJob('pulls-watch');
    expect(buzzes).toEqual([]);

    servePull(github, { ci: failed });
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(buzzes).toHaveLength(1);
    expect(buzzes[0]).toMatchObject({
      title: 'CI failed on #7',
      body: 'Fix the thing',
      kind: 'ci',
      tag: 'pr-octo:widgets-7',
      url: `/pulls/${P1}/octo~widgets/7`,
    });

    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    expect(buzzes).toHaveLength(1);
  });

  test('a baseline with CI already failing tells nothing; a restart tells nothing again (the snapshot is on disk)', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: failed });
    const buzzes: any[] = [];
    const host = await boot(github, { buzzes });
    await host.runJob('pulls-watch');
    expect(buzzes).toEqual([]);
    const again = await host.restart();
    await again.clock.advance(STEP);
    await again.runJob('pulls-watch');
    expect(buzzes).toEqual([]);
  });

  test('default choices: passing, comments and endings are quiet; reviews asked of you and verdicts speak', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const buzzes: any[] = [];
    const host = await boot(github, { buzzes });
    await host.runJob('pulls-watch');
    servePull(github, {
      ci: passed,
      comments: [{ id: 1 }, { id: 2 }],
      reviews: [{ user: { login: 'rev' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-11-03T00:00:00Z' }],
    });
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    expect(buzzes.map(buzz => buzz.title)).toEqual(['Changes requested on #7']);
    expect(buzzes[0].kind).toBe('pr');
  });

  test('turning an event on makes it speak; a review asked of the account fires for someone else’s PR', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const buzzes: any[] = [];
    const host = await boot(github, {
      buzzes,
      config: { projects: { [P1]: { watch: true, notify: { ciPassed: true } } } },
    });
    await host.runJob('pulls-watch');
    servePull(github, { ci: passed });
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(buzzes.map(buzz => buzz.title)).toEqual(['CI passed on #7']);

    servePull(github, { number: 9, author: 'someone', title: 'Theirs', requested: ['octo-fake'], ci: failed });
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    expect(buzzes.map(buzz => buzz.title)).toEqual(['CI passed on #7', 'Review requested on #9']);
  });

  test('an own PR that merged is told as Merged when closing is on; one that is merely out of the page is not', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: passed });
    const buzzes: any[] = [];
    const host = await boot(github, {
      buzzes,
      config: { projects: { [P1]: { watch: true, notify: { closed: true } } } },
    });
    await host.runJob('pulls-watch');
    github.set(LIST, []);
    // Still open (only past the page): not an ending.
    github.set(`${BASE}/pulls/7`, {
      number: 7,
      title: 't',
      state: 'open',
      html_url: 'https://github.com/o/r/pull/7',
      user: null,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      head: { sha: SHA, ref: 'f' },
      base: { ref: 'main' },
    });
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    expect(buzzes).toEqual([]);
    github.set(`${BASE}/pulls/7`, {
      number: 7,
      title: 't',
      state: 'closed',
      merged_at: '2026-11-03T00:00:00Z',
      html_url: 'https://github.com/o/r/pull/7',
      user: null,
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      head: { sha: SHA, ref: 'f' },
      base: { ref: 'main' },
    });
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    expect(buzzes.map(buzz => buzz.title)).toEqual(['Merged: #7']);
  });

  test('a buzz carries nothing of GitHub’s but the PR title, cleaned and cut to the push caps', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running, title: 'x'.repeat(3000) });
    const buzzes: any[] = [];
    const host = await boot(github, { buzzes });
    await host.runJob('pulls-watch');
    servePull(github, { ci: failed, title: `${'x'.repeat(3000)}‮` });
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(Object.keys(buzzes[0]).sort()).toEqual(['body', 'eventKey', 'kind', 'tag', 'title', 'url']);
    expect(buzzes[0].body.length).toBeLessThanOrEqual(200);
    expect(buzzes[0].body).not.toContain('‮');
  });

  test('with no Access the watch still keeps and shows PRs, and throws nothing', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: failed });
    const host = await boot(github, { access: false });
    await host.runJob('pulls-watch');
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(view.projects[0]?.repos[0]?.pulls[0]?.ci).toBe('failing');
  });
});

describe('watch: failures and the limit', () => {
  test('a read that fails keeps what was last seen, names the problem by our code, and tells nobody anything', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const buzzes: any[] = [];
    const host = await boot(github, {
      buzzes,
      config: { projects: { [P1]: { watch: true, notify: { closed: true } } } },
    });
    await host.runJob('pulls-watch');
    github.fail(LIST, 500);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(view.projects[0]?.repos[0]?.pulls).toHaveLength(1);
    expect(view.projects[0]?.repos[0]?.problem).toBe('pulls_github_error');
    expect(buzzes).toEqual([]);
    // It answers again: the PR is still there, so there is still nothing to say.
    github.clearFailure(LIST);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(buzzes).toEqual([]);
  });

  test('below 10 % of the allowance polling pauses until the reset, and the status says so', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const host = await boot(github);
    await host.runJob('pulls-watch');
    const resetSec = Math.floor(Date.parse('2026-11-06T09:30:00.000Z') / 1000);
    github.rate(100, resetSec);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    const asked = github.seen.length;
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(github.seen.length).toBe(asked);
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(view.projects[0]?.pausedUntil).toBe('2026-11-06T09:30:00.000Z');
  });
});

describe('watch: live, settings and removal', () => {
  test('a change publishes pulls.changed for the project; no change publishes none', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const host = await boot(github);
    await host.runJob('pulls-watch');
    const count = () => host.published.filter(each => each.event === 'pulls.changed').length;
    expect(count()).toBe(1);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(count()).toBe(1);
    servePull(github, { ci: failed });
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(count()).toBe(2);
    expect(host.published.at(-1)?.payload).toEqual({ project: P1 });
  });

  test('the status route answers per project with the effective choices, even for a project not watched', async () => {
    const github = new FakeGithub();
    const host = await boot(github, { config: { projects: {} } });
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(view.projects[0]).toMatchObject({ project: P1, watch: false, repos: [] });
    expect(view.projects[0]?.notify).toMatchObject({ ciFailed: true, ciPassed: false });
  });

  test('PATCH writes the choice to config/pulls.yaml, naming only what changes; an unknown project is 404; a bad body 400', async () => {
    const github = new FakeGithub();
    const host = await boot(github, { config: { projects: {} } });
    const ok = await host.request('PATCH', `/v1/pulls/watch/${P1}`, {
      body: { watch: true, notify: { ciPassed: true } },
    });
    expect(ok.status).toBe(200);
    expect(ok.json()).toMatchObject({ view: { project: P1, watch: true } });
    // The file is the truth: the status now reads it, and a second PATCH keeps what the first chose.
    await host.request('PATCH', `/v1/pulls/watch/${P1}`, { body: { notify: { comment: true } } });
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(view.projects[0]).toMatchObject({ watch: true, notify: { ciPassed: true, comment: true, ciFailed: true } });
    expect(
      (await host.request('PATCH', `/v1/pulls/watch/22222222-2222-4222-8222-222222222222`, { body: { watch: true } }))
        .status,
    ).toBe(404);
    expect((await host.request('PATCH', `/v1/pulls/watch/${P1}`, { body: { watch: 'yes' } })).status).toBe(400);
    expect((await host.request('PATCH', `/v1/pulls/watch/${P1}`, { body: { token: 'x' } })).status).toBe(400);
  });

  test('removing the project, or the account, takes the snapshot with it at once', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const host = await boot(github);
    await host.runJob('pulls-watch');
    const folder = host.state('pulls');
    expect(folder.raw(WATCH_STATE, P1)).toBeDefined();
    host.emit(ProjectRemoved, { id: P1 as never });
    await host.settle();
    expect(folder.raw(WATCH_STATE, P1)).toBeUndefined();
  });
});
