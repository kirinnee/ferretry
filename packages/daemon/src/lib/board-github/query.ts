/**
 * ONE GRAPHQL QUERY PER REPOSITORY: every linked PR of that repository, every branch a card names, and —
 * when a merged PR is waiting for one — the repository's recent releases, in a single `gh api graphql`.
 *
 * Everything a caller supplies travels as a GraphQL VARIABLE (`-f name=value`, which `gh` never reads as a
 * file), except PR numbers, which are validated positive integers. So a branch called `x") { … }` is a
 * string, never a piece of the query.
 *
 * The answer is parsed field by field: one PR the repository no longer has, or one GitHub could not
 * resolve, leaves that PR unobserved and the rest of the answer whole.
 */
import { type PrChecks, prUrlParts } from '@ferretry/protocol';
import { z } from 'zod';
import type { PrObservation } from '../board/index.ts';

/** How many PRs and branches one query asks about; the rest wait for the repository's next poll. */
export const MAX_PRS_PER_QUERY = 50;
export const MAX_BRANCHES_PER_QUERY = 20;
/** How many PRs one branch may name (newest first): a branch reused for a second PR finds both. */
export const PRS_PER_BRANCH = 5;
/** How many of a repository's newest releases are read to find the one a merge first shipped in. */
export const RELEASES_PER_QUERY = 50;

/** What one poll of one repository asks. `repo` is `owner/name`. */
export interface RepositoryPoll {
  readonly repo: string;
  readonly numbers: readonly number[];
  readonly branches: readonly string[];
  readonly releases: boolean;
}

const PR_FIELDS =
  'number url state isDraft mergedAt mergeCommit { oid } headRefName ' +
  'commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }';

/** The `gh` arguments of one repository's poll, or `null` for a repository name that is not `owner/name`. */
export const pollArguments = (poll: RepositoryPoll): readonly string[] | null => {
  const [owner, name, extra] = poll.repo.split('/');
  if (owner === undefined || owner === '' || name === undefined || name === '' || extra !== undefined) return null;
  const numbers = [...new Set(poll.numbers)].filter(number => Number.isSafeInteger(number) && number > 0);
  const branches = [...new Set(poll.branches)].slice(0, MAX_BRANCHES_PER_QUERY);
  const variables = ['$owner: String!', '$name: String!', ...branches.map((_, index) => `$b${index}: String!`)];
  const fields = [
    'defaultBranchRef { name }',
    ...numbers.slice(0, MAX_PRS_PER_QUERY).map(number => `p${number}: pullRequest(number: ${number}) { ...pr }`),
    ...branches.map(
      (_, index) =>
        `b${index}: pullRequests(headRefName: $b${index}, first: ${PRS_PER_BRANCH}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { ...pr } }`,
    ),
    ...(poll.releases
      ? [
          `releases(first: ${RELEASES_PER_QUERY}, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { tagName publishedAt isDraft isPrerelease } }`,
        ]
      : []),
  ];
  const query =
    `query(${variables.join(', ')}) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } } ` +
    `fragment pr on PullRequest { ${PR_FIELDS} }`;
  return [
    'api',
    'graphql',
    '-f',
    `query=${query}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    ...branches.flatMap((branch, index) => ['-f', `b${index}=${branch}`]),
  ];
};

// ---------------------------------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------------------------------

/** A PR as one poll saw it: the observation, keyed by its number, and the branch it was opened from. */
export interface PolledPr {
  readonly number: number;
  readonly headRefName: string;
  readonly observation: PrObservation;
}

/** A published release: its tag, the version the tag names, and when it was published. */
export interface PolledRelease {
  readonly tag: string;
  readonly version: string;
  readonly publishedAt: string;
}

export interface RepositoryAnswer {
  /** The linked PRs the repository answered for, by number. */
  readonly prs: ReadonlyMap<number, PolledPr>;
  /** The PRs opened from each asked branch, newest first. The default branch is never listed. */
  readonly branches: ReadonlyMap<string, readonly PolledPr[]>;
  /** Non-draft, non-prerelease `v*` releases, newest first; `null` when they were not asked for. */
  readonly releases: readonly PolledRelease[] | null;
}

const InstantString = z.iso.datetime({ offset: true });

const PrNodeSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  mergedAt: InstantString.nullable(),
  mergeCommit: z.object({ oid: z.string().regex(/^[0-9a-f]{40}$/u) }).nullable(),
  headRefName: z.string(),
  commits: z
    .object({
      nodes: z.array(
        z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) }).nullable(),
      ),
    })
    .nullable(),
});

const ReleaseNodeSchema = z.object({
  tagName: z.string(),
  publishedAt: InstantString.nullable(),
  isDraft: z.boolean(),
  isPrerelease: z.boolean(),
});

const AnswerSchema = z.object({
  data: z.object({ repository: z.record(z.string(), z.unknown()).nullable() }).nullable(),
});

const RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?)$/u;

/** The version a release tag names (`v4.110.0` → `4.110.0`), or `null` for a tag that is not a `v*` version. */
export const versionOfTag = (tag: string): string | null => RELEASE_TAG.exec(tag)?.[1] ?? null;

/** GitHub's rollup of a commit's checks, as the card draws it: ✓ passing, ✗ failing, ⏳ pending. */
export const checksOf = (rollup: string | null): PrChecks => {
  if (rollup === null) return 'none';
  if (rollup === 'SUCCESS') return 'passing';
  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'failing';
  return 'pending';
};

/** One PR node, or `null` when it does not parse or claims a merge it cannot name. */
const polledPr = (node: unknown, repo: string): PolledPr | null => {
  const parsed = PrNodeSchema.safeParse(node);
  if (!parsed.success) return null;
  const pr = parsed.data;
  const parts = prUrlParts(pr.url);
  if (parts === null || parts.number !== pr.number || parts.repo.toLowerCase() !== repo.toLowerCase()) return null;
  const merged = pr.state === 'MERGED';
  if (merged && (pr.mergedAt === null || pr.mergeCommit === null)) return null;
  const rollup = pr.commits?.nodes.at(-1)?.commit.statusCheckRollup?.state ?? null;
  return {
    number: pr.number,
    headRefName: pr.headRefName,
    observation: {
      url: pr.url,
      state: merged ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed',
      draft: pr.isDraft,
      checks: checksOf(rollup),
      mergedAt: merged ? pr.mergedAt : null,
      mergeSha: merged ? (pr.mergeCommit?.oid ?? null) : null,
    },
  };
};

const releasesOf = (value: unknown): readonly PolledRelease[] => {
  const nodes = z.object({ nodes: z.array(z.unknown()) }).safeParse(value);
  if (!nodes.success) return [];
  return nodes.data.nodes.flatMap(node => {
    const release = ReleaseNodeSchema.safeParse(node);
    if (!release.success || release.data.isDraft || release.data.isPrerelease) return [];
    const version = versionOfTag(release.data.tagName);
    const publishedAt = release.data.publishedAt;
    return version === null || publishedAt === null ? [] : [{ tag: release.data.tagName, version, publishedAt }];
  });
};

/**
 * Reads one repository's answer to {@link pollArguments}. `null` when there is no repository in it at all
 * (it does not exist, or the account cannot see it); otherwise every field that parses, and nothing for
 * one that does not.
 */
export const parseRepositoryAnswer = (stdout: string, poll: RepositoryPoll): RepositoryAnswer | null => {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const answer = AnswerSchema.safeParse(json);
  const repository = answer.success ? answer.data.data?.repository : null;
  if (repository === null || repository === undefined) return null;
  const defaultBranch = z.object({ name: z.string() }).safeParse(repository.defaultBranchRef);
  const prs = new Map<number, PolledPr>();
  for (const number of poll.numbers) {
    const pr = polledPr(repository[`p${number}`], poll.repo);
    if (pr !== null && pr.number === number) prs.set(number, pr);
  }
  const branches = new Map<string, readonly PolledPr[]>();
  [...new Set(poll.branches)].slice(0, MAX_BRANCHES_PER_QUERY).forEach((branch, index) => {
    if (defaultBranch.success && defaultBranch.data.name === branch) return;
    const nodes = z.object({ nodes: z.array(z.unknown()) }).safeParse(repository[`b${index}`]);
    if (!nodes.success) return;
    const found = nodes.data.nodes
      .map(node => polledPr(node, poll.repo))
      .filter((pr): pr is PolledPr => pr !== null && pr.headRefName === branch);
    branches.set(branch, found);
  });
  return { prs, branches, releases: poll.releases ? releasesOf(repository.releases) : null };
};
