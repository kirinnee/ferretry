import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import daemon from '../../daemon/index.ts';
import { FakeGithub } from '../fixtures/fake-github/index.ts';
import { type FakeThread, serveThreads } from '../fixtures/fake-github/threads.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const project = (patch: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    id: P1,
    path: '/work/demo',
    name: 'demo',
    accounts: ['gha_4242'],
    repos: [{ path: '.', remote: 'https://github.com/octo/demo', provider: 'github' }],
    ...patch,
  }) as ProjectInfo;

async function boot(github: FakeGithub, projects: ProjectInfo[]) {
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => projects, find: async (id: string) => projects.find(p => p.id === id) },
    },
  });
}

const URL = `/v1/pulls/${P1}/octo~demo/7/threads`;
const thread = (id: string, patch: Partial<FakeThread> = {}): FakeThread => ({
  id,
  path: 'src/a.ts',
  line: 10,
  comments: [{ id: `${id}c1`, login: 'reviewer', body: 'please rename' }],
  ...patch,
});

describe('GET …/threads', () => {
  test('answers the threads in the wire shape, both sides, resolved and outdated flagged', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, [
      thread('T1'),
      thread('T2', { side: 'LEFT', line: 4, startLine: 2, resolved: true }),
      thread('T3', { outdated: true, line: null }),
    ]);
    const host = await boot(fake, [project()]);
    const answer = await host.request('GET', URL);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { threads: Array<Record<string, unknown>>; truncated: boolean };
    expect(body.truncated).toBe(false);
    expect(body.threads.map(t => [t.id, t.side, t.line, t.startLine, t.resolved, t.outdated])).toEqual([
      ['T1', 'right', 10, undefined, false, false],
      ['T2', 'left', 4, 2, true, false],
      ['T3', 'right', undefined, undefined, false, true],
    ]);
    // GraphQL is not cached: asking again asks GitHub again.
    await host.request('GET', URL);
    expect(fake.seen.filter(s => s.path === '/graphql')).toHaveLength(2);
  });

  test('follows the cursor across pages', async () => {
    const fake = new FakeGithub();
    serveThreads(
      fake,
      Array.from({ length: 7 }, (_, i) => thread(`T${i}`)),
      3,
    );
    const host = await boot(fake, [project()]);
    const body = (await (await host.request('GET', URL)).json()) as { threads: unknown[]; truncated: boolean };
    expect(body.threads).toHaveLength(7);
    expect(body.truncated).toBe(false);
    expect(fake.seen.filter(s => s.path === '/graphql')).toHaveLength(3);
  });

  test('a deleted author reads as ghost; a malformed thread is dropped and the answer says it is incomplete', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, [
      thread('T1', { comments: [{ id: 'c', login: null, body: 'gone' }] }),
      thread('T2', { comments: [] }),
    ]);
    const host = await boot(fake, [project()]);
    const body = (await (await host.request('GET', URL)).json()) as {
      threads: Array<{ comments: Array<{ author: { login: string } }> }>;
      truncated: boolean;
    };
    expect(body.threads).toHaveLength(1);
    expect(body.threads[0]?.comments[0]?.author.login).toBe('ghost');
    expect(body.truncated).toBe(true);
  });

  test('refuses with its own words: no project, repository not in the project, no account, bad path, no such PR', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, undefined);
    const host = await boot(fake, [
      project(),
      project({ id: '22222222-2222-4222-8222-222222222222' as ProjectInfo['id'], accounts: [] }),
    ]);
    expect(
      (await host.request('GET', `/v1/pulls/33333333-3333-4333-8333-333333333333/octo~demo/7/threads`)).status,
    ).toBe(404);
    expect((await host.request('GET', `/v1/pulls/${P1}/octo~other/7/threads`)).status).toBe(404);
    expect(
      (await host.request('GET', `/v1/pulls/22222222-2222-4222-8222-222222222222/octo~demo/7/threads`)).status,
    ).toBe(409);
    expect((await host.request('GET', `/v1/pulls/${P1}/octo-demo/7/threads`)).status).toBe(400);
    expect((await host.request('GET', `/v1/pulls/${P1}/octo~demo/0/threads`)).status).toBe(400);
    expect((await host.request('GET', `/v1/pulls/${P1}/octo~demo/abc/threads`)).status).toBe(400);
    expect((await host.request('GET', URL)).status).toBe(404);
    // Nothing was asked of GitHub for a refused path except the one real read.
    expect(fake.seen.filter(s => s.path === '/graphql')).toHaveLength(1);
  });

  test('a repository’s own account wins over the project’s first; a rate pause is a 503, never GitHub’s text', async () => {
    const fake = new FakeGithub();
    fake.knownAccounts.add('gha_9' as never);
    serveThreads(fake, [thread('T1')]);
    const own = project({
      repos: [{ path: '.', remote: 'https://github.com/OCTO/demo.git', provider: 'github', account: 'gha_9' }],
    });
    const host = await boot(fake, [own]);
    expect((await host.request('GET', URL)).status).toBe(200);
    expect(fake.seen.at(-1)?.account).toBe('gha_9');

    const limited = new FakeGithub();
    serveThreads(limited, [thread('T1')]);
    limited.rate(1, 4_102_444_800, 5000);
    const paused = await boot(limited, [project()]);
    await paused.request('GET', URL);
    const second = await paused.request('GET', URL);
    expect(second.status).toBe(503);
    expect(JSON.stringify(await second.json())).not.toContain('rate limit exceeded');
  });
});
