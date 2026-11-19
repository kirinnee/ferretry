import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { GitAccountDisconnected, type GitApiCall } from '@ferretry/plugin-git-accounts/contract';
import { ProjectRemoved } from '@ferretry/plugin-projects/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import type { Log } from '@ferretry/kernel/contract';
import {
  PULLS_CACHE,
  PullsConfigSchema,
  WATCH_STATE,
  type WatchOverview,
  type WatchSnapshot,
} from '../../contract/index.ts';
import { GithubClient } from '../../daemon/adapters/github/client.ts';
import { WatchService } from '../../daemon/features/watch/service.ts';
import type { WatchStore } from '../../daemon/features/watch/store.ts';
import type { PullBuzz } from '../../daemon/features/watch/words.ts';
import { PullsCache } from '../../daemon/lib/cache/store.ts';
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
  options: {
    projects?: unknown[];
    config?: unknown;
    access?: boolean;
    buzzes?: unknown[];
    /** Runs before each GitHub call is answered: a test holds a response here. */
    before?: (call: GitApiCall) => Promise<void>;
    buzz?: (buzz: unknown) => Promise<unknown>;
  } = {},
) {
  const buzzes = options.buzzes ?? [];
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        api: async (id: never, call: GitApiCall) => {
          await options.before?.(call);
          return await github.accounts.api(id, call);
        },
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => options.projects ?? [project()], find: async () => undefined },
    },
    ...(options.access === false
      ? {}
      : { uses: { access: { buzz: options.buzz ?? (async (buzz: unknown) => (buzzes.push(buzz), 1)) } } }),
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

const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const P4 = '44444444-4444-4444-8444-444444444444';
const everyone = (...ids: string[]) => ({ projects: Object.fromEntries(ids.map(id => [id, { watch: true }])) });

describe('watch: one budget per account, shared by every project', () => {
  test('Retry-After on one project’s read keeps the other project, on the same account, from asking until it passes', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: passed });
    github.fail(LIST, 429, { retryAfter: '120' });
    const host = await boot(github, {
      projects: [project(), project({ id: P2, name: 'gadgets' })],
      config: everyone(P1, P2),
    });
    await host.runJob('pulls-watch');
    expect(github.seen).toHaveLength(1);

    github.clearFailure(LIST);
    await host.clock.advance(60_000);
    await host.runJob('pulls-watch');
    expect(github.seen).toHaveLength(1);
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(view.projects.map(each => each.pausedUntil)).toEqual([expect.any(String), expect.any(String)]);

    // 121 s after the first answer: the project that was never asked is asked now, and it is still due (it did not lose its turn).
    await host.clock.advance(61_000);
    await host.runJob('pulls-watch');
    expect(github.seen.filter(seen => seen.path === LIST).length).toBeGreaterThan(1);
  });

  test('a secondary-limit 403 (GitHub’s own words, no Retry-After) holds the account for a minute', async () => {
    const github = new FakeGithub();
    github.on('GET', '/repos/octo/widgets/pulls', () => ({
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit.' },
    }));
    const host = await boot(github, { projects: [project(), project({ id: P2 })], config: everyone(P1, P2) });
    await host.runJob('pulls-watch');
    expect(github.seen).toHaveLength(1);
  });

  test('a 5xx backs the account off for longer each time in a row, and an answer ends it', async () => {
    const real = Math.random;
    Math.random = () => 1; // the longest of each jittered wait
    try {
      const github = new FakeGithub();
      servePull(github, { ci: running });
      const host = await boot(github);
      await host.runJob('pulls-watch');
      github.fail(LIST, 500);
      const asked = () => looks(github);
      await host.clock.advance(31_000);
      await host.runJob('pulls-watch'); // fails: 30 s
      expect(asked()).toBe(2);
      await host.clock.advance(31_000);
      await host.runJob('pulls-watch'); // free again, fails again: 60 s
      expect(asked()).toBe(3);
      await host.clock.advance(31_000);
      await host.runJob('pulls-watch'); // still backing off
      expect(asked()).toBe(3);
      const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
      expect(view.projects[0]?.repos[0]?.problem).toBe('pulls_github_error');
      await host.clock.advance(31_000);
      github.clearFailure(LIST);
      await host.runJob('pulls-watch');
      expect(asked()).toBe(4);
      // The answer cleared the backoff: the next failure waits 30 s again, not 120 s.
      github.fail(LIST, 500);
      await host.clock.advance(31_000);
      await host.runJob('pulls-watch');
      expect(asked()).toBe(5);
      await host.clock.advance(31_000);
      await host.runJob('pulls-watch');
      expect(asked()).toBe(6);
    } finally {
      Math.random = real;
    }
  });

  test('a long list of projects is looked at three a pass, the longest-waiting first, so GitHub is not hit all at once', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const ids = [P1, P2, P3, P4];
    const host = await boot(github, {
      projects: ids.map(id => project({ id, name: `w${id.slice(0, 2)}` })),
      config: everyone(...ids),
    });
    await host.runJob('pulls-watch');
    expect(looks(github)).toBe(3);
    await host.clock.advance(1_000);
    await host.runJob('pulls-watch');
    expect(looks(github)).toBe(4);
  });
});

describe('watch: a look that lands after its project is gone', () => {
  /** Boots with a baseline of CI running, then holds the next list read; `during` happens while it is held. */
  async function held(during: (host: Awaited<ReturnType<typeof boot>>, projects: unknown[]) => Promise<void>) {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const buzzes: any[] = [];
    let armed = false;
    let held = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    const projects: unknown[] = [project()];
    const host = await boot(github, {
      buzzes,
      projects,
      config: { projects: { [P1]: { watch: true, notify: { ciFailed: true } } } },
      before: async call => {
        if (armed && call.path === LIST) {
          held += 1;
          await gate;
        }
      },
    });
    await host.runJob('pulls-watch');
    const folder = host.state('pulls');
    const baseline = folder.raw(WATCH_STATE, P1);
    const changes = () => host.published.filter(each => each.event === 'pulls.changed').length;
    const before = changes();
    servePull(github, { ci: failed });
    await host.clock.advance(31_000);
    armed = true;
    const pass = host.runJob('pulls-watch');
    while (held === 0) await new Promise(resolve => setTimeout(resolve, 0));
    await during(host, projects);
    await host.settle();
    release();
    await pass;
    return { folder, baseline, buzzes, changed: changes() - before };
  }

  test('removed: nothing is written back, nothing is sent, nobody is told', async () => {
    const out = await held(async host => {
      host.emit(ProjectRemoved, { id: P1 as never });
    });
    expect(out.folder.raw(WATCH_STATE, P1)).toBeUndefined();
    expect(out.buzzes).toEqual([]);
    expect(out.changed).toBe(0);
  });

  test('its account removed: the snapshot has none of its repositories, and nothing is sent', async () => {
    const out = await held(async host => {
      host.emit(GitAccountDisconnected, { id: 'gha_4242' as never });
    });
    expect(JSON.parse(out.folder.raw(WATCH_STATE, P1) ?? '{}').repos).toEqual([]);
    expect(out.buzzes).toEqual([]);
  });

  test('unlinked from its account: the stale look changes nothing on disk and sends nothing', async () => {
    const out = await held(async (_host, projects) => {
      projects[0] = project({ accounts: undefined });
    });
    expect(out.folder.raw(WATCH_STATE, P1)).toBe(out.baseline);
    expect(out.buzzes).toEqual([]);
    expect(out.changed).toBe(0);
  });

  test('a project that is gone from the list altogether is not written either', async () => {
    const out = await held(async (_host, projects) => {
      projects.length = 0;
    });
    expect(out.folder.raw(WATCH_STATE, P1)).toBe(out.baseline);
    expect(out.buzzes).toEqual([]);
  });
});

describe('watch: many alerts at once, and a write that fails', () => {
  /** Serves `count` open PRs, each asking the account for a review (or not), on one repository. */
  function serveMany(
    github: FakeGithub,
    numbers: readonly number[],
    options: { asked: boolean | readonly number[]; mine?: boolean },
  ): void {
    github.set(
      LIST,
      numbers.map(number => ({
        number,
        title: `PR ${number}`,
        state: 'open',
        draft: false,
        html_url: `https://github.com/octo/widgets/pull/${number}`,
        user: { login: options.mine === true ? 'octo-fake' : 'someone' },
        created_at: '2026-11-01T00:00:00Z',
        updated_at: `2026-11-02T00:00:${String(60 - (number % 60)).padStart(2, '0')}Z`,
        head: { sha: `abcdef${number}`, ref: `b${number}` },
        base: { ref: 'main' },
        requested_reviewers:
          options.asked === true || (Array.isArray(options.asked) && options.asked.includes(number))
            ? [{ login: 'octo-fake' }]
            : [],
      })),
    );
    for (const number of numbers) {
      github.set(`${BASE}/commits/abcdef${number}/check-runs?per_page=100`, { check_runs: [] });
      github.set(`${BASE}/actions/runs?head_sha=abcdef${number}&per_page=50`, { workflow_runs: [] });
      github.set(`${BASE}/pulls/${number}/reviews?per_page=100`, []);
      github.set(`${BASE}/issues/${number}/comments?per_page=100`, []);
    }
  }
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, at) => from + at);

  test('thirty review requests after a long sleep are ONE alert that counts them; three or fewer speak one by one', async () => {
    const github = new FakeGithub();
    serveMany(github, range(1, 30), { asked: false });
    const buzzes: any[] = [];
    const host = await boot(github, { buzzes });
    await host.runJob('pulls-watch');
    serveMany(github, range(1, 30), { asked: true });
    await host.clock.advance(8 * 3_600_000);
    await host.runJob('pulls-watch');
    expect(buzzes).toHaveLength(1);
    expect(buzzes[0]).toMatchObject({
      title: '30 review requests in octo/widgets',
      kind: 'pr',
      tag: 'pr-octo:widgets-reviewRequested',
    });
    expect(buzzes[0].body).toBe('PR 1 and 29 more');
    expect(buzzes[0].eventKey.length).toBeLessThanOrEqual(400);

    // Three is still three, each told by itself.
    buzzes.length = 0;
    serveMany(github, range(1, 30), { asked: false });
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    serveMany(github, range(1, 30), { asked: [1, 2, 3] });
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    expect(buzzes.map(buzz => buzz.title)).toEqual([
      'Review requested on #1',
      'Review requested on #2',
      'Review requested on #3',
    ]);
  });

  test('a failed write keeps the last valid snapshot, tells nothing, and the next look tells it once', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    let nowMs = Date.parse('2026-11-06T09:00:00.000Z');
    const quiet: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
    const folder = new MemoryStateFolder(() => nowMs);
    const client = new GithubClient(
      github.accounts,
      new PullsCache(folder.port([PULLS_CACHE]), () => nowMs, quiet),
      () => nowMs,
      quiet,
    );
    let kept: WatchSnapshot | undefined;
    let failing = false;
    const store = {
      read: async () => kept,
      write: async (_project: string, snapshot: WatchSnapshot) => {
        if (failing) throw new Error('disk full');
        kept = snapshot;
      },
      remove: async () => undefined,
      projects: async () => [],
    } as unknown as WatchStore;
    const sent: PullBuzz[] = [];
    const service = new WatchService({
      github: client,
      store,
      projects: async () => [project() as never],
      accounts: async () => [github.account],
      config: () => PullsConfigSchema.parse({ projects: { [P1]: { watch: true } } }),
      buzz: () => async buzz => sent.push(buzz),
      changed: () => undefined,
      nowMs: () => nowMs,
      random: () => 0.5,
      log: quiet,
    });
    await service.tick();
    servePull(github, { ci: failed });
    nowMs += 31_000;
    failing = true;
    await service.tick();
    expect(sent).toEqual([]);
    expect((await service.overview()).projects[0]?.repos[0]?.pulls[0]?.ci).toBe('running');
    failing = false;
    nowMs += 31_000;
    await service.tick();
    expect(sent.map(buzz => buzz.title)).toEqual(['CI failed on #7']);
    expect((await service.overview()).projects[0]?.repos[0]?.pulls[0]?.ci).toBe('failing');
  });

  test('an account made to wait mid-pass: the next project is not asked, keeps what it last showed, and the status says until when', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: passed });
    const host = await boot(github, {
      projects: [project(), project({ id: P2, name: 'gadgets' })],
      config: everyone(P1, P2),
    });
    await host.runJob('pulls-watch');
    github.fail(LIST, 429, { retryAfter: '120' });
    await host.clock.advance(STEP);
    await host.runJob('pulls-watch');
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(github.seen.filter(seen => seen.path === LIST).length).toBe(3);
    expect(view.projects.map(each => each.repos[0]?.pulls.length)).toEqual([1, 1]);
    expect(view.projects.map(each => each.pausedUntil)).toEqual([expect.any(String), expect.any(String)]);
  });

  test('a pass that throws, and a push that cannot be sent, are logged and never thrown', async () => {
    const github = new FakeGithub();
    servePull(github, { ci: running });
    const host = await boot(github, {
      buzz: async () => {
        throw new Error('push is down');
      },
    });
    await host.runJob('pulls-watch');
    servePull(github, { ci: failed });
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    const view = (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>();
    expect(view.projects[0]?.repos[0]?.pulls[0]?.ci).toBe('failing');

    const quiet: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
    const service = new WatchService({
      github: undefined as never,
      store: undefined as never,
      projects: async () => {
        throw new Error('no projects');
      },
      accounts: async () => [],
      config: () => undefined,
      buzz: () => undefined,
      changed: () => undefined,
      nowMs: () => 0,
      random: () => 0,
      log: quiet,
    });
    await service.tick();
  });

  test('120 open own PRs seen over several looks never push the status past its cap: it answers 200 with the newest 100', async () => {
    const github = new FakeGithub();
    const host = await boot(github);
    for (const from of [1, 31, 61, 91, 121]) {
      serveMany(github, range(from, from + 29), { asked: false, mine: true });
      await host.runJob('pulls-watch');
      await host.clock.advance(STEP);
    }
    const out = await host.request('GET', '/v1/pulls/watch');
    expect(out.status).toBe(200);
    const pulls = out.json<WatchOverview>().projects[0]?.repos[0]?.pulls ?? [];
    expect(pulls).toHaveLength(100);
    expect(pulls.map(each => each.number)).toContain(150);
    expect(JSON.parse(host.state('pulls').raw(WATCH_STATE, P1) ?? '{}').repos[0].pulls).toHaveLength(100);
  });
});
