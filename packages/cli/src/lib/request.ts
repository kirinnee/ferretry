/** Turns a route key and the caller's `{ params, query, body }` into a daemon request. Pure. */
import { parseRouteKey } from '@ferretry/kernel/contract';
import { EXIT, ShellError } from './errors.ts';

export interface DaemonRequest {
  readonly method: string;
  /** Path and query string, already encoded. */
  readonly path: string;
  readonly body?: unknown;
}

export interface CallInit {
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/**
 * A parameter fills one path segment, so one that is `.` or `..` (a dot segment the URL parser would resolve to a
 * different route) or that holds a `/` is refused rather than filled.
 */
const isSafePathParam = (value: string): boolean => value !== '.' && value !== '..' && !value.includes('/');

/** `GET /v1/cards/:id` with `{ id: 'c 1' }` becomes `GET /v1/cards/c%201`. A missing, unused or unsafe parameter is a bug. */
export function buildRequest(routeKey: string, init: CallInit = {}): DaemonRequest {
  const { method, path } = parseRouteKey(routeKey);
  const params = init.params ?? {};
  const used = new Set<string>();
  const filled = path.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new ShellError(`${routeKey} needs the parameter "${name}"`, EXIT.usage);
    if (!isSafePathParam(value))
      throw new ShellError(`${routeKey}: the parameter "${name}" cannot be "." or ".." or hold a "/"`, EXIT.usage);
    used.add(name);
    return encodeURIComponent(value);
  });
  for (const name of Object.keys(params))
    if (!used.has(name)) throw new ShellError(`${routeKey} has no parameter "${name}"`, EXIT.usage);
  const query = new URLSearchParams(init.query ?? {}).toString();
  return {
    method,
    path: query === '' ? filled : `${filled}?${query}`,
    ...(init.body === undefined ? {} : { body: init.body }),
  };
}

/** A read, or a request whose repeat changes nothing: the only kind a dropped connection may be sent again. */
export const isRepeatable = (method: string): boolean => method === 'GET' || method === 'HEAD';

/** The sentence a daemon refusal carries: its `error`, else the status. */
export function refusalText(status: number, body: unknown): { readonly message: string; readonly code?: string } {
  if (typeof body === 'object' && body !== null) {
    const { error, code } = body as { error?: unknown; code?: unknown };
    if (typeof error === 'string') return typeof code === 'string' ? { message: error, code } : { message: error };
  }
  return { message: `the daemon answered HTTP ${String(status)}` };
}
