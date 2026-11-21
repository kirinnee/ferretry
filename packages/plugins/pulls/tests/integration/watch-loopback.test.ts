/**
 * r11 S7 at the daemon tier: the REAL watch (its routes and its job) over a REAL loopback HTTP server that plays GitHub, and
 * a push sink. The server's own request log is what is asserted, so the count is what GitHub would have been asked, not a
 * number a stand-in kept about itself. Fake data only; the server listens on 127.0.0.1 only, on a free port.
 *
 *   - a project with no linked account (or one naming an account that is gone) asks GitHub for NOTHING;
 *   - a project watched only by default sends NO push for a confirmed CI failure; after the owner ticks the event, ONE;
 *   - THE RACE: a read of project A is held at the server, project B (queued behind it in the same pass) is unlinked, then A
 *     is released. B must not be asked at all, with its former account or any other.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import type { GitAccountId, GitApiAnswer, GitApiCall } from '@ferretry/plugin-git-accounts/contract';
import { WATCH_STATE, type WatchOverview } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { FakeGithub } from '../fixtures/fake-github/index.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const SHA = 'abcdef1234567';
const listOf = (repo: string) => `/repos/octo/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=30`;

const project = (id: string, repo: string, over: Record<string, unknown> = {}) => ({
  id,
  name: repo,
  path: `/work/${repo}`,
  source: 'existing-folder',
  createdAt: '2026-01-01T00:00:00.000Z',
  accounts: ['gha_4242'],
  repos: [{ path: '.', provider: 'github', remote: `https://github.com/octo/${repo}` }],
  ...over,
});

function servePull(github: FakeGithub, repo: string, ci: { status: string; conclusion: string | null }[]): void {
  const base = `/repos/octo/${repo}`;
  github.set(listOf(repo), [
    {
      number: 7,
      title: 'Fix the thing',
      state: 'open',
      draft: false,
      html_url: `https://github.com/octo/${repo}/pull/7`,
      user: { login: 'octo-fake' },
      created_at: '2026-11-01T00:00:00Z',
      updated_at: '2026-11-02T00:00:00Z',
      head: { sha: SHA, ref: 'fix' },
      base: { ref: 'main' },
      requested_reviewers: [],
    },
  ]);
  github.set(`${base}/commits/${SHA}/check-runs?per_page=100`, { check_runs: ci });
  github.set(`${base}/actions/runs?head_sha=${SHA}&per_page=50`, { workflow_runs: [] });
  github.set(`${base}/pulls/7/reviews?per_page=100`, []);
  github.set(`${base}/issues/7/comments?per_page=100`, []);
}

const running = [{ status: 'in_progress', conclusion: null }];
const failed = [{ status: 'completed', conclusion: 'failure' }];

/** A loopback "GitHub": every request is logged here, and a test can hold the answer to one path. */
class Loopback {
  readonly requests: string[] = [];
  readonly github = new FakeGithub();
  #hold: { path: string; reached: () => void; release: Promise<void> } | undefined;
  readonly #server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      this.requests.push(`${url.pathname}${url.search}`);
      const hold = this.#hold;
      if (hold !== undefined && `${url.pathname}${url.search}` === hold.path) {
        this.#hold = undefined;
        hold.reached();
        await hold.release;
      }
      return await this.github.fetch(url, {
        method: request.method,
        headers: request.headers,
        ...(request.method === 'GET' ? {} : { body: await request.text() }),
      });
    },
  });

  /** Holds the answer to the next request for `path` until `release()`; resolves `reached` once it is being held. */
  hold(path: string): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>(resolve => (release = resolve));
    const arrived = new Promise<void>(resolve => (reached = resolve));
    this.#hold = { path, reached, release: released };
    return { reached: arrived, release };
  }

  /** The kernel's `api` seam, answered over real HTTP by this server. */
  readonly api = async (id: GitAccountId, call: GitApiCall): Promise<GitApiAnswer> => {
    const response = await fetch(`http://127.0.0.1:${this.#server.port}${call.path}`, {
      method: call.method,
      headers: {
        accept: 'application/vnd.github+json',
        ...(call.ifNoneMatch === undefined ? {} : { 'if-none-match': call.ifNoneMatch }),
        'x-fake-account': id,
      },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    });
    const header = (name: string) => response.headers.get(name) ?? undefined;
    const pairs = {
      etag: header('etag'),
      link: header('link'),
      rateLimitRemaining: header('x-ratelimit-remaining'),
      rateLimitReset: header('x-ratelimit-reset'),
      retryAfter: header('retry-after'),
      oauthScopes: header('x-oauth-scopes'),
    };
    const text = await response.text();
    return {
      status: response.status,
      body: response.status === 304 || text === '' ? undefined : (JSON.parse(text) as unknown),
      headers: Object.fromEntries(Object.entries(pairs).filter(([, value]) => value !== undefined)),
    };
  };

  /** Requests for one repository's pull list: the first read the watch makes of it. */
  lookedAt(repo: string): number {
    return this.requests.filter(path => path === listOf(repo)).length;
  }

  stop(): void {
    void this.#server.stop(true);
  }
}

const loopbacks: Loopback[] = [];
afterEach(() => {
  for (const each of loopbacks.splice(0)) each.stop();
});

async function boot(
  projects: unknown[],
  options: { buzzes?: unknown[]; config?: unknown } = {},
): Promise<{ host: Awaited<ReturnType<typeof testHost>>; loopback: Loopback; buzzes: unknown[] }> {
  const loopback = new Loopback();
  loopbacks.push(loopback);
  const buzzes = options.buzzes ?? [];
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
      projects: { list: async () => projects, find: async () => undefined },
    },
    uses: { access: { buzz: async (buzz: unknown) => (buzzes.push(buzz), 1) } },
    // No `pulls.yaml` entry at all unless asked: the default is what is under test.
    config: { 'pulls.yaml': options.config ?? { projects: {} } },
  });
  return { host, loopback, buzzes };
}

const view = async (host: Awaited<ReturnType<typeof testHost>>, id: string) =>
  (await host.request('GET', '/v1/pulls/watch')).json<WatchOverview>().projects.find(each => each.project === id);

describe('r11 S7 over a loopback GitHub: what the real watch asks, and what it pushes', () => {
  test('a project with no linked account, or one naming an account that is gone, is never asked about', async () => {
    const { host, loopback } = await boot([
      project(P1, 'widgets', { accounts: undefined }),
      project(P2, 'gadgets', { accounts: ['gha_9999'] }),
    ]);
    servePull(loopback.github, 'widgets', running);
    servePull(loopback.github, 'gadgets', running);
    await host.runJob('pulls-watch');
    expect(loopback.requests).toEqual([]);
    expect(await view(host, P1)).toMatchObject({ watch: false });
    expect(await view(host, P2)).toMatchObject({ watch: false });
  });

  test('watched only by default: a confirmed CI failure pushes nothing; after the owner ticks it, ONE push', async () => {
    const { host, loopback, buzzes } = await boot([project(P1, 'widgets')]);
    servePull(loopback.github, 'widgets', running);
    await host.runJob('pulls-watch'); // the silent baseline
    expect(loopback.lookedAt('widgets')).toBe(1);
    expect(await view(host, P1)).toMatchObject({ watch: true, watchedBy: 'default' });

    servePull(loopback.github, 'widgets', failed);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch'); // CI failed, nobody ticked it
    expect(loopback.lookedAt('widgets')).toBe(2);
    expect(buzzes).toEqual([]);

    const ticked = await host.request('PATCH', `/v1/pulls/watch/${P1}`, { body: { notify: { ciFailed: true } } });
    expect(ticked.json()).toMatchObject({ view: { watch: true, watchedBy: 'default', notify: { ciFailed: true } } });
    servePull(loopback.github, 'widgets', running);
    await host.clock.advance(301_000);
    await host.runJob('pulls-watch');
    servePull(loopback.github, 'widgets', failed);
    await host.clock.advance(31_000);
    await host.runJob('pulls-watch');
    expect(buzzes).toHaveLength(1);
    expect(buzzes[0]).toMatchObject({ title: 'CI failed on #7' });
  });

  test('THE RACE: a project unlinked while an earlier read of the pass is held is not asked about at all', async () => {
    const projects: unknown[] = [project(P1, 'widgets'), project(P2, 'gadgets')];
    const { host, loopback } = await boot(projects);
    servePull(loopback.github, 'widgets', running);
    servePull(loopback.github, 'gadgets', running);
    const held = loopback.hold(listOf('widgets'));
    const pass = host.runJob('pulls-watch');
    await held.reached; // A's first read is in flight at the server, B is queued behind it in the same pass
    expect(loopback.lookedAt('gadgets')).toBe(0);
    projects[1] = project(P2, 'gadgets', { accounts: undefined }); // B is unlinked from its account
    held.release();
    await pass;
    expect(loopback.lookedAt('widgets')).toBe(1);
    // Before the fix B still started its GET with its former account here (measured: 1 request); now there is none.
    expect(loopback.requests.filter(path => path.startsWith('/repos/octo/gadgets/'))).toEqual([]);
    expect(await view(host, P2)).toMatchObject({ watch: false });
    expect(host.state('pulls').raw(WATCH_STATE, P2)).toBeUndefined();
  });

  test('a project removed while an earlier read is held is not asked about either', async () => {
    const projects: unknown[] = [project(P1, 'widgets'), project(P2, 'gadgets')];
    const { host, loopback } = await boot(projects);
    servePull(loopback.github, 'widgets', running);
    servePull(loopback.github, 'gadgets', running);
    const held = loopback.hold(listOf('widgets'));
    const pass = host.runJob('pulls-watch');
    await held.reached;
    projects.splice(1, 1);
    held.release();
    await pass;
    expect(loopback.requests.filter(path => path.startsWith('/repos/octo/gadgets/'))).toEqual([]);
  });
});
