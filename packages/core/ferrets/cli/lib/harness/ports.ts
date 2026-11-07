import type { IFyApiClient } from '@ferretry/protocol';

/** The two harness-update calls the protocol client already owns and validates. */
export type IHarnessUpdateGateway = Pick<IFyApiClient, 'harnessUpdate' | 'startHarnessUpdate'>;

/** Terminal output used by `fy harness`. */
export interface IHarnessOutput {
  report(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Asking a person a question at a terminal. */
export interface IHarnessPrompt {
  ask(message: string): Promise<string>;
}

/** Waiting between reads while an update runs. */
export type HarnessWait = (milliseconds: number) => Promise<void>;
