import type {
  IFyApiClient,
  SecuritySettingsChange,
  SecuritySettingsPatch,
  SecuritySettingsView,
} from '@ferretry/protocol';

/** Presentation for the security commands. */
export interface ISecurityOutput {
  success(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** The daemon calls the security commands need. */
export interface ISecurityGateway {
  read(): Promise<SecuritySettingsView>;
  change(patch: SecuritySettingsPatch): Promise<SecuritySettingsChange>;
}

/** The only client capability the security gateway consumes. */
export type SecurityApiClient = Pick<IFyApiClient, 'request'>;
