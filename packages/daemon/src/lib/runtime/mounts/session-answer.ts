import { AnswerSessionRequestSchema, FY_REQUEST_ID_HEADER, type SessionView } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter, headerValue } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

export type SessionAnswerFailure = 'invalid' | 'not_found' | 'refused' | 'failed';

export class SessionAnswerError extends Error {
  constructor(
    readonly failure: SessionAnswerFailure,
    message: string,
  ) {
    super(message);
    this.name = 'SessionAnswerError';
  }
}

/** The bounded capability that answers an already-rendered structured question. */
export interface SessionAnswerSubsystem {
  answer(
    sessionId: string,
    request: {
      readonly toolUseId: string;
      readonly labels: readonly string[];
      readonly other?: string | undefined;
      readonly responses?: readonly string[] | undefined;
      readonly answers?: readonly import('@ferretry/protocol').StructuredQuestionAnswer[] | undefined;
      readonly requestId: string;
    },
  ): Promise<SessionView>;
}

function id(context: RouteContext): string {
  const decoded = decodeParameter(context.params.get('sessionId') ?? '');
  if (decoded === undefined || decoded === '')
    throw new ApiError(400, 'the session id in the path is not usable', 'invalid_session_id');
  return decoded;
}

function requestId(context: RouteContext): string {
  const value = headerValue(context.request, FY_REQUEST_ID_HEADER)?.trim() ?? '';
  if (value === '') throw new ApiError(400, `an answer must carry ${FY_REQUEST_ID_HEADER}`, 'missing_request_id');
  return value;
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
    case 'failed':
      throw new ApiError(500, error.message, 'session_answer_failed');
  }
}

/**
 * `POST /v1/sessions/:sessionId/answer`.  The route never treats arrival as
 * delivery: its subsystem returns only after the live pane advanced and state
 * cleared its exact bound tool id.
 */
export function sessionAnswerRoutes(subsystem: SessionAnswerSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/answer',
      scope: 'admin',
      noStore: true,
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
