import type { Question } from '../../../../contract/index.ts';
import { AnswerSessionRequestSchema, FY_REQUEST_ID_HEADER, type SessionView } from '../../../seams/protocol.ts';
import { parseBody } from '../../../seams/api.ts';
import { ApiError } from '../../../seams/api.ts';
import { type ApiResponse, decodeParameter, headerValue } from '../../../seams/api.ts';
import { jsonResponse } from '../../../seams/api.ts';
import type { MountRoute, RouteContext } from '../../../seams/api.ts';

/**
 * Why an answer could not be served.
 *
 * `refused`, `conflict` and `unconfirmed` are three genuinely different next actions and are
 * deliberately not collapsed into one `409`: answer the question that is displayed NOW, use a fresh
 * request id for a different answer, and go and look at the session because nobody can say whether
 * the last attempt reached it. A caller that saw one code would otherwise be told to retry in the
 * one case where retrying is the thing that must not happen.
 */
type SessionAnswerFailure =
  | 'invalid'
  | 'not_found'
  | 'refused'
  | 'conflict'
  | 'already_answered'
  | 'unconfirmed'
  | 'released'
  | 'paused'
  | 'failed';

class SessionAnswerError extends Error {
  constructor(
    readonly failure: SessionAnswerFailure,
    message: string,
    /** What was answered, for `already_answered`; the sentence in `message` already names it. */
    readonly answeredWith?: string,
    /** The technical explanation, kept out of `message` so a screen can show it as Details only. */
    readonly detail?: string,
    /** For `paused`: the question the drive stopped at (from 0) and which questions are ticked. */
    readonly progress?: { readonly stoppedAt: number; readonly answered: readonly boolean[] },
  ) {
    super(message);
    this.name = 'SessionAnswerError';
  }
}

/** The bounded capability that answers an already-rendered structured question. */
export interface SessionAnswerSubsystem {
  /** The question the ferret is waiting on, or none. */
  question(sessionId: string): Promise<Question | undefined>;
  answer(
    sessionId: string,
    request: {
      readonly toolUseId: string;
      readonly labels: readonly string[];
      readonly other?: string | undefined;
      readonly responses?: readonly string[] | undefined;
      readonly answers?: readonly import('../../../seams/protocol.ts').StructuredQuestionAnswer[] | undefined;
      readonly requestId: string;
    },
  ): Promise<SessionView>;
}

function id(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('ferretId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

function requestId(context: RouteContext): string {
  const value = headerValue(context.request, FY_REQUEST_ID_HEADER)?.trim() ?? '';
  if (value === '') throw new ApiError(400, `an answer must carry ${FY_REQUEST_ID_HEADER}`, 'missing_request_id');
  return value;
}

function detailOf(error: SessionAnswerError): Record<string, string> {
  return error.detail === undefined ? {} : { detail: error.detail };
}

function refuse(error: unknown): never {
  if (!(error instanceof SessionAnswerError)) throw error;
  switch (error.failure) {
    case 'invalid':
      throw new ApiError(400, error.message, 'invalid_request');
    case 'not_found':
      throw new ApiError(404, error.message, 'not-found');
    case 'refused':
      throw new ApiError(409, error.message, 'answer_refused');
    case 'conflict':
      throw new ApiError(409, error.message, 'answer_request_id_reused', undefined, detailOf(error));
    case 'already_answered':
      throw new ApiError(409, error.message, 'question_already_answered', undefined, {
        ...detailOf(error),
        ...(error.answeredWith === undefined ? {} : { answeredWith: error.answeredWith }),
      });
    // The one refusal that must never be read as "try again": a retry is exactly what it forbids.
    case 'unconfirmed':
      throw new ApiError(409, error.message, 'answer_unconfirmed', undefined, detailOf(error));
    // Recovery deliberately removed structured-question state. The next action is inspect the
    // terminal and use prose when safe, not retry a destructive selector drive.
    case 'released':
      throw new ApiError(409, error.message, 'answer_released', undefined, detailOf(error));
    // Nothing was submitted and the form is still open with what was answered so far: sending the same
    // answer again resumes it, which is the one refusal here where a retry is the remedy.
    case 'paused':
      throw new ApiError(409, error.message, 'answer_paused', undefined, {
        ...detailOf(error),
        ...(error.progress === undefined
          ? {}
          : { stoppedAt: error.progress.stoppedAt, answered: [...error.progress.answered] }),
      });
    case 'failed':
      throw new ApiError(500, error.message, 'session_answer_failed', undefined, detailOf(error));
  }
}

/**
 * `POST /v1/ferrets/:ferretId/answer`.  The route never treats arrival as
 * delivery: its subsystem returns only after the live pane advanced and state
 * cleared its exact bound tool id.
 */
export function sessionAnswerRoutes(subsystem: SessionAnswerSubsystem): readonly MountRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/ferrets/:ferretId/question',
      handle: async context =>
        jsonResponse({ question: (await subsystem.question(id(context))) ?? null }) as ApiResponse,
    },
    {
      method: 'POST',
      path: '/v1/ferrets/:ferretId/answer',
      handle: async context => {
        const request = await parseBody(context.request, AnswerSessionRequestSchema);
        const view = await subsystem
          .answer(id(context), {
            toolUseId: request.toolUseId,
            labels: request.labels,
            ...(request.other === undefined ? {} : { other: request.other }),
            ...(request.responses === undefined ? {} : { responses: request.responses }),
            ...(request.answers === undefined ? {} : { answers: request.answers }),
            requestId: requestId(context),
          })
          .catch(refuse);
        return jsonResponse(view) as ApiResponse;
      },
    },
  ];
}
