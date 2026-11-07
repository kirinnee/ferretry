/**
 * A scripted per-daemon client for the app suites: `route key` -> answer. A route with no answer fails like an
 * unreachable daemon; an `Error` answer is thrown; a function answer is called with the call and may be async.
 */

import type { RuntimesClient } from '../../../../app/lib/client.ts';

export interface Call {
  readonly route: string;
  readonly params: Readonly<Record<string, string>> | undefined;
  readonly query: Readonly<Record<string, string>> | undefined;
  readonly body: unknown;
}

export type Route = unknown | Error | ((call: Call) => unknown);

export const scripted = (routes: Readonly<Record<string, Route>>, calls: Call[] = []): RuntimesClient => ({
  call: async <Answer = unknown>(
    route: string,
    init?: {
      readonly params?: Readonly<Record<string, string>>;
      readonly query?: Readonly<Record<string, string>>;
      readonly body?: unknown;
    },
  ): Promise<Answer> => {
    const call: Call = { route, params: init?.params, query: init?.query, body: init?.body };
    calls.push(call);
    // A script may key a route by its concrete path (`POST /v1/x/abc/apply`) or by the template the half called.
    const concrete = route.replace(/:(\w+)/gu, (_, name: string) => init?.params?.[name] ?? `:${name}`);
    const key = concrete in routes ? concrete : route;
    if (!(key in routes)) throw new Error(`no route ${route}`);
    const answer = routes[key];
    const value = typeof answer === 'function' ? await (answer as (call: Call) => unknown)(call) : answer;
    if (value instanceof Error) throw value;
    return value as Answer;
  },
});
