import type {
  InputTargetFacts,
  PushNumberProvider as ContractPushNumberProvider,
  PushNumberRead,
} from '../../../contract/index.ts';
import type { BrowserElementTarget } from './borrowed.ts';

/**
 * THE TERMINAL AND PAGE SEAMS THE INPUT TARGETS STAND ON (copied, not owned). `terminal-target.ts` types into a tmux
 * pane and `page-target.ts` into a page of the agent browser; in 5.0 tmux is Terminals' and the agent browser is
 * Browsers', and each provides `input.targets:<kind>` (§4.7). Only the declarations those two adapters call are copied
 * here, byte for byte from rebuild-ref (bb89d054d) (`tmux/{pane-proof,contracts}.ts`, `terminal/runtime-policy.ts`,
 * `browser/transport/{input-contracts,push-number}.ts`), with a browser fact named `page`.
 */

// ─── from pane-proof.ts ───

/**
 * WHICH PANE THIS IS, ALIVE OR DEAD — the one proof every reader of a registered pane uses.
 *
 * A registration pins a pane by its id and the pid it ran. A live pane is proven by both. A DEAD pane
 * cannot be, on every tmux: since 3.8 `#{pane_pid}` prints NOTHING once the pane's process is gone
 * (`format_cb_pane_pid` answers only while the pane still has its terminal), where 3.6a and 3.7 kept
 * printing the old pid. A reader that demanded the pid therefore never recognised a dead pane on 3.8 —
 * an agent whose harness exited stayed `running` for good.
 *
 * So the proof carries a second stamp that outlives the process: `#{session_created}`, the second the
 * pane's tmux session was made. Every agent runs in a session of its own made for that launch, its
 * registration is written moments later, and a pane id is never handed out twice by one server — so
 * the same pane id in a session created in the same second is the same pane. Wherever tmux still
 * prints a pid, the pid must match too.
 */
export const PANE_PROOF_FORMAT = '#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_created}';

/** What tmux says about a pane right now. */
export interface PaneSighting {
  readonly paneId: string;
  /** The pid the pane runs; absent for a dead pane on tmux 3.8 and later. */
  readonly pid?: number;
  readonly dead: boolean;
  /** The UNIX second the pane's session was created. */
  readonly sessionCreated?: number;
}

const PANE_ID = /^%(?:0|[1-9][0-9]*)$/u;

const WHOLE = /^[1-9][0-9]*$/u;

const positive = (field: string): number | undefined => {
  if (!WHOLE.test(field)) return undefined;
  const value = Number(field);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** Parse {@link PANE_PROOF_FORMAT}; `undefined` for anything that is not a pane tmux described. */
export function parsePaneSighting(output: string): PaneSighting | undefined {
  const fields = output.trimEnd().split('|');
  if (fields.length !== 4) return undefined;
  const [paneId = '', pidField = '', deadField = '', createdField = ''] = fields;
  if (!PANE_ID.test(paneId) || (deadField !== '0' && deadField !== '1')) return undefined;
  const pid = positive(pidField);
  // An empty pid is how tmux 3.8 describes a dead pane; any other unreadable one is not tmux's.
  if (pidField !== '' && (pid === undefined || pid <= 1)) return undefined;
  const sessionCreated = positive(createdField);
  return {
    paneId,
    dead: deadField === '1',
    ...(pid === undefined ? {} : { pid }),
    ...(sessionCreated === undefined ? {} : { sessionCreated }),
  };
}

// ─── from contracts.ts ───

/** The narrow process seam required by the tmux domain. */
export interface TmuxCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Implemented by the process adapter; every command excludes the executable and socket flags. */
export interface TmuxCommandPort {
  /**
   * Run one tmux command.
   *
   * `stdin` exists for `load-buffer -`: a turn brief is longer than any argv limit and would be
   * world-readable through `/proc` if it were passed as an argument. A command whose ARGUMENTS carry a
   * payload — a pane's environment, typed keys — is moved onto stdin by the adapter itself
   * (`script.ts`), so callers keep passing ordinary argv.
   */
  execute(arguments_: readonly string[], stdin?: string): Promise<TmuxCommandResult>;
}

// ─── from runtime-policy.ts ───

export const TERMINAL_INPUT_CHUNK_BYTES = 512;

export interface TerminalRuntimeMetadata {
  readonly cols: number;
  readonly rows: number;
  readonly id: string;
  readonly owner: string;
  readonly title: string;
  readonly root: string;
  readonly tmuxSession: string;
  readonly createdAtMs: number;
  readonly lastActivityAtMs: number;
}

export function terminalPaneTarget(record: Pick<TerminalRuntimeMetadata, 'tmuxSession'>): string {
  return `${record.tmuxSession}:0.0`;
}

export function hexInputChunks(
  bytes: Uint8Array,
  chunkSize = TERMINAL_INPUT_CHUNK_BYTES,
): readonly (readonly string[])[] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0)
    throw new RangeError('terminal input chunk size must be positive');
  const chunks: string[][] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push([...bytes.subarray(offset, offset + chunkSize)].map(byte => byte.toString(16).padStart(2, '0')));
  }
  return chunks;
}

// ─── from input-contracts.ts ───

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
export type BrowserInputFacts = Extract<InputTargetFacts, { readonly kind: 'page' }>;

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

/**
 * A grant fill's check before its page hold ends (`inputClear`): each password field it typed into, by node. NEVER
 * THE VALUE: a field that is still connected and holds anything is emptied, whatever it holds.
 */
export interface BrowserInputClearJob {
  readonly navigationId: string;
  readonly fields: readonly { readonly frameId: string; readonly backendNodeId: number }[];
}

/** `cleared`: a field still held a value and is empty now; `moved`: none holds one; `unknown`: it can't be told. */
export type BrowserInputClearOutcome = 'cleared' | 'moved' | 'unknown';

/** The push number look is the Vault contract's now (`PushNumberRead`): one shape for every taker. */
export type PushNumberProvider = ContractPushNumberProvider;
export type BrowserPushNumberRead = PushNumberRead;

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
  /**
   * A grant fill, before its write (`armInputFields`): checks the page against `expected` as a write does, then arms a
   * `pagehide` listener in an isolated world of each named password field's frame that empties every password input
   * when the page is hidden (the back/forward cache would otherwise keep the value). Its own call, so a browser worker
   * from before it refuses the method and the daemon types nothing. `armed`, or `refused` with nothing armed.
   */
  inputArm?(pageId: string, expected: BrowserInputFacts, fieldIds: readonly string[]): Promise<'armed' | 'refused'>;
  /**
   * A grant fill's check before its page hold ends (`clearInputFields`): a typed password field that still holds a
   * value is emptied. Absent: this browser can't, so a grant fill on a page types nothing.
   */
  inputClear?(pageId: string, job: BrowserInputClearJob): Promise<BrowserInputClearOutcome>;
}
