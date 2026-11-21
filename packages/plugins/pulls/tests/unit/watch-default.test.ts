/**
 * r11 S7: a project with a linked GitHub account is watched by default (no `pulls.yaml` entry needed), "Stop watching" is
 * the owner's own PATCH, a project with no account asks GitHub for nothing, a notify-only PATCH never changes the watch,
 * and a project watched only by default pushes nothing until an event is ticked.
 */
import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import type { GitApiCall } from '@ferretry/plugin-git-accounts/contract';
import type { WatchOverview } from '../../contract/index.ts';
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

function servePull(github: FakeGithub, ci: { status: string; conclusion: string | null }[]): void {
  github.set(LIST, [
    {
      number: 7,
      title: 'Fix the thing',
      state: 'open',
      draft: false,
      html_url: 'https://github.com/octo/widgets/pull/7',
      user: { login: 'octo-fake' },
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      head: { sha: SHA, ref: 'fix' },
      base: { ref: 'main' },
      requested_reviewers: [],
    },
  ]);
  github.set(`${BASE}/commits/${SHA}/check-runs?per_page=100`, { check_runs: ci });
  github.set(`${BASE}/actions/runs?head_sha=${SHA}&per_page=50`, { workflow_runs: [] });
  github.set(`${BASE}/pulls/7/reviews?per_page=100`, []);
  github.set(`${BASE}/issues/7/comments?per_page=100`, []);
}

const running = [{ status: 'in_progress', conclusion: null }];
const failed = [{ status: 'completed', conclusion: 'failure' }];

async function boot(github: FakeGithub, options: { projects?: unknown[]; config?: unknown; buzzes?: unknown[] } = {}) {
  const buzzes = options.buzzes ?? [];
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        api: async (id: never, call: GitApiCall) => await github.accounts.api(id, call),
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => options.projects ?? [project()], find: async () => undefined },
    },
    uses: { access: { buzz: async (buzz: unknown) => (buzzes.push(buzz), 1) } },
    // No `pulls.yaml` entry at all: the default is what is under test.
    config: { 'pulls.yaml': options.config ?? { projects: {} } },
  });
}

const status = async (host: Awaited<ReturnType<typeof boot>>) =>
  (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>().projects[0];

describe('r11 S7: watched by default when an account is linked', () => {
  test('a linked project with NO pulls.yaml entry is looked at, and says it is watched by default', async () => {
    const github = new FakeGithub();
    servePull(github, running);
    const host = await boot(github);
    await host.runJob('pulls-watch');
    expect(github.seen.filter(seen => seen.path === LIST)).toHaveLength(1);
    expect(await status(host)).toMatchObject({ project: P1, watch: true, watchedBy: 'default' });
    expect((await status(host))?.repos[0]?.pulls).toHaveLength(1);
  });

  test('a project with no linked account asks GitHub for NOTHING and reads as not watched', async () => {
    const github = new FakeGithub();
    servePull(github, running);
    const host = await boot(github, { projects: [project({ accounts: undefined })] });
    await host.runJob('pulls-watch');
    expect(github.seen).toEqual([]);
    expect(await status(host)).toMatchObject({ watch: false, watchedBy: 'default' });
  });

  test('a project that names an account that no longer exists is not read either', async () => {
    const github = new FakeGithub();
    servePull(github, running);
    const host = await boot(github, { projects: [project({ accounts: ['gha_9999'] })] });
    await host.runJob('pulls-watch');
    expect(github.seen).toEqual([]);
    expect(await status(host)).toMatchObject({ watch: false, watchedBy: 'default' });
  });

  test('Stop watching is one PATCH {watch:false}: nothing is asked afterwards, and Watch again turns it back on', async () => {
    const github = new FakeGithub();
    servePull(github, running);
    const host = await boot(github);
    const stopped = await host.request('PATCH', `/v1/pulls/watch/${P1}`, { body: { watch: false } });
    expect(stopped.json()).toMatchObject({ view: { project: P1, watch: false, watchedBy: 'you' } });
    await host.runJob('pulls-watch');
    expect(github.seen).toEqual([]);
    expect(await status(host)).toMatchObject({ watch: false, watchedBy: 'you' });
    await host.request('PATCH', `/v1/pulls/watch/${P1}`, { body: { watch: true } });
    expect(await status(host)).toMatchObject({ watch: true, watchedBy: 'you' });
  });

  test('ticking a notify event on a default-watched project keeps it watched (the stored watch stays absent)', async () => {
    const github = new FakeGithub();
    const host = await boot(github);
    const ticked = await host.request('PATCH', `/v1/pulls/watch/${P1}`, { body: { notify: { ciPassed: true } } });
    expect(ticked.json()).toMatchObject({ view: { watch: true, watchedBy: 'default', notify: { ciPassed: true } } });
    // The read AFTER the patch still has watch: true and is still the default's (it was not turned into a choice).
    expect(await status(host)).toMatchObject({ watch: true, watchedBy: 'default', notify: { ciPassed: true } });
  });

  test('a project watched only by default pushes nothing until an event is ticked; then that event speaks', async () => {
    const github = new FakeGithub();
    servePull(github, running);
    const buzzes: unknown[] = [];
    const host = await boot(github, { buzzes });
    await host.runJob('pulls-watch'); // the silent baseline
    expect((await status(host))?.notify).toMatchObject({ ciFailed: false, reviewRequested: false, approved: false });

    servePull(github, failed);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch'); // CI failed, nobody ticked it
    expect(buzzes).toEqual([]);

    await host.request('PATCH', `/v1/pulls/watch/${P1}`, { body: { notify: { ciFailed: true } } });
    servePull(github, running);
    await host.clock.advance(301_000);
    await host.runJob('pulls-watch');
    servePull(github, failed);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(buzzes).toHaveLength(1);
    expect(buzzes[0]).toMatchObject({ title: 'CI failed on #7' });
  });

  test('a project the owner watched ON PURPOSE keeps the old defaults (CI failures speak with nothing ticked)', async () => {
    const github = new FakeGithub();
    servePull(github, running);
    const buzzes: unknown[] = [];
    const host = await boot(github, { buzzes, config: { projects: { [P1]: { watch: true } } } });
    await host.runJob('pulls-watch');
    servePull(github, failed);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(buzzes).toHaveLength(1);
    expect(await status(host)).toMatchObject({ watch: true, watchedBy: 'you', notify: { ciFailed: true } });
  });
});
