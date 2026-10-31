import type { SecretChildRunner } from '../secrets/types.ts';

/**
 * THE SEAMS THE SECURE-COPY SERVICE STANDS ON (docs/secure-copy.md).
 *
 * A value enters through exactly one of these — {@link CopyPorts.runner}'s stdout — and leaves through two:
 * the masking registry, which only ever matches it, and the transcript check, which answers a word. No port
 * here hands a value to a caller.
 */

export interface CopyClock {
  now(): number;
}

/** The folder a session works in, for a command copy's working folder; nothing when the session is unknown. */
export interface CopyFolders {
  folderOf(sessionId: string): Promise<string | undefined>;
}

/**
 * Whether the session's own transcript already holds the value: the honest answer to "did the agent see it
 * before it was sealed". `clean` covers only what was read; a transcript that cannot be read is `unknown`.
 */
export interface CopyExposurePort {
  transcriptHolds(sessionId: string, value: string): Promise<'found' | 'clean' | 'unknown'>;
}

/**
 * The daemon's one masking registry (`EphemeralValues`): from capture on, the value is masked wherever the
 * daemon scrubs text — terminal reads and the live viewer, transcript, journal and operator reads.
 */
export interface CopyMasking {
  holdUntil(sessionId: string, value: string, marker: string, until: number): void;
  retime(sessionId: string, marker: string, until: number): void;
}

export interface CopyPorts {
  readonly clock: CopyClock;
  /** The secret store's no-shell child runner: an allowlisted environment, a timeout and a byte cap. */
  readonly runner: SecretChildRunner;
  readonly folders: CopyFolders;
  readonly exposure: CopyExposurePort;
  readonly masking: CopyMasking;
  /** The vault redactor over one text; it throws when the vault cannot be opened, and the text is withheld. */
  readonly redact: (text: string) => Promise<string>;
}
