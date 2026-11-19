import { z } from 'zod';
import {
  MAX_REVIEW_THREADS,
  PullCommentSchema,
  type ReviewThread,
  ReviewThreadSchema,
} from '../../../contract/index.ts';

/**
 * How much one page asks for. The seam under this plugin refuses an answer over 4 MiB (a 502, no partial answer), so a
 * page is small and the rungs get smaller: a page that was refused is asked again with the next rung, from the same cursor.
 */
export interface PageSize {
  readonly threads: number;
  readonly comments: number;
}
export const FIRST_PAGE: PageSize = { threads: 20, comments: 20 };
export const PAGE_SIZES: readonly PageSize[] = [FIRST_PAGE, { threads: 5, comments: 5 }, { threads: 1, comments: 3 }];
/** Most pages one read follows: 25 × 20 = 500 threads, the same bound the wire answer has. */
export const MAX_THREAD_PAGES = Math.ceil(MAX_REVIEW_THREADS / FIRST_PAGE.threads);
/** The comment text the whole answer may carry (characters): past it the answer stops and says it is incomplete. */
export const ANSWER_TEXT_BUDGET = 2 * 1024 * 1024;

/**
 * The review threads of one pull request. GraphQL has no ETag, so this is read when a PR page opens and when the watch
 * sees `updated_at` change; it is never cached. Only fields the wire shape names are asked for: never `bodyHTML`. The
 * page sizes are variables (`$threads`, `$comments`); each thread says how many replies it has and whether more exist.
 */
export const REVIEW_THREADS_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String, $threads: Int!, $comments: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: $threads, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          comments(first: $comments) {
            totalCount
            pageInfo { hasNextPage }
            nodes { id body createdAt url author { login avatarUrl } }
          }
        }
      }
    }
  }
}`;

const Nullable = <T extends z.ZodType>(inner: T) => inner.nullish();

const RawComment = z.object({
  id: z.string(),
  body: z.string().nullish(),
  createdAt: z.string(),
  url: z.string(),
  author: Nullable(z.object({ login: z.string(), avatarUrl: Nullable(z.string()) })),
});

const RawThread = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  isOutdated: z.boolean(),
  path: z.string(),
  line: Nullable(z.number()),
  startLine: Nullable(z.number()),
  diffSide: Nullable(z.string()),
  comments: z.object({
    nodes: z.array(z.unknown()),
    totalCount: Nullable(z.number()),
    pageInfo: Nullable(z.object({ hasNextPage: z.boolean() })),
  }),
});

/** What one page of the query answers: the threads as GitHub sent them (checked later, one at a time). */
export const ThreadsPageSchema = z.object({
  repository: Nullable(
    z.object({
      pullRequest: Nullable(
        z.object({
          reviewThreads: z.object({
            pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: Nullable(z.string()) }),
            nodes: z.array(z.unknown()),
          }),
        }),
      ),
    }),
  ),
});

/**
 * One GraphQL thread as the wire shape. A thread whose comments are all unusable is dropped (`undefined`), and so is a
 * comment that does not fit the wire shape: a stranger's malformed text must not take the whole page down. A deleted
 * author reads as GitHub's own `ghost`.
 */
export function toThread(node: unknown): ReviewThread | undefined {
  const raw = RawThread.safeParse(node);
  if (!raw.success) return undefined;
  const thread = raw.data;
  const comments = thread.comments.nodes.flatMap(item => {
    const parsed = RawComment.safeParse(item);
    if (!parsed.success) return [];
    const { author } = parsed.data;
    const comment = PullCommentSchema.safeParse({
      id: parsed.data.id,
      author: {
        login: author?.login ?? 'ghost',
        ...(author?.avatarUrl === undefined || author.avatarUrl === null ? {} : { avatarUrl: author.avatarUrl }),
      },
      body: parsed.data.body ?? '',
      createdAt: parsed.data.createdAt,
      url: parsed.data.url,
    });
    return comment.success ? [comment.data] : [];
  });
  // Replies GitHub holds that this page did not ask for: the card says so and links to GitHub for the rest.
  const omitted =
    thread.comments.pageInfo?.hasNextPage === true
      ? Math.max(1, (thread.comments.totalCount ?? 0) - thread.comments.nodes.length)
      : 0;
  const shaped = ReviewThreadSchema.safeParse({
    id: thread.id,
    resolved: thread.isResolved,
    outdated: thread.isOutdated,
    path: thread.path,
    ...(typeof thread.line === 'number' && thread.line > 0 ? { line: thread.line } : {}),
    ...(typeof thread.startLine === 'number' && thread.startLine > 0 ? { startLine: thread.startLine } : {}),
    side: thread.diffSide === 'LEFT' ? 'left' : 'right',
    comments,
    ...(omitted > 0 ? { omittedReplies: omitted } : {}),
  });
  return shaped.success ? shaped.data : undefined;
}
