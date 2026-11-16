import type { CopyElementPart } from '../../../contract/routes/index.ts';
import type { SecretChildRunner } from '../local-ports.ts';
import type { BrowserElementTarget } from '../vault-inputs.ts';

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
interface CopyFolders {
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
  /** A copy was pasted into a terminal: it stays masked for the life of that session's scrollback, not the copy's own. */
  holdScrollback(sessionId: string, value: string, marker: string): boolean;
  /** Whether the session already keeps as many different copies masked in scrollback as it may, and `marker` is not one of them. */
  scrollbackFull(sessionId: string, marker: string): boolean;
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
      /** The element (or one it sits in) is editable: its text is whatever was typed there. */
      readonly editable?: true;
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
  /**
   * What the agent browser's clipboard holds, read in the daemon's own context (never an agent page's) and emptied, filed under
   * the page `key` (the one whose Copy button the agent pressed). The same queue and seal as a page read.
   */
  clipboard?(sessionId: string, key: string, queue: CopyPageQueue): Promise<CopyPageRead>;
}

/**
 * Which pages stay closed while a copy lives (Browsers keeps the record: `BrowsersApi.copy.sealed`). Never a value: the copy's
 * name, the origins it is on, and a function that answers when it ends (nothing once it has).
 */
export interface CopyGuards {
  hold(sessionId: string, copy: string, origins: readonly string[], until: () => number | undefined): void;
  /**
   * A paste of the copy is about to land on a page document (and frames) at these origins: they join the copy's. Throws when it
   * cannot record them; the write then does not happen.
   */
  pastedOn(sessionId: string, copy: string, origins: readonly string[], until: () => number | undefined): void;
  drop(sessionId: string): void;
}

/** Where pictures of a page wait while it shows the document a value was copied from (`PageCopyRecords`). */
interface CopyPageHolds {
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
  /** Keeps the pages a live copy sits on closed to an agent's reads and pictures (`BrowsersApi.copy.sealed`). */
  readonly guards?: CopyGuards;
}
