#!/usr/bin/env bun
/**
 * Cross-platform partner-browser worker. The parent leases and launches Chrome
 * with a disposable profile; this process attaches only to that loopback CDP
 * endpoint, so a human and an agent retain the same cookies and tabs.
 */
import { createInterface } from 'node:readline';
import type { BrowserInputEvent } from '@ferretry/protocol';
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from 'playwright-core';

const endpoint = process.argv[2];
const MAX_PAGES = 40;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_ERROR_CHARS = 200;
const MAX_TEXT_CHARS = 200_000;
const MAX_SCREENSHOT_CHARS = 24 * 1024 * 1024;
const MAX_URL_CHARS = 4_096;
const MAX_TITLE_CHARS = 500;

type Request = { readonly id: number; readonly method: string; readonly params: Readonly<Record<string, unknown>> };
type PageState = { readonly state: 'ready' | 'loading' | 'error'; readonly error?: string };
type HeldFrame = { readonly session: CDPSession; readonly cdpSessionId: number };

let browser: Browser | undefined;
let context: BrowserContext | undefined;
let activePage: Page | undefined;
let viewport: { width: number; height: number } = DEFAULT_VIEWPORT;
let screencastPage: Page | undefined;
let screencastSession: CDPSession | undefined;
let screencastEnabled = false;
let serial = Promise.resolve();
let pageSerial = 0;
let frameSerial = 0;
let knownPages: readonly Page[] = [];
const pageIds = new WeakMap<Page, string>();
const pageStates = new WeakMap<Page, PageState>();
const heldFrames = new Map<number, HeldFrame>();

function send(record: unknown): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n|\r/, 1)[0]?.slice(0, MAX_ERROR_CHARS) || 'unknown error';
}

function schedule<T>(work: () => Promise<T>): Promise<T> {
  const result = serial.then(work);
  serial = result.then(
    () => undefined,
    () => undefined,
  );
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
  page.on('request', request => {
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) setPageState(page, 'loading');
    } catch {}
  });
  page.on('domcontentloaded', () => {
    if (pageStates.get(page)?.state !== 'error') setPageState(page, 'ready');
    rebindWhenActive(page);
  });
  page.on('load', () => {
    if (pageStates.get(page)?.state !== 'error') setPageState(page, 'ready');
  });
  page.on('crash', () => {
    setPageState(page, 'error', 'the page crashed');
    rebindWhenActive(page);
  });
  page.on('requestfailed', request => {
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        setPageState(page, 'error', request.failure()?.errorText ?? 'navigation failed');
      }
    } catch {}
  });
  page.on('close', () => void schedule(async () => await recoverAfterClose(page)));
}

function livePages(): readonly Page[] {
  const pages = requireContext()
    .pages()
    .filter(page => !page.isClosed());
  for (const page of pages) registerPage(page);
  knownPages = pages;
  return pages;
}

async function selectPage(page: Page): Promise<void> {
  registerPage(page);
  activePage = page;
  if (screencastEnabled) await refreshScreencast(true);
}

async function active(): Promise<Page> {
  if (activePage && !activePage.isClosed()) return activePage;
  const index = activePage ? knownPages.indexOf(activePage) : 0;
  const pages = livePages();
  const replacement = pages[Math.max(0, index)] ?? pages.at(-1) ?? (await requireContext().newPage());
  await selectPage(replacement);
  return replacement;
}

async function recoverAfterClose(closed: Page): Promise<void> {
  if (activePage !== closed && activePage && !activePage.isClosed()) {
    livePages();
    return;
  }
  activePage = undefined;
  await active();
}

function rebindWhenActive(page: Page): void {
  void schedule(async () => {
    if (screencastEnabled && screencastPage === page && !page.isClosed()) await refreshScreencast(true);
  }).catch(() => undefined);
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
  const page = livePages().find(candidate => pageIds.get(candidate) === text(id, 'pageId'));
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

async function usingSession<T>(page: Page, work: (session: CDPSession) => Promise<T>): Promise<T> {
  if (page === screencastPage && screencastSession) return await work(screencastSession);
  const session = await requireContext().newCDPSession(page);
  try {
    return await work(session);
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function snapshot(extra: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown>> {
  const page = await active();
  const all = livePages();
  let shown = all.slice(0, MAX_PAGES);
  if (!shown.includes(page)) shown = [...shown.slice(0, MAX_PAGES - 1), page];
  let canGoBack = false;
  let canGoForward = false;
  try {
    await usingSession(page, async session => {
      const history = (await session.send('Page.getNavigationHistory')) as {
        currentIndex?: number;
        entries?: unknown[];
      };
      canGoBack = (history.currentIndex ?? 0) > 0;
      canGoForward = (history.currentIndex ?? 0) < (history.entries?.length ?? 0) - 1;
    });
  } catch {
    // A status can still be honest about tabs when CDP history is briefly unavailable.
  }
  const state = pageStates.get(page) ?? { state: 'ready' as const };
  return {
    url: safeUrl(page),
    title: await safeTitle(page),
    activePageId: pageId(page),
    pages: await Promise.all(
      shown.map(async item => ({ id: pageId(item), url: safeUrl(item), title: await safeTitle(item) })),
    ),
    pageState: state.state,
    ...(state.state === 'error' ? { pageError: state.error ?? 'unknown error' } : {}),
    canGoBack,
    canGoForward,
    ...extra,
  };
}

async function action(page: Page, extra: Readonly<Record<string, unknown>> = {}): Promise<Record<string, unknown>> {
  return { ...(await snapshot(extra)), actedPageId: pageId(page) };
}

async function stopScreencast(): Promise<void> {
  const session = screencastSession;
  screencastSession = undefined;
  screencastPage = undefined;
  heldFrames.clear();
  if (!session) return;
  await session.send('Page.stopScreencast').catch(() => undefined);
  await session.detach().catch(() => undefined);
}

function frame(
  event: { data?: unknown; sessionId?: unknown; metadata?: { deviceWidth?: unknown; deviceHeight?: unknown } },
  session: CDPSession,
  page: Page,
): void {
  if (session !== screencastSession || typeof event.data !== 'string' || typeof event.sessionId !== 'number') return;
  frameSerial += 1;
  heldFrames.set(frameSerial, { session, cdpSessionId: event.sessionId });
  const width = typeof event.metadata?.deviceWidth === 'number' ? event.metadata.deviceWidth : viewport.width;
  const height = typeof event.metadata?.deviceHeight === 'number' ? event.metadata.deviceHeight : viewport.height;
  send({
    type: 'screencast-frame',
    dataBase64: event.data,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    pageId: pageId(page),
    ackId: frameSerial,
  });
}

async function refreshScreencast(force = false): Promise<void> {
  if (!screencastEnabled) return;
  const page = await active();
  if (!force && page === screencastPage && screencastSession) return;
  await stopScreencast();
  const session = await requireContext().newCDPSession(page);
  screencastPage = page;
  screencastSession = session;
  session.on('Page.screencastFrame', event => frame(event, session, page));
  await session.send('Page.enable');
  await session.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });
  await session.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 50,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });
}

async function input(value: unknown): Promise<void> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('browser input is required');
  await refreshScreencast();
  if (!screencastSession) throw new Error('browser input requires an active viewer');
  const event = value as BrowserInputEvent;
  if (event.kind === 'mouse')
    await screencastSession.send('Input.dispatchMouseEvent', {
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
    await screencastSession.send('Input.dispatchKeyEvent', {
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
    await screencastSession.send('Input.insertText', { text: event.text });
  else throw new Error('unsupported browser input');
}

async function run(request: Request): Promise<Record<string, unknown>> {
  const params = request.params;
  switch (request.method) {
    case 'navigate': {
      const page = await active();
      setPageState(page, 'loading');
      try {
        await page.goto(text(params.url, 'url'), { waitUntil: 'domcontentloaded', timeout: 45_000 });
        setPageState(page, 'ready');
      } catch (error) {
        setPageState(page, 'error', error);
        throw error;
      }
      await refreshScreencast();
      return await action(page);
    }
    case 'click': {
      const page = await active();
      await page.locator(text(params.selector, 'selector')).first().click({ timeout: 30_000 });
      await refreshScreencast();
      return await action(page);
    }
    case 'type': {
      const page = await active();
      await page
        .locator(text(params.selector, 'selector'))
        .first()
        .fill(text(params.text, 'text'), { timeout: 30_000 });
      return await action(page);
    }
    case 'read': {
      const page = await active();
      const selector = typeof params.selector === 'string' && params.selector ? params.selector : 'body';
      return await action(page, {
        text: (await page.locator(selector).first().innerText({ timeout: 30_000 })).slice(0, MAX_TEXT_CHARS),
      });
    }
    case 'screenshot': {
      const page = await active();
      return await action(page, {
        screenshotBase64: (await page.screenshot({ type: 'png', fullPage: false }))
          .toString('base64')
          .slice(0, MAX_SCREENSHOT_CHARS),
      });
    }
    case 'back': {
      const page = await active();
      await page.goBack({ waitUntil: 'commit', timeout: 30_000 });
      await refreshScreencast();
      return await action(page);
    }
    case 'forward': {
      const page = await active();
      await page.goForward({ waitUntil: 'commit', timeout: 30_000 });
      await refreshScreencast();
      return await action(page);
    }
    case 'reload': {
      const page = await active();
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await refreshScreencast();
      return await action(page);
    }
    case 'location':
      return await snapshot();
    case 'newPage': {
      const page = await requireContext().newPage();
      await selectPage(page);
      if (typeof params.url === 'string' && params.url)
        await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      return await action(page);
    }
    case 'activatePage': {
      const page = targetPage(params.pageId);
      await selectPage(page);
      return await action(page);
    }
    case 'closePage': {
      const page = targetPage(params.pageId);
      await page.close({ runBeforeUnload: false });
      return await action(page);
    }
    case 'resize': {
      const page = await active();
      viewport = { width: dimension(params.width, 'width'), height: dimension(params.height, 'height') };
      await usingSession(
        page,
        async session =>
          await session.send('Emulation.setDeviceMetricsOverride', {
            ...viewport,
            deviceScaleFactor: 1,
            mobile: false,
          }),
      );
      await refreshScreencast(true);
      return await action(page);
    }
    case 'startScreencast':
      viewport = { width: dimension(params.width, 'width'), height: dimension(params.height, 'height') };
      screencastEnabled = true;
      await refreshScreencast(true);
      return {};
    case 'stopScreencast':
      screencastEnabled = false;
      await stopScreencast();
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
      await input(params.input);
      return {};
    case 'close':
      screencastEnabled = false;
      await stopScreencast();
      await browser?.close().catch(() => undefined);
      return {};
    default:
      throw new Error(`unknown browser worker method: ${request.method}`);
  }
}

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
    context.on('page', page => {
      registerPage(page);
      void schedule(async () => await selectPage(page)).catch(() => undefined);
    });
    activePage = livePages().at(-1) ?? (await context.newPage());
    registerPage(activePage);
    send({ type: 'ready' });
  } catch (error) {
    send({ type: 'fatal', error: safeError(error) });
    process.exitCode = 1;
    return;
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on(
    'line',
    line =>
      void schedule(async () => {
        let request: Request | undefined;
        try {
          request = parse(line);
          const result = await run(request);
          send({ id: request.id, ok: true, result });
          if (request.method === 'close') process.exit(0);
        } catch (error) {
          send({ id: request?.id, ok: false, error: safeError(error) });
        }
      }),
  );
  process.stdin.on('end', () => {
    screencastEnabled = false;
    void stopScreencast().finally(() => void browser?.close().finally(() => process.exit(0)));
  });
}

if (import.meta.main) await startBrowserWorker();
