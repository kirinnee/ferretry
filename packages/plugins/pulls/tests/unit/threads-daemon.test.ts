import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import type { GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import daemon from '../../daemon/index.ts';
import { ANSWER_TEXT_BUDGET, FIRST_PAGE } from '../../daemon/features/threads/query.ts';
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

async function boot(github: FakeGithub, projects: ProjectInfo[], api?: GitAccountsApi['api']) {
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        ...(api === undefined ? {} : { api }),
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

/**
 * A busy PR, read the way production reads it: E1's client over a seam with `git-accounts`' HTTP bound. The real
 * `FetchGithubHttp` cannot be imported here (a package is reached only through its contract), so `http` is a stand-in for
 * the one rule that matters to this read: an answer over 4 MiB (`MAX_BYTES` in `git-accounts/daemon/adapters/github-http.ts`)
 * is a refusal with no partial answer. It reads the fake's own HTTP response (`fake.fetch`) and counts its bytes.
 */
describe('GET …/threads on a busy pull request', () => {
  const MIB = 1024 * 1024;
  const http = (github: FakeGithub) => ({
    request: async (request: { method: string; url: string; bearer?: string; json?: unknown }) => {
      const url = new globalThis.URL(request.url);
      const response = await github.fetch(url, { method: request.method, body: JSON.stringify(request.json) });
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > 4 * MIB) throw new Error('GitHub answered with too much data');
      return {
        status: response.status,
        body: JSON.parse(text) as unknown,
        headers: {} as Record<string, string>,
      };
    },
  });
  const throughHttp =
    (github: FakeGithub, seen: Array<{ threads: number; comments: number }> = []): GitAccountsApi['api'] =>
    async (_id, call) => {
      const variables = (call.body as { variables: { threads: number; comments: number } }).variables;
      seen.push({ threads: variables.threads, comments: variables.comments });
      const answer = await http(github).request({
        method: call.method,
        url: `https://api.github.com${call.path}`,
        bearer: 'fake-token',
        json: call.body,
      });
      return { status: answer.status, body: answer.body, headers: answer.headers };
    };
  const busy = (threads: number, replies: number, size: number): FakeThread[] =>
    Array.from({ length: threads }, (_, t) =>
      thread(`T${t}`, {
        comments: Array.from({ length: replies }, (_, c) => ({
          id: `T${t}c${c}`,
          login: 'reviewer',
          body: 'x'.repeat(size),
        })),
      }),
    );
  type Answer = {
    threads: Array<{ id: string; comments: unknown[]; omittedReplies?: number }>;
    truncated: boolean;
  };

  test('the old page (50 threads × 100 replies) is refused by the HTTP bound; the new one is not', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, busy(60, 100, 700));
    const asked = {
      method: 'POST' as const,
      url: 'https://api.github.com/graphql',
      json: { query: 'q', variables: { threads: 50, comments: 100 } },
    };
    // 50 threads × 100 replies of 700 characters is about 4.7 MB: more than the 4 MiB the seam reads.
    await expect(http(fake).request(asked)).rejects.toThrow('too much data');
    const fits = { ...asked, json: { query: 'q', variables: { threads: 20, comments: 20 } } };
    expect((await http(fake).request(fits)).status).toBe(200);
  });

  test('reads a busy PR in 20 × 20 pages, says how many replies each thread has left on GitHub, and stays inside the bound', async () => {
    const fake = new FakeGithub();
    const seen: Array<{ threads: number; comments: number }> = [];
    serveThreads(fake, busy(60, 100, 700));
    const host = await boot(fake, [project()], throughHttp(fake, seen));
    const answer = await host.request('GET', URL);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as Answer;
    expect(body.threads).toHaveLength(60);
    expect(body.truncated).toBe(false);
    expect(body.threads.every(t => t.comments.length === 20 && t.omittedReplies === 80)).toBe(true);
    expect(seen).toEqual([FIRST_PAGE, FIRST_PAGE, FIRST_PAGE]);
    expect(JSON.stringify(body).length).toBeLessThan(ANSWER_TEXT_BUDGET);
  });

  test('a thread whose replies all fit says nothing about omitted ones', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, busy(3, 20, 100));
    const host = await boot(fake, [project()], throughHttp(fake));
    const body = (await (await host.request('GET', URL)).json()) as Answer;
    expect(body.threads).toHaveLength(3);
    expect(body.threads.some(t => 'omittedReplies' in t)).toBe(false);
  });

  test('a page the seam refuses is asked again smaller from the same cursor; the whole answer stops at its text budget', async () => {
    const fake = new FakeGithub();
    const seen: Array<{ threads: number; comments: number }> = [];
    // 20 × 20 of 60 000 characters is 24 MB: refused. 5 × 5 is 1.5 MB: fits. 300 000 characters a thread: 6 fit the budget.
    serveThreads(fake, busy(12, 10, 60_000));
    const host = await boot(fake, [project()], throughHttp(fake, seen));
    const body = (await (await host.request('GET', URL)).json()) as Answer;
    expect(seen.slice(0, 2)).toEqual([FIRST_PAGE, { threads: 5, comments: 5 }]);
    expect(body.threads).toHaveLength(Math.floor(ANSWER_TEXT_BUDGET / (5 * 60_000)));
    expect(body.threads.map(t => t.id)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
    expect(body.truncated).toBe(true);
    expect(ANSWER_TEXT_BUDGET).toBeLessThan(4 * MIB);
  });

  test('a PR with more threads than the answer holds says it is truncated', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, busy(600, 1, 10), 600);
    const host = await boot(fake, [project()], throughHttp(fake));
    const body = (await (await host.request('GET', URL)).json()) as Answer;
    expect(body.threads).toHaveLength(500);
    expect(body.truncated).toBe(true);
  });

  test('stops at the page bound with a truncated answer', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, busy(520, 1, 10));
    const host = await boot(fake, [project()], throughHttp(fake));
    const body = (await (await host.request('GET', URL)).json()) as Answer;
    expect(body.threads).toHaveLength(500);
    expect(body.truncated).toBe(true);
    expect(fake.seen.filter(s => s.path === '/graphql')).toHaveLength(25);
  });

  test('a seam that refuses every size is a 502 on the first page, and a truncated answer once some threads were read', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, busy(30, 1, 10));
    const refusing: GitAccountsApi['api'] = async () => {
      throw new Error('too much');
    };
    const none = await (await boot(fake, [project()], refusing)).request('GET', URL);
    expect(none.status).toBe(502);

    let calls = 0;
    const later: GitAccountsApi['api'] = async (id, call) => {
      calls += 1;
      if (calls > 1) throw new Error('too much');
      return await throughHttp(fake)(id, call);
    };
    const partial = await (await boot(fake, [project()], later)).request('GET', URL);
    expect(partial.status).toBe(200);
    const body = (await partial.json()) as Answer;
    expect(body.threads).toHaveLength(20);
    expect(body.truncated).toBe(true);
  });
});

describe('GET …/threads refusals GitHub and the project can cause', () => {
  test('a repository whose remote is not a GitHub address is not read; a 404 from GitHub is a 404', async () => {
    const fake = new FakeGithub();
    serveThreads(fake, [thread('T1')]);
    const odd = project({ repos: [{ path: '.', remote: 'not a url', provider: 'github' }] });
    expect((await (await boot(fake, [odd])).request('GET', URL)).status).toBe(404);
    expect(fake.seen).toHaveLength(0);

    fake.fail('/graphql', 404);
    const missing = await (await boot(fake, [project()])).request('GET', URL);
    expect(missing.status).toBe(404);
  });
});
