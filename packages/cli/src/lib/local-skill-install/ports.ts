import type { IFyApiClient } from '@ferretry/protocol';

/** The four local-copy calls the protocol client already owns and validates. */
export type ILocalSkillInstallGateway = Pick<
  IFyApiClient,
  'previewLocalSkillInstall' | 'applyLocalSkillInstall' | 'localSkillInstalls' | 'removeLocalSkillInstall'
>;

/** Terminal output used by `fy skill install`. */
export interface ILocalSkillInstallOutput {
  report(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Uncoloured stderr for JSON evidence (the preview) that must not corrupt the final stdout payload. */
  diagnostic(message: string): void;
  setExitCode(code: number): void;
}

/** Asking a person a question at a terminal. */
export interface ILocalSkillInstallPrompt {
  ask(message: string): Promise<string>;
}
