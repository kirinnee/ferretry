/**
 * Fixtures for the connector's app suites, written out longhand and typed as the contract: a fixture derived from the
 * schema could never fail on the day the daemon's answer changes shape. Every code, id and host here is fake.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import type { ConnectorGrantView, ConnectorPendingView, ConnectorStatus } from '../../../contract/index.ts';

export const NOW = Date.parse('2026-11-25T20:00:00.000Z');
const ago = (minutes: number): Instant => instantFromEpochMs(NOW - minutes * 60_000);

export const pendingView = (overrides: Partial<ConnectorPendingView> = {}): ConnectorPendingView => ({
  id: 'cr_abcde23456',
  matchCode: 'K7Q-2MF',
  clientName: 'Claude',
  redirectHost: 'claude.example',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: ago(2),
  expiresAt: instantFromEpochMs(NOW + 8 * 60_000),
  ...overrides,
});

export const grantView = (overrides: Partial<ConnectorGrantView> = {}): ConnectorGrantView => ({
  id: 'cg_abcde23456',
  clientName: 'Claude',
  redirectHost: 'claude.example',
  scopes: ['fleet:read', 'fleet:write'],
  createdAt: ago(60 * 26),
  approvedBy: 'device:dev_fixture',
  lastUsedAt: ago(5),
  ...overrides,
});

/** Switched off: nothing answers, and the daemon says why. */
export const OFF: ConnectorStatus = {
  enabled: false,
  switchedOn: false,
  disabledReason: 'Switch it on in Settings › Claude connector.',
  pending: [],
  grants: [],
};

/** On at the owner's own address. */
export const ON: ConnectorStatus = {
  enabled: true,
  switchedOn: true,
  publicUrlSource: 'configured',
  publicUrl: 'https://ferretry.example',
  mcpUrl: 'https://ferretry.example/mcp',
  pending: [],
  grants: [],
};

/** On over the built-in tunnel, whose hostname is not known yet. */
export const WAITING_FOR_TUNNEL: ConnectorStatus = {
  enabled: false,
  switchedOn: true,
  publicUrlSource: 'tunnel',
  disabledReason: 'Waiting for the tunnel to get its hostname.',
  pending: [],
  grants: [],
};

export interface Call {
  readonly route: string;
  readonly params: Readonly<Record<string, string>> | undefined;
  readonly body: unknown;
}

/** One answer per route key: a value, an Error to throw, or a function of the call. */
export type Answers = Record<string, unknown>;

/** A client that answers by route key, recording every call; an unscripted call fails like a dead machine. */
export const scriptedClient = (answers: Answers, calls: Call[] = []): Pick<PluginClient, 'call'> => ({
  call: async <Answer = unknown>(
    route: string,
    init?: { readonly params?: Readonly<Record<string, string>>; readonly body?: unknown },
  ): Promise<Answer> => {
    const call: Call = { route, params: init?.params, body: init?.body };
    calls.push(call);
    if (!(route in answers)) throw new Error(`no route ${route}`);
    const answer = answers[route];
    const value = typeof answer === 'function' ? (answer as (call: Call) => unknown)(call) : answer;
    if (value instanceof Error) throw value;
    return (await value) as Answer;
  },
});

/** A refusal the way the shell's client throws one: a status and the daemon's code and sentence. */
export const refusal = (status: number, code: string, message: string): Error =>
  Object.assign(new Error(message), { status, code });
