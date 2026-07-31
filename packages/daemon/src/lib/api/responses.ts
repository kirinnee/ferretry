import { daemonVersion } from '../version.ts';
import type { ApiResponse } from './http.ts';

/** Every API response carries the daemon version so a client can name a skew instead of guessing
 *  why a route it knows about answered 404. */
export const VERSION_HEADER = 'x-ferretry-version';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Prometheus text exposition format, version 0.0.4 — what every scraper negotiates by default. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function baseHeaders(contentType: string): Map<string, string> {
  return new Map([
    ['content-type', contentType],
    [VERSION_HEADER, daemonVersion],
  ]);
}

/** A JSON response. `extra` wins over the defaults so a route can set its own cache policy. */
export function jsonResponse(value: unknown, status = 200, extra: Readonly<Record<string, string>> = {}): ApiResponse {
  const headers = baseHeaders(JSON_CONTENT_TYPE);
  for (const [name, headerValue] of Object.entries(extra)) headers.set(name.toLowerCase(), headerValue);
  return { status, headers, body: JSON.stringify(value) };
}

/** A plain-text (or other non-JSON) response. */
export function textResponse(
  body: string,
  status = 200,
  contentType = 'text/plain; charset=utf-8',
  extra: Readonly<Record<string, string>> = {},
): ApiResponse {
  const headers = baseHeaders(contentType);
  for (const [name, headerValue] of Object.entries(extra)) headers.set(name.toLowerCase(), headerValue);
  return { status, headers, body };
}

/** The uniform error envelope. A `code` is included whenever the client can act on the distinction
 *  programmatically rather than by matching on prose. */
export function errorResponse(status: number, message: string, code?: string): ApiResponse {
  return jsonResponse(code === undefined ? { error: message } : { error: message, code }, status);
}

/**
 * The answer for a route this daemon does not have.
 *
 * `code` lets a client tell this apart from a "no such session" 404, and method+path let it name
 * the exact route — the classic version-skew symptom when a new client reaches an old daemon.
 */
export function unknownRouteResponse(method: string, path: string): ApiResponse {
  return jsonResponse({ error: `no route ${method} ${path}`, code: 'unknown_route', method, path }, 404);
}

/** 405 with the `Allow` header the HTTP specification requires; without it a client cannot tell a
 *  wrong verb from a missing route. */
export function methodNotAllowedResponse(method: string, path: string, allowed: readonly string[]): ApiResponse {
  return jsonResponse(
    { error: `method ${method} is not allowed on ${path}`, code: 'method_not_allowed', method, path, allowed },
    405,
    { allow: [...allowed].join(', ') },
  );
}

/** Marks a response as never cacheable. Used for anything carrying credentials or working-tree
 *  bytes, and for the machine feeds, whose whole value is freshness. */
export function noStore(response: ApiResponse): ApiResponse {
  const headers = new Map(response.headers);
  headers.set('cache-control', 'no-store');
  return { ...response, headers };
}
