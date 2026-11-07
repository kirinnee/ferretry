import { type ApiResponse, headersFrom, queryFrom, type RouteHandler } from '@ferretry/kernel/contract';
import { localArrival } from '@ferretry/kernel/host';

/**
 * Calls one route handler the way the dispatcher does after admission: the matched key's `:params` raw, a request that
 * arrived on the host, and whatever standing the test names. Admission, grants and step-up are Gate's and tested there.
 */
export async function call(
  routes: Readonly<Record<string, RouteHandler>>,
  key: string,
  init: { readonly path?: string; readonly body?: unknown; readonly governance?: unknown } = {},
): Promise<ApiResponse> {
  const [method = 'GET', pattern = '/'] = key.split(' ');
  const path = init.path ?? pattern;
  const params = new Map<string, string>();
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  patternParts.forEach((part, index) => {
    if (part.startsWith(':')) params.set(part.slice(1), pathParts[index] ?? '');
  });
  const handler = routes[key];
  if (handler === undefined) throw new Error(`no route ${key}`);
  const text = init.body === undefined ? '' : JSON.stringify(init.body);
  return await handler({
    request: {
      method,
      path,
      query: queryFrom([]),
      headers: headersFrom({ 'content-type': 'application/json' }),
      arrival: localArrival(true),
      text: async () => text,
    },
    params,
    ...(init.governance === undefined ? {} : { governance: init.governance }),
  } as never);
}
