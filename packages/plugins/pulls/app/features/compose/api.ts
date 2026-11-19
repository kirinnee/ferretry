import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  POST_CODES,
  type PostAnswer,
  PostAnswerSchema,
  type PosterAnswer,
  PosterAnswerSchema,
} from '../../../contract/index.ts';
import { repoSegment } from '../../../contract/repo-segment.ts';

export type PullsClient = Pick<PluginClient, 'call'>;

export interface PullAddress {
  readonly project: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

/** What a post is, in the words of the wire (the request id and the second tap are added by the hook). */
export type PostPayload =
  | { readonly kind: 'comment' }
  | { readonly kind: 'reply'; readonly threadId: string }
  | {
      readonly kind: 'line';
      readonly commitId: string;
      readonly path: string;
      readonly side: 'left' | 'right';
      readonly line: number;
      readonly startLine?: number;
    };

const ROUTES = {
  comment: 'POST /v1/pulls/:project/:repo/:number/comment',
  reply: 'POST /v1/pulls/:project/:repo/:number/reply',
  line: 'POST /v1/pulls/:project/:repo/:number/line-comment',
} as const;
const POSTER_ROUTE = 'GET /v1/pulls/:project/:repo/:number/poster';

const paramsOf = (address: PullAddress) => ({
  project: address.project,
  repo: repoSegment(address),
  number: String(address.number),
});

/** Which account a post goes out as. */
export async function readPoster(client: PullsClient, address: PullAddress): Promise<PosterAnswer> {
  return PosterAnswerSchema.parse(await client.call(POSTER_ROUTE, { params: paramsOf(address) }));
}

/** Sends ONE post. Never called twice for one tap: the hook holds the request id and the in-flight flag. */
export async function sendPost(
  client: PullsClient,
  address: PullAddress,
  payload: PostPayload,
  request: { readonly requestId: string; readonly body: string; readonly postAnyway?: true },
): Promise<PostAnswer> {
  const { kind, ...rest } = payload;
  return PostAnswerSchema.parse(
    await client.call(ROUTES[kind], { params: paramsOf(address), body: { ...request, ...rest } }),
  );
}

/** How a thrown call reads: the daemon's code and sentence as they are, and whether the call died on the carrier. */
export interface Failure {
  readonly code: string | undefined;
  readonly message: string;
  /** The call died on the carrier: it may have reached the daemon. */
  readonly carrier: boolean;
}

export function failureOf(cause: unknown): Failure {
  const thing = cause as { code?: unknown; message?: unknown; carrier?: unknown } | null;
  return {
    code: typeof thing?.code === 'string' ? thing.code : undefined,
    message:
      typeof thing?.message === 'string' && thing.message !== '' ? thing.message : 'The comment could not be posted.',
    carrier: thing?.carrier === true,
  };
}

export const isSecretStop = (failure: Failure): boolean => failure.code === POST_CODES.secretShaped;
