/**
 * Fake GitHub's GraphQL review threads (E6). `serveThreads` answers `POST /graphql` for the threads query, paged by
 * `perPage` with a cursor, so a test can ask for every page. Fake data only.
 */
import type { FakeGithub } from './server.ts';

interface FakeThreadComment {
  readonly id: string;
  readonly login: string | null;
  readonly body: string;
  readonly createdAt?: string;
}

export interface FakeThread {
  readonly id: string;
  readonly path: string;
  readonly line: number | null;
  readonly startLine?: number | null;
  readonly side?: 'LEFT' | 'RIGHT';
  readonly resolved?: boolean;
  readonly outdated?: boolean;
  readonly comments: readonly FakeThreadComment[];
}

const node = (thread: FakeThread, firstComments: number) => ({
  id: thread.id,
  isResolved: thread.resolved ?? false,
  isOutdated: thread.outdated ?? false,
  path: thread.path,
  line: thread.line,
  startLine: thread.startLine ?? null,
  diffSide: thread.side ?? 'RIGHT',
  comments: {
    totalCount: thread.comments.length,
    pageInfo: { hasNextPage: thread.comments.length > firstComments },
    nodes: thread.comments.slice(0, firstComments).map(comment => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt ?? '2026-11-01T10:00:00Z',
      url: `https://github.com/octo/demo/pull/7#discussion_${comment.id}`,
      author: comment.login === null ? null : { login: comment.login, avatarUrl: null },
    })),
  },
});

/** `null` for `pullRequest` when `threads` is `undefined` (no such PR). */
export function serveThreads(fake: FakeGithub, threads: readonly FakeThread[] | undefined, perPage?: number): void {
  fake.on('POST', '/graphql', ({ body }) => {
    const variables =
      (body as { variables?: { after?: string | null; threads?: number; comments?: number } }).variables ?? {};
    if (threads === undefined) return { status: 200, body: { data: { repository: { pullRequest: null } } } };
    // The page GitHub gives is the page asked for (`$threads`, `$comments`), unless a test fixes `perPage`.
    const size = perPage ?? variables.threads ?? 50;
    const from = variables.after === null || variables.after === undefined ? 0 : Number(variables.after);
    const slice = threads.slice(from, from + size);
    const more = from + size < threads.length;
    return {
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: more, endCursor: more ? String(from + size) : null },
                nodes: slice.map(each => node(each, variables.comments ?? 100)),
              },
            },
          },
        },
      },
    };
  });
}
