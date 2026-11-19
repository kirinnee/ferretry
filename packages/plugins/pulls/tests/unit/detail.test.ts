import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { NO_SECRET_FIELDS, PULLS_CODES, PullPageAnswerSchema, type PullPage } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { checkStatus, githubUrl, mapChecks, mapReviews, reviewState } from '../../daemon/features/detail/map.ts';
import { FAKE_ACCOUNT, FakeGithub } from '../fixtures/fake-github/index.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const SHA = 'a'.repeat(40);

const project = (over: Record<string, unknown> = {}) => ({
  id: P1,
  name: 'demo',
  path: '/work/demo',
  source: 'existing-folder',
  createdAt: '2026-01-01T00:00:00.000Z',
  accounts: [FAKE_ACCOUNT],
  repos: [{ path: '.', remote: 'https://github.com/octo/demo', provider: 'github' }],
  ...over,
});

async function boot(github: FakeGithub, found: unknown = project()) {
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => [], find: async (id: string) => (id === P1 ? found : undefined) },
    },
  });
}

const prJson = (over: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Add the thing',
  user: { login: 'alice', avatar_url: 'https://avatars.githubusercontent.com/u/1', id: 1 },
  state: 'open',
  draft: false,
  merged_at: null,
  closed_at: null,
  created_at: '2026-02-01T10:00:00Z',
  updated_at: '2026-02-02T10:00:00Z',
  body: 'Hello <script>alert(1)</script>',
  body_html: '<p>NEVER SHOWN</p>',
  head: { sha: SHA, ref: 'feature' },
  base: { ref: 'main' },
  requested_reviewers: [{ login: 'bob' }],
  commits: 2,
  changed_files: 3,
  additions: 10,
  deletions: 4,
  ...over,
});

function seed(github: FakeGithub, over: Record<string, unknown> = {}) {
  github.set('/repos/octo/demo/pulls/7', prJson(over));
  github.set('/repos/octo/demo/issues/7/comments?per_page=100', [
    {
      id: 11,
      user: { login: 'bob' },
      body: 'first',
      created_at: '2026-02-01T11:00:00Z',
      html_url: 'https://github.com/octo/demo/pull/7#issuecomment-11',
    },
    {
      id: 12,
      user: null,
      body: 'from a ghost',
      created_at: '2026-02-01T12:00:00Z',
      html_url: 'https://evil.example/x',
    },
  ]);
  github.set('/repos/octo/demo/pulls/7/reviews?per_page=100', [
    {
      id: 21,
      user: { login: 'bob' },
      state: 'CHANGES_REQUESTED',
      body: 'please fix',
      submitted_at: '2026-02-01T13:00:00Z',
      html_url: 'https://github.com/octo/demo/pull/7#pullrequestreview-21',
    },
    { id: 22, user: { login: 'carol' }, state: 'PENDING', body: 'my draft', submitted_at: null },
  ]);
  github.set(`/repos/octo/demo/commits/${SHA}/check-runs?per_page=100`, {
    total_count: 2,
    check_runs: [
      { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.com/octo/demo/runs/1' },
      { name: 'test', status: 'in_progress', conclusion: null },
    ],
  });
}

const URL_OK = `/v1/pulls/${P1}/octo~demo/7`;

describe('GET /v1/pulls/:project/:repo/:number', () => {
  test('answers the PR, its conversation and its checks, in the wire shape alone', async () => {
    const github = new FakeGithub();
    seed(github);
    const host = await boot(github);
    const res = await host.request('GET', URL_OK);
    expect(res.status).toBe(200);
    const page = PullPageAnswerSchema.parse(await res.json()) as PullPage;
    expect(page.kind).toBe('page');
    expect(page.pull).toMatchObject({
      number: 7,
      title: 'Add the thing',
      state: 'open',
      review: 'changes_requested',
      ci: 'running',
      url: 'https://github.com/octo/demo/pull/7',
      requestedReviewers: ['bob'],
    });
    expect(page.pull.author).toEqual({ login: 'alice' });
    expect(page.comments.map(c => c.author.login)).toEqual(['bob', 'ghost']);
    // An address that is not on github.com is replaced by the PR's own.
    expect(page.comments[1]?.url).toBe('https://github.com/octo/demo/pull/7');
    // A pending review is somebody's unsent draft.
    expect(page.reviews.map(r => r.id)).toEqual(['21']);
    expect(page.checks).toMatchObject({ state: 'running', total: 2, passed: 1, running: 1 });
    const text = JSON.stringify(page);
    expect(text).not.toContain('NEVER SHOWN');
    expect(text).not.toContain('avatar');
    expect(text).not.toMatch(NO_SECRET_FIELDS);
  });

  test('reads through the one client: a second page read is all 304', async () => {
    const github = new FakeGithub();
    seed(github);
    const host = await boot(github);
    await host.request('GET', URL_OK);
    const spent = github.remaining;
    const again = PullPageAnswerSchema.parse(await (await host.request('GET', URL_OK)).json()) as PullPage;
    expect(again.fromCache).toBe(true);
    expect(github.remaining).toBe(spent);
    expect(github.seen.every(call => call.account === FAKE_ACCOUNT && call.method === 'GET')).toBe(true);
  });

  test('a merged PR reads merged; a draft reads draft', async () => {
    const github = new FakeGithub();
    seed(github, {
      state: 'closed',
      merged_at: '2026-02-03T10:00:00Z',
      closed_at: '2026-02-03T10:00:00Z',
      draft: true,
    });
    const page = PullPageAnswerSchema.parse(
      await (await (await boot(github)).request('GET', URL_OK)).json(),
    ) as PullPage;
    expect(page.pull).toMatchObject({ state: 'merged', draft: true, mergedAt: '2026-02-03T10:00:00Z' });
  });

  test('says "paused" with the time when the budget is under 10 %, and reads nothing more', async () => {
    const github = new FakeGithub();
    seed(github);
    // The test host's clock starts at 2026-11-06T09:00:00Z; the allowance resets half an hour later.
    const resetSec = Date.parse('2026-11-06T09:30:00Z') / 1000;
    github.rate(100, resetSec);
    const host = await boot(github);
    await host.request('GET', URL_OK);
    const seen = github.seen.length;
    const answer = PullPageAnswerSchema.parse(await (await host.request('GET', URL_OK)).json());
    expect(answer).toEqual({ kind: 'paused', until: new Date(resetSec * 1000).toISOString() });
    expect(github.seen.length).toBe(seen);
  });

  test('refuses a project that is unknown, a repository it does not hold, and a project with no account', async () => {
    const github = new FakeGithub();
    seed(github);
    const host = await boot(github);
    expect((await host.request('GET', `/v1/pulls/22222222-2222-4222-8222-222222222222/octo~demo/7`)).status).toBe(404);
    expect((await host.request('GET', `/v1/pulls/${P1}/octo~other/7`)).status).toBe(404);
    expect(github.seen.length).toBe(0);
    const bare = await boot(
      github,
      project({ accounts: [], repos: [{ path: '.', remote: 'https://github.com/octo/demo' }] }),
    );
    const noAccount = await bare.request('GET', URL_OK);
    expect(noAccount.status).toBe(409);
    expect(JSON.stringify(await noAccount.json())).toContain(PULLS_CODES.noAccount);
    expect(github.seen.length).toBe(0);
  });

  test('a repository linked to its own account uses it, not the project’s first', async () => {
    const github = new FakeGithub();
    seed(github);
    github.knownAccounts.add('gha_9' as never);
    const host = await boot(
      github,
      project({
        accounts: ['gha_9'],
        repos: [{ path: '.', remote: 'https://github.com/Octo/Demo.git', account: FAKE_ACCOUNT }],
      }),
    );
    expect((await host.request('GET', URL_OK)).status).toBe(200);
    expect(github.seen.every(call => call.account === FAKE_ACCOUNT)).toBe(true);
  });

  test('malformed path parts are 400 before any lookup', async () => {
    const github = new FakeGithub();
    const host = await boot(github);
    for (const path of [
      `/v1/pulls/not-a-uuid/octo~demo/7`,
      `/v1/pulls/${P1}/octo-demo/7`,
      `/v1/pulls/${P1}/octo~demo/0`,
      `/v1/pulls/${P1}/octo~demo/x`,
    ])
      expect((await host.request('GET', path)).status).toBe(400);
    expect(github.seen.length).toBe(0);
  });

  test('GitHub errors map to our words, never GitHub’s text', async () => {
    const github = new FakeGithub();
    seed(github);
    github.fail('/repos/octo/demo/pulls/7', 404);
    const host = await boot(github);
    const res = await host.request('GET', URL_OK);
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain('fake failure');
  });
});

describe('mapping', () => {
  test('githubUrl keeps https github.com only', () => {
    expect(githubUrl('https://github.com/o/r/pull/1')).toBe('https://github.com/o/r/pull/1');
    for (const bad of [
      'http://github.com/x',
      'https://evil.example/x',
      'javascript:alert(1)',
      'https://u:p@github.com/x',
      'https://github.com.evil.example/x',
      undefined,
    ])
      expect(githubUrl(bad)).toBeUndefined();
  });
  test('check statuses and the one word for the PR', () => {
    expect(checkStatus('completed', 'failure')).toBe('failed');
    expect(checkStatus('completed', 'skipped')).toBe('skipped');
    expect(checkStatus('queued', null)).toBe('queued');
    expect(mapChecks({ check_runs: [] }).state).toBe('none');
    expect(
      mapChecks({
        check_runs: [
          { name: 'a', status: 'completed', conclusion: 'success' },
          { name: 'b', status: 'completed', conclusion: 'failure' },
        ],
      }).state,
    ).toBe('failing');
    expect(mapChecks('nonsense').total).toBe(0);
  });
  test('the latest decisive review of a person decides; a request alone reads review_required', () => {
    const r = (login: string, verdict: string) => ({
      id: login + verdict,
      user: { login },
      state: verdict,
      body: '',
      submitted_at: '2026-01-01T00:00:00Z',
    });
    const reviews = mapReviews([r('bob', 'CHANGES_REQUESTED'), r('bob', 'APPROVED')], 'https://github.com/o/r/pull/1');
    expect(reviewState(reviews, 0)).toBe('approved');
    expect(reviewState([], 1)).toBe('review_required');
    expect(reviewState([], 0)).toBe('none');
  });
});
