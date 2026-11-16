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

/**
 * A literal request line against the route templates a plugin declares (`DELETE /v1/pair/devices/:deviceId`): the
 * template that matches segment for segment, with what its parameters were, or `undefined` when none does.
 */
function matchTemplate(
  line: string,
  templates: readonly string[],
): { readonly route: string; readonly params: Record<string, string> } | undefined {
  const [method = '', path = ''] = line.split(' ');
  const actual = path.split('/');
  for (const template of templates) {
    const [templateMethod = '', templatePath = ''] = template.split(' ');
    const pattern = templatePath.split('/');
    if (templateMethod !== method || pattern.length !== actual.length) continue;
    const params: Record<string, string> = {};
    const fits = pattern.every((part, index) => {
      const got = actual[index] ?? '';
      if (!part.startsWith(':')) return part === got;
      try {
        params[part.slice(1)] = decodeURIComponent(got);
        return got !== '';
      } catch {
        return false;
      }
    });
    if (fits) return { route: template, params };
  }
  return undefined;
}

/**
 * Today's request client over one daemon's Access client. `templates` are the route keys with parameters the caller
 * reaches by a literal path (`/v1/pair/devices/abc`); a path no template names is called as written.
 */
export function routeRequestClient(
  client: Pick<PluginClient, 'call'>,
  templates: readonly string[] = [],
): IFyApiClient {
  return {
    async request<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
      // A query string is not part of the route key: it rides as the call's `query`.
      const [pathOnly = path, search = ''] = path.split('?', 2);
      const line = `${(init.method ?? 'GET').toUpperCase()} ${pathOnly}`;
      const matched = matchTemplate(line, templates);
      const route = matched?.route ?? line;
      const body = bodyOf(init.body);
      const query = Object.fromEntries(new URLSearchParams(search));
      let answer: unknown;
      try {
        answer = await client.call(route, {
          ...(matched === undefined ? {} : { params: matched.params }),
          ...(search === '' ? {} : { query }),
          ...(body === undefined ? {} : { body }),
        });
      } catch (reason) {
        if (isRefusal(reason)) throw new FyHttpError(reason.message, reason.status, reason.code, reason.body);
        throw reason;
      }
      return schema.parse(answer);
    },
  };
}
