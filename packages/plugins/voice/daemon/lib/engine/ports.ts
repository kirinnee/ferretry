import type { EngineFile } from './catalog.ts';
import type { SpeechCall, SpeechReply } from './protocol.ts';

/** The downloaded files; a present file is one whose hash was checked before it was written. */
export interface EngineFilesPort {
  size(file: Pick<EngineFile, 'role'>): Promise<number | undefined>;
  read(file: Pick<EngineFile, 'role'>): Promise<Uint8Array | undefined>;
  write(file: Pick<EngineFile, 'role'>, bytes: Uint8Array): Promise<void>;
  remove(file: Pick<EngineFile, 'role'>): Promise<void>;
}

/** `kernel.fetch.request`: the manifest's hosts only, and no redirect is followed for you. */
export interface HttpPort {
  request(url: string, init?: RequestInit): Promise<Response>;
}

/** One running speech thread, as the engine drives it. */
export interface SpeechThread {
  /** Sends one request and answers its reply; rejects when the thread ends first. */
  call(request: SpeechCall, transfer?: readonly ArrayBuffer[]): Promise<SpeechReply & { readonly ok: true }>;
  terminate(): Promise<void>;
  onEnd(listener: () => void): void;
}
