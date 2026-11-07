/**
 * A scripted per-daemon client: what the shell hands a half as `client`. It records every call and answers from a
 * script, throwing `DaemonCallError` for a refusal exactly as the shell's client does.
 */
import { DaemonCallError, type UsageClient } from '../../../../app/shell.ts';

export interface RecordedCall {
  readonly route: string;
  readonly params?: Readonly<Record<string, string>> | undefined;
  readonly query?: Readonly<Record<string, string>> | undefined;
  readonly body?: unknown;
}

type Answer = unknown | ((call: RecordedCall) => unknown | Promise<unknown>);

export interface FakeClient extends UsageClient {
  readonly calls: RecordedCall[];
}

/** `routes` maps a route key (`GET /v1/usage`) to its answer, or to a function that makes one. */
export const fakeClient = (routes: Readonly<Record<string, Answer>>): FakeClient => {
  const calls: RecordedCall[] = [];
  return {
    calls,
    call: (async (route: string, init?: Omit<RecordedCall, 'route'>) => {
      const call: RecordedCall = { route, ...init };
      calls.push(call);
      if (!(route in routes)) throw new DaemonCallError(404, 'not_found', `no scripted answer for ${route}`);
      const answer = routes[route];
      return typeof answer === 'function' ? await (answer as (call: RecordedCall) => unknown)(call) : answer;
    }) as UsageClient['call'],
  };
};

/** A client whose every call is refused the way a daemon refuses. */
export const refusingClient = (status: number, code: string, message: string): UsageClient => ({
  call: (async () => {
    throw new DaemonCallError(status, code, message);
  }) as UsageClient['call'],
});
