import { err, ok, type Result } from '@ferretry/std';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import { PULLS_CODES, WatchedPullSchema, type RepoRef, type WatchedPull } from '../../../contract/index.ts';
import type { GithubClient, ReadFailure } from '../../adapters/github/client.ts';
import { foldCi, type CiSignal } from './ci-fold.ts';
import {
  CheckRunsSchema,
  parseEach,
  RawPullSchema,
  RawReviewSchema,
  WorkflowRunsSchema,
  type RawPull,
} from './github-shapes.ts';
import { foldReviews } from './review-fold.ts';

/** How many open PRs one repository's watch looks at: the most recently updated. A bound, not a promise of all. */
const MAX_WATCHED_PULLS = 30;
/**
 * How many PRs one repository's snapshot keeps: what is open now plus the own PRs an earlier look held that could not be
 * ended yet. The snapshot's schema allows 100, so a repository holding more keeps its newest 100.
 */
const MAX_RETAINED_PULLS = 100;
/** Requests made at once for one repository: the account's one connection is not a firehose. */
const AT_ONCE = 5;
const COMMENT_PAGES = 3;
const URL_OK = /^https:\/\/[^\s]{1,480}$/u;

export interface WatchTarget {
  readonly project: string;
  readonly repo: RepoRef;
  readonly account: GitAccountId;
  /** The connected account's GitHub login: "mine" and "asked of me" are about this person. */
  readonly login: string;
}

/** A PR the watch last saw open and no longer finds: how it ended. */
export interface Ended {
  readonly pull: WatchedPull;
  readonly merged: boolean;
}

export interface Observation {
  /** Open now, plus any earlier PR whose end could not be read yet (it is looked at again next tick). */
  readonly pulls: readonly WatchedPull[];
  readonly ended: readonly Ended[];
}

type Reader = Pick<GithubClient, 'get' | 'getAll'>;

const base = (target: WatchTarget): string => `/repos/${target.repo.owner}/${target.repo.name}`;

/** A read of a sub-resource: a missing one (Actions off, no checks) is empty, anything else fails the repository. */
async function listOf(
  github: Reader,
  target: WatchTarget,
  path: string,
  pages = 1,
): Promise<Result<readonly unknown[], ReadFailure>> {
  const read = await github.getAll({ project: target.project, account: target.account, path }, pages);
  if (read.ok) return ok(read.value.items);
  return read.error.code === PULLS_CODES.notFound ? ok([]) : err(read.error);
}

async function objectOf(github: Reader, target: WatchTarget, path: string): Promise<Result<unknown, ReadFailure>> {
  const read = await github.get({ project: target.project, account: target.account, path });
  if (read.ok) return ok(read.value.body);
  return read.error.code === PULLS_CODES.notFound ? ok({}) : err(read.error);
}

async function describe(
  github: Reader,
  target: WatchTarget,
  raw: RawPull,
): Promise<Result<WatchedPull | undefined, ReadFailure>> {
  const sha = raw.head.sha.toLowerCase();
  const prefix = base(target);
  const mine = raw.user?.login.toLowerCase() === target.login.toLowerCase();
  const [checks, runs, reviews, comments] = await Promise.all([
    objectOf(github, target, `${prefix}/commits/${sha}/check-runs?per_page=100`),
    objectOf(github, target, `${prefix}/actions/runs?head_sha=${sha}&per_page=50`),
    listOf(github, target, `${prefix}/pulls/${raw.number}/reviews?per_page=100`),
    mine ? listOf(github, target, `${prefix}/issues/${raw.number}/comments?per_page=100`, COMMENT_PAGES) : ok([]),
  ]);
  if (!checks.ok) return err(checks.error);
  if (!runs.ok) return err(runs.error);
  if (!reviews.ok) return err(reviews.error);
  if (!comments.ok) return err(comments.error);
  const signals: CiSignal[] = [
    ...(CheckRunsSchema.safeParse(checks.value).data?.check_runs ?? []),
    ...(WorkflowRunsSchema.safeParse(runs.value).data?.workflow_runs ?? []),
  ];
  const requested = raw.requested_reviewers ?? [];
  const avatar = raw.user?.avatar_url;
  const built = WatchedPullSchema.safeParse({
    repo: target.repo,
    number: raw.number,
    title: raw.title.slice(0, 1024),
    author: {
      login: raw.user?.login ?? 'ghost',
      ...(avatar !== undefined && URL_OK.test(avatar) ? { avatarUrl: avatar } : {}),
    },
    state: 'open',
    draft: raw.draft === true,
    review: foldReviews(parseEach(reviews.value, RawReviewSchema), requested.length),
    ci: foldCi(signals),
    headSha: sha,
    headRef: raw.head.ref.slice(0, 255),
    baseRef: raw.base.ref.slice(0, 255),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    url: raw.html_url,
    mine,
    requestedMe: requested.some(user => user.login.toLowerCase() === target.login.toLowerCase()),
    comments: mine ? comments.value.length : 0,
  });
  return ok(built.success ? built.data : undefined);
}

/**
 * One repository, now. Reads the open PRs (most recently updated first, up to {@link MAX_WATCHED_PULLS}) and for each its
 * head commit's check and workflow runs and its reviews, and, for the account's own PRs, the conversation's comments. Every
 * read goes through the one client: conditional, so a quiet repository costs `304`s.
 *
 * ANY failed read fails the repository (`err`), so the caller keeps what it saw last and tells nobody anything: a PR is
 * never reported merged because a read failed. The one exception is a missing sub-resource (a repository with Actions
 * off), which reads as empty.
 */
export async function observeRepo(
  github: Reader,
  target: WatchTarget,
  previous: readonly WatchedPull[],
): Promise<Result<Observation, ReadFailure>> {
  const list = await github.get({
    project: target.project,
    account: target.account,
    path: `${base(target)}/pulls?state=open&sort=updated&direction=desc&per_page=${MAX_WATCHED_PULLS}`,
  });
  if (!list.ok) return err(list.error);
  const raws = parseEach(Array.isArray(list.value.body) ? list.value.body : [], RawPullSchema).slice(
    0,
    MAX_WATCHED_PULLS,
  );
  const pulls: WatchedPull[] = [];
  // A batch at a time, and no further batch once one failed: a throttled or failing GitHub is not asked for the rest.
  for (let at = 0; at < raws.length; at += AT_ONCE) {
    const batch = await Promise.all(raws.slice(at, at + AT_ONCE).map(raw => describe(github, target, raw)));
    for (const one of batch) {
      if (!one.ok) return err(one.error);
      if (one.value !== undefined) pulls.push(one.value);
    }
  }

  // An own PR that is no longer in the list: closed, merged, or only past the first page. Ask GitHub which.
  const open = new Set(raws.map(raw => raw.number));
  const ended: Ended[] = [];
  let failing = false;
  for (const old of previous) {
    if (open.has(old.number) || !old.mine) continue;
    // One read that did not answer ends the asking: the rest are kept as they were and looked at again next tick.
    if (failing) {
      pulls.push(old);
      continue;
    }
    const read = await github.get({
      project: target.project,
      account: target.account,
      path: `${base(target)}/pulls/${old.number}`,
    });
    failing = !read.ok;
    const raw = read.ok ? RawPullSchema.safeParse(read.value.body) : undefined;
    if (raw === undefined || !raw.success || raw.data.state === 'open') {
      pulls.push(old);
      continue;
    }
    ended.push({ pull: old, merged: raw.data.merged_at !== null && raw.data.merged_at !== undefined });
  }
  // Bounded before anything is published or written: the newest PRs stay.
  const kept =
    pulls.length > MAX_RETAINED_PULLS
      ? [...pulls].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_RETAINED_PULLS)
      : pulls;
  return ok({ pulls: kept, ended });
}
