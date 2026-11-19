import { describe, expect, test } from 'bun:test';
import { StandInAdmission, ownerStanding } from '@ferretry/core-gate/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import { MAX_FILES_PATCH_BYTES, MAX_PULL_FILES, PullFilesAnswerSchema } from '../../contract/index.ts';
import { repoSegment } from '../../contract/repo-segment.ts';
import daemon from '../../daemon/index.ts';
import { FAKE_ACCOUNT, FakeGithub } from '../fixtures/fake-github/index.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const REPO = { owner: 'octo', name: 'widgets' } as const;
const FILES = `/repos/octo/widgets/pulls/7/files`;
const filesPath = (project: string, repo: { owner: string; name: string }, number: number) =>
  `/v1/pulls/${project}/${encodeURIComponent(repoSegment(repo))}/${number}/files`;

const project = (over: Partial<ProjectInfo> = {}): ProjectInfo =>
  ({
    id: P1,
    name: 'Widgets',
    path: '/work/widgets',
    source: 'existing-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    accounts: [FAKE_ACCOUNT],
    repos: [{ path: '.', remote: 'https://github.com/octo/widgets', provider: 'github' }],
    ...over,
  }) as ProjectInfo;

async function boot(github: FakeGithub, found: ProjectInfo | null = project()) {
  return await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => (found === null ? [] : [found]), find: async () => found ?? undefined },
    },
  });
}

const file = (name: string, extra: Record<string, unknown> = {}) => ({
  filename: name,
  status: 'modified',
  additions: 1,
  deletions: 1,
  patch: '@@ -1 +1 @@\n-a\n+b',
  blob_url: `https://github.com/octo/widgets/blob/abc/${name}`,
  ...extra,
});

const get = async (host: Awaited<ReturnType<typeof boot>>, number = 7) =>
  await host.request('GET', filesPath(P1, REPO, number));

describe('GET /v1/pulls/:project/:repo/:number/files', () => {
  test('answers the files with their hunks, renames and status, from the one linked account', async () => {
    const github = new FakeGithub();
    github.setPaged(
      FILES,
      [
        file('src/a.ts'),
        file('src/new.ts', { status: 'renamed', previous_filename: 'src/old.ts', patch: undefined }),
        file('img.png', { status: 'added', patch: undefined }),
      ],
      100,
    );
    const response = await get(await boot(github));
    expect(response.status).toBe(200);
    const answer = PullFilesAnswerSchema.parse(response.json());
    expect(answer.files.map(f => [f.path, f.status, f.previousPath, f.patch === undefined])).toEqual([
      ['src/a.ts', 'modified', undefined, false],
      ['src/new.ts', 'renamed', 'src/old.ts', true],
      ['img.png', 'added', undefined, true],
    ]);
    expect(answer).toMatchObject({ truncated: false, unreadable: 0, fromCache: false });
    expect(github.seen.map(s => [s.method, s.path, s.account])).toEqual([
      ['GET', `${FILES}?per_page=100`, FAKE_ACCOUNT],
    ]);
  });

  test('pages 100 at a time and follows Link to the end; a second read is a 304 from the cache', async () => {
    const github = new FakeGithub();
    github.setPaged(
      FILES,
      Array.from({ length: 250 }, (_, i) => file(`f${i}.ts`)),
      100,
    );
    const host = await boot(github);
    const first = PullFilesAnswerSchema.parse((await get(host)).json());
    expect(first.files).toHaveLength(250);
    expect(github.seen.map(s => s.path)).toEqual([
      `${FILES}?per_page=100`,
      `${FILES}?per_page=100&page=2`,
      `${FILES}?per_page=100&page=3`,
    ]);
    const second = PullFilesAnswerSchema.parse((await get(host)).json());
    expect(second.fromCache).toBe(true);
    expect(github.seen.slice(3).every(s => s.ifNoneMatch !== undefined)).toBe(true);
  });

  test('stops at GitHub’s 3000 files and says so', async () => {
    const github = new FakeGithub();
    github.setPaged(
      FILES,
      Array.from({ length: MAX_PULL_FILES + 40 }, (_, i) => file(`f${i}.ts`, { patch: undefined })),
      100,
    );
    const answer = PullFilesAnswerSchema.parse((await get(await boot(github))).json());
    expect(answer.files).toHaveLength(MAX_PULL_FILES);
    expect(answer.truncated).toBe(true);
  });

  test('a file with no patch (binary, or too large for GitHub) is listed with none', async () => {
    const github = new FakeGithub();
    github.setPaged(FILES, [file('big.bin', { patch: undefined }), file('empty.txt', { patch: '' })], 100);
    const answer = PullFilesAnswerSchema.parse((await get(await boot(github))).json());
    expect(answer.files.every(f => f.patch === undefined)).toBe(true);
  });

  test('bounds the patch text in one answer: files past the budget, or with a patch no file may have, are listed with none', async () => {
    const github = new FakeGithub();
    const chunk = 'x'.repeat(700 * 1024);
    const count = Math.floor(MAX_FILES_PATCH_BYTES / chunk.length);
    github.setPaged(
      FILES,
      [
        ...Array.from({ length: count + 1 }, (_, i) => file(`f${i}`, { patch: chunk })),
        file('huge', { patch: 'y'.repeat(2 * 1024 * 1024) }),
        file('small'),
      ],
      100,
    );
    const answer = PullFilesAnswerSchema.parse((await get(await boot(github))).json());
    expect(answer.files).toHaveLength(count + 3);
    expect(answer.files.filter(f => f.patch !== undefined).map(f => f.path)).toEqual([
      ...Array.from({ length: count }, (_, i) => `f${i}`),
      'small',
    ]);
    expect(answer.unreadable).toBe(0);
  });

  test('leaves out and counts a file it cannot read; a blob link off github.com is not passed on', async () => {
    const github = new FakeGithub();
    github.setPaged(
      FILES,
      [
        file('ok.ts', { blob_url: 'https://evil.example/x' }),
        { filename: 5 },
        null,
        file('bad-status', { status: 'weird' }),
      ],
      100,
    );
    const answer = PullFilesAnswerSchema.parse((await get(await boot(github))).json());
    expect(answer.files.map(f => [f.path, f.url])).toEqual([['ok.ts', undefined]]);
    expect(answer.unreadable).toBe(3);
  });

  test('the repository’s own account wins over the project’s first; no account is a 409 and a removed one too', async () => {
    const github = new FakeGithub();
    github.setPaged(FILES, [file('a.ts')], 100);
    const linked = project({
      repos: [{ path: '.', remote: 'https://github.com/octo/widgets', provider: 'github', account: FAKE_ACCOUNT }],
      accounts: ['gha_1'],
    });
    expect((await get(await boot(github, linked))).status).toBe(200);
    const none = await get(await boot(github, project({ accounts: [] })));
    expect(none.status).toBe(409);
    expect(none.json()).toMatchObject({ code: 'pulls_no_account' });
    expect((await get(await boot(github, project({ accounts: ['gha_99'] })))).status).toBe(409);
  });

  test('only a repository the project holds can be read: another repo, no project and a bad path are refused before any request', async () => {
    const github = new FakeGithub();
    github.setPaged(FILES, [file('a.ts')], 100);
    const host = await boot(github);
    expect((await host.request('GET', filesPath(P1, { owner: 'octo', name: 'other' }, 7))).status).toBe(404);
    expect((await (await boot(github, null)).request('GET', filesPath(P1, REPO, 7))).status).toBe(404);
    expect((await get(host, 0)).status).toBe(400);
    expect((await host.request('GET', `/v1/pulls/${P1}/octo%2Fwidgets/7/files`)).status).toBe(400);
    expect((await host.request('GET', `/v1/pulls/${P1}/octo~widgets/x/files`)).status).toBe(400);
    expect(github.seen).toEqual([]);
  });

  test('a repository named in another case is the same repository', async () => {
    const github = new FakeGithub();
    github.setPaged('/repos/Octo/Widgets/pulls/7/files', [file('a.ts')], 100);
    const host = await boot(
      github,
      project({ repos: [{ path: '.', remote: 'https://github.com/octo/widgets', provider: 'github' }] }),
    );
    expect((await host.request('GET', filesPath(P1, { owner: 'Octo', name: 'Widgets' }, 7))).status).toBe(200);
  });

  test('GitHub’s answers become ours: 404 is 404, a refusal is 502, and a pause is 429 with when it ends; none carries GitHub’s text', async () => {
    const github = new FakeGithub();
    const host = await boot(github);
    expect((await get(host)).status).toBe(404);
    github.fail(`${FILES}?per_page=100`, 500);
    const failed = await get(host);
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.json())).not.toContain('fake failure');
    github.clearFailure(`${FILES}?per_page=100`);
    github.setPaged(FILES, [file('a.ts')], 100);
    github.rate(100, Math.floor(Date.now() / 1000) + 1200, 5000);
    await get(host);
    const paused = await get(host);
    expect(paused.status).toBe(429);
    expect(paused.json()).toMatchObject({ code: 'pulls_paused', pausedUntilMs: expect.any(Number) });
  });
});
