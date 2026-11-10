/**
 * Fixtures for MCP's app suites, typed as the contract and written out longhand: a fixture derived from the schema
 * could never fail on the day the daemon's answer changes shape. Every address here is fake: `fixture-state` is not a
 * real single-use state, and the code is a word.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type McpInventory,
  McpInventorySchema,
  type McpInventoryServer,
  type McpOAuthCompletion,
  type McpOAuthConnection,
  type McpOAuthFlow,
} from '../../../contract/index.ts';
import type { McpSignInChannel, McpSignInChannelFactory } from '../../../app/views/sign-in-sheet.tsx';

export const NOW = Date.parse('2026-10-16T10:00:00.000Z');

export const AUTHORIZE_URL =
  'https://auth.linear.example/authorize?response_type=code&client_id=fy&code_challenge=abc&code_challenge_method=S256&state=fixture-state';
export const CALLBACK = 'https://pwa.example.test/oauth/mcp-callback?code=fixture-code&state=fixture-state';
export const OTHER_CALLBACK = 'https://pwa.example.test/oauth/mcp-callback?code=fixture-code&state=another-state';
export const REDIRECT = 'https://pwa.example.test/oauth/mcp-callback';

export const mcpFlow = (overrides: Partial<McpOAuthFlow> = {}): McpOAuthFlow => ({
  flowId: 'mcp-flow-one',
  component: 'linear',
  authorizeUrl: AUTHORIZE_URL,
  mode: 'pwa',
  redirectUri: REDIRECT,
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

export const mcpServer = (overrides: Partial<McpInventoryServer> & { name: string }): McpInventoryServer => ({
  id: `id-${overrides.name}-${overrides.scope ?? 'component'}`,
  scope: 'component',
  harness: 'claude-code',
  transport: 'http',
  target: `https://${overrides.name}.example/mcp`,
  runtimes: [{ runtime: 'claude-work' }],
  ...overrides,
});

export const MCP: McpInventory = McpInventorySchema.parse({
  problems: [],
  servers: [
    mcpServer({ name: 'ferretry', scope: 'ferretry', transport: 'stdio', target: 'fy mcp serve' }),
    mcpServer({ name: 'github', scope: 'user', transport: 'stdio', target: 'npx', source: '/fy/home/.claude.json' }),
    mcpServer({
      name: 'linear',
      signIn: { subject: 'linear', required: true },
      connection: {
        component: 'linear',
        state: 'signed-in',
        issuer: 'https://auth.linear.example',
        expiresAt: '2026-10-23T10:00:00.000Z',
        renewable: true,
        secrets: [],
      },
    }),
    mcpServer({
      name: 'notion',
      scope: 'project',
      source: '/work/app/.mcp.json',
      project: { root: '/work/app' },
      runtimes: [{ runtime: 'claude-work', approval: 'approved' }],
      signIn: { subject: 'notion..a1b2c3d4e5f6', required: false },
    }),
    mcpServer({
      name: 'lint',
      scope: 'project',
      transport: 'stdio',
      target: 'npx',
      source: '/work/app/.mcp.json',
      project: { root: '/work/app' },
      runtimes: [{ runtime: 'claude-work', approval: 'pending' }],
    }),
    mcpServer({ name: 'scratch', scope: 'local', transport: 'stdio', target: 'node', project: { root: '/work/app' } }),
  ],
});

// ── A scripted client ────────────────────────────────────────────────────────────────────────────

export interface Call {
  readonly route: string;
  readonly params: Readonly<Record<string, string>> | undefined;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/** One answer per route key: a value, an Error to throw, or a function of the call. */
export type Answers = Record<string, unknown>;

export type ScriptedClient = Pick<PluginClient, 'call'>;

/** A client that answers by route key, recording every call; an unscripted call fails like a dead machine. */
export const scriptedClient = (answers: Answers, calls: Call[] = []): ScriptedClient => ({
  call: async <Answer = unknown>(
    route: string,
    init?: {
      readonly params?: Readonly<Record<string, string>>;
      readonly body?: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<Answer> => {
    const call: Call = { route, params: init?.params, body: init?.body, headers: init?.headers };
    calls.push(call);
    if (!(route in answers)) throw new Error(`no route ${route}`);
    const answer = answers[route];
    const value = typeof answer === 'function' ? (answer as (call: Call) => unknown)(call) : answer;
    if (value instanceof Error) throw value;
    return (await value) as Answer;
  },
});

// ── A same-origin channel ────────────────────────────────────────────────────────────────────────

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
