#!/usr/bin/env bun
/**
 * The machine's agent-browser worker. The parent leases and launches ONE headless Chrome over the
 * machine's dedicated agent profile; this process attaches only to that loopback CDP endpoint.
 *
 * THERE IS NO ACTIVE TAB. Every request that touches a page names it (`pageId`), every input — a
 * person's or an agent's — is dispatched to that page's own CDP session, and every screencast is
 * pinned to one page. So a person typing into one tab and an agent driving another never cross: the
 * person's keystrokes cannot land in the agent's page, and the agent's work never moves the person's
 * view. Requests on DIFFERENT pages run concurrently; requests on one page run in order; input is
 * never queued behind a slow page load.
 *
 * Each page opens in its OWN WINDOW, in the background, because Chrome only renders — and only
 * screencasts — a tab that is visible in its window: two tabs sharing a window could not both stream.
 * An INCOGNITO page gets its own browser context (its own cookies and storage, shared with nothing),
 * closed with the page.
 */
import { createInterface } from 'node:readline';
import {
  BROWSER_MODIFIERS,
  type BrowserInputEvent,
  type BrowserModifier,
  type BrowserMouseButton,
  type BrowserTarget,
} from '@ferretry/protocol';
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from 'playwright-core';
import { recogniseBrowserChallenge } from '../src/lib/browser/transport/challenge.ts';
import {
  browserElementParam,
  browserTargetParam,
  clickOn,
  readPage,
  shootPage,
  typeInto,
} from '../src/lib/browser/transport/page-acts.ts';
import { type PointerPosition, pointerAfter, pointerSequence } from '../src/lib/browser/transport/pointer.ts';

const endpoint = process.argv[2];
const MAX_PAGES = 200;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_ERROR_CHARS = 200;
const MAX_SCREENSHOT_CHARS = 24 * 1024 * 1024;
const MAX_URL_CHARS = 4_096;
const MAX_TITLE_CHARS = 500;
const TARGET_WAIT_MS = 10_000;

type Request = { readonly id: number; readonly method: string; readonly params: Readonly<Record<string, unknown>> };
type PageState = { readonly state: 'ready' | 'loading' | 'error'; readonly error?: string };
type HeldFrame = { readonly session: CDPSession; readonly cdpSessionId: number };
type Viewport = { width: number; height: number };

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let browserSession: CDPSession | undefined;
let pageSerial = 0;
let frameSerial = 0;
const pageIds = new WeakMap<Page, string>();
const pageStates = new WeakMap<Page, PageState>();
const openers = new WeakMap<Page, string>();
const sessions = new WeakMap<Page, Promise<CDPSession>>();
const targets = new WeakMap<Page, Promise<string>>();
/** The context of each incognito page, closed with it. */
const incognito = new WeakMap<Page, BrowserContext>();
const queues = new Map<string, Promise<unknown>>();
const viewports = new Map<string, Viewport>();
/** Where the person's pointer last was on each page, so a bare press can be preceded by its arrival. */
const pointers = new Map<string, PointerPosition>();
const screencasts = new Map<string, CDPSession>();
const heldFrames = new Map<number, HeldFrame>();
let global: Promise<unknown> = Promise.resolve();

function send(record: unknown): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n|\r/, 1)[0]?.slice(0, MAX_ERROR_CHARS) || 'unknown error';
}

/** Runs work in order behind everything else queued under the same key. */
function queued<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = key === '' ? global : (queues.get(key) ?? Promise.resolve());
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  if (key === '') global = settled;
  else {
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
  }
  return result;
}

function requireContext(): BrowserContext {
  if (!context) throw new Error('Chrome exposed no persistent browser context');
  return context;
}

function pageId(page: Page): string {
  const known = pageIds.get(page);
  if (known) return known;
  pageSerial += 1;
  const id = `pg-${pageSerial.toString(36)}`;
  pageIds.set(page, id);
  return id;
}

function setPageState(page: Page, state: PageState['state'], error?: unknown): void {
  pageStates.set(page, { state, ...(error === undefined ? {} : { error: safeError(error) }) });
}

function registerPage(page: Page): void {
  if (pageIds.has(page)) return;
  pageId(page);
  setPageState(page, 'ready');
  void page
    .opener()
    .then(opener => {
      if (opener) openers.set(page, pageId(opener));
    })
    .catch(() => undefined);
  page.on('request', request => {
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) setPageState(page, 'loading');
    } catch {}
  });
  page.on('domcontentloaded', () => {
    if (pageStates.get(page)?.state !== 'error') setPageState(page, 'ready');
  });
  page.on('load', () => {
    if (pageStates.get(page)?.state !== 'error') setPageState(page, 'ready');
  });
  page.on('crash', () => setPageState(page, 'error', 'the page crashed'));
  page.on('requestfailed', request => {
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        setPageState(page, 'error', request.failure()?.errorText ?? 'navigation failed');
      }
    } catch {}
  });
  page.on('close', () => {
    const id = pageId(page);
    viewports.delete(id);
    pointers.delete(id);
    const cast = screencasts.get(id);
    screencasts.delete(id);
    if (cast) void cast.detach().catch(() => undefined);
    const own = incognito.get(page);
    if (own) void own.close().catch(() => undefined);
  });
}

/** Every open page, in every context — the shared profile's and each incognito one. */
function livePages(): readonly Page[] {
  const pages = (browser?.contexts() ?? []).flatMap(each => each.pages()).filter(page => !page.isClosed());
  for (const page of pages) registerPage(page);
  return pages;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  return value;
}

function dimension(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
  return Math.round(value);
}

function targetPage(id: unknown): Page {
  const wanted = text(id, 'pageId');
  const page = livePages().find(candidate => pageIds.get(candidate) === wanted);
  if (!page) throw new Error('that page is no longer open');
  return page;
}

function safeUrl(page: Page): string {
  try {
    return (page.url() || 'about:blank').slice(0, MAX_URL_CHARS);
  } catch {
    return 'about:blank';
  }
}

async function safeTitle(page: Page): Promise<string> {
  try {
    return (await page.title()).slice(0, MAX_TITLE_CHARS);
  } catch {
    return '';
  }
}

/** The page's own long-lived CDP session: every input, screencast and history read goes through it. */
async function pageSession(page: Page): Promise<CDPSession> {
  let session = sessions.get(page);
  if (session === undefined) {
    session = page.context().newCDPSession(page);
    sessions.set(page, session);
  }
  return await session;
}

async function targetId(page: Page): Promise<string> {
  let id = targets.get(page);
  if (id === undefined) {
    id = pageSession(page).then(async session => {
      const info = (await session.send('Target.getTargetInfo')) as { targetInfo?: { targetId?: string } };
      return info.targetInfo?.targetId ?? '';
    });
    targets.set(page, id);
  }
  return await id;
}

/** Whether the page appears to be asking for a human check — read from what the browser already knows
 *  about it (address, title, frame addresses), running nothing inside the page. */
async function challengeOf(page: Page): Promise<{ challenge?: { provider: string } }> {
  try {
    const challenge = recogniseBrowserChallenge({
      url: safeUrl(page),
      title: await safeTitle(page),
      frameUrls: page.frames().map(each => each.url()),
    });
    return challenge === undefined ? {} : { challenge };
  } catch {
    return {};
  }
}
/** A page that always exists, so a listing is never empty: Chrome's own first tab, or a new one. */
async function anyPage(): Promise<Page> {
  return livePages()[0] ?? (await requireContext().newPage());
}

async function snapshot(focus: Page, extra: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown>> {
  const all = livePages().slice(0, MAX_PAGES);
  const shown = all.includes(focus) || focus.isClosed() ? all : [...all.slice(0, MAX_PAGES - 1), focus];
  let canGoBack = false;
  let canGoForward = false;
  if (!focus.isClosed()) {
    try {
      const history = (await (await pageSession(focus)).send('Page.getNavigationHistory')) as {
        currentIndex?: number;
        entries?: unknown[];
      };
      canGoBack = (history.currentIndex ?? 0) > 0;
      canGoForward = (history.currentIndex ?? 0) < (history.entries?.length ?? 0) - 1;
    } catch {
      // A status can still be honest about tabs when CDP history is briefly unavailable.
    }
  }
  const listed = shown.length === 0 ? [await anyPage()] : shown;
  const active = focus.isClosed() ? (listed[0] as Page) : focus;
  const state = pageStates.get(active) ?? { state: 'ready' as const };
  return {
    url: safeUrl(active),
    title: await safeTitle(active),
    activePageId: pageId(active),
    pages: await Promise.all(
      listed.map(async item => ({
        id: pageId(item),
        url: safeUrl(item),
        title: await safeTitle(item),
        ...(incognito.has(item) ? { incognito: true } : {}),
        ...(openers.has(item) ? { openerId: openers.get(item) } : {}),
        ...(await challengeOf(item)),
      })),
    ),
    pageState: state.state,
    ...(state.state === 'error' ? { pageError: state.error ?? 'unknown error' } : {}),
    canGoBack,
    canGoForward,
    ...extra,
  };
}

async function acted(page: Page, extra: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown>> {
  return { ...(await snapshot(page, extra)), actedPageId: pageId(page) };
}

/** Opens a page in its own background window — in the shared profile, or in a new incognito context. */
async function openPage(private_: boolean): Promise<Page> {
  if (private_) {
    if (!browser) throw new Error('the browser is not connected');
    const own = await browser.newContext({ viewport: null });
    const page = await own.newPage();
    incognito.set(page, own);
    registerPage(page);
    return page;
  }
  if (!browserSession) throw new Error('the browser is not connected');
  const created = (await browserSession.send('Target.createTarget', {
    url: 'about:blank',
    newWindow: true,
    background: true,
  })) as { targetId?: string };
  const deadline = Date.now() + TARGET_WAIT_MS;
  for (;;) {
    for (const page of requireContext().pages())
      if (!page.isClosed() && (await targetId(page)) === created.targetId) {
        registerPage(page);
        return page;
      }
    if (Date.now() > deadline) throw new Error('Chrome opened a window that never appeared');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function applyViewport(page: Page, viewport: Viewport): Promise<void> {
  viewports.set(pageId(page), viewport);
  await (
    await pageSession(page)
  ).send('Emulation.setDeviceMetricsOverride', {
    ...viewport,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function startScreencast(page: Page, viewport: Viewport): Promise<void> {
  const id = pageId(page);
  await stopScreencast(id);
  const session = await pageSession(page);
  screencasts.set(id, session);
  session.on('Page.screencastFrame', event => frame(event, session, page));
  await session.send('Page.enable');
  await applyViewport(page, viewport);
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 50,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });
}

async function stopScreencast(id: string): Promise<void> {
  const session = screencasts.get(id);
  screencasts.delete(id);
  for (const [ackId, held] of heldFrames) if (held.session === session) heldFrames.delete(ackId);
  if (!session) return;
  await session.send('Page.stopScreencast').catch(() => undefined);
}

function frame(
  event: { data?: unknown; sessionId?: unknown; metadata?: { deviceWidth?: unknown; deviceHeight?: unknown } },
  session: CDPSession,
  page: Page,
): void {
  const id = pageId(page);
  if (screencasts.get(id) !== session || typeof event.data !== 'string' || typeof event.sessionId !== 'number') return;
  frameSerial += 1;
  heldFrames.set(frameSerial, { session, cdpSessionId: event.sessionId });
  const viewport = viewports.get(id) ?? DEFAULT_VIEWPORT;
  const width = typeof event.metadata?.deviceWidth === 'number' ? event.metadata.deviceWidth : viewport.width;
  const height = typeof event.metadata?.deviceHeight === 'number' ? event.metadata.deviceHeight : viewport.height;
  send({
    type: 'screencast-frame',
    dataBase64: event.data,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    pageId: id,
    ackId: frameSerial,
  });
}

/** One input event, to exactly the page it names — never to "whatever is active". A bare press first moves
 * the pointer to where it presses (`pointerSequence`), as a real pointer would have. */
async function input(page: Page, value: unknown): Promise<void> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('browser input is required');
  const session = await pageSession(page);
  const id = pageId(page);
  const received = value as BrowserInputEvent;
  const last = pointers.get(id);
  const next = pointerAfter(last, received);
  if (next !== undefined) pointers.set(id, next);
  // Every event is SENT before any reply is awaited: input is never queued, so awaiting the arrival first
  // would let the next event — this press's own release — reach Chrome ahead of the press.
  await Promise.all(pointerSequence(last, received).map(event => dispatch(session, event)));
}

async function dispatch(session: CDPSession, event: BrowserInputEvent): Promise<void> {
  if (event.kind === 'mouse')
    await session.send('Input.dispatchMouseEvent', {
      type: event.type,
      x: event.x,
      y: event.y,
      button: event.button ?? 'none',
      buttons: event.buttons ?? 0,
      clickCount: event.clickCount ?? 0,
      deltaX: event.deltaX ?? 0,
      deltaY: event.deltaY ?? 0,
      modifiers: event.modifiers ?? 0,
      pointerType: 'mouse',
    });
  else if (event.kind === 'key')
    await session.send('Input.dispatchKeyEvent', {
      type: event.type,
      key: event.key,
      code: event.code,
      text: event.type === 'keyDown' ? event.text : undefined,
      unmodifiedText: event.type === 'keyDown' ? event.unmodifiedText : undefined,
      windowsVirtualKeyCode: event.windowsVirtualKeyCode,
      nativeVirtualKeyCode: event.nativeVirtualKeyCode,
      modifiers: event.modifiers ?? 0,
      autoRepeat: event.autoRepeat ?? false,
      isKeypad: event.isKeypad ?? false,
    });
  else if (event.kind === 'insertText' && typeof event.text === 'string')
    await session.send('Input.insertText', { text: event.text });
  else throw new Error('unsupported browser input');
}

/** Requests that touch one page run in that page's own queue; the rest in the global one. */
function keyOf(request: Request): string {
  const id = request.params.pageId;
  return typeof id === 'string' && request.method !== 'dispatchInput' && request.method !== 'ackFrame' ? id : '';
}

async function run(request: Request): Promise<Record<string, unknown>> {
  const params = request.params;
  switch (request.method) {
    case 'navigate': {
      const page = targetPage(params.pageId);
      setPageState(page, 'loading');
      try {
        await page.goto(text(params.url, 'url'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
        setPageState(page, 'ready');
      } catch (error) {
        setPageState(page, 'error', error);
        throw error;
      }
      return await acted(page);
    }
    case 'click': {
      const page = targetPage(params.pageId);
      await clickOn(page, requiredTarget(params), {
        ...(isButton(params.button) ? { button: params.button } : {}),
        ...(params.double === true ? { double: true } : {}),
        ...(Array.isArray(params.modifiers) ? { modifiers: params.modifiers.filter(isModifier) } : {}),
      });
      return await acted(page);
    }
    case 'type': {
      const page = targetPage(params.pageId);
      const target = browserElementParam(legacyTarget(params));
      if (target === undefined) throw new Error('target is required');
      await typeInto(page, target, typeof params.text === 'string' ? params.text : '', {
        ...(params.submit === true ? { submit: true } : {}),
        ...(params.slowly === true ? { slowly: true } : {}),
      });
      return await acted(page);
    }
    case 'read': {
      const page = targetPage(params.pageId);
      const target = browserElementParam(legacyTarget(params));
      // The snapshot names what can be clicked and typed into, each with a ref an act accepts; the
      // visible text is what a person reads.
      const read = await readPage(page, {
        ...(target === undefined ? {} : { target }),
        mode: params.mode === 'a11y' || params.mode === 'snapshot' ? params.mode : 'text',
        ...(typeof params.find === 'string' && params.find ? { find: params.find } : {}),
        ...(typeof params.depth === 'number' && Number.isSafeInteger(params.depth) && params.depth > 0
          ? { depth: params.depth }
          : {}),
        ...(params.boxes === true ? { boxes: true } : {}),
      });
      return await acted(page, { text: read });
    }
    case 'screenshot': {
      const page = targetPage(params.pageId);
      const target = browserElementParam(params.target);
      const shot = await shootPage(page, {
        ...(target === undefined ? {} : { target }),
        ...(params.fullPage === true ? { fullPage: true } : {}),
        format: params.format === 'jpeg' ? 'jpeg' : 'png',
      });
      return await acted(page, {
        screenshotBase64: shot.base64.slice(0, MAX_SCREENSHOT_CHARS),
        screenshotFormat: shot.format,
      });
    }
    case 'back': {
      const page = targetPage(params.pageId);
      await page.goBack({ waitUntil: 'commit', timeout: 30_000 });
      return await acted(page);
    }
    case 'forward': {
      const page = targetPage(params.pageId);
      await page.goForward({ waitUntil: 'commit', timeout: 30_000 });
      return await acted(page);
    }
    case 'reload': {
      const page = targetPage(params.pageId);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      return await acted(page);
    }
    case 'location':
      return await snapshot(typeof params.pageId === 'string' ? targetPage(params.pageId) : await anyPage());
    case 'newPage': {
      const page = await openPage(params.incognito === true);
      await applyViewport(page, DEFAULT_VIEWPORT);
      if (typeof params.url === 'string' && params.url)
        await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return await acted(page);
    }
    case 'closePage': {
      const page = targetPage(params.pageId);
      await stopScreencast(pageId(page));
      await page.close({ runBeforeUnload: false });
      const own = incognito.get(page);
      if (own) await own.close().catch(() => undefined);
      return await acted(page);
    }
    case 'resize': {
      const page = targetPage(params.pageId);
      const viewport = { width: dimension(params.width, 'width'), height: dimension(params.height, 'height') };
      if (screencasts.has(pageId(page))) await startScreencast(page, viewport);
      else await applyViewport(page, viewport);
      return await acted(page);
    }
    case 'startScreencast':
      await startScreencast(targetPage(params.pageId), {
        width: dimension(params.width, 'width'),
        height: dimension(params.height, 'height'),
      });
      return {};
    case 'stopScreencast':
      await stopScreencast(text(params.pageId, 'pageId'));
      return {};
    case 'ackFrame': {
      if (typeof params.ackId !== 'number') throw new Error('ackId is required');
      const held = heldFrames.get(params.ackId);
      if (!held) throw new Error('that screencast frame is no longer held');
      heldFrames.delete(params.ackId);
      await held.session.send('Page.screencastFrameAck', { sessionId: held.cdpSessionId });
      return {};
    }
    case 'dispatchInput':
      await input(targetPage(params.pageId), params.input);
      return {};
    case 'close':
      for (const id of [...screencasts.keys()]) await stopScreencast(id);
      await browser?.close().catch(() => undefined);
      return {};
    default:
      throw new Error(`unknown browser worker method: ${request.method}`);
  }
}

/** A request's target — or, from a daemon older than refs, its bare `selector`. */
function legacyTarget(params: Readonly<Record<string, unknown>>): unknown {
  if (params.target !== undefined) return params.target;
  return typeof params.selector === 'string' && params.selector
    ? { kind: 'selector', selector: params.selector }
    : undefined;
}

function requiredTarget(params: Readonly<Record<string, unknown>>): BrowserTarget {
  const target = browserTargetParam(legacyTarget(params));
  if (target === undefined) throw new Error('target is required');
  return target;
}

const isButton = (value: unknown): value is BrowserMouseButton =>
  value === 'left' || value === 'right' || value === 'middle';

const isModifier = (value: unknown): value is BrowserModifier =>
  typeof value === 'string' && (BROWSER_MODIFIERS as readonly string[]).includes(value);

function parse(line: string): Request {
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('worker request must be an object');
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id) || typeof raw.method !== 'string' || !raw.method)
    throw new Error('worker request is invalid');
  return {
    id: raw.id,
    method: raw.method,
    params:
      raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
        ? (raw.params as Record<string, unknown>)
        : {},
  };
}

async function answer(request: Request): Promise<void> {
  try {
    const result = await run(request);
    send({ id: request.id, ok: true, result });
    if (request.method === 'close') process.exit(0);
  } catch (error) {
    send({ id: request.id, ok: false, error: safeError(error) });
  }
}

export async function startBrowserWorker(): Promise<void> {
  if (!endpoint) {
    send({ type: 'fatal', error: 'a CDP endpoint is required' });
    process.exitCode = 2;
    return;
  }
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    context = browser.contexts()[0];
    if (!context) throw new Error('Chrome exposed no persistent browser context');
    browserSession = await browser.newBrowserCDPSession();
    context.on('page', page => registerPage(page));
    livePages();
    send({ type: 'ready' });
  } catch (error) {
    send({ type: 'fatal', error: safeError(error) });
    process.exitCode = 1;
    return;
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    let request: Request;
    try {
      request = parse(line);
    } catch (error) {
      send({ id: undefined, ok: false, error: safeError(error) });
      return;
    }
    // Input and frame acknowledgements never wait: a person typing must not queue behind a page load.
    if (request.method === 'dispatchInput' || request.method === 'ackFrame') void answer(request);
    else void queued(keyOf(request), async () => await answer(request));
  });
  process.stdin.on('end', () => {
    void Promise.all([...screencasts.keys()].map(id => stopScreencast(id))).finally(
      () => void browser?.close().finally(() => process.exit(0)),
    );
  });
}

if (import.meta.main) await startBrowserWorker();
