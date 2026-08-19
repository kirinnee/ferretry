import type { GrantAuditView, GrantsPatch, GrantsView, IFyApiClient } from '@ferretry/protocol';

/** Presentation for the grant commands. */
export interface IGrantOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/**
 * Where an operator password comes from.
 *
 * NEVER ARGV. A password on the command line is in the shell history of whoever typed it and in
 * `/proc/<pid>/cmdline` for every account on the box for as long as the command runs — which is
 * exactly the disclosure this password exists to prevent. So it arrives on stdin, and the flag that
 * would accept it as an argument does not exist. This is the same rule `fy secret set` follows, for
 * the same reason.
 */
export interface IOperatorPasswordSource {
  read(): Promise<string>;
}

/**
 * The daemon calls the grant commands need.
 *
 * NOTE WHAT IS MISSING: there is no way to READ a password. The daemon serves no route that could
 * answer one, so there is nothing here to call.
 */
export interface IGrantGateway {
  read(): Promise<GrantsView>;
  /** Who changed what, newest first. */
  history(): Promise<GrantAuditView>;
  change(patch: GrantsPatch, unlock?: string): Promise<GrantsView>;
  /** Trades the operator password for a short-lived unlock. */
  unlock(password: string): Promise<string>;
  /**
   * Sets or replaces the operator password. There is no companion that removes one.
   *
   * SETTING IT IS ONE-WAY, and the missing verb is the point rather than an omission: removing a
   * password revokes nothing, so a machine that had paired devices would keep them and lose the only
   * thing standing behind them. Replacing never asks for the old one, which is what keeps a forgotten
   * password a repair rather than a lockout.
   */
  setPassword(password: string): Promise<boolean>;
}

/** The only client capability the grant gateway consumes. */
export type GrantApiClient = Pick<IFyApiClient, 'request'>;
