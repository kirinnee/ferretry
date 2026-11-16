/**
 * A scripted client for the suites that were written against a fetcher. The half calls its daemon by route key
 * (`client.call('GET /v1/ferrets/:ferretId/agenda', { params })`); this turns each call into the request a fetcher
 * would have seen — the route's method, its path with the parameters filled in and encoded, the query, the JSON body
 * and the headers — and reads the fetcher's answer back the way the shell's client does: a 2xx body is the value, any
 * other status is a refusal carrying `status`, `code` and the daemon's message.
 *
 * The URL is on a fixed test origin ({@link CALL_ORIGIN}); nothing is ever sent anywhere.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';

const CALL_ORIGIN = 'https://daemon.test';

export type TestFetch = (input: string, init: RequestInit) => Promise<Response>;

type CallInit = NonNullable<Parameters<PluginClient['call']>[1]>;

/** One recorded call: its route key and what it carried. */
export interface RecordedCall {
  readonly route: string;
  readonly init: CallInit;
}

/** The refusal shape the shell's client throws. */
class CallRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CallRefusal';
  }
}

/** The request a route key and its parameters name. */
export const requestOf = (
  route: string,
  init: CallInit = {},
  origin: string = CALL_ORIGIN,
): { readonly url: string; readonly init: RequestInit } => {
  const [method = 'GET', template = '/'] = route.split(' ');
  const params = (init.params ?? {}) as Readonly<Record<string, string>>;
  const path = template.replace(/:([A-Za-z]+)/gu, (_, name: string) => encodeURIComponent(params[name] ?? ''));
  const query = new URLSearchParams(
    Object.entries((init.query ?? {}) as Readonly<Record<string, unknown>>).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  ).toString();
  const headers = new Headers(init.headers as HeadersInit | undefined);
  const body = init.body === undefined ? undefined : JSON.stringify(init.body);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return {
    url: `${origin}${path}${query === '' ? '' : `?${query}`}`,
    init: { method, headers, ...(body === undefined ? {} : { body }) },
  };
};

/** A client whose every call is answered by `fetcher` (on `origin`); `calls` records each route key in order. */
export const callFromFetch = (
  fetcher: TestFetch,
  origin: string = CALL_ORIGIN,
): Pick<PluginClient, 'call'> & { readonly calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  return {
    calls,
    call: (async (route: string, init: CallInit = {}) => {
      calls.push({ route, init });
      const request = requestOf(route, init, origin);
      const response = await fetcher(request.url, request.init);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
        throw new CallRefusal(
          response.status,
          typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
          typeof body.code === 'string' ? body.code : undefined,
        );
      }
      const text = await response.text();
      return text === '' ? undefined : JSON.parse(text);
    }) as PluginClient['call'],
  };
};
