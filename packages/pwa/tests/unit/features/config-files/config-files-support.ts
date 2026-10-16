import type { ConfigFileView, ConfigStatusView } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import type { z } from 'zod';
import type { ConfigFilesClient } from '../../../../src/features/config-files/config-files-api.ts';
import type { ConfigFilesClientFactory } from '../../../../src/features/config-files/config-files-settings.tsx';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';

export const alpha = daemonConnection({
  daemonId: 'alpha',
  baseUrl: 'https://alpha.example.test',
  deviceId: 'fy_device_id_alpha00000000000000000',
});

export const DIRECTORY = '/home/ernest/.ferretry/config';

export const STATUS: ConfigStatusView = {
  directory: DIRECTORY,
  files: [
    { path: 'warden.yaml', kind: 'warden', schema: 'warden', state: 'invalid' },
    { path: 'machine.yaml', kind: 'machine', schema: 'machine', state: 'pending' },
    { path: 'logins/glm.yaml', kind: 'login', schema: 'login', state: 'ok' },
    { path: 'logins/claude.yaml', kind: 'login', schema: 'login', state: 'ok' },
  ],
  issues: [
    {
      path: 'warden.yaml',
      line: 3,
      column: 5,
      severity: 'error',
      message: 'intervalMinutes must be a whole number',
      fix: 'Write a number of minutes, such as 5.',
    },
    {
      path: 'warden.yaml',
      line: 7,
      severity: 'error',
      message: 'unknown key "spend"',
      fix: 'Remove it.',
    },
    {
      path: 'logins/glm.yaml',
      severity: 'warning',
      message: 'this login is not used by any runtime',
      fix: 'Name it in a runtime, or remove the file.',
    },
  ],
  pending: [
    {
      path: 'machine.yaml',
      etag: 'etag-machine-held',
      changes: ['agents may now edit Ferretry settings', 'agents skip every permission check'],
    },
  ],
  checkedAt: '2026-10-16T12:00:00.000Z',
};

export const fileView = (overrides: Partial<ConfigFileView> = {}): ConfigFileView => ({
  path: 'logins/glm.yaml',
  absolutePath: `${DIRECTORY}/logins/glm.yaml`,
  kind: 'login',
  schema: 'login',
  exists: true,
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a secret reference, exactly as a file holds one
  text: 'apiKey: ${secret:GLM_API_KEY}\n',
  etag: 'etag-glm-1',
  state: 'ok',
  issues: [],
  ...overrides,
});

interface Call {
  readonly route: string;
  readonly path: string;
  readonly headers: Headers;
  readonly body: unknown;
}

export type Handler = (call: Call) => unknown;

/** A client answering from per-route handlers (`GET /v1/config/status`), each answer parsed by the caller's schema. */
export const fakeClients = (handlers: Readonly<Record<string, Handler>>) => {
  const calls: Call[] = [];
  const client: ConfigFilesClient = {
    request: (async (path: string, schema: z.ZodType<unknown>, init?: RequestInit) => {
      const route = `${init?.method ?? 'GET'} ${path.split('?')[0] ?? path}`;
      const call: Call = {
        route,
        path,
        headers: new Headers(init?.headers),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      const handler = handlers[route];
      if (handler === undefined) throw new Error(`no handler for ${route}`);
      return schema.parse(await handler(call));
    }) as ConfigFilesClient['request'],
  };
  const createClient: ConfigFilesClientFactory = async () => client;
  return { calls, createClient };
};

/** The client's refusal, as `FyHttpError` with the parsed body a `422` carries. */
export const httpError = (message: string, status: number, code: string, body?: unknown): Error =>
  new FyHttpError(message, status, code, body);
