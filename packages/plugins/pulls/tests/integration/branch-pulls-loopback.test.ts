/**
 * G3 U5 at the daemon tier: the REAL `GET /v1/pulls/:project/:repo/branches` route and the REAL `pulls` port over a
 * loopback HTTP server that plays GitHub (fake data, 127.0.0.1 only, no real token and no real GitHub). The server's own
 * request log is what is asserted: what GitHub was asked, and that an unchanged answer is asked for with `If-None-Match`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import type { GitAccountId, GitApiAnswer, GitApiCall } from '@ferretry/plugin-git-accounts/contract';
import { BranchPullsAnswerSchema, PULLS_CODES, PullsPort } from '../../contract/index.ts';
import { repoSegment } from '../../contract/repo-segment.ts';
import daemon from '../../daemon/index.ts';
import { FakeGithub } from '../fixtures/fake-github/index.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const REPO = { owner: 'octo', name: 'widgets' } as const;
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

class Loopback {
  readonly requests: { path: string; ifNoneMatch: string | null }[] = [];
  readonly github = new FakeGithub();
  readonly #server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      this.requests.push({ path: `${url.pathname}${url.search}`, ifNoneMatch: request.headers.get('if-none-match') });
      return await this.github.fetch(url, { method: request.method, headers: request.headers });
    },
  });

  readonly api = async (id: GitAccountId, call: GitApiCall): Promise<GitApiAnswer> => {
    const response = await fetch(`http://127.0.0.1:${this.#server.port}${call.path}`, {
      method: call.method,
      headers: {
        accept: 'application/vnd.github+json',
        ...(call.ifNoneMatch === undefined ? {} : { 'if-none-match': call.ifNoneMatch }),
        'x-fake-account': id,
      },
    });
    const header = (name: string) => response.headers.get(name) ?? undefined;
    const pairs = {
      etag: header('etag'),
      link: header('link'),
      rateLimitRemaining: header('x-ratelimit-remaining'),
      rateLimitReset: header('x-ratelimit-reset'),
    };
    const text = await response.text();
    return {
      status: response.status,
      body: response.status === 304 || text === '' ? undefined : (JSON.parse(text) as unknown),
      headers: Object.fromEntries(Object.entries(pairs).filter(([, value]) => value !== undefined)),
    };
  };

  stop(): void {
    void this.#server.stop(true);
  }
}

const loopbacks: Loopback[] = [];
afterEach(() => {
  for (const each of loopbacks.splice(0)) each.stop();
});

async function boot(found: unknown = project()) {
  const loopback = new Loopback();
  loopbacks.push(loopback);
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...loopback.github.accounts,
        api: loopback.api as never,
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => [], find: async (id: string) => (id === P1 ? found : undefined) },
    },
  });
  return { host, loopback };
}

const list = (branch: string) =>
  `/repos/octo/widgets/pulls?state=all&head=octo:${encodeURIComponent(branch)}&sort=created&direction=desc&per_page=30`;

function serve(github: FakeGithub, branch: string, number: number, over: Record<string, unknown> = {}, ci = 'success') {
  const sha = SHA + String(number);
  github.set(list(branch), [
    {
      number,
      title: 'Fix the thing',
      state: 'closed',
      html_url: `https://github.com/octo/widgets/pull/${number}`,
      user: { login: 'octo-fake' },
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      merged_at: '2026-11-02T00:00:00Z',
      head: { sha, ref: branch },
      base: { ref: 'main' },
      ...over,
    },
  ]);
  github.set(`/repos/octo/widgets/commits/${sha}/check-runs?per_page=100`, {
    check_runs: [{ status: 'completed', conclusion: ci }],
  });
  github.set(`/repos/octo/widgets/actions/runs?head_sha=${sha}&per_page=50`, { workflow_runs: [] });
}

const path = (project = P1) => `/v1/pulls/${project}/${encodeURIComponent(repoSegment(REPO))}/branches`;
const ask = (
  host: Awaited<ReturnType<typeof boot>>['host'],
  branches: readonly string[],
  extra: Record<string, string> = {},
  project = P1,
) => host.request('GET', path(project), { query: { branch: branches, ...extra } });

describe('GET /v1/pulls/:project/:repo/branches over a loopback GitHub', () => {
  test('answers the merged PR of a branch with its merged head, CI word and address; ETag-cached on the second ask', async () => {
    const { host, loopback } = await boot();
    serve(loopback.github, 'feat/done', 41);
    serve(loopback.github, 'feat/open', 42, { state: 'open', merged_at: null }, 'failure');
    loopback.github.set(list('feat/none'), []);

    const first = await ask(host, ['feat/done', 'feat/open', 'feat/none']);
    expect(first.status).toBe(200);
    const answer = BranchPullsAnswerSchema.parse(first.json());
    expect(answer.repo).toEqual({ provider: 'github', ...REPO });
    expect(answer.branches).toEqual([
      {
        branch: 'feat/done',
        outcome: 'pull',
        pull: {
          number: 41,
          state: 'merged',
          createdAt: '2026-11-01T00:00:00Z',
          mergedAt: '2026-11-02T00:00:00Z',
          headSha: `${SHA}41`,
          ci: 'passing',
          url: 'https://github.com/octo/widgets/pull/41',
        },
      },
      expect.objectContaining({
        branch: 'feat/open',
        outcome: 'pull',
        pull: expect.objectContaining({ state: 'open', ci: 'failing' }),
      }),
      { branch: 'feat/none', outcome: 'none' },
    ]);
    // The branch's list went out with the owner-qualified head filter, over every state.
    expect(loopback.requests.map(each => each.path)).toContain(list('feat/done'));
    expect(JSON.stringify(first.json())).not.toContain('Fix the thing');

    const before = loopback.requests.length;
    const again = await ask(host, ['feat/done', 'feat/open', 'feat/none']);
    expect(BranchPullsAnswerSchema.parse(again.json()).branches).toEqual(answer.branches);
    const second = loopback.requests.slice(before);
    expect(second.length).toBe(before);
    expect(second.every(each => each.ifNoneMatch !== null)).toBe(true);
  });

  test('a refused read is `unknown` in a 200 answer, and the rate budget stops the next call from asking GitHub', async () => {
    const { host, loopback } = await boot();
    serve(loopback.github, 'a', 1);
    // 100 left of 5000: the first answer tips the budget under 10 %, so polling pauses until the (test clock's) reset.
    loopback.github.rate(100, Math.floor(host.clock.nowMs() / 1000) + 1200);
    const first = await ask(host, ['a']);
    expect(BranchPullsAnswerSchema.parse(first.json()).branches[0]?.outcome).toBe('pull');
    const asked = loopback.requests.length;
    const paused = await ask(host, ['a', 'b']);
    expect(paused.status).toBe(200);
    expect(BranchPullsAnswerSchema.parse(paused.json()).branches).toEqual([
      { branch: 'a', outcome: 'unknown', code: PULLS_CODES.paused },
      { branch: 'b', outcome: 'unknown', code: PULLS_CODES.paused },
    ]);
    expect(loopback.requests).toHaveLength(asked);
  });

  test('refuses a call that names no branch, too many, an unusable one or an unknown parameter; and a project it does not hold', async () => {
    const { host } = await boot();
    expect((await host.request('GET', path())).status).toBe(400);
    expect(
      (
        await ask(
          host,
          Array.from({ length: 26 }, (_, at) => `b${at}`),
        )
      ).status,
    ).toBe(400);
    expect((await ask(host, ['has space'])).status).toBe(400);
    expect((await ask(host, ['a'], { state: 'open' })).status).toBe(400);
    const other = await ask(host, ['a'], {}, '22222222-2222-4222-8222-222222222222');
    expect(other.status).toBe(404);
    const noAccount = await boot(project({ accounts: undefined }));
    expect((await ask(noAccount.host, ['a'])).status).toBe(409);
    expect(noAccount.loopback.requests).toEqual([]);
  });
});

describe('the `pulls` port', () => {
  test('answers the same read for another plugin; a project it cannot resolve is all unknown and asks GitHub nothing', async () => {
    const { host, loopback } = await boot();
    serve(loopback.github, 'feat/done', 41);
    const port = host.provided(PullsPort);
    expect(await port.branchPulls(P1, REPO, ['feat/done'])).toEqual([
      expect.objectContaining({
        branch: 'feat/done',
        outcome: 'pull',
        pull: expect.objectContaining({ state: 'merged', number: 41 }),
      }),
    ]);
    const asked = loopback.requests.length;
    expect(await port.branchPulls('22222222-2222-4222-8222-222222222222', REPO, ['x', 'x', 'y'])).toEqual([
      { branch: 'x', outcome: 'unknown', code: PULLS_CODES.notFound },
      { branch: 'y', outcome: 'unknown', code: PULLS_CODES.notFound },
    ]);
    expect(loopback.requests).toHaveLength(asked);
  });
});
