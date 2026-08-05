import type { IFyApiClient, SttEnhancementRequest, SttEnhancementResult } from '@ferretry/protocol';

/**
 * Presentation port for the dictation command — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally.
 */
export interface ISttOutput {
  success(message: string): void;
}

/** The daemon call the dictation command needs, with no URL or status code in sight. */
export interface ISttGateway {
  /** Clean up a transcript through the configured enhancement provider. */
  enhance(request: SttEnhancementRequest): Promise<SttEnhancementResult>;
}

/** The only client capability the dictation gateway consumes. */
export type SttApiClient = Pick<IFyApiClient, 'request'>;
