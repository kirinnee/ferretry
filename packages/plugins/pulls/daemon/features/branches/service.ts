import { err, ok, type Result } from '@ferretry/std';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import {
  isUsableBranch,
  MAX_BRANCH_NAME,
  MAX_BRANCH_PULLS,
  PULLS_CODES,
  type BranchPull,
  type BranchPullResult,
  type PullsCode,
  type RepoRef,
} from '../../../contract/index.ts';
import { z } from 'zod';
import type { GithubClient, ReadFailure } from '../../adapters/github/client.ts';
import { nextPagePath } from '../../adapters/github/link.ts';
import { foldCi } from '../watch/ci-fold.ts';
import { CheckRunsSchema, WorkflowRunsSchema } from '../watch/github-shapes.ts';

/** Most PRs asked for per branch: the newest come first, so this is a bound on a page, not on which PR wins. */
const PER_BRANCH = 30;
/** Branches read at once: the account's one connection is not a firehose. */
const AT_ONCE = 5;

export interface BranchScope {
  readonly project: string;
  readonly account: GitAccountId;
  readonly repo: RepoRef;
}

type Reader = Pick<GithubClient, 'get'>;

const unknown = (branch: string, code: PullsCode): BranchPullResult => ({ branch, outcome: 'unknown', code });

/** Pages of one branch's list that are followed; a list still linking more after this is not a complete answer. */
const MAX_PAGES = 3;

/** Only what choosing the latest PR reads: a field of another purpose missing from an entry must not drop it. */
const ListedPullSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  html_url: z.string(),
  created_at: z.string(),
  merged_at: z.string().nullable().optional(),
  head: z.object({ sha: z.string(), ref: z.string() }),
});
type ListedPull = z.infer<typeof ListedPullSchema>;

/** Newest first by creation, a later number on a tie. */
const newer = (a: ListedPull, b: ListedPull): number => b.created_at.localeCompare(a.created_at) || b.number - a.number;

/** One read of a sub-resource: a missing one (Actions off, no checks) is empty; any other failure is not an answer. */
async function objectOf(github: Reader, scope: BranchScope, path: string): Promise<Result<unknown, ReadFailure>> {
  const read = await github.get({ project: scope.project, account: scope.account, path });
  if (read.ok) return ok(read.value.body);
  return read.error.code === PULLS_CODES.notFound ? ok({}) : err(read.error);
}

/** The CI word of a PR's head commit, or `undefined` when a read did not answer (the word is then left out, not guessed). */
async function ciOf(github: Reader, scope: BranchScope, sha: string): Promise<BranchPull['ci']> {
  const prefix = `/repos/${scope.repo.owner}/${scope.repo.name}`;
  const [checks, runs] = await Promise.all([
    objectOf(github, scope, `${prefix}/commits/${sha}/check-runs?per_page=100`),
    objectOf(github, scope, `${prefix}/actions/runs?head_sha=${sha}&per_page=50`),
  ]);
  if (!checks.ok || !runs.ok) return undefined;
  return foldCi([
    ...(CheckRunsSchema.safeParse(checks.value).data?.check_runs ?? []),
    ...(WorkflowRunsSchema.safeParse(runs.value).data?.workflow_runs ?? []),
  ]);
}

/** One branch: the newest PR whose head is that branch, in any state. A read that did not answer is `unknown`. */
async function readBranch(github: Reader, scope: BranchScope, branch: string): Promise<BranchPullResult> {
  const head = encodeURIComponent(`${scope.repo.owner}:${branch}`).replace(/%3A/giu, ':');
  // Every page is read: "none" is only said of a list that is provably complete, and a list still linking more pages
  // after the bound is not.
  const entries: unknown[] = [];
  let path: string | undefined =
    `/repos/${scope.repo.owner}/${scope.repo.name}/pulls?state=all&head=${head}&sort=created&direction=desc&per_page=${PER_BRANCH}`;
  for (let page = 0; path !== undefined; page += 1) {
    if (page === MAX_PAGES) return unknown(branch, PULLS_CODES.github);
    const list = await github.get({ project: scope.project, account: scope.account, path });
    if (!list.ok) return unknown(branch, list.error.code);
    if (!Array.isArray(list.value.body)) return unknown(branch, PULLS_CODES.github);
    entries.push(...(list.value.body as unknown[]));
    path = nextPagePath(list.value.link);
  }
  if (entries.length === 0) return { branch, outcome: 'none' };
  // An entry that cannot be read could be the newest: nothing is certified over it.
  const parsed = entries.map(entry => ListedPullSchema.safeParse(entry));
  const readable = parsed.flatMap(each => (each.success ? [each.data] : []));
  if (readable.length !== parsed.length) return unknown(branch, PULLS_CODES.github);
  // GitHub's `head` filter is exact; a PR of another ref is never taken as this branch's.
  const newest = readable.filter(raw => raw.head.ref === branch).sort(newer)[0];
  if (newest === undefined) return unknown(branch, PULLS_CODES.github);
  const sha = newest.head.sha.toLowerCase();
  const merged = newest.merged_at ?? undefined;
  const ci = await ciOf(github, scope, sha);
  return {
    branch,
    outcome: 'pull',
    pull: {
      number: newest.number,
      state: merged !== undefined ? 'merged' : newest.state === 'open' ? 'open' : 'closed',
      createdAt: newest.created_at,
      ...(merged === undefined ? {} : { mergedAt: merged }),
      headSha: sha,
      ...(ci === undefined ? {} : { ci }),
      url: newest.html_url,
    },
  };
}

/**
 * The latest PR of each branch, in the order asked, a branch once. At most {@link MAX_BRANCH_PULLS} usable branches are
 * read; the rest (and any name that is not usable) answer `unknown`. Every read goes through the one client, so it is
 * conditional (an unchanged answer is a free `304`) and stops while the rate budget is paused. Branches are read a few at
 * a time and once a batch had a read that did not answer no further batch is asked: the rest are `unknown` with that
 * reason. Never throws.
 */
export async function readBranchPulls(
  github: Reader,
  scope: BranchScope,
  branches: readonly string[],
): Promise<readonly BranchPullResult[]> {
  const asked = [...new Set(branches)];
  const readable = asked.filter(isUsableBranch).slice(0, MAX_BRANCH_PULLS);
  const answers = new Map<string, BranchPullResult>();
  let stopped: PullsCode | undefined;
  for (let at = 0; at < readable.length; at += AT_ONCE) {
    const results = await Promise.all(
      readable
        .slice(at, at + AT_ONCE)
        .map(async branch =>
          stopped !== undefined
            ? unknown(branch, stopped)
            : await readBranch(github, scope, branch).catch(() => unknown(branch, PULLS_CODES.github)),
        ),
    );
    for (const result of results) {
      answers.set(result.branch, result);
      if (result.outcome === 'unknown') stopped ??= result.code;
    }
  }
  return asked.map(branch => answers.get(branch) ?? unknown(branch.slice(0, MAX_BRANCH_NAME), PULLS_CODES.refused));
}
