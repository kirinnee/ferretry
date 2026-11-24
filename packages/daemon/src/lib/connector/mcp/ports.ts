/**
 * The MCP part's own seams. Shared connector seams (access, dispatch, audit, the HTTP handler) live in
 * `../ports.ts`; these are only what the tools and the endpoint need beyond them.
 */

import type { CapabilityGrants } from '@ferretry/protocol';

/** One line of the calls log: a WRITE tool call, arguments already redacted. Never a token, never a secret. */
export interface ConnectorCallRecord {
  readonly at: string;
  readonly tool: string;
  readonly grantId: string;
  /** The access token's id (first 12 hex of its digest), never the token. */
  readonly tokenId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly outcome: 'ok' | 'error' | 'refused';
}

/** Where write calls are recorded. A failure to record never fails the call (the security log still has it). */
export interface ConnectorCallsLog {
  append(record: ConnectorCallRecord): Promise<void>;
}

/**
 * What the operator has agreed remote callers may do, daemon-wide, RIGHT NOW (docs/grants.md). The listener
 * wiring supplies `grants.enforced()`. `undefined` is "cannot be determined" — which refuses, because an
 * undetermined document fails closed everywhere in this daemon.
 */
export type DaemonGrantsSource = () => CapabilityGrants | undefined;
