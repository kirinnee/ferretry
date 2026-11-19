import type { PluginClient } from '@ferretry/kernel/manifest';
import { type ReviewThreadsAnswer, ReviewThreadsAnswerSchema } from '../../../contract/index.ts';
import { repoSegment } from '../../../contract/repo-segment.ts';

const THREADS_ROUTE = 'GET /v1/pulls/:project/:repo/:number/threads';

export type PullsClient = Pick<PluginClient, 'call'>;

/**
 * The review threads of one PR, parsed whole. `repo` is `owner~name` (the router refuses `/` inside a segment). Read when
 * a PR page opens and again when the PR's `updatedAt` moves: GraphQL has no ETag, so every call is a real read.
 */
export const fetchThreads = async (
  client: PullsClient,
  project: string,
  owner: string,
  name: string,
  number: number,
): Promise<ReviewThreadsAnswer> =>
  ReviewThreadsAnswerSchema.parse(
    await client.call(THREADS_ROUTE, {
      params: { project, repo: repoSegment({ owner, name }), number: String(number) },
    }),
  );
