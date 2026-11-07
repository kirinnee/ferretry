/**
 * A {@link PluginClient} over a {@link TestHost}: a half's CLI or app code can be driven against the daemon half under
 * test. `call` and `conditional` take a route key (`'GET /v1/ferrets/:id'`) and its params; `conditional` sends
 * `If-None-Match` and maps the answer to `200` with its etag or `304`. Events and sockets are the test host's own.
 */
import type { Cancel } from '../contract/ports.ts';
import type { PluginClient, PluginConditionalAnswer } from '../manifest/implement.ts';
import type { TestCaller } from './admission.ts';
import type { TestHost } from './host.ts';

function pathOf(key: string, params: Readonly<Record<string, string>> = {}): { method: string; path: string } {
  const [method, pattern] = key.split(' ') as [string, string];
  const path = pattern.replace(/:([A-Za-z0-9_]+)/gu, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new TypeError(`${key}: no value for :${name}`);
    return encodeURIComponent(value);
  });
  return { method, path };
}

export function testPluginClient(host: TestHost, as?: TestCaller): PluginClient {
  return {
    async call(route, init = {}) {
      const { method, path } = pathOf(route, init.params);
      const response = await host.request(method, path, {
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.query === undefined ? {} : { query: init.query }),
        ...(init.headers === undefined ? {} : { headers: { ...init.headers } as Record<string, string> }),
        ...(as === undefined ? {} : { as }),
      });
      if (response.status >= 400) throw new Error(`${route} answered ${String(response.status)}: ${response.body}`);
      return (response.body === '' ? undefined : response.json()) as never;
    },
    subscribe(): Cancel {
      return () => undefined;
    },
    async conditional(key, params, init = {}): Promise<PluginConditionalAnswer> {
      const { method, path } = pathOf(key, params);
      const headers: Record<string, string> = { ...((init.headers ?? {}) as Record<string, string>) };
      if (init.ifNoneMatch !== undefined) headers['if-none-match'] = init.ifNoneMatch;
      const response = await host.request(method, path, { headers, ...(as === undefined ? {} : { as }) });
      const etag = response.headers.get('etag');
      if (response.status === 304) return etag === undefined ? { status: 304 } : { status: 304, etag };
      if (response.status !== 200) throw new Error(`${key} answered ${String(response.status)}: ${response.body}`);
      const body = response.body === '' ? undefined : response.json();
      return etag === undefined ? { status: 200, body } : { status: 200, etag, body };
    },
  };
}
