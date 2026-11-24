import type { ConnectorGrantView, ConnectorPendingView, ConnectorStatus, IFyApiClient } from '@ferretry/protocol';

/** Presentation for the connector commands. */
export interface IConnectorOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/**
 * The daemon calls the connector commands need. Each takes what the person typed — an id or a match code for a
 * sign-in, a grant id for a grant — and leaves what it means to the daemon.
 */
export interface IConnectorGateway {
  status(): Promise<ConnectorStatus>;
  approve(idOrMatchCode: string): Promise<ConnectorGrantView>;
  deny(idOrMatchCode: string): Promise<ConnectorPendingView>;
  revoke(grantId: string): Promise<ConnectorGrantView>;
}

/** The only client capability the connector gateway consumes. */
export type ConnectorApiClient = Pick<IFyApiClient, 'request'>;
