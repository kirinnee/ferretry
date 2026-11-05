import type { VoiceArchiveFormat, VoiceMachineEngine } from '@ferretry/protocol';

/**
 * The seams the install rules cross. `src/lib/voice-install` holds the RULES (resume from the first missing
 * byte, hash, refuse a short disk, one install at a time, what an archive may contain); every byte that
 * actually moves goes through these, so the tests drive the whole install with a fake network and a fake disk
 * and never download a model.
 */

/** A file open for appending. */
export interface VoiceFileSink {
  write(chunk: Uint8Array): Promise<void>;
  /** Flushes to disk and closes. */
  close(): Promise<void>;
}

/** The disk, under the state home's `voice/` directory. Every path is absolute. */
export interface VoiceInstallFiles {
  /** The file's size in bytes, or `undefined` when there is no such file. */
  size(path: string): Promise<number | undefined>;
  /** The file's bytes, in order. */
  read(path: string): AsyncIterable<Uint8Array>;
  /** Opens for appending (creating the directory and file if needed); `truncate` empties it first. */
  openAppend(path: string, options: { readonly truncate: boolean }): Promise<VoiceFileSink>;
  /** Creates a file (and its parent directories) for a staged write. */
  openStaged(path: string, options: { readonly executable: boolean }): Promise<VoiceFileSink>;
  makeDirectory(path: string): Promise<void>;
  /** Moves a directory or file; the destination must not exist. */
  rename(from: string, to: string): Promise<void>;
  /** Deletes a file or a directory tree; absent is success. */
  remove(path: string): Promise<void>;
  /** The text of a small file, or `undefined` when there is none. */
  readText(path: string): Promise<string | undefined>;
  writeText(path: string, text: string): Promise<void>;
  /** Free bytes on the volume holding `path` (its nearest existing parent), or `undefined` when unknowable. */
  freeBytes(path: string): Promise<number | undefined>;
  /** The names directly inside a directory; empty when there is none. */
  list(path: string): Promise<readonly string[]>;
}

/** `fetch`, narrowed to what a resumable download needs. */
export type VoiceFetch = (
  url: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal: AbortSignal },
) => Promise<Response>;

/** The tool that turns a compressed archive into a tar stream is missing from this machine. */
export class NoDecompressorError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} is needed to unpack a model and was not found on this machine; install it and try again`);
    this.name = 'NoDecompressorError';
  }
}

/** Reads an archive file as the tar stream inside it. Throws `NoDecompressorError`. */
export interface VoiceArchiveReader {
  tarStream(path: string, format: VoiceArchiveFormat, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

/** `engine` in `voice.yaml`. */
export interface VoiceEngineSettings {
  read(): Promise<VoiceMachineEngine>;
  /** Sets the model a role uses, or clears it (`null`) so the default applies. */
  setModel(role: 'batch' | 'streaming', id: string | null): Promise<void>;
}

export interface VoiceInstallClock {
  /** The current instant as ISO-8601 with an offset. */
  now(): string;
}
