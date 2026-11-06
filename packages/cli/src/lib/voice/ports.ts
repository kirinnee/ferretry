import type { IFyApiClient, VoiceEngineView } from '@ferretry/protocol';

/**
 * Presentation port for the voice commands — the narrowest slice of the shipped `ConsoleIo` adapter this
 * context uses, so the production adapter satisfies it structurally.
 */
export interface IVoiceOutput {
  success(message: string): void;
  report(message: string): void;
  warn(message: string): void;
  setExitCode(code: number): void;
}

/** The daemon calls the voice commands need, with no URL or status code in sight. */
export interface IVoiceGateway {
  /** The catalog with what is installed, the runtime, and the install under way or how the last one ended. */
  status(): Promise<VoiceEngineView>;
  /** Starts installing a model (and the runtime it needs); answers at once, the download runs in the daemon. */
  install(id: string): Promise<VoiceEngineView>;
  cancel(): Promise<VoiceEngineView>;
  remove(id: string): Promise<VoiceEngineView>;
  use(id: string): Promise<VoiceEngineView>;
}

/** Time, so the install's wait for the daemon can be driven by a test. */
export interface IVoiceClock {
  sleep(milliseconds: number): Promise<void>;
}

/** The only client capability the voice gateway consumes. */
export type VoiceApiClient = Pick<IFyApiClient, 'request'>;
