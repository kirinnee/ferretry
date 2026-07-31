import type {
  IFyApiClient,
  SttEnhancementRequest,
  SttEnhancementResult,
  SttModelListResponse,
  SttModelStatus,
  SttStatus,
  SttTranscript,
} from '@ferretry/protocol';

/**
 * Presentation port for the dictation commands — the narrowest slice of the shipped `ConsoleIo`
 * adapter this context uses, so the production adapter satisfies it structurally.
 */
export interface ISttOutput {
  success(message: string): void;
  warn(message: string): void;
}

/** Reading the audio file named on the command line. The only filesystem touch this group makes. */
export interface IAudioFileReader {
  /** The file's bytes, or a stated failure naming the path. */
  read(path: string): Promise<Uint8Array>;
}

/** The daemon calls the dictation commands need, with no URL or status code in sight. */
export interface ISttGateway {
  /** Whether dictation is available, and the state of the model and worker behind it. */
  status(): Promise<SttStatus>;
  /** The daemon-side and browser-side models, installed or not. */
  models(): Promise<SttModelListResponse>;
  /** Where one model's installation has got to. */
  modelStatus(modelId: string): Promise<SttModelStatus>;
  /** Begin installing a model; the daemon answers with the state the request left it in. */
  install(modelId: string): Promise<SttModelStatus>;
  /** Transcribe one clip. `contentType` tells the daemon how the bytes are encoded. */
  transcribe(audio: Uint8Array, contentType: string): Promise<SttTranscript>;
  /** Clean up a transcript through the configured enhancement provider. */
  enhance(request: SttEnhancementRequest): Promise<SttEnhancementResult>;
}

/** The only client capability the dictation gateway consumes. */
export type SttApiClient = Pick<IFyApiClient, 'request'>;
