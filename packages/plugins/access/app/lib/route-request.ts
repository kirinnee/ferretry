/**
 * TODAY'S `request(path, schema, init)` OVER ACCESS'S OWN GUARDED CLIENT.
 *
 * The passkey ceremonies (`step-up-client.ts`) and the security read (`security-settings-client.ts`) were written
 * against today's protocol client: a path, a schema, a `RequestInit` with a JSON text body. In 5.0 every daemon call
 * goes through the half's own plugin client by ROUTE KEY, behind the shell's hash guard, so this turns one into the
 * other — `POST` + `/v1/step-up` is the route `POST /v1/step-up` — and nothing else: no fetch, no header but the
 * guard's, nothing kept and nothing logged (a challenge or an assertion passes through and is gone).
 *
 * A refusal comes back as today's {@link FyHttpError} (status, code, whole body), which is what the ceremony's
 * sentences read; an answer that does not parse is an error, never a guess.
 */

import type { PluginClient } from '@ferretry/kernel/manifest';
import type { z } from 'zod';
import { FyHttpError, type IFyApiClient } from '../shell-grants.ts';

/** The refusal shape the shell's client throws (`DaemonCallError`), read structurally so no class is shared. */
interface CallRefusal {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly body?: unknown;
}

const isRefusal = (reason: unknown): reason is CallRefusal =>
  reason instanceof Error &&
  typeof (reason as Partial<CallRefusal>).status === 'number' &&
  typeof (reason as Partial<CallRefusal>).code === 'string';

/** A JSON text body back to the value the route takes; no body is no body. */
const bodyOf = (body: RequestInit['body']): unknown => {
  if (body === undefined || body === null) return undefined;
  if (typeof body !== 'string') throw new TypeError('a passkey route takes a JSON text body');
  return JSON.parse(body) as unknown;
};

/** Today's request client over one daemon's Access client. */
export function routeRequestClient(client: Pick<PluginClient, 'call'>): IFyApiClient {
  return {
    async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
      const route = `${(init.method ?? 'GET').toUpperCase()} ${path}`;
      const body = bodyOf(init.body);
      let answer: unknown;
      try {
        answer = await client.call(route, body === undefined ? {} : { body });
      } catch (reason) {
        if (isRefusal(reason)) throw new FyHttpError(reason.message, reason.status, reason.code, reason.body);
        throw reason;
      }
      return schema.parse(answer);
    },
  };
}
