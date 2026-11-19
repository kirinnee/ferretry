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

const node = (thread: FakeThread) => ({
  id: thread.id,
  isResolved: thread.resolved ?? false,
  isOutdated: thread.outdated ?? false,
  path: thread.path,
  line: thread.line,
  startLine: thread.startLine ?? null,
  diffSide: thread.side ?? 'RIGHT',
  comments: {
    nodes: thread.comments.map(comment => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt ?? '2026-11-01T10:00:00Z',
      url: `https://github.com/octo/demo/pull/7#discussion_${comment.id}`,
      author: comment.login === null ? null : { login: comment.login, avatarUrl: null },
    })),
  },
});

/** `null` for `pullRequest` when `threads` is `undefined` (no such PR). */
export function serveThreads(fake: FakeGithub, threads: readonly FakeThread[] | undefined, perPage = 50): void {
  fake.on('POST', '/graphql', ({ body }) => {
    const variables = (body as { variables?: { after?: string | null } }).variables ?? {};
    if (threads === undefined) return { status: 200, body: { data: { repository: { pullRequest: null } } } };
    const from = variables.after === null || variables.after === undefined ? 0 : Number(variables.after);
    const slice = threads.slice(from, from + perPage);
    const more = from + perPage < threads.length;
    return {
      status: 200,
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: more, endCursor: more ? String(from + perPage) : null },
                nodes: slice.map(node),
              },
            },
          },
        },
      },
    };
  });
}
