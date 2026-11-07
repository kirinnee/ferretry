/**
 * Fixtures for the MCP sign-in suites, typed as the shared contract and written out longhand: a fixture
 * derived from the schema could never fail on the day the daemon's answer changes shape.
 *
 * Every address here is a fake: `fixture-state` is not a real single-use state, and the code is a word.
 */

import type { McpOAuthCompletion, McpOAuthConnection, McpOAuthFlow } from '@ferretry/protocol';
import type { z } from 'zod';
import type { FleetClient, FleetClientFactory } from '../../../../src/features/fleet/fleet-client.ts';
import type {
  McpSignInChannel,
  McpSignInChannelFactory,
} from '../../../../src/features/fleet/components/mcp-sign-in-sheet.tsx';

export const NOW = Date.parse('2026-10-16T10:00:00.000Z');

export const AUTHORIZE_URL =
  'https://auth.linear.example/authorize?response_type=code&client_id=fy&code_challenge=abc&code_challenge_method=S256&state=fixture-state';
export const CALLBACK = 'https://pwa.example.test/oauth/mcp-callback?code=fixture-code&state=fixture-state';
export const OTHER_CALLBACK = 'https://pwa.example.test/oauth/mcp-callback?code=fixture-code&state=another-state';

export const mcpFlow = (overrides: Partial<McpOAuthFlow> = {}): McpOAuthFlow => ({
  flowId: 'mcp-flow-one',
  component: 'linear',
  authorizeUrl: AUTHORIZE_URL,
  mode: 'pwa',
  redirectUri: 'https://pwa.example.test/oauth/mcp-callback',
  issuer: 'auth.linear.example',
  expiresAt: '2026-10-16T10:10:00.000Z',
  ...overrides,
});

export const SECRETS = ['MCP_LINEAR_1A2B3C4D_ACCESS', 'MCP_LINEAR_1A2B3C4D_REFRESH'] as const;

export const mcpConnection = (overrides: Partial<McpOAuthConnection> = {}): McpOAuthConnection => ({
  component: 'linear',
  state: 'signed-in',
  issuer: 'https://auth.linear.example',
  signedInAt: '2026-10-16T09:00:00.000Z',
  expiresAt: '2026-10-16T10:59:00.000Z',
  renewable: true,
  secrets: [...SECRETS],
  ...overrides,
});

export const completion = (connection: McpOAuthConnection = mcpConnection()): McpOAuthCompletion => ({
  component: connection.component,
  connection,
});

export interface Call {
  readonly path: string;
  readonly method: string;
  readonly body: unknown;
}

/** One answer per `METHOD path`: a value, an Error to throw, or a function of the call. */
export type Answers = Record<string, unknown>;

/** A client that answers by `METHOD path`, recording every call; an unscripted call fails like a dead machine. */
export const scriptedMcpClient = (answers: Answers, calls: Call[] = []): FleetClient => ({
  request: async <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
    const method = init?.method ?? 'GET';
    calls.push({ path, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const key = `${method} ${path}`;
    if (!(key in answers)) throw new Error(`no route ${key}`);
    const answer = answers[key];
    const value = typeof answer === 'function' ? (answer as (calls: Call[]) => unknown)(calls) : answer;
    if (value instanceof Error) throw value;
    return schema.parse(await value);
  },
});

export const factoryFor =
  (answers: Answers, calls: Call[] = []): FleetClientFactory =>
  async () =>
    scriptedMcpClient(answers, calls);

/** A same-origin channel pair a test drives: what the sheet posted, and a way to deliver a message to it. */
export interface FakeChannel extends McpSignInChannel {
  readonly name: string;
  readonly posted: unknown[];
  closed: boolean;
  deliver(data: unknown): void;
}

export const fakeChannels = (): { factory: McpSignInChannelFactory; opened: FakeChannel[] } => {
  const opened: FakeChannel[] = [];
  const factory: McpSignInChannelFactory = name => {
    const channel: FakeChannel = {
      name,
      posted: [],
      closed: false,
      onmessage: null,
      postMessage(message) {
        this.posted.push(message);
      },
      close() {
        this.closed = true;
      },
      deliver(data) {
        this.onmessage?.(new MessageEvent('message', { data }));
      },
    };
    opened.push(channel);
    return channel;
  };
  return { factory, opened };
};
