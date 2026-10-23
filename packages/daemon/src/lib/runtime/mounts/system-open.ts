import { OpenUrlRequestSchema, type OpenUrlView } from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute } from '../../api/route.ts';
import { OpenUrlError, type OpenUrlErrorCode } from '../../system/open-url.ts';

/** Hands one web address to this computer's own browser. */
export interface SystemOpenSubsystem {
  open(url: string): Promise<OpenUrlView>;
}

const REFUSALS: Readonly<Record<OpenUrlErrorCode, number>> = {
  invalid_url: 400,
  rate_limited: 429,
  opener_failed: 503,
};

/**
 * `POST /v1/system/open-url`.
 *
 * `privilegedOnly` is the whole of "only a caller on this machine": the dispatcher refuses a relayed,
 * tunnelled or WebRTC caller with 403 before this handler runs, because privilege is decided from the
 * carrier the request arrived on. Nothing in the body, a header or a peer address can widen it.
 * `noStore` because the answer names a host the reader opened.
 */
export function systemOpenRoutes(subsystem: SystemOpenSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'POST',
      path: '/v1/system/open-url',
      minimum: 'operator',
      privilegedOnly: true,
      noStore: true,
      handle: async context => {
        const body = await parseBody(context.request, OpenUrlRequestSchema);
        try {
          return jsonResponse(await subsystem.open(body.url));
        } catch (error) {
          if (!(error instanceof OpenUrlError)) throw error;
          throw new ApiError(
            REFUSALS[error.code],
            error.message,
            error.code,
            undefined,
            error.retryAfterSeconds === undefined ? undefined : { retryAfterSeconds: error.retryAfterSeconds },
          );
        }
      },
    },
  ];
}
