import { describe, it } from 'bun:test';
import should from 'should';
import {
  checksOf,
  MAX_BRANCHES_PER_QUERY,
  MAX_PRS_PER_QUERY,
  parseRepositoryAnswer,
  pollArguments,
  type RepositoryPoll,
  versionOfTag,
} from '../../../src/lib/board-github/index.ts';
import { answer, prNode, prUrl, REPO, SHA } from './support.ts';

const poll = (overrides: Partial<RepositoryPoll> = {}): RepositoryPoll => ({
  repo: REPO,
  numbers: [940],
  branches: [],
  releases: false,
  ...overrides,
});

const field = (args: readonly string[], name: string): string | undefined =>
  args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);

describe('pollArguments', () => {
  it('should ask one GraphQL query for every PR, branch and the releases, with the names as variables', () => {
    const args = pollArguments(
      poll({ numbers: [940, 941, 940], branches: ['feat/x', 'a") { evil }'], releases: true }),
    );
    should(args?.slice(0, 2)).deepEqual(['api', 'graphql']);
    const query = field(args ?? [], 'query') ?? '';
    should(query).match(/^query\(\$owner: String!, \$name: String!, \$b0: String!, \$b1: String!\)/u);
    should(query).containEql('p940: pullRequest(number: 940) { ...pr }');
    should(query).containEql('p941: pullRequest(number: 941) { ...pr }');
    should(query.match(/p940:/gu)).have.length(1);
    should(query).containEql('b1: pullRequests(headRefName: $b1, first: 5');
    should(query).containEql('releases(first: 50');
    should(query).containEql('fragment pr on PullRequest { number url state isDraft mergedAt mergeCommit { oid }');
    // A caller's string is a variable, never a piece of the query.
    should(query).not.containEql('evil');
    should(field(args ?? [], 'owner')).equal('kirinnee');
    should(field(args ?? [], 'name')).equal('ferretry');
    should(field(args ?? [], 'b1')).equal('a") { evil }');
    // Every value is a raw field: `gh` never reads `-f` as a file.
    should(args?.filter(arg => arg === '-F')).be.empty();
  });

  it('should leave the releases out when none are waited for, and drop numbers that are not PR numbers', () => {
    const query = field(pollArguments(poll({ numbers: [0, -1, 1.5, 7] })) ?? [], 'query') ?? '';
    should(query).not.containEql('releases(');
    should(query).containEql('p7:');
    should(query).not.containEql('p0:');
  });

  it('should bound how many PRs and branches one query asks about', () => {
    const many = Array.from({ length: MAX_PRS_PER_QUERY + 5 }, (_, index) => index + 1);
    const branches = Array.from({ length: MAX_BRANCHES_PER_QUERY + 5 }, (_, index) => `b-${String(index)}`);
    const query = field(pollArguments(poll({ numbers: many, branches })) ?? [], 'query') ?? '';
    should(query.match(/: pullRequest\(/gu)).have.length(MAX_PRS_PER_QUERY);
    should(query.match(/: pullRequests\(/gu)).have.length(MAX_BRANCHES_PER_QUERY);
  });

  it('should refuse a repository that is not owner/name', () => {
    for (const repo of ['nope', '/name', 'owner/', 'a/b/c']) should(pollArguments(poll({ repo }))).be.null();
  });
});

describe('checksOf and versionOfTag', () => {
  it('should draw a rollup as the card shows it', () => {
    should([null, 'SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED'].map(checksOf)).deepEqual([
      'none',
      'passing',
      'failing',
      'failing',
      'pending',
      'pending',
    ]);
  });

  it('should read only v-prefixed release versions', () => {
    should(versionOfTag('v4.110.0')).equal('4.110.0');
    should(versionOfTag('v4.110.0+build.1')).equal('4.110.0+build.1');
    should(versionOfTag('4.110.0')).be.null();
    should(versionOfTag('v4.110.0-rc.1')).be.null();
    should(versionOfTag('nightly')).be.null();
  });
});

describe('parseRepositoryAnswer', () => {
  it('should map each PR node to the cache facts', () => {
    const parsed = parseRepositoryAnswer(
      answer({
        prs: {
          1: prNode(1, { rollup: 'SUCCESS' }),
          2: prNode(2, { state: 'MERGED', rollup: null }),
          3: prNode(3, { state: 'CLOSED', draft: true, rollup: 'FAILURE' }),
        },
      }),
      poll({ numbers: [1, 2, 3] }),
    );
    should(parsed?.prs.get(1)?.observation).deepEqual({
      url: prUrl(1),
      state: 'open',
      draft: false,
      checks: 'passing',
      mergedAt: null,
      mergeSha: null,
    });
    should(parsed?.prs.get(2)?.observation).match({
      state: 'merged',
      checks: 'none',
      mergedAt: '2026-10-30T09:00:00Z',
      mergeSha: SHA,
    });
    should(parsed?.prs.get(3)?.observation).match({ state: 'closed', draft: true, checks: 'failing' });
    should(parsed?.prs.get(3)?.headRefName).equal('feat/pr-3');
    should(parsed?.releases).be.null();
  });

  it('should leave unobserved a PR that is missing, malformed, from another repository, or a merge it cannot name', () => {
    const parsed = parseRepositoryAnswer(
      answer({
        prs: {
          1: null,
          2: { number: 2 },
          3: prNode(3, { repo: 'someone/else' }),
          4: prNode(4, { state: 'MERGED', sha: null }),
          5: prNode(5, { state: 'MERGED', mergedAt: null }),
          6: { ...prNode(6), commits: null },
          7: prNode(8),
        },
      }),
      poll({ numbers: [1, 2, 3, 4, 5, 6, 7] }),
    );
    should([...(parsed?.prs.keys() ?? [])]).deepEqual([6]);
    should(parsed?.prs.get(6)?.observation.checks).equal('none');
  });

  it('should list the PRs opened from each branch, but never the default branch', () => {
    const parsed = parseRepositoryAnswer(
      answer({
        branches: [
          [prNode(10, { head: 'feat/x' }), prNode(11, { head: 'feat/other' }), 'junk'],
          [prNode(12, { head: 'main' })],
        ],
      }),
      poll({ numbers: [], branches: ['feat/x', 'main', 'feat/missing'] }),
    );
    should(parsed?.branches.get('feat/x')?.map(pr => pr.number)).deepEqual([10]);
    should(parsed?.branches.has('main')).be.false();
    should(parsed?.branches.has('feat/missing')).be.false();
  });

  it('should read the published v* releases newest first, skipping drafts, prereleases and other tags', () => {
    const parsed = parseRepositoryAnswer(
      answer({
        releases: [
          { tagName: 'v4.111.0', publishedAt: '2026-10-30T11:00:00Z' },
          { tagName: 'v4.110.0', publishedAt: '2026-10-30T10:00:00Z' },
          { tagName: 'v4.112.0', publishedAt: null, isDraft: true },
          { tagName: 'v4.112.0-rc.1', publishedAt: '2026-10-30T12:00:00Z', isPrerelease: true },
          { tagName: 'nightly', publishedAt: '2026-10-30T12:00:00Z' },
          { tagName: 'v9.9.9', publishedAt: null },
        ],
      }),
      poll({ releases: true }),
    );
    should(parsed?.releases).deepEqual([
      { tag: 'v4.111.0', version: '4.111.0', publishedAt: '2026-10-30T11:00:00Z' },
      { tag: 'v4.110.0', version: '4.110.0', publishedAt: '2026-10-30T10:00:00Z' },
    ]);
    const broken = JSON.stringify({ data: { repository: { releases: 'nope', defaultBranchRef: null } } });
    should(parseRepositoryAnswer(broken, poll({ releases: true }))?.releases).deepEqual([]);
  });

  it('should answer null when there is no repository in the answer at all', () => {
    should(parseRepositoryAnswer('not json', poll())).be.null();
    should(parseRepositoryAnswer('{"errors": []}', poll())).be.null();
    should(parseRepositoryAnswer('{"data": null}', poll())).be.null();
    should(parseRepositoryAnswer('{"data": {"repository": null}}', poll())).be.null();
  });
});
