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
} from './input-contracts.ts';
import { type ActablePage, BROWSER_PROBE_TIMEOUT_MS, browserElementOf } from './page-acts.ts';

/**
 * WHAT THE BROWSER WORKER DOES FOR THE INPUT BRIDGE (docs/input-requests.md, "Pages"): look at the fields an
 * agent pointed at, take a picture of them, and — only after checking that nothing changed — type an owner's
 * values into them.
 *
 * Written against {@link InputablePage} and {@link InputCdpSession}, the slices of a Playwright page and a
 * DevTools session these calls touch, so each rule is tested with fakes and no browser.
 *
 * THE BROWSER DECIDES, THE PAGE IS NOT ASKED. The agent's pointer (a ref or a selector) only says where to
 * look. The node, its frame, its attributes and the document come from DevTools; the only thing the page's own
 * script is made to do is carry a one-time marker attribute on the element, so the element can be found again
 * by DevTools, and the marker is always taken off.
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
}

/** The element a locator resolved, held while the marker is on it. */
export interface InputHandle {
  ownerFrame(): Promise<InputFrame | null>;
  /** Sets {@link INPUT_MARKER} on the element to `token`; the one thing the page's own script is made to carry. */
  mark(token: string): Promise<void>;
  /** Takes {@link INPUT_MARKER} off the element. */
  unmark(): Promise<void>;
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

/** The attribute that marks the one element being looked at, so DevTools can find it again. */
export const INPUT_MARKER = 'data-fy-input';
const SELECT_CONTENTS = 'function () { if (typeof this.select === "function") this.select(); }';
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
  return { navigationId: await navigationIdOf(await subject.cdp.page()) };
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

/** The one session that owns an element's frame: the page's, or an out-of-process frame's own. */
async function sessionOwning(
  subject: InputSubject,
  frame: InputFrame,
): Promise<{ readonly session: InputCdpSession; readonly owned: boolean }> {
  const own = await subject.cdp.page();
  if (frame === subject.page.mainFrame()) return { session: own, owned: false };
  try {
    return { session: await subject.cdp.frame(frame), owned: true };
  } catch {
    return { session: own, owned: false };
  }
}

/** The element's node, found by DevTools from the marker alone, or a refusal when it is not exactly one. */
async function findMarked(session: InputCdpSession, token: string): Promise<Record<string, unknown>> {
  await ask(session, 'DOM.getDocument', { depth: 0 });
  const search = await ask(session, 'DOM.performSearch', {
    query: `[${INPUT_MARKER}="${token}"]`,
    includeUserAgentShadowDOM: true,
  });
  const searchId = search.searchId;
  if (typeof searchId !== 'string') throw new Error(REFUSALS.unidentified);
  try {
    const count = search.resultCount;
    if (count !== 1) throw new Error(REFUSALS.unidentified);
    const results = await ask(session, 'DOM.getSearchResults', { searchId, fromIndex: 0, toIndex: 1 });
    const nodeIds = Array.isArray(results.nodeIds) ? (results.nodeIds as readonly unknown[]) : [];
    const nodeId = nodeIds[0];
    if (nodeIds.length !== 1 || typeof nodeId !== 'number' || nodeId <= 0) throw new Error(REFUSALS.unidentified);
    return objectOf((await ask(session, 'DOM.describeNode', { nodeId })).node);
  } finally {
    await session.send('DOM.discardSearchResults', { searchId }).catch(() => undefined);
  }
}

/** Looks at one field: its frame, node, attributes and box. `undefined` when the element is not on the page. */
async function observeField(
  subject: InputSubject,
  pointer: BrowserInputFieldPointer,
  token: string,
): Promise<InputBrowserFieldFacts | undefined> {
  let handle: InputHandle | null;
  try {
    const element = (await browserElementOf(
      subject.page as unknown as ActablePage,
      pointer.target as BrowserElementTarget,
    )) as unknown as InputLocator;
    if ((await element.count().catch(() => 0)) === 0) return undefined;
    handle = await element.elementHandle({ timeout: BROWSER_PROBE_TIMEOUT_MS });
  } catch {
    return undefined;
  }
  if (handle === null) return undefined;
  let marked = false;
  try {
    const frame = await handle.ownerFrame();
    if (frame === null) throw new Error(REFUSALS.frameless);
    marked = true;
    await handle.mark(token);
    const { session, owned } = await sessionOwning(subject, frame);
    const node = await findMarked(session, token);
    const backendNodeId = node.backendNodeId;
    if (typeof backendNodeId !== 'number' || !Number.isSafeInteger(backendNodeId) || backendNodeId <= 0)
      throw new Error(REFUSALS.unidentified);
    const info = objectOf(objectOf(await ask(session, 'Target.getTargetInfo')).targetInfo);
    const frameId = typeof info.targetId === 'string' ? oneLine(info.targetId, FRAME_ID_LIMIT) : '';
    if (frameId === '') throw new Error(REFUSALS.unidentified);
    subject.sessions.remember(frameId, session, owned);
    const box = (await handle.boundingBox().catch(() => null)) ?? { x: 0, y: 0, width: 0, height: 0 };
    const visible = (await handle.isVisible().catch(() => false)) && box.width > 0 && box.height > 0;
    return {
      fieldId: pointer.id,
      frameOrigin: originOfUrl(frame.url()),
      frameId,
      backendNodeId,
      field: inputFieldAttributes(node),
      box: { x: box.x, y: box.y, w: box.width, h: box.height },
      visible,
    };
  } finally {
    if (marked) await handle.unmark().catch(() => undefined);
    await handle.dispose().catch(() => undefined);
  }
}

/**
 * What the fields are, as the browser sees them: the page's origin and document, and for each field its
 * frame, node, attributes and box. A field whose element is not on the page answers `missing`.
 */
export async function observeInputFields(
  subject: InputSubject,
  fields: readonly BrowserInputFieldPointer[],
): Promise<BrowserInputObservation> {
  const { page } = subject;
  const observed: InputBrowserFieldFacts[] = [];
  for (const pointer of fields) {
    const token = crypto.randomUUID().replaceAll('-', '');
    const found = await observeField(subject, pointer, token);
    if (found === undefined) return { ok: false, missing: pointer.id };
    observed.push(found);
  }
  const url = page.url();
  const challenge = recogniseBrowserChallenge({
    url,
    title: await titleOf(page),
    frameUrls: page.frames().map(frame => frame.url()),
  });
  const facts = {
    kind: 'browser',
    pageId: subject.pageId,
    origin: originOfUrl(url),
    secure: isSecureUrl(url),
    navigationId: await navigationIdOf(await subject.cdp.page()),
    fields: observed,
    ...(challenge === undefined ? {} : { challenge }),
  } satisfies BrowserInputFacts;
  return { ok: true, facts };
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

/** Focuses the node and proves the page's focus is on it, not on something else the page moved focus to. */
async function focusExactly(session: InputCdpSession, backendNodeId: number): Promise<void> {
  await session.send('DOM.focus', { backendNodeId });
  const active = objectOf(objectOf(await ask(session, 'Runtime.evaluate', { expression: ACTIVE_ELEMENT })).result);
  if (typeof active.objectId !== 'string') throw new Refusal();
  const node = objectOf((await ask(session, 'DOM.describeNode', { objectId: active.objectId })).node);
  if (node.backendNodeId !== backendNodeId) throw new Refusal();
}

async function selectContents(session: InputCdpSession, backendNodeId: number): Promise<void> {
  const resolved = objectOf(objectOf(await ask(session, 'DOM.resolveNode', { backendNodeId })).object);
  if (typeof resolved.objectId !== 'string') throw new Refusal();
  await session.send('Runtime.callFunctionOn', {
    objectId: resolved.objectId,
    functionDeclaration: SELECT_CONTENTS,
    returnByValue: true,
  });
}

async function pressEnter(session: InputCdpSession): Promise<void> {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key, text: '\r' });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

/**
 * The one write. The page is checked against `expected` first — the same document and origin, and every
 * expected node answering with the same tag and attributes — and NOTHING is written if anything differs
 * (`target_changed`, or `target_gone` for a closed page). Then, for each value in order: focus the node, prove
 * the focus landed there, select what it holds, insert the text. Enter goes to the last field when `submit`.
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
    let last: InputCdpSession | undefined;
    for (const value of values) {
      const target = known.get(value.field);
      if (target === undefined) throw new Refusal();
      await focusExactly(target.session, target.field.backendNodeId);
      await selectContents(target.session, target.field.backendNodeId);
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
