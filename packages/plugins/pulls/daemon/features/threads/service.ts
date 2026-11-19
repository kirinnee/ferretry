import { err, ok, type Result } from '@ferretry/std';
import { GitAccountIdSchema, type GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import {
  MAX_REVIEW_THREADS,
  PULLS_CODES,
  type RepoRef,
  type ReviewThread,
  type ReviewThreadsAnswer,
} from '../../../contract/index.ts';
import type { GithubClient, ReadFailure } from '../../adapters/github/client.ts';
import {
  ANSWER_TEXT_BUDGET,
  MAX_THREAD_PAGES,
  PAGE_SIZES,
  type PageSize,
  REVIEW_THREADS_QUERY,
  ThreadsPageSchema,
  toThread,
} from './query.ts';

/** A refusal the route turns into an HTTP answer. `message` is ours, never GitHub's text. */
export interface ThreadsRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

const remoteOf = (remote: string): { owner: string; name: string } | undefined => {
  try {
    const url = new URL(remote);
    if (url.hostname.toLowerCase() !== 'github.com') return undefined;
    const [owner, name] = url.pathname
      .replace(/^\/+|\/+$/gu, '')
      .replace(/\.git$/u, '')
      .split('/');
    return owner === undefined || name === undefined ? undefined : { owner, name };
  } catch {
    return undefined;
  }
};

/**
 * The account a repository of the project is read with: the repository's own, else the project's first. The repository
 * must be one the project lists (a project reads its own repositories, not any a token could reach).
 */
export function accountFor(
  project: ProjectInfo,
  repo: Pick<RepoRef, 'owner' | 'name'>,
): Result<GitAccountId, ThreadsRefusal> {
  const listed = (project.repos ?? []).find(item => {
    const at = item.remote === undefined ? undefined : remoteOf(item.remote);
    return (
      item.provider === 'github' &&
      at !== undefined &&
      at.owner.toLowerCase() === repo.owner.toLowerCase() &&
      at.name.toLowerCase() === repo.name.toLowerCase()
    );
  });
  if (listed === undefined)
    return err({ status: 404, code: PULLS_CODES.notFound, message: 'that repository is not in this project' });
  const id = GitAccountIdSchema.safeParse(listed.account ?? project.accounts?.[0]);
  if (!id.success)
    return err({
      status: 409,
      code: PULLS_CODES.noAccount,
      message: 'connect a GitHub account to this project to read its pull requests',
    });
  return ok(id.data);
}

const refusalOf = (failure: ReadFailure): ThreadsRefusal => {
  switch (failure.code) {
    case PULLS_CODES.paused:
      return { status: 503, code: failure.code, message: failure.message };
    case PULLS_CODES.notFound:
      return { status: 404, code: failure.code, message: failure.message };
    default:
      return { status: 502, code: failure.code, message: failure.message };
  }
};

/** The characters of comment text a thread carries (what the answer's budget counts). */
const textOf = (thread: ReviewThread): number => thread.comments.reduce((sum, comment) => sum + comment.body.length, 0);

/**
 * Reads the review threads of one pull request (up to the page bound), page by page. A page the seam refused (too much
 * data) is asked again from the same cursor with the next smaller page size. The answer as a whole has a text budget:
 * past it, or past the page bound, or when a smaller page still fails after some threads were read, the answer keeps
 * what it has and says `truncated`. A refusal on the very first page is a refusal.
 */
export async function readThreads(
  github: Pick<GithubClient, 'graphql'>,
  account: GitAccountId,
  repo: Pick<RepoRef, 'owner' | 'name'>,
  number: number,
  nowIso: () => string,
): Promise<Result<ReviewThreadsAnswer, ThreadsRefusal>> {
  const threads: ReviewThread[] = [];
  let truncated = false;
  let spent = 0;
  let after: string | null = null;
  let size = 0;
  for (let page = 0; page < MAX_THREAD_PAGES; page += 1) {
    const asked = PAGE_SIZES[size] as PageSize;
    const read = await github.graphql(account, REVIEW_THREADS_QUERY, {
      owner: repo.owner,
      name: repo.name,
      number,
      after,
      threads: asked.threads,
      comments: asked.comments,
    });
    if (!read.ok) {
      // Too big for the seam: the same page again, smaller. Only a refusal can mean that; a pause or a 404 cannot.
      if (read.error.code === PULLS_CODES.refused && size + 1 < PAGE_SIZES.length) {
        size += 1;
        page -= 1;
        continue;
      }
      if (threads.length > 0 && read.error.code === PULLS_CODES.refused)
        return ok({ threads, truncated: true, fetchedAt: nowIso() });
      return err(refusalOf(read.error));
    }
    const shaped = ThreadsPageSchema.safeParse(read.value);
    const connection = shaped.success ? shaped.data.repository?.pullRequest?.reviewThreads : undefined;
    if (connection === undefined || connection === null)
      return err({ status: 404, code: PULLS_CODES.notFound, message: 'GitHub does not have that pull request' });
    for (const node of connection.nodes) {
      const thread = toThread(node);
      // A thread that cannot be shown is not silently lost: the answer says it is incomplete.
      if (thread === undefined) truncated = true;
      else if (threads.length >= MAX_REVIEW_THREADS || spent + textOf(thread) > ANSWER_TEXT_BUDGET) {
        // Over the budget: this thread and every one after it is left on GitHub.
        return ok({ threads, truncated: true, fetchedAt: nowIso() });
      } else {
        threads.push(thread);
        spent += textOf(thread);
      }
    }
    if (!connection.pageInfo.hasNextPage) return ok({ threads, truncated, fetchedAt: nowIso() });
    after = connection.pageInfo.endCursor ?? null;
    if (after === null) break;
  }
  return ok({ threads, truncated: true, fetchedAt: nowIso() });
}
