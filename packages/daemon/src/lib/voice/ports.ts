import type {
  VoiceFailureCode,
  VoiceRecognizerDescription,
  VoiceRecognizerSet,
  VoiceWorkerRequest,
  VoiceWorkerResponse,
} from './ipc.ts';

export type VoiceOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: VoiceFailureCode; readonly message: string };
export interface VoiceClock {
  after(milliseconds: number, callback: () => void): { cancel(): void };
}
export interface VoiceWorkerHandle {
  send(message: VoiceWorkerRequest): void;
  /** Must kill and await the real child before a replacement is permitted. */
  stop(): Promise<void>;
  readonly placement: VoicePlacement;
}
export type VoicePlacement = { readonly hardCapped: true } | { readonly hardCapped: false; readonly reason: string };
export interface VoiceWorkerSpawner {
  start(
    handlers: {
      message(message: unknown): void;
      exited(reason: string): void;
    },
    recognizers: VoiceRecognizerSet,
  ): Promise<VoiceWorkerHandle>;
}
/** Implemented inside the child only. Construction and description reads must not allocate models;
 * load starts allocations and unload releases them. Available handles stay cheap until selected. */
export interface VoiceRecognizer {
  readonly description: VoiceRecognizerDescription;
  load(): Promise<VoiceOutcome<void>>;
  audio(streamId: string, samples: Float32Array): Promise<VoiceOutcome<string>>;
  finish(streamId: string): Promise<VoiceOutcome<string>>;
  cancel(streamId: string): void;
  unload(): Promise<void>;
}
export interface VoiceWorkerChannel {
  send(message: VoiceWorkerResponse): void;
  receive(handler: (message: unknown) => void): void;
}
