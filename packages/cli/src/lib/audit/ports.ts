import type { AuditView, IFyApiClient } from '@ferretry/protocol';

/** Presentation for `fy daemon audit`. */
export interface IAuditOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** The one daemon call the audit command needs. */
export interface IAuditGateway {
  /** The most recent activity and a page of the security changes from `keptOffset`, each newest first. */
  read(limit: number, keptOffset?: number): Promise<AuditView>;
}

/** The only client capability the audit gateway consumes. */
export type AuditApiClient = Pick<IFyApiClient, 'request'>;
