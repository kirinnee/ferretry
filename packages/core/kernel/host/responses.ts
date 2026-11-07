import type { ApiResponse, PlainApiResponse } from '../contract/http.ts';
import { ApiError, errorResponse, jsonResponse } from '../contract/http.ts';
import { KERNEL_REFUSALS, skeletonSentence } from '../contract/refusals.ts';

/** The header every response carries so a client can name a skew instead of guessing (today's `FY_VERSION_HEADER`). */
export const VERSION_HEADER = 'x-ferretry-version';

/** Marks a response as never cacheable (credentials, working-tree bytes, live feeds). */
export function noStore<R extends ApiResponse>(response: R): R {
  const headers = new Map(response.headers);
  headers.set('cache-control', 'no-store');
  return { ...response, headers };
}

export function withVersion<R extends ApiResponse>(response: R, version: string): R {
  if (response.headers.get(VERSION_HEADER) === version) return response;
  const headers = new Map(response.headers);
  headers.set(VERSION_HEADER, version);
  return { ...response, headers };
}

/** A route this daemon does not have. `code` tells it apart from a "no such thing" 404. */
export function unknownRouteResponse(method: string, path: string): PlainApiResponse {
  return jsonResponse({ error: `no route ${method} ${path}`, code: 'unknown_route', method, path }, 404);
}

/** 405 with the `Allow` header the HTTP specification requires. */
export function methodNotAllowedResponse(method: string, path: string, allowed: readonly string[]): PlainApiResponse {
  return jsonResponse(
    { error: `method ${method} is not allowed on ${path}`, code: 'method_not_allowed', method, path, allowed },
    405,
    { allow: [...allowed].join(', ') },
  );
}

/** A refusal a handler named keeps its own status; anything else is a bare 500 that says nothing of the cause. */
export function failureResponse(error: unknown): PlainApiResponse {
  return error instanceof ApiError
    ? errorResponse(error.status, error.message, error.code, error.extra)
    : errorResponse(500, 'the daemon failed to handle this request', 'internal_error');
}

/** D10: a skeleton half's declared route. */
export function skeletonResponse(title: string): PlainApiResponse {
  return errorResponse(
    KERNEL_REFUSALS.pluginUnavailable.status,
    skeletonSentence(title),
    KERNEL_REFUSALS.pluginUnavailable.code,
  );
}

/** §3.4 `failed`: the plugin's build threw. */
export function pluginFailedResponse(title: string): PlainApiResponse {
  return errorResponse(
    KERNEL_REFUSALS.pluginFailed.status,
    `${title} failed to start; \`fy doctor\` says why.`,
    KERNEL_REFUSALS.pluginFailed.code,
  );
}

/** §9.3: a damaged subsystem answers every call naming the file, never as if empty. */
export function storeDamagedResponse(title: string, files: readonly string[]): PlainApiResponse {
  return errorResponse(
    KERNEL_REFUSALS.storeDamaged.status,
    `${title} cannot read ${files.join(', ')}, so it is refusing calls until the file is restored or reset.`,
    KERNEL_REFUSALS.storeDamaged.code,
    { files: [...files] },
  );
}

// The publication brand lives beside the session wire (browser-safe), which checks it on every answer.
export { isPublishedResponse, publishResponse } from './session/wire/publication.ts';
