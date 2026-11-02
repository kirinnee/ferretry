#!/usr/bin/env bun
/**
 * The machine's agent-browser worker. The parent leases and launches ONE Chrome over the machine's
 * dedicated agent profile, and this process drives only that Chrome, by the transport the parent chose:
 * `pipe` — the other ends of Chrome's DevTools pipe, handed over as fds 3 (requests to Chrome) and 4
 * (replies and events from it), which nobody else on the host holds and which take Chrome down with this
 * process — or the loopback CDP endpoint URL Chrome listens on.
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
import { closeSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import {
  BROWSER_MODIFIERS,
  type BrowserElementTarget,
  type BrowserInputEvent,
  type BrowserModifier,
  type BrowserMouseButton,
  BrowserPageLifecycleRequestSchema,
  type BrowserTarget,
  InputTargetFactsSchema,
} from '@ferretry/protocol';
import {
  type Browser,
  type BrowserContext,
  type CDPSession,
  chromium,
  type ElementHandle,
  type Locator,
  type Page,
  type WebSocket,
} from 'playwright-core';
import {
  CDP_PIPE_ENDPOINT,
  CDP_PIPE_FROM_CHROME_FD,
  CDP_PIPE_TO_CHROME_FD,
  CdpPipeTransport,
} from '../src/lib/browser/transport/cdp-pipe.ts';
import { recogniseBrowserChallenge } from '../src/lib/browser/transport/challenge.ts';
import { type CopyablePage, readCopyElement } from '../src/lib/browser/transport/copy-read.ts';
import { DownloadStage } from '../src/lib/browser/transport/download-stage.ts';
import type {
  BrowserInputClearJob,
  BrowserInputFacts,
  BrowserInputValue,
} from '../src/lib/browser/transport/input-contracts.ts';
import {
  armInputFields,
  clearInputFields,
  describeInputDocument,
  type InputablePage,
  type InputCdpSession,
  InputFrameSessions,
  type InputHandle,
  type InputLocator,
  type InputSubject,
  observeInputFields,
  playwrightNodeOf,
  probeInputFields,
  readInputText,
  refindInputFields,
  shootInputFields,
  typeInputFields,
} from '../src/lib/browser/transport/input-fields.ts';
import {
  browserElementParam,
  browserTargetParam,
  clickOn,
  printPdf,
  readPage,
  shootPage,
  typeInto,
  uploadFiles,
} from '../src/lib/browser/transport/page-acts.ts';
import {
  ConsoleLog,
  NetworkLog,
  PageDialogs,
  PageEmulation,
  runLifecycleRequest,
  type WaitablePage,
} from '../src/lib/browser/transport/page-lifecycle.ts';
import { runPageScript } from '../src/lib/browser/transport/page-script.ts';
import { disablePasskeys } from '../src/lib/browser/transport/passkeys.ts';
import { type PointerPosition, pointerAfter, pointerSequence } from '../src/lib/browser/transport/pointer.ts';
import { type PointerPage, performPointerAct, pointerActParam } from '../src/lib/browser/transport/pointer-acts.ts';
import { type PushNumberPage, readPushNumber } from '../src/lib/browser/transport/push-number-read.ts';

const endpoint = process.argv[2];
/** Where downloads and PDFs are staged for the daemon; without it the worker stages nothing. */
const stageDirectory = process.argv[3];
const downloads = new DownloadStage({
  directory: stageDirectory,
  disk: {
    mkdirp: async directory => void (await mkdir(directory, { recursive: true, mode: 0o700 })),
    size: async file => (await stat(file)).size,
    remove: async file => await rm(file, { force: true }),
    write: async (file, bytes) => await writeFile(file, bytes, { mode: 0o600 }),
  },
  now: () => Date.now(),
  sleep: async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds)),
});
const MAX_PAGES = 200;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_ERROR_CHARS = 200;
const MAX_SCREENSHOT_CHARS = 24 * 1024 * 1024;
const MAX_URL_CHARS = 4_096;
/** How long the DevTools handshake over the pipe may take: a cold Chrome is still starting when it begins. */
const CONNECT_TIMEOUT_MS = 20_000;
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
/** What each page is holding, logging and emulating — all of it forgotten with the page. */
const dialogs = new PageDialogs();
const consoles = new Map<string, ConsoleLog>();
const networks = new Map<string, NetworkLog>();
const emulations = new Map<string, PageEmulation>();
/** Which DevTools session owns each frame the input bridge has looked at, per page. */
const inputSessions = new Map<string, InputFrameSessions>();
/** The last title a page answered with: `page.title()` hangs while a dialog is open. */
const titles = new WeakMap<Page, string>();
const TITLE_WAIT_MS = 750;
/** The acts that can be stuck behind a dialog the page opened. */
const DIALOG_RACED = new Set([
  'navigate',
  'click',
  'type',
  'read',
  'screenshot',
  'back',
  'forward',
  'reload',
  'evaluate',
]);

/**
 * Chrome's DevTools pipe, as the transport Playwright's `connectOverCDP` takes. The daemon's ends are
 * NON-BLOCKING sockets, which file streams fail on with EAGAIN, so each runtime gets the reader that waits
 * for them properly: a source worker runs under Node, whose `net.Socket` does; the compiled worker runs
 * under Bun, whose `net.Socket` does not but whose `Bun.file(fd)` does. Ending the request side is what
 * tells Chrome to quit.
 */
function chromePipe(): CdpPipeTransport {
  return typeof globalThis.Bun === 'undefined' ? nodeChromePipe() : bunChromePipe();
}

function nodeChromePipe(): CdpPipeTransport {
  const toChrome = new Socket({ fd: CDP_PIPE_TO_CHROME_FD, readable: false, writable: true });
  const fromChrome = new Socket({ fd: CDP_PIPE_FROM_CHROME_FD, readable: true, writable: false });
  const transport = new CdpPipeTransport({
    write: bytes => void toChrome.write(bytes),
    close: () => void toChrome.end(() => toChrome.destroy()),
  });
  // A write that fails means Chrome is gone, and the read side reports that end.
  toChrome.on('error', () => undefined);
  fromChrome.on('data', (chunk: Buffer) => transport.receive(chunk));
  fromChrome.on('end', () => transport.ended());
  fromChrome.on('error', error => transport.ended(safeError(error)));
  return transport;
}

/** Neither `Bun.file` reader nor writer closes a descriptor it did not open, so closing fd 3 is explicit. */
function bunChromePipe(): CdpPipeTransport {
  const toChrome = Bun.file(CDP_PIPE_TO_CHROME_FD).writer();
  const transport = new CdpPipeTransport({
    write: bytes => {
      toChrome.write(bytes);
      void toChrome.flush();
    },
    close: () => {
      void Promise.resolve(toChrome.end())
        .catch(() => undefined)
        .finally(() => closeSync(CDP_PIPE_TO_CHROME_FD));
    },
  });
  void (async () => {
    try {
      for await (const chunk of Bun.file(CDP_PIPE_FROM_CHROME_FD).stream()) transport.receive(chunk);
      transport.ended();
    } catch (error) {
      transport.ended(safeError(error));
    }
  })();
  return transport;
}

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

function logOf<T>(logs: Map<string, T>, key: string, make: () => T): T {
  let log = logs.get(key);
  if (log === undefined) {
    log = make();
    logs.set(key, log);
  }
  return log;
}

/** Listeners that only ever record: a failure in one must not become a failure of the page. */
function watch(page: Page, key: string): void {
  const guarded =
    <A extends unknown[]>(handler: (...args: A) => void) =>
    (...args: A): void => {
      try {
        handler(...args);
      } catch {}
    };
  page.on(
    'dialog',
    guarded(dialog => dialogs.hold(key, dialog)),
  );
  page.on(
    'console',
    guarded(message =>
      logOf(consoles, key, () => new ConsoleLog()).add(message.type(), message.text(), message.location()),
    ),
  );
  page.on(
    'pageerror',
    guarded(error => logOf(consoles, key, () => new ConsoleLog()).add('error', error.message)),
  );
  page.on(
    'request',
    guarded(request => logOf(networks, key, () => new NetworkLog()).started(request)),
  );
  page.on(
    'response',
    guarded(response => logOf(networks, key, () => new NetworkLog()).responded(response.request(), response)),
  );
  page.on(
    'requestfinished',
    guarded(
      request =>
        void logOf(networks, key, () => new NetworkLog())
          .finished(request)
          .catch(() => undefined),
    ),
  );
  page.on(
    'requestfailed',
    guarded(request =>
      logOf(networks, key, () => new NetworkLog()).failed(request, request.failure()?.errorText ?? 'request failed'),
    ),
  );
}

function registerPage(page: Page): void {
  if (pageIds.has(page)) return;
  const key = pageId(page);
  // The WebSockets the page holds open: the dummy probe will not type where a socket may carry each keystroke.
  const sockets = new Set<WebSocket>();
  openSockets.set(page, sockets);
  page.on('websocket', socket => {
    sockets.add(socket);
    socketsOpened.set(page, (socketsOpened.get(page) ?? 0) + 1);
    socket.on('close', () => sockets.delete(socket));
  });
  watch(page, key);
  setPageState(page, 'ready');
  void page
    .opener()
    .then(opener => {
      if (opener) openers.set(page, pageId(opener));
    })
    .catch(() => undefined);
  page.on('download', download => downloads.accept(pageId(page), download));
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
  // Every page, popups included, finds no passkey: the owner's card supplies a password instead.
  void pageSession(page)
    .then(async session => await disablePasskeys(session as unknown as InputCdpSession))
    .catch(() => undefined);
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
    dialogs.drop(id);
    consoles.delete(id);
    networks.delete(id);
    emulations.delete(id);
    inputSessions.get(id)?.release();
    inputSessions.delete(id);
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

/** Gives up on slow work after `ms` rather than hang a status behind a page that cannot answer. */
async function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('the page did not answer in time')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function safeTitle(page: Page): Promise<string> {
  const known = titles.get(page) ?? '';
  if (dialogs.pending(pageId(page)) !== undefined) return known;
  try {
    const title = (await within(TITLE_WAIT_MS, page.title())).slice(0, MAX_TITLE_CHARS);
    titles.set(page, title);
    return title;
  } catch {
    return known;
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

/** The page's CDP session, as the acts that need DevTools directly see it. */
async function cdpOf(
  page: Page,
): Promise<{ send(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown> }> {
  const session = await pageSession(page);
  return {
    send: async (method, params) =>
      await (session as { send(m: string, p: unknown): Promise<unknown> }).send(method, params),
  };
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

function inputHandleOf(handle: ElementHandle): InputHandle {
  return {
    ownerFrame: async () => await handle.ownerFrame(),
    describe: async () => await playwrightNodeOf(handle),
    boundingBox: async () => await handle.boundingBox(),
    isVisible: async () => await handle.isVisible(),
    dispose: async () => await handle.dispose(),
  };
}

function inputLocatorOf(locator: Locator): InputLocator {
  return {
    first: () => inputLocatorOf(locator.first()),
    nth: index => inputLocatorOf(locator.nth(index)),
    count: async () => await locator.count(),
    elementHandle: async options => {
      const handle = await locator.elementHandle(options);
      return handle === null ? null : inputHandleOf(handle);
    },
  };
}

/** The page as the input bridge sees it: Playwright for the element, DevTools for the node. */
/** Each page's open WebSockets (`registerPage`). */
const openSockets = new WeakMap<Page, Set<WebSocket>>();
/** How many WebSockets each page has ever opened. */
const socketsOpened = new WeakMap<Page, number>();

function inputSubject(page: Page): InputSubject {
  const key = pageId(page);
  let sessions = inputSessions.get(key);
  if (sessions === undefined) {
    sessions = new InputFrameSessions();
    inputSessions.set(key, sessions);
  }
  return {
    pageId: key,
    page: {
      locator: (selector: string) => inputLocatorOf(page.locator(selector)),
      isClosed: () => page.isClosed(),
      url: () => safeUrl(page),
      title: async () => await safeTitle(page),
      mainFrame: () => page.mainFrame(),
      frames: () => page.frames(),
      on: (event: 'request', listener: () => void) => page.on(event, listener),
      off: (event: 'request', listener: () => void) => page.off(event, listener),
      openSockets: () => openSockets.get(page)?.size ?? 0,
      socketsOpened: () => socketsOpened.get(page) ?? 0,
    } as unknown as InputablePage,
    cdp: {
      page: async () => (await pageSession(page)) as unknown as InputCdpSession,
      frame: async frame => (await page.context().newCDPSession(frame as never)) as unknown as InputCdpSession,
    },
    sessions,
  };
}

/** The input bridge's browser facts or values, as the worker receives them: parsed, because it trusts no line. */
function browserFactsParam(value: unknown): BrowserInputFacts {
  const parsed = InputTargetFactsSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== 'browser') throw new Error('facts are not browser facts');
  return parsed.data;
}

function inputPointers(value: unknown): { readonly id: string; readonly target: BrowserElementTarget }[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('fields are required');
  return value.map(item => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const target = browserElementParam(raw.target);
    if (typeof raw.id !== 'string' || raw.id === '' || target === undefined)
      throw new Error('a field needs an id and a target');
    return { id: raw.id, target };
  });
}

/**
 * The one write of an owner's values. EVERYTHING is caught here and answers a word, because `answer` would
 * put an error's first line on the wire and a value must never ride in one.
 */
async function inputType(params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  let page: Page;
  try {
    page = targetPage(params.pageId);
  } catch {
    return { outcome: 'target_gone' };
  }
  let expected: BrowserInputFacts;
  let values: BrowserInputValue[];
  try {
    expected = browserFactsParam(params.expected);
    if (!Array.isArray(params.values)) throw new Error('values are required');
    values = params.values.map(item => {
      const raw = (item ?? {}) as Record<string, unknown>;
      if (typeof raw.field !== 'string' || typeof raw.text !== 'string')
        throw new Error('a value needs a field and text');
      return { field: raw.field, text: raw.text };
    });
  } catch {
    return { outcome: 'target_changed' };
  }
  try {
    return {
      outcome: await typeInputFields(inputSubject(page), expected, values, params.submit === true),
    };
  } catch {
    return { outcome: 'uncertain' };
  }
}

/** A grant fill arms its `pagehide` clear before the write: anything malformed or failing is `refused`, so nothing is typed. */
async function inputArm(params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    const page = targetPage(params.pageId);
    const expected = browserFactsParam(params.expected);
    if (!Array.isArray(params.fieldIds) || !params.fieldIds.every(id => typeof id === 'string'))
      return { outcome: 'refused' };
    return { outcome: await armInputFields(inputSubject(page), expected, params.fieldIds as string[]) };
  } catch {
    return { outcome: 'refused' };
  }
}

/**
 * A grant fill's check before its page hold ends. A page that is gone holds nothing (`moved`); anything malformed or
 * failing is `unknown`, which stops the line. The job names nodes, never a value.
 */
async function inputClear(params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  let page: Page;
  try {
    page = targetPage(params.pageId);
  } catch {
    return { outcome: 'moved' };
  }
  try {
    return { outcome: await clearInputFields(inputSubject(page), clearJobParam(params.job)) };
  } catch {
    return { outcome: 'unknown' };
  }
}

/** A clear job as the daemon sent it, checked field by field: a frame and a node each, and nothing else. */
function clearJobParam(raw: unknown): BrowserInputClearJob {
  const job = (raw ?? {}) as Record<string, unknown>;
  if (typeof job.navigationId !== 'string' || job.navigationId === '' || !Array.isArray(job.fields))
    throw new Error('a clear job needs a document and fields');
  const fields = job.fields.map(item => {
    const field = (item ?? {}) as Record<string, unknown>;
    if (
      typeof field.frameId !== 'string' ||
      typeof field.backendNodeId !== 'number' ||
      !Number.isInteger(field.backendNodeId) ||
      field.backendNodeId <= 0
    )
      throw new Error('a clear field needs a frame and a node');
    return { frameId: field.frameId, backendNodeId: field.backendNodeId };
  });
  if (fields.length === 0 || fields.length > 8) throw new Error('a clear job names 1 to 8 fields');
  return { navigationId: job.navigationId, fields };
}

/** The dummy probe: anything malformed or failing is `aborted`, which only ever makes the lock longer. */
async function inputProbe(params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    const page = targetPage(params.pageId);
    const expected = browserFactsParam(params.expected);
    if (!Array.isArray(params.fieldIds) || !params.fieldIds.every(id => typeof id === 'string'))
      return { outcome: 'aborted' };
    if (typeof params.dummy !== 'string' || params.dummy === '') return { outcome: 'aborted' };
    return {
      outcome: await probeInputFields(inputSubject(page), expected, params.fieldIds as string[], params.dummy),
    };
  } catch {
    return { outcome: 'aborted' };
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
      const history = (await within(TITLE_WAIT_MS, (await pageSession(focus)).send('Page.getNavigationHistory'))) as {
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
  const dialog = dialogs.pending(pageId(page));
  const started = await downloads.notices(pageId(page));
  return {
    ...(await snapshot(page, extra)),
    actedPageId: pageId(page),
    ...(dialog === undefined ? {} : { dialog }),
    ...(started.length === 0 ? {} : { downloads: started }),
  };
}

/**
 * An act that a dialog can strand: a click that opens an `alert` does not return until the alert is
 * answered, and nor does the next `page.title()`. So the act races the dialog; when the dialog wins the
 * act's own outcome is dropped and the result reports the dialog instead, leaving the page's queue free
 * for the `browser.dialog` that answers it.
 */
async function racing(request: Request): Promise<Record<string, unknown>> {
  const page = targetPage(request.params.pageId);
  const key = pageId(page);
  if (dialogs.pending(key) === undefined) {
    const work = act(request);
    work.catch(() => undefined);
    const opened = dialogs.opened(key);
    try {
      const outcome = await Promise.race([work.then(value => ({ value })), opened.promise.then(() => undefined)]);
      if (outcome !== undefined) return outcome.value;
    } finally {
      opened.cancel();
    }
  }
  const pending = dialogs.pending(key);
  if (request.method === 'screenshot')
    throw new Error(
      `a ${pending?.type ?? 'browser'} dialog is open on this page; answer it with browser.dialog before taking a screenshot`,
    );
  return await acted(page, request.method === 'read' || request.method === 'evaluate' ? { text: '' } : {});
}

/** One lifecycle request: a dialog answer, a bounded wait, a log read or an emulation. */
async function lifecycle(params: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const page = targetPage(params.pageId);
  const parsed = BrowserPageLifecycleRequestSchema.safeParse(params.request);
  if (!parsed.success) throw new Error(`invalid lifecycle request: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
  const key = pageId(page);
  const reply = await runLifecycleRequest(
    {
      pageKey: key,
      page: page as unknown as WaitablePage,
      dialogs,
      messages: logOf(consoles, key, () => new ConsoleLog()),
      network: logOf(networks, key, () => new NetworkLog()),
      emulation: logOf(emulations, key, () => new PageEmulation()),
      targets: {
        session: await pageSession(page),
        setViewport: async viewport => await resizeTo(page, viewport),
        url: () => safeUrl(page),
        grantPermissions: async (permissions, origin) =>
          await page.context().grantPermissions([...permissions], { origin }),
        clearPermissions: async () => await page.context().clearPermissions(),
      },
    },
    parsed.data,
  );
  return { ...(await acted(page)), lifecycle: reply };
}

async function resizeTo(page: Page, viewport: Viewport): Promise<void> {
  if (screencasts.has(pageId(page))) await startScreencast(page, viewport);
  else await applyViewport(page, viewport);
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

/** Requests that must not wait behind the page's other work, because that work may be what they unstick. */
function unqueued(request: Request): boolean {
  if (request.method === 'dispatchInput' || request.method === 'ackFrame') return true;
  if (request.method !== 'lifecycle') return false;
  const op = (request.params.request as { op?: unknown } | undefined)?.op;
  return op === 'dialog' || op === 'console' || op === 'network';
}

async function run(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'lifecycle') return await lifecycle(request.params);
  if (DIALOG_RACED.has(request.method)) return await racing(request);
  return await act(request);
}

async function act(request: Request): Promise<Record<string, unknown>> {
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
      // A click that starts a download hears of it a moment later; the act should be able to say so.
      await downloads.awaitStart(pageId(page), 250);
      return await acted(page);
    }
    case 'type': {
      const page = targetPage(params.pageId);
      const target = browserElementParam(legacyTarget(params));
      if (target === undefined) throw new Error('target is required');
      const typed = await typeInto(page, target, typeof params.text === 'string' ? params.text : '', {
        ...(params.submit === true ? { submit: true } : {}),
        ...(params.slowly === true ? { slowly: true } : {}),
      });
      return await acted(
        page,
        typed.passwordField
          ? { passwordField: true }
          : typed.identifierHost === undefined
            ? {}
            : { identifierHost: typed.identifierHost },
      );
    }
    case 'copyRead': {
      const page = targetPage(params.pageId);
      const target = browserElementParam(params.target);
      const part = params.part;
      if (target === undefined || (part !== 'text' && part !== 'value' && part !== 'attribute'))
        throw new Error('a copy read needs a target and a part');
      const attribute = typeof params.attribute === 'string' ? params.attribute : undefined;
      return {
        read: await readCopyElement(
          page as unknown as CopyablePage,
          async () => await describeInputDocument(inputSubject(page)),
          target,
          part,
          attribute,
        ),
      };
    }
    case 'pushNumberRead': {
      const page = targetPage(params.pageId);
      return {
        read: await readPushNumber(
          page as unknown as PushNumberPage,
          async () => await describeInputDocument(inputSubject(page)),
        ),
      };
    }
    case 'inputDocument':
      return { document: await describeInputDocument(inputSubject(targetPage(params.pageId))) };
    case 'inputText':
      return { text: await readInputText(inputSubject(targetPage(params.pageId))) };
    case 'inputObserve':
      return {
        observation: await observeInputFields(inputSubject(targetPage(params.pageId)), inputPointers(params.fields)),
      };
    case 'inputRefind':
      return {
        observation: await refindInputFields(
          inputSubject(targetPage(params.pageId)),
          browserFactsParam(params.expected),
          inputPointers(params.fields),
        ),
      };
    case 'inputShot': {
      const page = targetPage(params.pageId);
      return {
        shot: await shootInputFields(
          (await pageSession(page)) as unknown as InputCdpSession,
          browserFactsParam(params.facts),
        ),
      };
    }
    case 'inputType':
      return await inputType(params);
    case 'inputProbe':
      return await inputProbe(params);
    case 'inputArm':
      return await inputArm(params);
    case 'inputClear':
      return await inputClear(params);
    case 'pointer': {
      const page = targetPage(params.pageId);
      const outcome = await performPointerAct(page as unknown as PointerPage, pointerActParam(params.act));
      return await acted(page, outcome.passwordField ? { passwordField: true } : {});
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
    case 'upload': {
      const page = targetPage(params.pageId);
      const target = browserElementParam(params.target);
      if (target === undefined) throw new Error('target is required');
      const paths = Array.isArray(params.paths)
        ? params.paths.filter((item): item is string => typeof item === 'string')
        : [];
      await uploadFiles(page, await cdpOf(page), target, paths, params.mode === 'drop' ? 'drop' : 'input');
      return await acted(page);
    }
    case 'evaluate': {
      const page = targetPage(params.pageId);
      const target = browserElementParam(params.target);
      const ran = await runPageScript(
        page,
        await cdpOf(page),
        {
          source: text(params.source, 'source'),
          ...(target === undefined ? {} : { target }),
          ...(typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
            ? { timeoutMs: params.timeoutMs }
            : {}),
        },
        () => crypto.randomUUID(),
      );
      return await acted(page, { text: ran.text, ...(ran.origin === undefined ? {} : { scriptOrigin: ran.origin }) });
    }
    case 'download': {
      const page = targetPage(params.pageId);
      const staged = await downloads.claim(
        pageId(page),
        typeof params.downloadId === 'string' ? params.downloadId : undefined,
      );
      return await acted(page, { staged });
    }
    case 'pdf': {
      const page = targetPage(params.pageId);
      const base64 = await printPdf(await cdpOf(page));
      const staged = await downloads.stagePdf(pageId(page), base64, await safeTitle(page));
      return await acted(page, { staged });
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
      await resizeTo(page, viewport);
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
    browser =
      endpoint === CDP_PIPE_ENDPOINT
        ? await chromium.connectOverCDP(chromePipe(), { timeout: CONNECT_TIMEOUT_MS })
        : await chromium.connectOverCDP(endpoint, { timeout: CONNECT_TIMEOUT_MS });
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
    // Input, frame acknowledgements and the dialog and log reads never wait: a person typing must not
    // queue behind a page load, nor a dialog answer behind the click that is stuck on that dialog.
    if (unqueued(request)) void answer(request);
    else void queued(keyOf(request), async () => await answer(request));
  });
  process.stdin.on('end', () => {
    void Promise.all([...screencasts.keys()].map(id => stopScreencast(id))).finally(
      () => void browser?.close().finally(() => process.exit(0)),
    );
  });
}

if (import.meta.main) await startBrowserWorker();
