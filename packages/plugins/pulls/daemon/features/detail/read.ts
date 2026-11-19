import { err, ok, type Result } from '@ferretry/std';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import { MAX_PAGE_ENTRIES, PULLS_CODES, type PullPageAnswer, type RepoRef } from '../../../contract/index.ts';
import type { GithubClient, ReadFailure } from '../../adapters/github/client.ts';
import { mapChecks, mapComments, mapPull, mapReviews, pullUrl, reviewState } from './map.ts';

/** GitHub lists 100 to a page; five pages is the most one PR page carries. */
const PAGES = MAX_PAGE_ENTRIES / 100;

export interface PageRequest {
  readonly project: string;
  readonly account: GitAccountId;
  readonly repo: RepoRef;
  readonly number: number;
}

/**
 * One PR page: the PR, its conversation and the summary of its head commit's checks. Every read is a conditional one
 * through the shared client (ETag, cache, one budget). While polling is paused the answer says until when and nothing
 * is read; any other failure is the client's own (`message` is ours, never GitHub's text).
 */
export async function readPullPage(
  github: GithubClient,
  request: PageRequest,
): Promise<Result<PullPageAnswer, ReadFailure>> {
  const base = `/repos/${request.repo.owner}/${request.repo.name}`;
  const reading = (path: string) => ({ project: request.project, account: request.account, path });

  const pull = await github.get(reading(`${base}/pulls/${String(request.number)}`));
  if (!pull.ok) return paused(pull.error);
  const head = (pull.value.body as { head?: { sha?: unknown } } | undefined)?.head?.sha;
  if (typeof head !== 'string' || !/^[0-9a-f]{7,64}$/u.test(head))
    return err({ code: PULLS_CODES.github, message: 'GitHub answered with an error' });

  const [comments, reviews, checks] = await Promise.all([
    github.getAll(reading(`${base}/issues/${String(request.number)}/comments?per_page=100`), PAGES),
    github.getAll(reading(`${base}/pulls/${String(request.number)}/reviews?per_page=100`), PAGES),
    github.get(reading(`${base}/commits/${head}/check-runs?per_page=100`)),
  ]);
  if (!comments.ok) return paused(comments.error);
  if (!reviews.ok) return paused(reviews.error);
  if (!checks.ok) return paused(checks.error);

  const url = pullUrl(request.repo, request.number);
  const mappedReviews = mapReviews(reviews.value.items, url);
  const summary = mapChecks(checks.value.body);
  const requested = Array.isArray((pull.value.body as { requested_reviewers?: unknown }).requested_reviewers)
    ? (pull.value.body as { requested_reviewers: unknown[] }).requested_reviewers.length
    : 0;
  const detail = mapPull(pull.value.body, request.repo, {
    review: reviewState(mappedReviews, requested),
    ci: summary.state,
  });
  if (detail === undefined) return err({ code: PULLS_CODES.github, message: 'GitHub answered with an error' });

  return ok({
    kind: 'page',
    pull: detail,
    comments: mapComments(comments.value.items, url).slice(0, MAX_PAGE_ENTRIES),
    reviews: mappedReviews.slice(0, MAX_PAGE_ENTRIES),
    checks: summary,
    truncated: comments.value.truncated || reviews.value.truncated,
    fromCache: pull.value.fromCache && comments.value.fromCache && reviews.value.fromCache && checks.value.fromCache,
  });
}

/** A pause is an answer ("until when"), not a failure. */
function paused(failure: ReadFailure): Result<PullPageAnswer, ReadFailure> {
  if (failure.code === PULLS_CODES.paused && failure.pausedUntilMs !== undefined)
    return ok({ kind: 'paused', until: new Date(failure.pausedUntilMs).toISOString() });
  return err(failure);
}
