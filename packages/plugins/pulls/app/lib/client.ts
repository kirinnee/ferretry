import type { PluginClient } from '@ferretry/kernel/manifest';
import { PullPageAnswerSchema, type PullPageAnswer } from '../../contract/index.ts';
import { repoSegment } from '../../contract/repo-segment.ts';

/** The generated per-daemon client, narrowed to what the PR page uses: calls (the guard is the client's own). */
export type PullsClient = Pick<PluginClient, 'call'>;

/** The sentence a thrown thing says; a refusal is shown as the daemon worded it, never paraphrased. */
export const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface PullAddress {
  readonly project: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

const DETAIL_ROUTE = 'GET /v1/pulls/:project/:repo/:number';

/** One PR page, as the daemon answers it (parsed: a shape that does not match is an error, never a half-drawn page). */
export async function readPullPage(client: PullsClient, address: PullAddress): Promise<PullPageAnswer> {
  const answer = await client.call(DETAIL_ROUTE, {
    params: { project: address.project, repo: repoSegment(address), number: String(address.number) },
  });
  return PullPageAnswerSchema.parse(answer);
}
