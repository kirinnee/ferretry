import type { BrowserElementTarget, InputTargetFacts } from '@ferretry/protocol';

/**
 * THE INPUT BRIDGE'S SEAM INTO THE AGENT BROWSER (docs/input-requests.md, "Pages").
 *
 * Three calls, each on ONE page, each run in that page's own queue so no agent act lands between them:
 *
 * - {@link BrowserInputFieldsPort.inputObserve}: what the fields the agent pointed at really are — the page's
 *   origin and document, and per field the frame, the node, the attributes, the box. The browser decides all
 *   of it; the agent's pointer (a ref or a selector) only says where to look.
 * - {@link BrowserInputFieldsPort.inputRefind}: the fields a card showed, found AGAIN after the page changed under it
 *   (a re-render replaced the node, a reload made a new document): the approved node if it is still there, else the
 *   agent's pointer when it names exactly one such field, else the one visible look-alike with the same tag and
 *   attributes in the page's main frame. It is looked at exactly as `inputObserve` looks, so its identity is the node
 *   Playwright holds; it never types.
 * - {@link BrowserInputFieldsPort.inputShot}: a picture of the part of the page the fields are in, for the
 *   owner's card, taken BEFORE anything is typed.
 * - {@link BrowserInputFieldsPort.inputType}: the one write. It checks the page against `expected` first (the
 *   same document, the same nodes with the same attributes) and writes nothing when anything differs. Then
 *   for each value in order it focuses the node, confirms the focus landed there, selects what the field
 *   holds and inserts the text; Enter in the last field when `submit`.
 *
 * A VALUE CROSSES THIS SEAM ONLY IN `inputType`'s `values`. It is never logged, never in an error message
 * and never in an answer: the answer is one of four words.
 *
 * REUSABLE: anything that must put an owner-supplied value into a page field (the secure-copy paste, &F230)
 * goes through {@link InputTargetPort} in `lib/input-requests`, which stands on this, so the binding check
 * runs for every such write.
 */

/** One field to look at: the card's field id and the agent's pointer to its element. */
export interface BrowserInputFieldPointer {
  readonly id: string;
  readonly target: BrowserElementTarget;
}

/** A page's facts, exactly the protocol's browser facts. */
export type BrowserInputFacts = Extract<InputTargetFacts, { readonly kind: 'browser' }>;

/**
 * What a look found. `missing` names a field whose element is not on the page (a stale ref, a selector that
 * matches nothing): nothing is asked of the owner for a field that is not there.
 */
export type BrowserInputObservation =
  | { readonly ok: true; readonly facts: BrowserInputFacts }
  | { readonly ok: false; readonly missing: string }
  /** A re-find only: more than one field on the page could be this one, so none is chosen. */
  | { readonly ok: false; readonly ambiguous: string };

/** One value for one field, by the card's field id. */
export interface BrowserInputValue {
  readonly field: string;
  readonly text: string;
}

/**
 * What came of the write: `typed`; `target_changed` / `target_gone` (NOTHING was written: the page or a node
 * differs from `expected`, or the page is closed); `uncertain` (a write began and did not finish cleanly — part
 * of the values may be in the page, so it is never retried).
 */
export type BrowserInputOutcome = 'typed' | 'target_changed' | 'target_gone' | 'uncertain';

/** A PNG of the part of the page around the fields, and where that part is in viewport CSS pixels. */
export interface BrowserInputShot {
  readonly pngBase64: string;
  readonly clip: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** Which document a page is showing now: a navigation since the owner's value was typed changes `navigationId`. */
export interface BrowserInputDocument {
  readonly navigationId: string;
  /** The host the page is on now (`accounts.google.com`): a login's facts watch it leave the sign-in hosts. */
  readonly host?: string;
}

/** A provider whose own sign-in page shows a push number (push-number.ts). */
export type PushNumberProvider = 'okta' | 'microsoft' | 'google' | 'duo';

/**
 * One look at a page for the number a push approval shows (docs/input-requests.md, "Approve on your phone"), as the
 * BROWSER answers it: where the page is (its origin and document, read before and after the look), which provider's
 * challenge the document is when one's document test held, and the number when one was found. The daemon decides
 * whether to believe it (the origin and the session's scripts); the browser only reads.
 */
export interface BrowserPushNumberRead {
  /** `scheme://host[:port]` of the page, from the browser. */
  readonly origin: string;
  /** The document the look was made in, read before it; a different one after is `missing: 'changed'`. */
  readonly navigationId: string;
  /** The provider whose challenge this document is, when its document test held (with or without a number). */
  readonly provider?: PushNumberProvider;
  /** The number: 1 to 6 digits, from the provider's own view, visible and no one can type into, in the main frame. */
  readonly number?: { readonly value: string; readonly from: PushNumberProvider; readonly frameOrigin: string };
  /** Why there is no number: none recognised, or the page changed meanwhile. */
  readonly missing?: 'none-found' | 'changed';
}

/** The most of each part of a page (text, snapshot, markup) the daemon looks at for a value after a sign-in. */
export const BROWSER_INPUT_TEXT_MAX_CHARS = 400_000;

export interface BrowserInputFieldsPort {
  /** The page's current document, cheaply: no field is looked at. */
  inputDocument(pageId: string): Promise<BrowserInputDocument>;
  /**
   * What a ferret's read of the page could show (visible text, accessibility snapshot, markup; see `readInputText`),
   * for the DAEMON's own yes-or-no look for a just-typed value after a sign-in. Never published: no route or tool
   * returns it.
   */
  inputText?(pageId: string): Promise<string>;
  /** The dummy probe (`probeInputFields`): `hidden`, `shown` or `aborted`. The throwaway value is no secret. */
  inputProbe?(
    pageId: string,
    expected: BrowserInputFacts,
    fieldIds: readonly string[],
    dummy: string,
  ): Promise<'hidden' | 'shown' | 'aborted'>;
  /**
   * The push number the page shows (`readPushNumber`): a provider's own challenge view only, never an element a ferret
   * points at. Absent: this browser cannot read one, and no card shows one.
   */
  pushNumberRead?(pageId: string): Promise<BrowserPushNumberRead>;
  inputObserve(pageId: string, fields: readonly BrowserInputFieldPointer[]): Promise<BrowserInputObservation>;
  /**
   * The fields `expected` describes, found again in the page as it is now. Each field: the node the card showed, if
   * it is still that field (same frame origin, tag and attributes, visible); else the agent's pointer when it names
   * exactly one such element; else the one visible look-alike. None is `missing`; several, or a search the page
   * disturbed, is `ambiguous`.
   */
  inputRefind(
    pageId: string,
    expected: BrowserInputFacts,
    fields: readonly BrowserInputFieldPointer[],
  ): Promise<BrowserInputObservation>;
  inputShot(pageId: string, facts: BrowserInputFacts): Promise<BrowserInputShot>;
  inputType(
    pageId: string,
    expected: BrowserInputFacts,
    values: readonly BrowserInputValue[],
    submit: boolean,
  ): Promise<BrowserInputOutcome>;
}

/** The longest side of a field shot, in CSS pixels: enough to see the form, not the whole page. */
export const BROWSER_INPUT_SHOT_MAX_SIDE = 900;
/** The margin kept around the fields' boxes in a shot. */
export const BROWSER_INPUT_SHOT_MARGIN = 48;

/**
 * The worker's JSON-line methods behind the port, one per call: `inputDocument` `{ pageId }` answers
 * `{ document: { navigationId } }` (the main frame's loaderId); `inputObserve` `{ pageId, fields }` answers
 * `{ observation }`; `inputRefind` `{ pageId, expected, fields }` answers `{ observation }`; `inputShot`
 * `{ pageId, facts }` answers `{ shot }`; `inputType` `{ pageId, expected, values, submit }` answers `{ outcome }`.
 * Each answer is parsed by the daemon before it is believed.
 */
export const BROWSER_INPUT_WORKER_METHODS = {
  document: 'inputDocument',
  observe: 'inputObserve',
  refind: 'inputRefind',
  shot: 'inputShot',
  type: 'inputType',
  text: 'inputText',
  probe: 'inputProbe',
  pushNumber: 'pushNumberRead',
} as const;
