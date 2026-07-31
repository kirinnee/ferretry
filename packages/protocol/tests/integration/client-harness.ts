import { FyApiClient } from '../../src/adapters/fy-api-client.ts';
import type { FyClientOptions } from '../../src/lib/client.ts';
import { QueuedEventTransport, type QueuedHttpTransport } from './fakes.ts';

/** The trailing slashes prove normalization; every expected URL is built from BASE_URL. */
export const BASE_CLIENT_OPTIONS = {
  baseUrl: 'http://daemon.test/api///',
  token: 'secret-token',
  version: '1.2.3',
} satisfies Pick<FyClientOptions, 'baseUrl' | 'token' | 'version'>;

export const BASE_URL = 'http://daemon.test/api';

export const connectClient = (
  transport: QueuedHttpTransport,
  options: Partial<FyClientOptions> = {},
): Promise<FyApiClient> =>
  FyApiClient.connect({
    ...BASE_CLIENT_OPTIONS,
    transport,
    eventTransport: new QueuedEventTransport(),
    requestId: () => 'request-1',
    sleep: async () => undefined,
    ...options,
  });

export const headersOf = (transport: QueuedHttpTransport, index = 0): Headers =>
  new Headers(transport.calls[index]?.init.headers);

export const jsonBodyOf = (transport: QueuedHttpTransport, index = 0): unknown =>
  JSON.parse(String(transport.calls[index]?.init.body));
