/**
 * The MCP part's own seams. The shared connector seams (access, audit, the HTTP handler) live in `../ports.ts`; these are
 * only what the tools and the endpoint need beyond them. This file decides nothing.
 */
import type { CapabilityGrants } from '@ferretry/core-gate/contract';
import type { DelegatePort } from '@ferretry/kernel/contract';
import type { ConnectorToolOutcome } from '../../../contract/index.ts';

export type { ConnectorToolOutcome };

/** One line of the calls log: a WRITE tool call, arguments already redacted. Never a token, never a secret. */
export interface ConnectorCallRecord {
  readonly at: string;
  readonly tool: string;
  readonly grantId: string;
  /** The access token's id (first 12 hex of its digest), never the token. */
  readonly tokenId: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly outcome: ConnectorToolOutcome;
}

/** Where write calls are recorded. A failure to record never fails the call (the security log still has it). */
export interface ConnectorCallsLog {
  append(record: ConnectorCallRecord): Promise<void>;
}

/**
 * What the operator has agreed remote callers may do, daemon-wide, RIGHT NOW (docs/grants.md). `undefined` is "cannot be
 * determined" — which refuses, because an undetermined document fails closed everywhere in this daemon.
 */
export type DaemonGrantsSource = () => CapabilityGrants | undefined;

/** The tools' only way to the daemon: the kernel's delegated dispatch (U2), through the real routes and Gate every time. */
export type ConnectorDelegate = Pick<DelegatePort, 'call'>;

/** Whether the connector is on RIGHT NOW. Asked again before every delegated call, so an off stops a request in flight (S17). */
export type ConnectorServing = () => boolean;
