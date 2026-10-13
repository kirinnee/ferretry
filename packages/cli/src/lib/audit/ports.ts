import type { AuditView, IFyApiClient } from '@ferretry/protocol';

/** Presentation for `fy daemon audit`. */
export interface IAuditOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** The one daemon call the audit command needs. */
export interface IAuditGateway {
  /** The most recent security records, newest first. */
  read(limit: number): Promise<AuditView>;
}

/** The only client capability the audit gateway consumes. */
export type AuditApiClient = Pick<IFyApiClient, 'request'>;
