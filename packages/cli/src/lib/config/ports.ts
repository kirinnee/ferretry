import type { AcceptedConfigFiles, ConfigFileText } from '@ferretry/fleet';
import type {
  ConfigConfirmResult,
  ConfigFilePutResult,
  ConfigFileView,
  ConfigStatusView,
  IFyApiClient,
} from '@ferretry/protocol';

/** Where `fy config` writes: the narrow slice of the console it needs. */
export interface IConfigOutput {
  success(message: string): void;
  setExitCode(code: number): void;
}

/**
 * The configuration directory, read WITHOUT a daemon — so `fy config check` works on a machine whose
 * daemon is stopped, and an agent can check its own edit before anything else reads it.
 */
export interface IConfigFiles {
  /** `<state home>/config`, absolute. */
  readonly directory: string;
  /** Every config file, read when it is an ordinary file of a sensible size, otherwise named. */
  list(): Promise<{ readonly files: readonly ConfigFileText[]; readonly unreadable: readonly string[] }>;
  /** The daemon's accepted record, read only; empty when there is none yet. */
  accepted(): Promise<AcceptedConfigFiles>;
}

/** The daemon calls `fy config` makes: the view in effect, one file, a checked write, the owner's confirmation. */
export interface IConfigGateway {
  status(): Promise<ConfigStatusView>;
  file(path: string): Promise<ConfigFileView>;
  /** Refused whole (`422 config_invalid`, with the located issues) unless the text checks. */
  write(path: string, text: string, ifMatch: string | undefined): Promise<ConfigFilePutResult>;
  confirm(path: string, etag: string): Promise<ConfigConfirmResult>;
}

/** Where `fy config write` reads the file's new text from: standard input, whole. */
export interface IConfigInput {
  read(): Promise<string>;
}

/** The only client capability the gateway consumes. */
export type ConfigApiClient = Pick<IFyApiClient, 'request'>;
