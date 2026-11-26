import { describe, expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import type { Log } from '@ferretry/kernel/contract';
import {
  BranchPullsAnswerSchema,
  MAX_BRANCH_PULLS,
  NO_SECRET_FIELDS,
  PULLS_CACHE,
  PULLS_CODES,
} from '../../contract/index.ts';
import { GithubClient } from '../../daemon/adapters/github/client.ts';
import { readBranchPulls } from '../../daemon/features/branches/service.ts';
import { PullsCache } from '../../daemon/lib/cache/store.ts';
import { FAKE_ACCOUNT, FakeGithub } from '../fixtures/fake-github/index.ts';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const quiet: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const NOW_SEC = 1_789_990_000;
const SCOPE = {
  project: PROJECT,
  account: FAKE_ACCOUNT,
  repo: { provider: 'github', owner: 'octo', name: 'demo' },
} as const;
const SHA = (char: string) => char.repeat(40);

function world() {
  const github = new FakeGithub();
  github.rate(5000, NOW_SEC + 3000);
  const nowMs = NOW_SEC * 1000;
  const folder = new MemoryStateFolder(() => nowMs);
  const cache = new PullsCache(folder.port([PULLS_CACHE]), () => nowMs, quiet);
  const client = new GithubClient(github.accounts, cache, () => nowMs, quiet);
  return { github, client };
}

const listPath = (branch: string) =>
  `/repos/octo/demo/pulls?state=all&head=octo:${encodeURIComponent(branch)}&sort=created&direction=desc&per_page=30`;

const pr = (number: number, branch: string, over: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  state: 'open',
  draft: false,
  html_url: `https://github.com/octo/demo/pull/${number}`,
  user: { login: 'alice' },
  created_at: `2026-11-0${number}T10:00:00Z`,
  updated_at: `2026-11-0${number}T11:00:00Z`,
  merged_at: null,
  head: { sha: SHA(String(number)), ref: branch },
  base: { ref: 'main' },
  ...over,
});

function serve(
  github: FakeGithub,
  branch: string,
  pulls: unknown[],
  ci: { status: string; conclusion: string | null }[] = [],
) {
  github.set(listPath(branch), pulls);
  for (const raw of pulls as { head?: { sha: string } }[]) {
    const sha = raw.head?.sha;
    if (sha === undefined) continue;
    github.set(`/repos/octo/demo/commits/${sha}/check-runs?per_page=100`, { check_runs: ci });
    github.set(`/repos/octo/demo/actions/runs?head_sha=${sha}&per_page=50`, { workflow_runs: [] });
  }
}

describe('branchPulls: which PR a branch had', () => {
  test('picks the NEWEST PR of a branch whatever order GitHub lists them in', async () => {
    const w = world();
    serve(w.github, 'feat/x', [
      pr(2, 'feat/x', { state: 'closed' }),
      pr(4, 'feat/x', { state: 'open' }),
      pr(3, 'feat/x', { state: 'closed', merged_at: '2026-11-03T12:00:00Z' }),
    ]);
    const [result] = await readBranchPulls(w.client, SCOPE, ['feat/x']);
    expect(result).toMatchObject({ branch: 'feat/x', outcome: 'pull', pull: { number: 4, state: 'open' } });
    // The `head` filter names the owner and the branch, percent-encoded, over every state.
    expect(w.github.seen[0]?.path).toBe(listPath('feat/x'));
  });

  test('tells merged from closed, with the merged head, the merge time, the CI word and the address', async () => {
    const w = world();
    serve(
      w.github,
      'merged',
      [pr(5, 'merged', { state: 'closed', merged_at: '2026-11-06T09:00:00Z' })],
      [{ status: 'completed', conclusion: 'success' }],
    );
    serve(w.github, 'closed', [pr(6, 'closed', { state: 'closed' })], [{ status: 'completed', conclusion: 'failure' }]);
    const results = await readBranchPulls(w.client, SCOPE, ['merged', 'closed']);
    expect(results[0]).toMatchObject({
      outcome: 'pull',
      pull: {
        number: 5,
        state: 'merged',
        mergedAt: '2026-11-06T09:00:00Z',
        headSha: SHA('5'),
        ci: 'passing',
        url: 'https://github.com/octo/demo/pull/5',
      },
    });
    const closed = results[1];
    expect(closed).toMatchObject({ outcome: 'pull', pull: { number: 6, state: 'closed', ci: 'failing' } });
    expect(closed?.outcome === 'pull' && closed.pull.mergedAt).toBeUndefined();
  });

  test('an answered empty list is `none`; the answer carries no title, author or token word', async () => {
    const w = world();
    w.github.set(listPath('lonely'), []);
    serve(w.github, 'has', [pr(1, 'has')]);
    const results = await readBranchPulls(w.client, SCOPE, ['lonely', 'has']);
    expect(results[0]).toEqual({ branch: 'lonely', outcome: 'none' });
    const answer = BranchPullsAnswerSchema.parse({
      repo: SCOPE.repo,
      branches: results,
      fetchedAt: '2026-11-26T00:00:00.000Z',
    });
    expect(JSON.stringify(answer)).not.toMatch(NO_SECRET_FIELDS);
    expect(JSON.stringify(answer)).not.toContain('PR 1');
    expect(JSON.stringify(answer)).not.toContain('alice');
  });

  test('a PR whose CI cannot be read is still answered, without a CI word', async () => {
    const w = world();
    serve(w.github, 'b', [pr(1, 'b')]);
    w.github.fail(`/repos/octo/demo/commits/${SHA('1')}/check-runs?per_page=100`, 500);
    const [result] = await readBranchPulls(w.client, SCOPE, ['b']);
    expect(result).toMatchObject({ outcome: 'pull', pull: { number: 1 } });
    expect(result?.outcome === 'pull' && 'ci' in result.pull).toBe(false);
  });

  test('a PR of another ref in the answer is never taken as the branch’s; no usable PR is `unknown`, not `none`', async () => {
    const w = world();
    w.github.set(listPath('b'), [pr(1, 'other')]);
    const [result] = await readBranchPulls(w.client, SCOPE, ['b']);
    expect(result).toEqual({ branch: 'b', outcome: 'unknown', code: PULLS_CODES.github });
  });
});

describe('branchPulls: a miss is `unknown`, never `none`', () => {
  test('a paused rate budget answers every branch unknown and asks GitHub for nothing more', async () => {
    const w = world();
    serve(w.github, 'a', [pr(1, 'a')]);
    serve(w.github, 'b', [pr(2, 'b')]);
    // 100 left of 5000: the first answer tips the budget under 10 %, so polling pauses until the reset.
    w.github.rate(100, NOW_SEC + 1200);
    const first = await readBranchPulls(w.client, SCOPE, ['a']);
    expect(first[0]?.outcome).toBe('pull');
    const spent = w.github.seen.length;
    const paused = await readBranchPulls(w.client, SCOPE, ['a', 'b']);
    expect(paused).toEqual([
      { branch: 'a', outcome: 'unknown', code: PULLS_CODES.paused },
      { branch: 'b', outcome: 'unknown', code: PULLS_CODES.paused },
    ]);
    expect(w.github.seen).toHaveLength(spent);
  });

  test('a refused or failing read is unknown with its reason, and no further batch is asked', async () => {
    const w = world();
    const names = Array.from({ length: 12 }, (_, at) => `b${at}`);
    for (const name of names) serve(w.github, name, [pr(1, name)]);
    w.github.fail(listPath('b1'), 403);
    const results = await readBranchPulls(w.client, SCOPE, names);
    expect(results).toHaveLength(12);
    expect(results[1]).toEqual({ branch: 'b1', outcome: 'unknown', code: PULLS_CODES.denied });
    // Batch two and three are never asked: only the first batch of five touched GitHub.
    expect(results.slice(5).every(result => result.outcome === 'unknown')).toBe(true);
    expect(w.github.seen.filter(seen => /\/b[5-9]|b1[01]/u.test(seen.path))).toHaveLength(0);
  });

  test('a repository GitHub cannot show is unknown (not found), not "no PR"', async () => {
    const w = world();
    const [result] = await readBranchPulls(w.client, SCOPE, ['ghost']);
    expect(result).toEqual({ branch: 'ghost', outcome: 'unknown', code: PULLS_CODES.notFound });
  });
});

describe('branchPulls: bounded and cached', () => {
  test('a branch is asked once, order is kept, names that are not usable and the ones over the bound are unknown', async () => {
    const w = world();
    const names = Array.from({ length: MAX_BRANCH_PULLS + 2 }, (_, at) => `b${at}`);
    for (const name of names) w.github.set(listPath(name), []);
    const results = await readBranchPulls(w.client, SCOPE, ['b0', 'b0', 'has space', ...names.slice(1)]);
    expect(results.map(result => result.branch)).toEqual(['b0', 'has space', ...names.slice(1)]);
    expect(results[1]).toEqual({ branch: 'has space', outcome: 'unknown', code: PULLS_CODES.refused });
    // 25 usable ones are read (b0 … b24); the last two are over the bound.
    expect(results.filter(result => result.outcome === 'none')).toHaveLength(MAX_BRANCH_PULLS);
    expect(results.slice(-2)).toEqual([
      { branch: names.at(-2) as string, outcome: 'unknown', code: PULLS_CODES.refused },
      { branch: names.at(-1) as string, outcome: 'unknown', code: PULLS_CODES.refused },
    ]);
    expect(w.github.seen).toHaveLength(MAX_BRANCH_PULLS);
  });

  test('a second read sends If-None-Match and a 304 costs no rate limit', async () => {
    const w = world();
    serve(w.github, 'b', [pr(1, 'b')]);
    await readBranchPulls(w.client, SCOPE, ['b']);
    const spent = w.github.remaining;
    const [again] = await readBranchPulls(w.client, SCOPE, ['b']);
    expect(again?.outcome).toBe('pull');
    expect(w.github.remaining).toBe(spent);
    expect(w.github.seen.slice(-3).every(seen => seen.ifNoneMatch !== undefined)).toBe(true);
  });
});
