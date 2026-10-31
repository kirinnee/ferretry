import type { BrowserElementTarget, CopyElementPart } from '@ferretry/protocol';
import type { SecretChildRunner } from '../secrets/types.ts';

/**
 * THE SEAMS THE SECURE-COPY SERVICE STANDS ON (docs/secure-copy.md).
 *
 * A value enters through one of two — {@link CopyPorts.runner}'s stdout, or a page read by {@link CopyPorts.pages} —
 * and leaves through two:
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

/** One page element, read for a copy in that page's own queue: the value and where it was read, or why not. */
export type CopyPageRead =
  | {
      readonly ok: true;
      readonly value: string;
      /** The page's id, beside the key the agent named it by. */
      readonly pageId: string;
      readonly origin: string;
      readonly frameOrigin: string;
      readonly navigationId: string;
    }
  | { readonly ok: false; readonly reason: 'missing' | 'empty' | 'changed' };

/** Checks run INSIDE the page's queue before the read, given the page's current document: a refusal throws. */
export type CopyPageGuard = (page: { document(): Promise<string | undefined> }) => Promise<void>;

/**
 * What a page read does inside the page's own queue, so nothing queued behind it runs first: the guard before the
 * read, and `seal` right after a read that found a value, before the queue moves on (the value is masked and the
 * page held there, so an act queued behind the copy already meets both).
 */
export interface CopyPageQueue {
  readonly guard?: CopyPageGuard;
  seal(read: Extract<CopyPageRead, { readonly ok: true }>): void;
}

/** The agent browser, as a page copy needs it. The page is the session's own; the agent tools checked it may act there. */
export interface CopyPagePort {
  read(
    sessionId: string,
    key: string,
    target: BrowserElementTarget,
    part: CopyElementPart,
    attribute: string | undefined,
    queue: CopyPageQueue,
  ): Promise<CopyPageRead>;
}

/** Where pictures of a page wait while it shows the document a value was copied from (`PageCopyRecords`). */
export interface CopyPageHolds {
  hold(
    sessionId: string,
    copy: string,
    names: readonly (string | undefined)[],
    navigationId: string,
    until: number,
  ): void;
  /** A copy's mask now ends sooner (it was discarded): its holds end with it. */
  retime(sessionId: string, copy: string, until: number): void;
  drop(sessionId: string): void;
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
  /** The agent browser, for a copy of a page element. Absent: a page copy is unavailable. */
  readonly pages?: CopyPagePort;
  /** Holds pictures of a page a value was copied from. */
  readonly pageHolds?: CopyPageHolds;
}
