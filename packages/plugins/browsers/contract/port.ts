/**
 * Browsers' port (§2.3): the agent browser's lifecycle and the pages a ferret holds, by id and name. Never a URL, a
 * title or page text: page metadata is a `reads` act and leaves only through the act runner (§4.7).
 */
import { defineEvent, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { BrowserPageIdSchema, type BrowserStateView, type SurfaceNameSchema } from './wire.ts';
import type { BrowserElementTarget } from './wire/target.ts';

export interface BrowserPageRef {
  readonly id: z.infer<typeof BrowserPageIdSchema>;
  readonly name?: z.infer<typeof SurfaceNameSchema>;
  readonly incognito?: true;
}

/**
 * Why a browser under a ferret's pane was left alone, a closed set (never free text, never argv): `not-proved` (the
 * fresh re-proof said it is not that browser under that pane, threw, or Terminals was off), `gone` (no such process
 * any more), `tool-running` (a tool command runs under the pane and may be using it), `invalid-pid` (1 or below, or
 * not a whole number, reported as -1), `signal-refused` (proved, but the SIGTERM did not land).
 */
export const LeftAloneWhySchema = z.enum(['not-proved', 'gone', 'tool-running', 'invalid-pid', 'signal-refused']);
export type LeftAloneWhy = z.infer<typeof LeftAloneWhySchema>;

/** What one close of a ferret's leftover browsers did: how many closed, and each pid it left alone and why. */
export interface LeftoverBrowsersClosed {
  readonly closed: number;
  readonly leftAlone: readonly { readonly pid: number; readonly why: LeftAloneWhy }[];
}

/** Why a page may not be used for a secure copy right now, as the browser tools word it. */
export type BrowserCopyRefusalCode = 'taken_over' | 'forbidden' | 'not_found' | 'unavailable';

/**
 * One element of a page, read for a secure copy in that page's own queue (docs/secure-copy.md, "Capturing"): the value, and
 * where it was read, or why not. THE VALUE CROSSES THIS SEAM ONCE, here, to the service that seals it; it is never logged and
 * never in an error. `editable`: the element, or one it sits in, is editable, so its text is whatever was typed there.
 */
export type BrowserCopyAnswer =
  | {
      readonly ok: true;
      readonly value: string;
      /** The page's id, beside the key the agent named it by. */
      readonly pageId: string;
      /** `scheme://host[:port]` of the page. */
      readonly origin: string;
      /** `scheme://host[:port]` of the frame the element is in: the page's own, or one from another site. */
      readonly frameOrigin: string;
      /** The document the value was read from: it changes with every navigation. */
      readonly navigationId: string;
      readonly editable?: true;
    }
  | { readonly ok: false; readonly reason: 'missing' | 'empty' | 'changed' }
  | { readonly ok: false; readonly reason: 'refused'; readonly code: BrowserCopyRefusalCode; readonly message: string };

/**
 * What a copy does INSIDE the page's queue: the owner's checks before the read (given the page's current document; a
 * refusal throws), and `seal` right after a read that found a value, before the queue moves on, so an act queued behind the
 * copy already meets the mask.
 */
export interface BrowserCopyQueue {
  readonly guard?: (page: { document(): Promise<string | undefined> }) => Promise<void>;
  seal(read: Extract<BrowserCopyAnswer, { readonly ok: true }>): void;
}

/** What Accounts tells Browsers about the copies that live, so their pages stay closed (never a value). */
export interface BrowserSealedPages {
  /**
   * A copy named `copy` now lives for `ferret` and sits on pages of these origins (none for a command's). `until` answers
   * when it ends, or nothing once it has: a discarded or expired copy lifts its pages at once.
   */
  hold(ferret: FerretId, copy: string, origins: readonly string[], until: () => number | undefined): void;
  /** A paste of the copy went into the page `key`: that page's origin joins the copy's. Nothing for a page not found. */
  pastedInto(ferret: FerretId, copy: string, key: string, until: () => number | undefined): Promise<void>;
  /** Every copy of this ferret's is let go of (its session ended). */
  drop(ferret: FerretId): void;
}

/** Whether a ferret may paste into one of its pages, and the key that names it, or why not. */
export type BrowserPasteTarget =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly code: BrowserCopyRefusalCode; readonly message: string };

/**
 * SECURE COPY'S REACH INTO THE AGENT BROWSER (docs/secure-copy.md). Handed to Accounts ALONE (`perNeeder`): no other
 * plugin's port carries it. Every call checks, before it acts, what a browser tool checks: the Browsers switch, a page of
 * the ferret's own (opened, handed, or a popup of those) and nobody holding it, and repeats the takeover check inside the
 * page's queue.
 */
export interface BrowsersCopyApi {
  copyRead(
    ferret: FerretId,
    key: string,
    target: BrowserElementTarget,
    part: 'text' | 'value' | 'attribute',
    attribute: string | undefined,
    queue: BrowserCopyQueue,
  ): Promise<BrowserCopyAnswer>;
  /**
   * What the agent browser's CLIPBOARD holds, read in the worker's own context and nowhere else (docs/secure-copy.md,
   * "Capturing"): the page `key` is cleared and queued as for `copyRead`, the clipboard is read and then EMPTIED, so the
   * value is no longer in the browser for a page's paste to carry into something the agent reads. No agent page is ever
   * granted clipboard-read. While it runs, `browser.eval` is refused on every page of the ferret. The answer is the same
   * as a page copy's (`origin` is the page's), or a refusal: a real window on this computer's own clipboard is refused.
   */
  clipboardRead(ferret: FerretId, key: string, queue: BrowserCopyQueue): Promise<BrowserCopyAnswer>;
  /** The page a paste may go to, cleared as a browser tool would, and the key the daemon knows it by. */
  pasteTarget(ferret: FerretId, key: string): Promise<BrowserPasteTarget>;
  /**
   * Which pages hold a sealed value (docs/secure-copy.md, "Pages that hold a value"). While a copy lives, an agent's read,
   * script, console, network, picture or text wait on a page of one of these origins is refused with a sentence that says why
   * and until when, and a picture of ANY page whose text shows a live copy is withheld. A person's own calls pass.
   */
  readonly sealed: BrowserSealedPages;
  /** Whether a person holds this page right now (any page not found counts as held: nothing is pasted there). */
  takenOver(ferret: FerretId, key: string): Promise<boolean>;
}

export interface BrowsersApi {
  /** Secure copy's reach (docs/secure-copy.md): present for Accounts only. */
  readonly copy?: BrowsersCopyApi;
  state(): Promise<BrowserStateView>;
  /**
   * Today's machine.browserPorts fact for Codex sign-in: shared is setting !== 'random' (per-user or explicit).
   * Optional until the provider is ported; a consumer without this fact must treat host ports as shared.
   */
  browserPorts?(): Promise<{ readonly shared: boolean }>;
  /** The pages one ferret holds, by id and name only. */
  pagesOf(ferret: FerretId): Promise<readonly BrowserPageRef[]>;
  /**
   * Whether this host shares its loopback ports with other local users: the machine's `browserPorts` is anything but
   * `random` (today's `FleetLoginService` reading). Logins takes it as an optional use (lead decision 19, L2); an
   * absent method means the host is treated as shared, which fails closed.
   *
   * GAP (card F1931): Browsers does not provide it yet — 5.0 serves Browsers no read of the machine's `browserPorts`
   * (Runtimes keeps it and no contract serves it), so Browsers cannot say, and leaves it absent rather than guess.
   */
  browserPorts?(): Promise<{ readonly shared: boolean }>;
  /**
   * Close the browsers a ferret launched that still run under its own pane, read afresh at this moment (today's
   * `closeLeftoverBrowsers`). ONLY A PID IT CAN PROVE IS SIGNALLED: each is re-proved by Terminals immediately before
   * its SIGTERM (same pid and start, still a top-level browser in THAT pane's tree, no tool command running) — never
   * the ferret itself, never a helper's browser, never anything outside its tree. Every other one is left alone and
   * reported in `leftAlone`, and the rest are still tried. Terminals off: `{ closed: 0, leftAlone: [] }`. Throws only
   * when the pane's tree could not be read at all.
   */
  closeLeftoverBrowsers(ferret: FerretId): Promise<LeftoverBrowsersClosed>;
}

export const BrowsersPort = definePort<BrowsersApi>('browsers');

/**
 * A page opened or closed, a person took the browser over or handed it back, or an agent is driving a page (the
 * "Ferret is typing here" marker). Read the port for the truth.
 */
export const PageChanged = defineEvent(
  'browsers.page-changed',
  z.strictObject({
    ferret: z.string().min(1),
    page: BrowserPageIdSchema,
    change: z.enum(['opened', 'closed', 'taken-over', 'handed-back', 'handed-over', 'asked', 'driving']),
  }),
);
