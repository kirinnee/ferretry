import type { IFyApiClient } from '@ferretry/protocol';

type Handler = (body: unknown) => unknown;

interface FakeCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

/** A client that answers `METHOD /path` from `handlers` and records each call. An unlisted route fails the test. */
export function fakeClient(handlers: Readonly<Record<string, Handler>>) {
  const calls: FakeCall[] = [];
  const client = {
    request: async (path: string, _schema: unknown, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const handler = handlers[`${method} ${path}`];
      if (handler === undefined) throw new Error(`unexpected request ${method} ${path}`);
      return await handler(body);
    },
  } as unknown as Pick<IFyApiClient, 'request'>;
  return { client, calls, factory: async () => client };
}
