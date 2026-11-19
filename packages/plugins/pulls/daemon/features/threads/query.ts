import { z } from 'zod';
import {
  MAX_REVIEW_THREADS,
  PullCommentSchema,
  type ReviewThread,
  ReviewThreadSchema,
} from '../../../contract/index.ts';

/** GitHub's own page sizes for this query: 50 threads a page, 100 comments to a thread. */
export const THREADS_PER_PAGE = 50;
const COMMENTS_PER_THREAD = 100;
/** Most pages one read follows: 10 × 50 = 500 threads, the same bound the wire answer has. */
export const MAX_THREAD_PAGES = MAX_REVIEW_THREADS / THREADS_PER_PAGE;

/**
 * The review threads of one pull request. GraphQL has no ETag, so this is read when a PR page opens and when the watch
 * sees `updated_at` change; it is never cached. Only fields the wire shape names are asked for: never `bodyHTML`.
 */
export const REVIEW_THREADS_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREADS_PER_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          startLine
          diffSide
          comments(first: ${COMMENTS_PER_THREAD}) {
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
  comments: z.object({ nodes: z.array(z.unknown()) }),
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
  const shaped = ReviewThreadSchema.safeParse({
    id: thread.id,
    resolved: thread.isResolved,
    outdated: thread.isOutdated,
    path: thread.path,
    ...(typeof thread.line === 'number' && thread.line > 0 ? { line: thread.line } : {}),
    ...(typeof thread.startLine === 'number' && thread.startLine > 0 ? { startLine: thread.startLine } : {}),
    side: thread.diffSide === 'LEFT' ? 'left' : 'right',
    comments,
  });
  return shaped.success ? shaped.data : undefined;
}
