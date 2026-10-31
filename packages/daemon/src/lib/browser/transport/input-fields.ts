import type { BrowserElementTarget, InputBrowserFieldFacts } from '@ferretry/protocol';
import { recogniseBrowserChallenge } from './challenge.ts';
import {
  BROWSER_INPUT_SHOT_MARGIN,
  BROWSER_INPUT_SHOT_MAX_SIDE,
  type BrowserInputDocument,
  type BrowserInputFacts,
  type BrowserInputFieldPointer,
  type BrowserInputObservation,
  type BrowserInputOutcome,
  type BrowserInputShot,
  type BrowserInputValue,
  BROWSER_INPUT_TEXT_MAX_CHARS,
} from './input-contracts.ts';
import { type ActablePage, BROWSER_PROBE_TIMEOUT_MS, browserElementOf, browserSelectorOf } from './page-acts.ts';

/**
 * WHAT THE BROWSER WORKER DOES FOR THE INPUT BRIDGE (docs/input-requests.md, "Pages"): look at the fields an
 * agent pointed at, take a picture of them, and — only after checking that nothing changed — type an owner's
 * values into them.
 *
 * Written against {@link InputablePage} and {@link InputCdpSession}, the slices of a Playwright page and a
 * DevTools session these calls touch, so each rule is tested with fakes and no browser.
 *
 * THE BROWSER DECIDES, THE PAGE IS NOT ASKED. The agent's pointer (a ref or a selector) only says where to
 * look: Playwright resolves it in its own isolated world and holds the element. The element's IDENTITY is the
 * node Playwright's own DevTools session names for that handle ({@link InputHandle.describe}); the node, its
 * frame, its attributes, its box and the document all come from DevTools for that one node. The page's own
 * script is never asked anything about which element it is.
 *
 * NOTHING THE PAGE CONTROLS RUNS BETWEEN THE LAST PROOF AND THE INSERT. The write selects and checks focus
 * through an isolated world of the field's frame, whose prototypes the page cannot reach, and `Input.insertText`
 * is the very next call after the final proof.
 *
 * A VALUE NEVER LEAVES. It reaches {@link typeInputFields} and goes to `Input.insertText`; it is not logged, not
 * in any error this file throws or returns, and not in the answer, which is one of four words.
 */

/** A raw DevTools session on a page or on one of its out-of-process frames. */
export interface InputCdpSession {
  send(method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  /** Releases a session this code opened; absent on one it was lent. */
  detach?(): Promise<void>;
}

/** A frame of the page, as far as the input calls look at it. */
export interface InputFrame {
  url(): string;
  /** The frame this one is inside, or `null` for the page's main frame. */
  parentFrame(): InputFrame | null;
}

/**
 * Who a handle holds, as the DevTools session that holds it says: the node (its `backendNodeId`, name and
 * attributes) and that session's TARGET. A backend node id is only unique inside one renderer, so the target is
 * half of the identity: the write must go through a session of the same target.
 */
export interface InputHeldNode {
  readonly node: unknown;
  readonly targetId: unknown;
}

/** The element a locator resolved, held while it is looked at. */
export interface InputHandle {
  ownerFrame(): Promise<InputFrame | null>;
  /**
   * The node this handle holds, as the DevTools session that holds it describes it (`DOM.describeNode` on the
   * handle's own remote object), and that session's target. This is the element's identity; no page script runs
   * to answer it.
   */
  describe(): Promise<InputHeldNode>;
  boundingBox(): Promise<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null>;
  isVisible(): Promise<boolean>;
  dispose(): Promise<void>;
}

/** The slice of a locator the input calls use: which element, and a hold on it. */
export interface InputLocator {
  first(): InputLocator;
  /** The element at this index of the ones it matches; a re-find looks at each candidate in turn. */
  nth(index: number): InputLocator;
  innerText?(options: { readonly timeout: number }): Promise<string>;
  ariaSnapshot?(options: { readonly timeout: number }): Promise<string>;
  count(): Promise<number>;
  elementHandle(options: { readonly timeout: number }): Promise<InputHandle | null>;
}

export interface InputablePage {
  locator(selector: string): InputLocator;
  isClosed(): boolean;
  url(): string;
  title(): Promise<string>;
  mainFrame(): InputFrame;
  frames(): readonly InputFrame[];
  /** Playwright's page events: the dummy probe listens for any request while it runs. */
  on?(event: 'request', listener: () => void): unknown;
  off?(event: 'request', listener: () => void): unknown;
  /** How many WebSockets the page holds open (the worker tracks them): the probe never types where one is. */
  openSockets?(): number;
  /** How many WebSockets the page has ever opened: one opened and closed while the probe ran still counts. */
  socketsOpened?(): number;
}

/** How the page's DevTools sessions are reached. */
export interface InputCdp {
  /** The page's own session, which owns the main frame and every frame that runs in the same process as the page. */
  page(): Promise<InputCdpSession>;
  /** A session of its own for an out-of-process frame; it rejects for a frame the page session already owns. */
  frame(frame: InputFrame): Promise<InputCdpSession>;
}

/**
 * Which DevTools session owns each frame a look found, kept per page so the write can reach the same frame.
 * Looking again at a frame replaces its session and lets the old one go.
 */
export class InputFrameSessions {
  private readonly held = new Map<string, { readonly session: InputCdpSession; readonly owned: boolean }>();

  remember(frameId: string, session: InputCdpSession, owned: boolean): void {
    const previous = this.held.get(frameId);
    this.held.set(frameId, { session, owned });
    if (previous?.owned === true && previous.session !== session)
      void previous.session.detach?.().catch(() => undefined);
  }

  get(frameId: string): InputCdpSession | undefined {
    return this.held.get(frameId)?.session;
  }

  /** Lets every session this code opened go; the page is closed. */
  release(): void {
    for (const { session, owned } of this.held.values()) if (owned) void session.detach?.().catch(() => undefined);
    this.held.clear();
  }
}

/** The page the calls run on: Playwright's view of it, DevTools' sessions, and the card's name for it. */
export interface InputSubject {
  readonly pageId: string;
  readonly page: InputablePage;
  readonly cdp: InputCdp;
  readonly sessions: InputFrameSessions;
}

/** The world the write runs its few scripts in: created by DevTools per frame, so the page's overrides are not in it. */
const ISOLATED_WORLD = 'ferretry-input';
/** Selects what a field holds with the browser's own `select`, not whatever `select` the page put on the element. */
const SELECT_CONTENTS =
  'function () { const p = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; if (typeof p.select === "function") p.select.call(this); }';
/**
 * The element that has focus, looked for through the documents it can sit in: a field in a same-origin
 * iframe or an open shadow root is not `document.activeElement` itself, its host is. A frame the page may
 * not look into stops the walk at the frame, which is not the field, and the write is refused.
 */
const ACTIVE_ELEMENT = `(() => {
  let element = document.activeElement;
  for (let depth = 0; depth < 16 && element; depth += 1) {
    const inner = (element.shadowRoot && element.shadowRoot.activeElement) || (element.contentDocument && element.contentDocument.activeElement);
    if (!inner) break;
    element = inner;
  }
  return element;
})()`;
/** The longest the page's title may take when it is read for the challenge hint. */
const TITLE_WAIT_MS = 750;

const FIELD_LIMITS = { type: 32, autocomplete: 64, name: 128, id: 128, inputmode: 32 } as const;
const TAG_LIMIT = 32;
const ORIGIN_LIMIT = 256;
const FRAME_ID_LIMIT = 128;
const NAVIGATION_ID_LIMIT = 128;

/** What a field is, as the card draws it. */
type FieldAttributes = InputBrowserFieldFacts['field'];

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The Playwright release {@link playwrightNodeOf} was written against; a test pins the installed one to it. */
export const PLAYWRIGHT_REACHED_VERSION = '1.62.1';

/** The sentences this file throws: fixed, so no page text or value can be in one. */
const REFUSALS = {
  unidentified: 'the browser could not identify that field on the page',
  frameless: 'that field is not in a frame the browser can reach',
  noDocument: 'the page has no document to describe',
  nothingToShoot: 'none of the fields has a visible area to take a picture of',
  noPicture: 'the browser took no picture',
} as const;

/** The page differs from what the owner was shown; caught inside {@link typeInputFields} and never thrown out of it. */
class Refusal extends Error {}

/** The origin of an address; `null` for one that has none (a `data:` page, a blank one) or does not parse. */
export function originOfUrl(url: string): string {
  try {
    const { origin } = new URL(url);
    return (origin === '' ? 'null' : origin).slice(0, ORIGIN_LIMIT);
  } catch {
    return 'null';
  }
}

/** https, or a page on this machine: what is typed does not cross a network in the clear. */
export function isSecureUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname));
  } catch {
    return false;
  }
}

const oneLine = (value: string, maximum: number): string => value.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, maximum);

/**
 * The fields of a node as DevTools describes it: its tag and the few attributes the card shows, cut to the
 * protocol's bounds and left out when empty. The same function reads the node at the look and at the write, so
 * a cut value compares equal to itself.
 */
export function inputFieldAttributes(node: unknown): FieldAttributes {
  const described = (node ?? {}) as { readonly nodeName?: unknown; readonly attributes?: unknown };
  const raw = Array.isArray(described.attributes) ? (described.attributes as readonly unknown[]) : [];
  const attribute = (name: string): string | undefined => {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      if (typeof raw[index] === 'string' && (raw[index] as string).toLowerCase() === name) {
        const value = raw[index + 1];
        return typeof value === 'string' ? value : undefined;
      }
    }
    return undefined;
  };
  const kept = (name: keyof typeof FIELD_LIMITS): { readonly [key: string]: string } => {
    const value = attribute(name);
    const text = value === undefined ? '' : oneLine(value, FIELD_LIMITS[name]);
    return text === '' ? {} : { [name]: text };
  };
  const tag = oneLine(typeof described.nodeName === 'string' ? described.nodeName.toLowerCase() : '', TAG_LIMIT);
  return {
    tag: tag === '' ? 'unknown' : tag,
    ...kept('type'),
    ...kept('autocomplete'),
    ...kept('name'),
    ...kept('id'),
    ...kept('inputmode'),
  };
}

const sameAttributes = (left: FieldAttributes, right: FieldAttributes): boolean =>
  left.tag === right.tag &&
  (['type', 'autocomplete', 'name', 'id', 'inputmode'] as const).every(key => left[key] === right[key]);

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

async function ask(session: InputCdpSession, method: string, params?: Readonly<Record<string, unknown>>) {
  return objectOf(await session.send(method, params));
}

/** The main frame's loader id: it changes with every navigation, so it names "this document". */
async function navigationIdOf(session: InputCdpSession): Promise<string> {
  const tree = await ask(session, 'Page.getFrameTree');
  const loaderId = objectOf(objectOf(tree.frameTree).frame).loaderId;
  if (typeof loaderId !== 'string' || loaderId === '') throw new Error(REFUSALS.noDocument);
  return loaderId.slice(0, NAVIGATION_ID_LIMIT);
}

/** The page's current document, cheaply: no field is looked at. */
export async function describeInputDocument(subject: InputSubject): Promise<BrowserInputDocument> {
  if (subject.page.isClosed()) throw new Error(REFUSALS.noDocument);
  const navigationId = await navigationIdOf(await subject.cdp.page());
  let host: string | undefined;
  try {
    host = new URL(subject.page.url()).host.toLowerCase() || undefined;
  } catch {
    host = undefined;
  }
  return { navigationId, ...(host === undefined ? {} : { host }) };
}

/** How long the daemon waits for a page's text after a sign-in. */
const TEXT_WAIT_MS = 2_000;

/**
 * Everything a ferret's read of the page could show, for the daemon's own look for a just-typed value: the main
 * frame's visible text and its accessibility snapshot (read by Playwright in its utility world, where a page's
 * overrides are not; the snapshot carries what text fields hold and accessible names), and the document's markup as
 * DevTools has it (attributes, hidden text), no page script asked. A part longer than
 * {@link BROWSER_INPUT_TEXT_MAX_CHARS} REFUSES: a value past a cut would read as "not there", which is a claim.
 */
export async function readInputText(subject: InputSubject): Promise<string> {
  if (subject.page.isClosed()) throw new Error(REFUSALS.noDocument);
  const body = subject.page.locator('body').first();
  if (body.innerText === undefined || body.ariaSnapshot === undefined) throw new Error(REFUSALS.noDocument);
  const session = await subject.cdp.page();
  const root = objectOf(objectOf(await ask(session, 'DOM.getDocument', { depth: 0 })).root).nodeId;
  if (typeof root !== 'number') throw new Error(REFUSALS.noDocument);
  const markup = objectOf(await ask(session, 'DOM.getOuterHTML', { nodeId: root })).outerHTML;
  const parts = [
    await body.innerText({ timeout: TEXT_WAIT_MS }),
    await body.ariaSnapshot({ timeout: TEXT_WAIT_MS }),
    typeof markup === 'string' ? markup : '',
  ];
  if (typeof markup !== 'string' || parts.some(part => part.length > BROWSER_INPUT_TEXT_MAX_CHARS))
    throw new Error(REFUSALS.noDocument);
  // The title and the address too: a page can echo a value into either (`document.title`, `history.replaceState`).
  return [...parts, await titleOf(subject.page), subject.page.url()].join('\n');
}

async function titleOf(page: InputablePage): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.title(),
      new Promise<string>(resolve => {
        timer = setTimeout(() => resolve(''), TITLE_WAIT_MS);
      }),
    ]);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The session of the TARGET that holds an element, found from the element's frame: that frame's own session when
 * it is out of process, else the nearest ancestor frame that has one, else the page's. Each candidate proves its
 * target id; one that is not `targetId` is let go and the next is tried, and none matching is a refusal — the
 * page's session is never used for a frame that runs in another target, because the same backend node id names
 * a different node there.
 */
async function sessionOfTarget(
  subject: InputSubject,
  frame: InputFrame,
  targetId: string,
): Promise<{ readonly session: InputCdpSession; readonly owned: boolean }> {
  const main = subject.page.mainFrame();
  for (let at: InputFrame | null = frame; at !== null && at !== main; at = at.parentFrame()) {
    const own = await subject.cdp.frame(at).catch(() => undefined);
    if (own === undefined) continue;
    if ((await targetOf(own)) === targetId) return { session: own, owned: true };
    await own.detach?.().catch(() => undefined);
  }
  const page = await subject.cdp.page();
  if ((await targetOf(page)) === targetId) return { session: page, owned: false };
  throw new Error(REFUSALS.unidentified);
}

/** The target a session is attached to, or an empty string when it will not say. */
async function targetOf(session: InputCdpSession): Promise<string> {
  const info = objectOf(objectOf(await ask(session, 'Target.getTargetInfo').catch(() => ({}))).targetInfo);
  return typeof info.targetId === 'string' ? info.targetId : '';
}

/**
 * The node a Playwright element handle holds, as Playwright's own DevTools session describes it. Playwright
 * resolves a ref or a selector in its own isolated world and adopts the element by its backend node, so the
 * remote object it holds IS the element; asking that session to describe the object needs no page script.
 *
 * This reaches past Playwright's public API (the in-process connection's `toImpl`, the page delegate's
 * `_sessionForHandle` and that frame session's `_targetId`, the handle's `_objectId`), pinned with the Playwright
 * version the worker ships ({@link PLAYWRIGHT_REACHED_VERSION}; a test fails on a bump so the reach is checked again). Any
 * part that is not there is a refusal: a field whose identity cannot be proved is never observed.
 */
export async function playwrightNodeOf(handle: unknown): Promise<InputHeldNode> {
  const client = handle as { readonly _connection?: { toImpl?: (object: unknown) => unknown } } | null;
  const server = client?._connection?.toImpl?.(handle) as
    | {
        readonly _objectId?: unknown;
        readonly _page?: {
          readonly delegate?: {
            _sessionForHandle?: (
              object: unknown,
            ) => { readonly _client?: { send?: unknown }; readonly _targetId?: unknown } | undefined;
          };
        };
      }
    | undefined;
  const objectId = server?._objectId;
  const frameSession = server?._page?.delegate?._sessionForHandle?.(server);
  const session = frameSession?._client;
  const targetId = frameSession?._targetId;
  if (typeof objectId !== 'string' || typeof session?.send !== 'function' || typeof targetId !== 'string')
    throw new Error(REFUSALS.unidentified);
  const send = session.send as (method: string, params: Readonly<Record<string, unknown>>) => Promise<unknown>;
  return { node: objectOf(objectOf(await send.call(session, 'DOM.describeNode', { objectId })).node), targetId };
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A node's border box as DevTools measures it, in CSS pixels; `undefined` for a node with no box or an answer that is not one. */
async function measuredBox(session: InputCdpSession, backendNodeId: number): Promise<Box | undefined> {
  let border: unknown;
  try {
    border = objectOf(objectOf(await ask(session, 'DOM.getBoxModel', { backendNodeId })).model).border;
  } catch {
    return undefined;
  }
  if (!Array.isArray(border) || border.length !== 8) return undefined;
  const points = border as readonly unknown[];
  if (!points.every(point => typeof point === 'number' && Number.isFinite(point))) return undefined;
  const xs = [0, 2, 4, 6].map(index => points[index] as number);
  const ys = [1, 3, 5, 7].map(index => points[index] as number);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * Whether the node is the one on top at the centre of its own box, measured and hit-tested by DevTools in the
 * node's own session (frame-local for a frame of its own). A field that is covered, or off screen, is not:
 * that is a fact for the owner's card (amber), never a reason to refuse — the identity is proved already.
 */
async function onTop(session: InputCdpSession, backendNodeId: number): Promise<boolean> {
  const box = await measuredBox(session, backendNodeId);
  if (box === undefined || box.w <= 0 || box.h <= 0) return false;
  // The node's UA internals answer as the field itself, so ask for the field and not for its inner editor.
  const top = await ask(session, 'DOM.getNodeForLocation', {
    x: Math.floor(box.x + box.w / 2),
    y: Math.floor(box.y + box.h / 2),
    includeUserAgentShadowDOM: false,
    ignorePointerEventsNone: true,
  }).catch(() => ({}) as Record<string, unknown>);
  return top.backendNodeId === backendNodeId;
}

/** Looks at one field: its frame, node, attributes and box. `undefined` when the element is not on the page. */
async function observeField(
  subject: InputSubject,
  pointer: BrowserInputFieldPointer,
): Promise<InputBrowserFieldFacts | undefined> {
  let element: InputLocator;
  try {
    element = (await browserElementOf(
      subject.page as unknown as ActablePage,
      pointer.target as BrowserElementTarget,
    )) as unknown as InputLocator;
    if ((await element.count().catch(() => 0)) === 0) return undefined;
  } catch {
    return undefined;
  }
  return await observeLocated(subject, pointer.id, element);
}

/**
 * Looks at the one element a locator holds, as the card's field `fieldId`: the node Playwright holds, described by
 * the session that holds it, then its frame, attributes and box. `undefined` when it holds none; a throw when the
 * element's identity cannot be proved.
 */
async function observeLocated(
  subject: InputSubject,
  fieldId: string,
  element: InputLocator,
): Promise<InputBrowserFieldFacts | undefined> {
  let handle: InputHandle | null;
  try {
    handle = await element.elementHandle({ timeout: BROWSER_PROBE_TIMEOUT_MS });
  } catch {
    return undefined;
  }
  if (handle === null) return undefined;
  try {
    const frame = await handle.ownerFrame();
    if (frame === null) throw new Error(REFUSALS.frameless);
    // The identity: the node Playwright holds, described by the session that holds it.
    const described = await handle.describe().catch(() => {
      throw new Error(REFUSALS.unidentified);
    });
    const held = objectOf(described.node);
    const backendNodeId = held.backendNodeId;
    const target = described.targetId;
    if (typeof backendNodeId !== 'number' || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0)
      throw new Error(REFUSALS.unidentified);
    if (typeof target !== 'string' || target === '') throw new Error(REFUSALS.unidentified);
    // The write's session is bound to the target that holds the handle, or there is none.
    const { session, owned } = await sessionOfTarget(subject, frame, target);
    // The same node, as the session the write will use names it: the same name and attributes, or a refusal.
    const node = objectOf(
      (
        await ask(session, 'DOM.describeNode', { backendNodeId }).catch(() => {
          throw new Error(REFUSALS.unidentified);
        })
      ).node,
    );
    if (node.backendNodeId !== backendNodeId || !sameNode(node, held)) throw new Error(REFUSALS.unidentified);
    const frameId = oneLine(target, FRAME_ID_LIMIT);
    // Playwright measures the element it holds, in the page's viewport whichever frame it is in.
    const measured = await handle.boundingBox().catch(() => null);
    const box =
      measured === null
        ? { x: 0, y: 0, w: 0, h: 0 }
        : { x: measured.x, y: measured.y, w: measured.width, h: measured.height };
    const visible = (await handle.isVisible().catch(() => false)) && box.w > 0 && box.h > 0;
    const covered = !(await onTop(session, backendNodeId));
    subject.sessions.remember(frameId, session, owned);
    return {
      fieldId,
      frameOrigin: originOfUrl(frame.url()),
      frameId,
      backendNodeId,
      field: inputFieldAttributes(node),
      box,
      visible,
      ...(covered ? { covered: true } : {}),
    };
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

/** Two descriptions of one node agree: the same element name and the same attributes. */
function sameNode(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return (
    left.nodeName === right.nodeName && JSON.stringify(left.attributes ?? []) === JSON.stringify(right.attributes ?? [])
  );
}

/**
 * What the fields are, as the browser sees them: the page's origin and document, and for each field its
 * frame, node, attributes and box. A field whose element is not on the page answers `missing`.
 */
export async function observeInputFields(
  subject: InputSubject,
  fields: readonly BrowserInputFieldPointer[],
): Promise<BrowserInputObservation> {
  const observed: InputBrowserFieldFacts[] = [];
  for (const pointer of fields) {
    const found = await observeField(subject, pointer);
    if (found === undefined) return { ok: false, missing: pointer.id };
    observed.push(found);
  }
  return { ok: true, facts: await pageFactsOf(subject, observed) };
}

/** The page's own facts around fields that were looked at: its origin, whether it is secure, its document, a challenge. */
async function pageFactsOf(
  subject: InputSubject,
  observed: readonly InputBrowserFieldFacts[],
): Promise<BrowserInputFacts> {
  const { page } = subject;
  const url = page.url();
  const challenge = recogniseBrowserChallenge({
    url,
    title: await titleOf(page),
    frameUrls: page.frames().map(frame => frame.url()),
  });
  return {
    kind: 'browser',
    pageId: subject.pageId,
    origin: originOfUrl(url),
    secure: isSecureUrl(url),
    navigationId: await navigationIdOf(await subject.cdp.page()),
    fields: [...observed],
    ...(challenge === undefined ? {} : { challenge }),
  } satisfies BrowserInputFacts;
}

/** The most elements a re-find looks at for one field: more than this many look-alikes is never one field. */
export const INPUT_REFIND_MAX_CANDIDATES = 8;

/**
 * A CSS string value, quoted, with a backslash and a quote escaped so the value cannot end the selector. The
 * attributes it quotes went through {@link inputFieldAttributes}, which leaves no control character in them.
 */
const cssString = (value: string): string => `"${value.replace(/[\\"]/gu, match => `\\${match}`)}"`;

/**
 * A selector for elements with a field's tag and the attributes the card recorded. A value cut at its limit is
 * matched by its start, since the element's own value is longer; {@link inputFieldAttributes} cuts the candidate
 * the same way, so the exact comparison after it still decides.
 */
export function inputFieldSelector(field: FieldAttributes): string {
  const tag = /^[a-z][a-z0-9-]*$/u.test(field.tag) ? field.tag : '*';
  const parts = (Object.keys(FIELD_LIMITS) as (keyof typeof FIELD_LIMITS)[]).map(name => {
    const value = field[name];
    if (value === undefined) return '';
    return `[${name}${value.length >= FIELD_LIMITS[name] ? '^=' : '='}${cssString(value)}]`;
  });
  // Named as CSS, so no part of a value is read as another selector engine.
  return `css=${tag}${parts.join('')}`;
}

/** A candidate is the field the card showed: the same frame origin, tag and attributes, and the owner can see it. */
const isSameField = (want: InputBrowserFieldFacts, got: InputBrowserFieldFacts): boolean =>
  got.visible && got.frameOrigin === want.frameOrigin && sameAttributes(got.field, want.field);

/** The same node: a field fact names one node by its target and backend node id. */
const sameNodeAs = (left: InputBrowserFieldFacts, right: InputBrowserFieldFacts): boolean =>
  left.frameId === right.frameId && left.backendNodeId === right.backendNodeId;

/**
 * Every visible element of the page that is the field the card showed, found by its tag and attributes. Strict
 * against the page itself: more than {@link INPUT_REFIND_MAX_CANDIDATES} elements, one whose identity cannot be
 * proved or that went away while it was looked at, or one node met twice, makes the whole search `ambiguous`,
 * so a page that mutates while it is searched never narrows the field down to one.
 */
async function lookAlikes(
  subject: InputSubject,
  want: InputBrowserFieldFacts,
): Promise<InputBrowserFieldFacts[] | 'ambiguous'> {
  const alike = subject.page.locator(inputFieldSelector(want.field));
  const count = await alike.count().catch(() => 0);
  if (count > INPUT_REFIND_MAX_CANDIDATES) return 'ambiguous';
  const matches: InputBrowserFieldFacts[] = [];
  const seen: InputBrowserFieldFacts[] = [];
  for (let index = 0; index < count; index += 1) {
    const found = await observeLocated(subject, want.fieldId, alike.nth(index)).catch(() => undefined);
    if (found === undefined || seen.some(other => sameNodeAs(other, found))) return 'ambiguous';
    seen.push(found);
    if (isSameField(want, found)) matches.push(found);
  }
  return matches;
}

/**
 * One field of a re-find, in order: the node the owner approved, when it is still there and still that field; the
 * agent's pointer, when it names exactly one element that is that field; the page's ONE look-alike. A search the page
 * disturbed is `ambiguous` before the pointer is asked: nothing narrows a page that changes under the search.
 */
async function refindField(
  subject: InputSubject,
  want: InputBrowserFieldFacts,
  pointer: BrowserInputFieldPointer | undefined,
): Promise<InputBrowserFieldFacts | 'missing' | 'ambiguous'> {
  const matches = await lookAlikes(subject, want);
  if (matches === 'ambiguous') return 'ambiguous';
  const approved = matches.find(found => sameNodeAs(found, want));
  if (approved !== undefined) return approved;
  if (pointer !== undefined) {
    const named = subject.page.locator(browserSelectorOf(pointer.target as BrowserElementTarget));
    if ((await named.count().catch(() => 0)) === 1) {
      const found = await observeLocated(subject, want.fieldId, named.first()).catch(() => undefined);
      if (found !== undefined && isSameField(want, found)) return found;
    }
  }
  const [only, ...more] = matches;
  if (only === undefined) return 'missing';
  return more.length > 0 ? 'ambiguous' : only;
}

/**
 * THE FIELDS A CARD SHOWED, FOUND AGAIN after the page changed under it: a re-render replaced the node (a new
 * backend node id, so the agent's ref is stale), a countdown moved the box, or a reload made a new document.
 *
 * Each field is the node the owner approved when it is still there, else the agent's pointer when it names exactly
 * one element that is still that field, else the ONE visible element of the page's main frame (or an open shadow
 * root) with the same tag and attributes. Every candidate is
 * looked at exactly as {@link observeInputFields} looks — the node Playwright holds, described by the session that
 * holds it — so the identity is proved the same way. None is `missing`; several, or two fields landing on one
 * node, is `ambiguous`; nothing is chosen then. It never types: the card is redrawn and the owner sends again.
 */
export async function refindInputFields(
  subject: InputSubject,
  expected: BrowserInputFacts,
  fields: readonly BrowserInputFieldPointer[],
): Promise<BrowserInputObservation> {
  const found: InputBrowserFieldFacts[] = [];
  for (const want of expected.fields) {
    const pointer = fields.find(each => each.id === want.fieldId);
    const field = await refindField(subject, want, pointer);
    if (field === 'missing') return { ok: false, missing: want.fieldId };
    if (field === 'ambiguous') return { ok: false, ambiguous: want.fieldId };
    if (found.some(other => other.frameId === field.frameId && other.backendNodeId === field.backendNodeId))
      return { ok: false, ambiguous: want.fieldId };
    found.push(field);
  }
  return { ok: true, facts: await pageFactsOf(subject, found) };
}

/** Whether the node a field fact names is still the same node: it answers, with the same tag and attributes. */
async function stillThere(subject: InputSubject, field: InputBrowserFieldFacts): Promise<InputCdpSession> {
  const session = subject.sessions.get(field.frameId);
  if (session === undefined) throw new Refusal();
  const node = objectOf((await ask(session, 'DOM.describeNode', { backendNodeId: field.backendNodeId })).node);
  if (!sameAttributes(inputFieldAttributes(node), field.field)) throw new Refusal();
  return session;
}

/** Checks the page against what the owner was shown. Writes nothing. Throws {@link Refusal} on any difference. */
async function checkUnchanged(
  subject: InputSubject,
  expected: BrowserInputFacts,
  values: readonly BrowserInputValue[],
): Promise<Map<string, { readonly session: InputCdpSession; readonly field: InputBrowserFieldFacts }>> {
  const url = subject.page.url();
  if (originOfUrl(url) !== expected.origin) throw new Refusal();
  if ((await navigationIdOf(await subject.cdp.page())) !== expected.navigationId) throw new Refusal();
  const known = new Map<string, { readonly session: InputCdpSession; readonly field: InputBrowserFieldFacts }>();
  for (const field of expected.fields) known.set(field.fieldId, { session: await stillThere(subject, field), field });
  for (const value of values) if (!known.has(value.field)) throw new Refusal();
  return known;
}

/** The ids of the frames a session owns, its root first: the main frame, or an out-of-process frame's own top. */
function frameIdsOf(tree: unknown): string[] {
  const ids: string[] = [];
  const walk = (entry: unknown): void => {
    const node = objectOf(entry);
    const id = objectOf(node.frame).id;
    if (typeof id === 'string' && id !== '') ids.push(id);
    if (Array.isArray(node.childFrames)) for (const child of node.childFrames as readonly unknown[]) walk(child);
  };
  walk(tree);
  return ids;
}

/** A field as an object of the trusted world, and the context of its session's root frame for the focus proof. */
interface TrustedField {
  readonly objectId: string;
  readonly rootContextId: number;
}

/** The isolated worlds made for one write, one per session and frame, so a card of several fields makes each once. */
class IsolatedWorlds {
  private readonly made = new Map<InputCdpSession, Map<string, number>>();

  private async worldOf(session: InputCdpSession, frameId: string): Promise<number> {
    let frames = this.made.get(session);
    if (frames === undefined) {
      frames = new Map();
      this.made.set(session, frames);
    }
    const known = frames.get(frameId);
    if (known !== undefined) return known;
    const created = await ask(session, 'Page.createIsolatedWorld', { frameId, worldName: ISOLATED_WORLD });
    const contextId = created.executionContextId;
    if (typeof contextId !== 'number') throw new Refusal();
    frames.set(frameId, contextId);
    return contextId;
  }

  /** Resolves the node in the first frame of the session whose world can hold it; a refusal when none can. */
  async resolve(session: InputCdpSession, backendNodeId: number): Promise<TrustedField> {
    const frames = frameIdsOf(objectOf(await ask(session, 'Page.getFrameTree')).frameTree);
    const [root] = frames;
    if (root === undefined) throw new Refusal();
    const rootContextId = await this.worldOf(session, root);
    for (const frameId of frames) {
      try {
        const executionContextId = await this.worldOf(session, frameId);
        const resolved = objectOf(
          objectOf(await ask(session, 'DOM.resolveNode', { backendNodeId, executionContextId })).object,
        );
        if (typeof resolved.objectId === 'string') return { objectId: resolved.objectId, rootContextId };
      } catch {
        // This frame cannot hold the node (or is gone); the next may.
      }
    }
    throw new Refusal();
  }
}

/**
 * The last look before an insert, from the trusted world only: the document is still the one the owner was
 * shown, and the focused element — walked through same-origin frames and open shadow roots — is the approved
 * node. Nothing the page can override runs here, and the insert is the very next call.
 */
async function proveFocus(
  subject: InputSubject,
  expected: BrowserInputFacts,
  session: InputCdpSession,
  rootContextId: number,
  backendNodeId: number,
): Promise<void> {
  if ((await navigationIdOf(await subject.cdp.page())) !== expected.navigationId) throw new Refusal();
  const active = objectOf(
    objectOf(await ask(session, 'Runtime.evaluate', { expression: ACTIVE_ELEMENT, contextId: rootContextId })).result,
  );
  if (typeof active.objectId !== 'string') throw new Refusal();
  const node = objectOf((await ask(session, 'DOM.describeNode', { objectId: active.objectId })).node);
  if (node.backendNodeId !== backendNodeId) throw new Refusal();
}

async function pressEnter(session: InputCdpSession): Promise<void> {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/**
 * The one write. The page is checked against `expected` first — the same document and origin, and every
 * expected node answering with the same tag and attributes — and NOTHING is written if anything differs
 * (`target_changed`, or `target_gone` for a closed page). Then, for each value in order: resolve the node in
 * an isolated world of its frame, focus it, select what it holds with the browser's own `select`, prove from
 * that world that the document is unchanged and the focus is on the node, and insert the text. Enter goes to
 * the last field when `submit`.
 *
 * A failure before the first text is inserted writes nothing (`target_changed`); one at or after it may have
 * written part of the values (`uncertain`). Nothing is retried, and no error leaves this function: the answer
 * is a word, so a value cannot ride out in a message.
 */
export async function typeInputFields(
  subject: InputSubject,
  expected: BrowserInputFacts,
  values: readonly BrowserInputValue[],
  submit: boolean,
): Promise<BrowserInputOutcome> {
  if (subject.page.isClosed()) return 'target_gone';
  let began = false;
  try {
    const known = await checkUnchanged(subject, expected, values);
    const worlds = new IsolatedWorlds();
    let last: InputCdpSession | undefined;
    for (const value of values) {
      const target = known.get(value.field);
      if (target === undefined) throw new Refusal();
      const { backendNodeId } = target.field;
      const trusted = await worlds.resolve(target.session, backendNodeId);
      await target.session.send('DOM.focus', { backendNodeId });
      await target.session.send('Runtime.callFunctionOn', {
        objectId: trusted.objectId,
        functionDeclaration: SELECT_CONTENTS,
        returnByValue: true,
      });
      await proveFocus(subject, expected, target.session, trusted.rootContextId, backendNodeId);
      began = true;
      await target.session.send('Input.insertText', { text: value.text });
      last = target.session;
    }
    if (submit && last !== undefined) await pressEnter(last);
    return 'typed';
  } catch {
    if (began) return 'uncertain';
    return subject.page.isClosed() ? 'target_gone' : 'target_changed';
  }
}

const dimensionsOf = (value: unknown): { readonly width: number; readonly height: number } | undefined => {
  const viewport = objectOf(value);
  const { clientWidth: width, clientHeight: height } = viewport;
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
    ? { width, height }
    : undefined;
};

/**
 * A picture of the part of the page the fields are in: the union of their boxes plus a margin, clamped to
 * the viewport and to {@link BROWSER_INPUT_SHOT_MAX_SIDE}. `clip` is in viewport CSS pixels, where the boxes
 * are; the capture itself is asked for in page coordinates, which is what DevTools clips in.
 */
export async function shootInputFields(session: InputCdpSession, facts: BrowserInputFacts): Promise<BrowserInputShot> {
  const boxes = facts.fields.map(field => field.box).filter(box => box.w > 0 && box.h > 0);
  if (boxes.length === 0) throw new Error(REFUSALS.nothingToShoot);
  const metrics = await ask(session, 'Page.getLayoutMetrics');
  const viewport = objectOf(metrics.cssVisualViewport);
  const size = dimensionsOf(viewport);
  if (size === undefined) throw new Error(REFUSALS.noPicture);
  const left = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.x)) - BROWSER_INPUT_SHOT_MARGIN));
  const top = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.y)) - BROWSER_INPUT_SHOT_MARGIN));
  const right = Math.min(
    size.width,
    Math.ceil(Math.max(...boxes.map(box => box.x + box.w)) + BROWSER_INPUT_SHOT_MARGIN),
  );
  const bottom = Math.min(
    size.height,
    Math.ceil(Math.max(...boxes.map(box => box.y + box.h)) + BROWSER_INPUT_SHOT_MARGIN),
  );
  const w = Math.min(right - left, BROWSER_INPUT_SHOT_MAX_SIDE);
  const h = Math.min(bottom - top, BROWSER_INPUT_SHOT_MAX_SIDE);
  if (w <= 0 || h <= 0) throw new Error(REFUSALS.nothingToShoot);
  const pageX = typeof viewport.pageX === 'number' ? viewport.pageX : 0;
  const pageY = typeof viewport.pageY === 'number' ? viewport.pageY : 0;
  const shot = await ask(session, 'Page.captureScreenshot', {
    format: 'png',
    clip: { x: left + pageX, y: top + pageY, width: w, height: h, scale: 1 },
    captureBeyondViewport: false,
  });
  if (typeof shot.data !== 'string' || shot.data === '') throw new Error(REFUSALS.noPicture);
  return { pngBase64: shot.data, clip: { x: left, y: top, w, h } };
}

/** What the dummy probe came to: the throwaway value showed nowhere, it showed, or the probe stopped. */
export type BrowserInputProbeOutcome = 'hidden' | 'shown' | 'aborted';

/** The field's value, read from the trusted world. */
const VALUE_OF = 'function () { return typeof this.value === "string" ? this.value : null; }';

/**
 * Empties a field the native way when Backspace did not: the element prototype's own value setter (not one the page
 * defined), then an `input` event so a framework's state follows. Run in the trusted world.
 */
const CLEAR_VALUE =
  'function () { const p = this instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const set = Object.getOwnPropertyDescriptor(p, "value")?.set; if (set) set.call(this, ""); this.dispatchEvent(new Event("input", { bubbles: true })); }';

/** Whether a field's document is the top window's: asked in the trusted world. */
const IN_MAIN_FRAME =
  'function () { const view = this.ownerDocument && this.ownerDocument.defaultView; return view !== null && view === view.top; }';

/** How long the probe waits before its second look: an echo a page draws after a short debounce is still seen. */
export const PROBE_SECOND_LOOK_MS = 750;

/**
 * Selects what a field holds and deletes it with a Backspace key: an edit the page sees as one (a framework's own
 * state follows), never Enter, never a blur.
 */
async function emptyField(session: InputCdpSession, objectId: string): Promise<void> {
  await session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: SELECT_CONTENTS, returnByValue: true });
  const key = { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/** What a field holds now, from the trusted world; `undefined` when it is not a text field. */
async function fieldValue(session: InputCdpSession, objectId: string): Promise<string | undefined> {
  const value = objectOf(
    objectOf(
      await ask(session, 'Runtime.callFunctionOn', { objectId, functionDeclaration: VALUE_OF, returnByValue: true }),
    ).result,
  ).value;
  return typeof value === 'string' ? value : undefined;
}

/** Empties a field and proves it: Backspace first, the native setter if that did not do it. Whether it is empty now. */
async function cleared(session: InputCdpSession, objectId: string): Promise<boolean> {
  await emptyField(session, objectId);
  if ((await fieldValue(session, objectId)) === '') return true;
  await session.send('Runtime.callFunctionOn', { objectId, functionDeclaration: CLEAR_VALUE, returnByValue: true });
  return (await fieldValue(session, objectId)) === '';
}

/**
 * THE DUMMY PROBE (docs/input-requests.md, "How long the lock lasts"): whether ONE password field shows what is typed
 * into it in the page's text. The page is checked against `expected` exactly as a write is; the field must be in the
 * page's main frame and EMPTY (a value someone put there is never wiped); the page must hold no WebSocket open (a
 * socket can carry every keystroke unseen) and the browser must be able to report requests. Then a throwaway value
 * (`dummy`) is typed the way the owner's value will be, the page's text is searched for it at once and again after
 * {@link PROBE_SECOND_LOOK_MS}, and the field is emptied and proven empty. Never Enter, never another field.
 *
 * `aborted` (and so the full lock) whenever anything is off: any request or another document while it ran, a socket
 * opened, a field that would not empty, a page that could not be read whole. The test value is never left behind
 * when the field can be emptied at all; the owner's own write selects and replaces whatever is there.
 */
export async function probeInputFields(
  subject: InputSubject,
  expected: BrowserInputFacts,
  fieldIds: readonly string[],
  dummy: string,
  wait: (ms: number) => Promise<void> = async ms => await new Promise(resolve => setTimeout(resolve, ms)),
): Promise<BrowserInputProbeOutcome> {
  const { page } = subject;
  const [field] = fieldIds;
  if (page.isClosed() || page.on === undefined || page.off === undefined) return 'aborted';
  if (page.openSockets === undefined || page.socketsOpened === undefined) return 'aborted';
  if (field === undefined || fieldIds.length !== 1 || page.openSockets() > 0) return 'aborted';
  const socketsBefore = page.socketsOpened();
  let requests = 0;
  const heard = (): void => {
    requests += 1;
  };
  page.on('request', heard);
  let typed: { readonly session: InputCdpSession; readonly objectId: string } | undefined;
  try {
    const known = await checkUnchanged(subject, expected, [{ field, text: dummy }]);
    const target = known.get(field);
    if (target === undefined) return 'aborted';
    const { backendNodeId } = target.field;
    const trusted = await new IsolatedWorlds().resolve(target.session, backendNodeId);
    // Only a field of the main frame: the text the probe reads is the main frame's.
    const main = objectOf(
      objectOf(
        await ask(target.session, 'Runtime.callFunctionOn', {
          objectId: trusted.objectId,
          functionDeclaration: IN_MAIN_FRAME,
          returnByValue: true,
        }),
      ).result,
    ).value;
    if (main !== true) return 'aborted';
    if ((await fieldValue(target.session, trusted.objectId)) !== '') return 'aborted';
    await target.session.send('DOM.focus', { backendNodeId });
    await proveFocus(subject, expected, target.session, trusted.rootContextId, backendNodeId);
    typed = { session: target.session, objectId: trusted.objectId };
    await target.session.send('Input.insertText', { text: dummy });
    let shown = (await readInputText(subject)).includes(dummy);
    if (!shown) {
      await wait(PROBE_SECOND_LOOK_MS);
      shown = (await readInputText(subject)).includes(dummy);
    }
    const empty = await cleared(typed.session, typed.objectId);
    if (empty) typed = undefined;
    if (!empty || requests > 0 || page.socketsOpened() !== socketsBefore) return 'aborted';
    if ((await navigationIdOf(await subject.cdp.page())) !== expected.navigationId) return 'aborted';
    return shown ? 'shown' : 'hidden';
  } catch {
    return 'aborted';
  } finally {
    // A probe that stopped part way still empties what it typed, best effort; the owner's write selects and replaces.
    if (typed !== undefined) await cleared(typed.session, typed.objectId).catch(() => false);
    page.off('request', heard);
  }
}
