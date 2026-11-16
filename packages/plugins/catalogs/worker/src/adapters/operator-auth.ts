/**
 * The hosted deployment's operator bearer, checked in one place for every `/v1/operator/*` route.
 *
 * The bearer is a Worker secret derived by the deploy workflow; comparing it in constant time and
 * answering an unset secret with 503 rather than 401 is the whole contract, and two copies of it is
 * how one route ends up compared with `===`.
 */

import { bytesEqual, utf8Bytes } from '../lib/index.ts';

/** Null when the request carries the operator bearer; otherwise the answer to send instead. */
export function operatorRefusal(request: Request, token: string | undefined): Response | null {
  if (token === undefined || token === '') {
    return operatorJson({ error: 'relay operator authentication is not configured' }, 503);
  }
  const authorization = request.headers.get('Authorization') ?? '';
  const supplied = authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : '';
  if (bytesEqual(utf8Bytes(supplied), utf8Bytes(token))) return null;
  return operatorJson({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
}

function operatorJson(value: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      ...headers,
    },
  });
}
