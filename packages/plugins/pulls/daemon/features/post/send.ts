/**
 * What one post is on the wire, and what its answer means. Pure over the GitHub client: no token (the client's seam
 * places it), no GitHub text passed on (a status is read, a sentence is OURS), and no retry (one `write`, one answer).
 */
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import {
  PULLS_CODES,
  type PostCommentRequest,
  type PostLineRequest,
  type PostReplyRequest,
  type RepoRef,
} from '../../../contract/index.ts';
import type { GithubClient, ReadFailure, WriteOutcome } from '../../adapters/github/client.ts';
import type { Settled } from './ledger.ts';

export interface PostTarget {
  readonly account: GitAccountId;
  readonly repo: Pick<RepoRef, 'owner' | 'name'>;
  readonly number: number;
}

/** One post, already parsed: the kind and what that kind needs. */
export type PostJob =
  | { readonly kind: 'comment'; readonly request: PostCommentRequest }
  | { readonly kind: 'reply'; readonly request: PostReplyRequest }
  | { readonly kind: 'line'; readonly request: PostLineRequest };

export interface Posted {
  readonly id: string;
  readonly url?: string;
}

/** An answer the route turns into an HTTP one. `message` is ours. */
export interface PostRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly pausedUntilMs?: number;
}

type Sent = Settled<Posted, PostRefusal>;

const refuse = (status: number, code: string, message: string, pausedUntilMs?: number): Sent => ({
  kind: 'refused',
  refusal: { status, code, message, ...(pausedUntilMs === undefined ? {} : { pausedUntilMs }) },
});

/** Only an `https://github.com` address is passed on: a URL in an answer is data, never trusted as a scheme or a host. */
function githubUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 500) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.username === '' && url.password === ''
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

const REPLY_MUTATION = `mutation($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) {
    comment { id url }
  }
}`;

/** Which PR a thread is on, asked BEFORE a reply so a thread of another repository or PR is never replied to from here. */
const THREAD_HOME_QUERY = `query($thread: ID!) {
  node(id: $thread) { ... on PullRequestReviewThread { pullRequest { number repository { nameWithOwner } } } }
}`;

/** A write that certainly did not leave: a pause is the person's to wait out, anything else is a refusal of ours. */
const unsent = (failure: ReadFailure): Sent =>
  failure.code === PULLS_CODES.paused
    ? refuse(429, failure.code, failure.message, failure.pausedUntilMs)
    : refuse(502, failure.code, failure.message);

/** What a status that is not a success says, in our own words. */
function refusalOf(outcome: Extract<WriteOutcome, { kind: 'answered' }>, what: string): Sent {
  if (outcome.paused !== undefined)
    return refuse(429, PULLS_CODES.paused, outcome.paused.message, outcome.paused.pausedUntilMs);
  switch (outcome.status) {
    case 401:
    case 403:
      return refuse(403, PULLS_CODES.denied, `GitHub did not let this account ${what} here`);
    case 404:
      return refuse(404, PULLS_CODES.notFound, 'GitHub does not have that, or this account cannot see it');
    case 422:
      return refuse(
        422,
        PULLS_CODES.refused,
        `GitHub did not accept that ${what === 'reply' ? 'reply' : 'comment'}; the line may have left the diff, or the pull request may have changed`,
      );
    case 429:
      return refuse(429, PULLS_CODES.paused, 'GitHub asked for a pause');
    default:
      return refuse(502, PULLS_CODES.github, 'GitHub answered with an error');
  }
}

/** A REST comment's `id` and `html_url`, or `undefined` when GitHub's 2xx is not one (the post may then have happened). */
function restPosted(body: unknown): Posted | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { id, html_url: url } = body as { id?: unknown; html_url?: unknown };
  const text = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
  if (text === undefined) return undefined;
  const link = githubUrl(url);
  return { id: text, ...(link === undefined ? {} : { url: link }) };
}

/** The reply a mutation made, `undefined` when the answer holds none. */
function replyPosted(body: unknown): Posted | undefined {
  const comment = (body as { data?: { addPullRequestReviewThreadReply?: { comment?: unknown } | null } } | null)?.data
    ?.addPullRequestReviewThreadReply?.comment as { id?: unknown; url?: unknown } | null | undefined;
  if (comment === null || comment === undefined || typeof comment.id !== 'string') return undefined;
  if (!/^[A-Za-z0-9_=-]{1,100}$/u.test(comment.id)) return undefined;
  const link = githubUrl(comment.url);
  return { id: comment.id, ...(link === undefined ? {} : { url: link }) };
}

async function threadIsOnThisPull(
  github: Pick<GithubClient, 'graphql'>,
  target: PostTarget,
  threadId: string,
): Promise<Sent | undefined> {
  const read = await github.graphql(target.account, THREAD_HOME_QUERY, { thread: threadId });
  if (!read.ok)
    return read.error.code === PULLS_CODES.paused
      ? refuse(429, read.error.code, read.error.message, read.error.pausedUntilMs)
      : refuse(502, read.error.code, 'GitHub could not say which pull request that thread is on');
  const home = (
    read.value as { node?: { pullRequest?: { number?: unknown; repository?: { nameWithOwner?: unknown } } } | null }
  ).node?.pullRequest;
  const name = home?.repository?.nameWithOwner;
  const same =
    home?.number === target.number &&
    typeof name === 'string' &&
    name.toLowerCase() === `${target.repo.owner}/${target.repo.name}`.toLowerCase();
  return same ? undefined : refuse(404, PULLS_CODES.notFound, 'that thread is not on this pull request');
}

/** Makes the one write a post is, and says what came of it. */
export async function sendPost(
  github: Pick<GithubClient, 'write' | 'graphql'>,
  target: PostTarget,
  job: PostJob,
): Promise<Sent> {
  const base = `/repos/${target.repo.owner}/${target.repo.name}`;
  if (job.kind === 'reply') {
    const wrong = await threadIsOnThisPull(github, target, job.request.threadId);
    if (wrong !== undefined) return wrong;
    const outcome = await github.write(target.account, 'graphql', {
      path: '/graphql',
      body: { query: REPLY_MUTATION, variables: { thread: job.request.threadId, body: job.request.body } },
    });
    if (outcome.kind === 'unsent') return unsent(outcome.failure);
    if (outcome.kind === 'unknown') return { kind: 'unknown' };
    if (outcome.status !== 200) return refusalOf(outcome, 'reply');
    const posted = replyPosted(outcome.body);
    if (posted !== undefined) return { kind: 'done', value: posted };
    // GraphQL answers 200 with `errors` and no comment when it did not post; with neither, nothing can be said.
    const errors = (outcome.body as { errors?: unknown } | null)?.errors;
    return Array.isArray(errors) && errors.length > 0
      ? refuse(502, PULLS_CODES.github, 'GitHub did not accept that reply')
      : { kind: 'unknown' };
  }
  const path =
    job.kind === 'comment' ? `${base}/issues/${target.number}/comments` : `${base}/pulls/${target.number}/comments`;
  const body =
    job.kind === 'comment'
      ? { body: job.request.body }
      : {
          body: job.request.body,
          commit_id: job.request.commitId,
          path: job.request.path,
          line: job.request.line,
          side: job.request.side === 'left' ? 'LEFT' : 'RIGHT',
          ...(job.request.startLine === undefined
            ? {}
            : { start_line: job.request.startLine, start_side: job.request.side === 'left' ? 'LEFT' : 'RIGHT' }),
        };
  const outcome = await github.write(target.account, 'rest', { path, body });
  if (outcome.kind === 'unsent') return unsent(outcome.failure);
  if (outcome.kind === 'unknown') return { kind: 'unknown' };
  if (outcome.status !== 201)
    return outcome.status >= 200 && outcome.status < 300 ? { kind: 'unknown' } : refusalOf(outcome, 'comment');
  const posted = restPosted(outcome.body);
  return posted === undefined ? { kind: 'unknown' } : { kind: 'done', value: posted };
}
