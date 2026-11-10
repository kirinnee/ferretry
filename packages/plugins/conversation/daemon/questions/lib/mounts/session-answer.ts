import type { Question } from '../../../../contract/index.ts';
import { AnswerSessionRequestSchema, FY_REQUEST_ID_HEADER, type SessionView } from '../../../seams/protocol.ts';
import { parseBody } from '../../../seams/api.ts';
import { ApiError } from '../../../seams/api.ts';
import { type ApiResponse, decodeParameter, headerValue } from '../../../seams/api.ts';
import { jsonResponse } from '../../../seams/api.ts';
import type { MountRoute, RouteContext } from '../../../seams/api.ts';

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
        const view = await subsystem.answer(id(context), {
          toolUseId: request.toolUseId,
          labels: request.labels,
          ...(request.other === undefined ? {} : { other: request.other }),
          ...(request.responses === undefined ? {} : { responses: request.responses }),
          ...(request.answers === undefined ? {} : { answers: request.answers }),
          requestId: requestId(context),
        });
        return jsonResponse(view) as ApiResponse;
      },
    },
  ];
}
