import type { EngineFile } from './catalog.ts';
import type { ReplyCall, ReplyReply } from '../reply/protocol.ts';
import type { SpeechCall, SpeechReply } from './protocol.ts';

/** The downloaded files; a present file is one whose hash was checked before it was written. */
export interface EngineFilesPort {
  size(file: Pick<EngineFile, 'role'>): Promise<number | undefined>;
  read(file: Pick<EngineFile, 'role'>): Promise<Uint8Array | undefined>;
  /**
   * The file's identity on disk (device, inode, size, change times), or `undefined` when it is not there or the port cannot
   * say. It moves whenever the file is written, replaced or touched, which is what lets a file proved pinned be trusted
   * again without hashing it again.
   */
  identity?(file: Pick<EngineFile, 'role'>): Promise<string | undefined>;
  write(file: Pick<EngineFile, 'role'>, bytes: Uint8Array): Promise<void>;
  remove(file: Pick<EngineFile, 'role'>): Promise<void>;
  /**
   * Bytes free where the files are kept (the nearest folder that exists, so a first install is asked too).
   * `undefined` when the machine cannot say: no check is made.
   */
  freeBytes(): Promise<number | undefined>;
}

/** Files a runtime reads by path (the reply voice's model), not as bytes sent to it. */
export interface EnginePathsPort extends EngineFilesPort {
  /** Where the file is on this machine's disk, whether or not it is there yet. */
  pathOf(file: Pick<EngineFile, 'role'>): string;
}

/** `kernel.fetch.request`: the manifest's hosts only, and no redirect is followed for you. */
export interface HttpPort {
  request(url: string, init?: RequestInit): Promise<Response>;
}

/** One running worker thread, as an engine drives it: a request in, its reply out, matched by the thread. */
export interface RequestThread<Call, Reply> {
  /** Sends one request and answers its reply; rejects when the thread ends first. */
  call(request: Call, transfer?: readonly ArrayBuffer[]): Promise<Reply>;
  terminate(): Promise<void>;
  /** Called once when the thread ends. A host that ended on its own says why in a plain sentence; one that was ended on purpose says nothing. */
  onEnd(listener: (stopped?: string) => void): void;
}

/** One running speech thread, as the engine drives it. */
export type SpeechThread = RequestThread<SpeechCall, SpeechReply & { readonly ok: true }>;

/** One running reply-voice thread, as its engine drives it. */
export type ReplyThread = RequestThread<ReplyCall, ReplyReply & { readonly ok: true }>;
