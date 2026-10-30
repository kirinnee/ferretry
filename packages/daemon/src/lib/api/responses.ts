import { createHash } from 'node:crypto';
import { FY_VERSION_HEADER } from '@ferretry/protocol';
import { daemonVersion } from '../version.ts';
import type { ApiResponse } from './http.ts';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Prometheus text exposition format, version 0.0.4 — what every scraper negotiates by default. */
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function baseHeaders(contentType: string): Map<string, string> {
  return new Map([
    ['content-type', contentType],
    // Every response carries the daemon version under the protocol-owned name, so a client can name a
    // skew instead of guessing why a route it knows about answered 404.
    [FY_VERSION_HEADER, daemonVersion],
  ]);
}

/** A JSON response. `extra` wins over the defaults so a route can set its own cache policy. */
export function jsonResponse(value: unknown, status = 200, extra: Readonly<Record<string, string>> = {}): ApiResponse {
  const headers = baseHeaders(JSON_CONTENT_TYPE);
  for (const [name, headerValue] of Object.entries(extra)) headers.set(name.toLowerCase(), headerValue);
  return { status, headers, body: JSON.stringify(value) };
}

/**
 * A JSON response whose body the caller has already spelled — for a body too large to build as a value and
 * serialise on the loop in one piece. The caller owns that it is valid JSON.
 */
export function jsonTextResponse(body: string, status = 200): ApiResponse {
  return { status, headers: baseHeaders(JSON_CONTENT_TYPE), body };
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
export function errorResponse(
  status: number,
  message: string,
  code?: string,
  extra: Readonly<Record<string, unknown>> = {},
): ApiResponse {
  return jsonResponse(code === undefined ? { ...extra, error: message } : { ...extra, error: message, code }, status);
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

/**
 * A strong validator for a body: a digest of its exact bytes, so the same answer always carries the
 * same tag — across a daemon restart too, which is when a client most wants its last read confirmed.
 *
 * It is computed over the body AS SERVED, after every redaction, for two reasons. A tag over the raw
 * evidence would let a client learn that something a redaction hides has changed, and it would match
 * across a change to the redaction itself, handing the client back a body this daemon no longer serves.
 */
export function entityTag(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url')}"`;
}

/** Whether `If-None-Match` names this tag. GET compares weakly (RFC 9110 §13.1.2), so `W/` is ignored. */
export function namesTag(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(',')
    .map(candidate => candidate.trim())
    .some(candidate => candidate === '*' || candidate.replace(/^W\//u, '') === etag);
}

/**
 * A successful response made conditional: it carries an `etag`, and a request whose `If-None-Match`
 * already names it is answered `304` with an empty body instead.
 *
 * WHY. A client that polls a large answer re-downloaded every byte of it each time, changed or not, and
 * across a metered relay that is the whole cost of watching a quiet session. A `304` is the headers
 * alone. The client keeps the body it already holds, so nothing about what it shows can differ.
 */
export function conditional(response: ApiResponse, ifNoneMatch: string | undefined): ApiResponse {
  const etag = entityTag(response.body);
  const headers = new Map(response.headers);
  headers.set('etag', etag);
  if (ifNoneMatch !== undefined && namesTag(ifNoneMatch, etag)) return { status: 304, headers, body: '' };
  return { ...response, headers };
}
/** Marks a response as never cacheable. Used for anything carrying credentials or working-tree
 *  bytes, and for the machine feeds, whose whole value is freshness. */
export function noStore(response: ApiResponse): ApiResponse {
  const headers = new Map(response.headers);
  headers.set('cache-control', 'no-store');
  return { ...response, headers };
}
