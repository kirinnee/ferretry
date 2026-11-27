import { type FerretId, type ForkFailure, type ForksApi, PERSON_ORIGIN } from '@ferretry/core-ferrets/contract';
import {
  ApiError,
  type ApiResponse,
  decodeParameter,
  jsonResponse,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { ForkRequestSchema, type ForkResult } from '../../contract/index.ts';
import { parseBody } from '../reader/lib/http.ts';
import { TranscriptReadError, type TranscriptReadFailure } from '../reader/lib/reads.ts';

type Call = Parameters<RouteHandler>[0];

/** What the fork route reaches: the fork Ferrets offers, and Conversation's own reads and attachment store. */
export interface ForkRouteDeps {
  /** Ferrets' `forks` slice; absent while Ferrets offers none (a build with no harness that can cut). */
  readonly forks: () => ForksApi['forks'];
  /** The number of owner turns up to the selected message, proved against the conversation as it reads now (writes nothing). */
  readonly selectTurn: (ferret: string, point: string, selectionBinding: string) => Promise<number>;
  /** Copies every attachment `from` holds into `to`; the number copied. */
  readonly copyAttachments: (from: string, to: string) => Promise<number>;
}

/** The status each way the selection can be refused answers with; every sentence is the read's own, in plain words. */
const SELECTION: Readonly<Partial<Record<TranscriptReadFailure, number>>> = {
  invalid_query: 400,
  not_a_turn: 400,
  selection_stale: 409,
  no_transcript: 409,
  transcript_unreadable: 409,
};

const FORK_REFUSALS: Readonly<Record<ForkFailure['code'], { readonly status: number; readonly code: string }>> = {
  no_ferret: { status: 404, code: 'not-found' },
  forbidden: { status: 403, code: 'forbidden' },
  // The harness cannot fork a conversation (or not this one): its sentence says why, and nothing was written.
  unsupported: { status: 409, code: 'fork_unsupported' },
  worktree: { status: 409, code: 'fork_worktree' },
  cut: { status: 409, code: 'fork_refused' },
  start: { status: 409, code: 'fork_start_failed' },
};

const ferretOf = (call: Call): string => {
  const decoded = decodeParameter(call.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_ferret_id');
  return decoded;
};

const sentence = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `POST /v1/ferrets/:ferretId/fork`: a new ferret from a message of this one's conversation.
 *
 * ORDER IS THE SAFETY. The selection is proved first, against a fresh read of the raw conversation, and a binding that no
 * longer holds is `selection_stale` with nothing started, cut or copied. Only then does Ferrets cut and start (its own
 * refusals write nothing either). Attachments are copied last, with this plugin's own store, into a ferret that now exists;
 * a failure there leaves the fork made and says so in `notice` rather than pretending it did not happen.
 */
export function forkRoute(deps: ForkRouteDeps): RouteHandler {
  return async (call): Promise<ApiResponse> => {
    const from = ferretOf(call);
    const request = await parseBody(call.request, ForkRequestSchema);
    const forks = deps.forks();
    if (forks === undefined) throw new ApiError(503, 'Forking is not available on this machine.', 'plugin_unavailable');

    let turn: number;
    try {
      turn = await deps.selectTurn(from, request.point, request.selectionBinding);
    } catch (error) {
      if (error instanceof TranscriptReadError)
        throw new ApiError(SELECTION[error.failure] ?? 409, error.message, error.failure);
      throw error;
    }

    const made = await forks.fork(
      from as FerretId,
      { turn },
      { worktree: request.worktree, ...(request.name === undefined ? {} : { name: request.name }) },
      PERSON_ORIGIN,
    );
    if (!made.ok) {
      const refusal = FORK_REFUSALS[made.error.code];
      throw new ApiError(refusal.status, made.error.reason, refusal.code);
    }

    let attachments = 0;
    let notice: string | undefined;
    try {
      attachments = await deps.copyAttachments(from, made.value.ferret);
    } catch (error) {
      notice = `The fork was made, but its attachments could not be copied (${sentence(error)}). The earlier messages still read as they were.`;
    }
    const result: ForkResult = {
      ferret: made.value.ferret,
      ...(made.value.worktree === undefined ? {} : { worktree: { branch: made.value.worktree.branch } }),
      attachments,
      ...(notice === undefined ? {} : { notice }),
    };
    return jsonResponse(result, 201);
  };
}
