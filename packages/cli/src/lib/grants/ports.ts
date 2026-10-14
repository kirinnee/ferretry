import type { GrantAuditView, GrantsPatch, GrantsView, IFyApiClient } from '@ferretry/protocol';

/** Presentation for the grant commands. */
export interface IGrantOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** The daemon calls the grant commands need. */
export interface IGrantGateway {
  read(): Promise<GrantsView>;
  /** Who changed what, newest first. */
  history(): Promise<GrantAuditView>;
  change(patch: GrantsPatch): Promise<GrantsView>;
}

/** The only client capability the grant gateway consumes. */
export type GrantApiClient = Pick<IFyApiClient, 'request'>;
