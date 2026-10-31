import type { BrowserElementTarget, InputTargetFacts } from '@ferretry/protocol';

/**
 * THE INPUT BRIDGE'S SEAM INTO THE AGENT BROWSER (docs/input-requests.md, "Pages").
 *
 * Three calls, each on ONE page, each run in that page's own queue so no agent act lands between them:
 *
 * - {@link BrowserInputFieldsPort.inputObserve}: what the fields the agent pointed at really are — the page's
 *   origin and document, and per field the frame, the node, the attributes, the box. The browser decides all
 *   of it; the agent's pointer (a ref or a selector) only says where to look.
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
  | { readonly ok: false; readonly missing: string };

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

export interface BrowserInputFieldsPort {
  inputObserve(pageId: string, fields: readonly BrowserInputFieldPointer[]): Promise<BrowserInputObservation>;
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
 * The worker's JSON-line methods behind the port, one per call: `inputObserve` `{ pageId, fields }` answers
 * `{ observation }`; `inputShot` `{ pageId, facts }` answers `{ shot }`; `inputType` `{ pageId, expected, values,
 * submit }` answers `{ outcome }`. Each answer is parsed by the daemon before it is believed.
 */
export const BROWSER_INPUT_WORKER_METHODS = {
  observe: 'inputObserve',
  shot: 'inputShot',
  type: 'inputType',
} as const;
