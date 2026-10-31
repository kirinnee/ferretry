import {
  BROWSER_MAX_MACHINE_PAGES,
  BROWSER_MAX_PAGES,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserDialogInfo,
  BrowserDialogInfoSchema,
  type BrowserElementTarget,
  type BrowserInputEvent,
  type BrowserPageActionSnapshot,
  type BrowserPageLifecycleReply,
  type BrowserPageLifecycleRequest,
  type BrowserPageSnapshot,
  type BrowserPageSummary,
  type BrowserScreencastFrame,
  type BrowserStateView,
  type BrowserStatus,
  type BrowserTarget,
  type BrowserTargetFields,
  type BrowserViewport,
  browserReadModeOf,
  browserTargetOf,
  type SurfaceOpener,
} from '@ferretry/protocol';
import { agentSpokenName } from '../../names/session-names.ts';
import type { BrowserAutomation, BrowserPageActed } from '../transport/automation-contracts.ts';
import type { BrowserInputFieldsPort } from '../transport/input-contracts.ts';
import type { BrowserUploadMode } from '../transport/page-acts.ts';
import type { PageScript } from '../transport/page-script.ts';
import type { BrowserViewerHost, ViewerAttachment, ViewerTerminalSignal } from '../transport/viewer-contracts.ts';
import type { WorkerStagedFile } from '../transport/worker-protocol.ts';

export const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = { width: 1280, height: 800 };

export class BrowserSessionError extends Error {
  constructor(
    readonly code: 'not_found' | 'capacity' | 'conflict' | 'not_running' | 'launch_failed' | 'upstream_failed',
    message: string,
  ) {
    super(message);
    this.name = 'BrowserSessionError';
  }
}

/** Starts the machine's one agent browser. */
export interface BrowserSessionLauncher {
  launch(viewport: BrowserViewport): Promise<BrowserAutomation>;
}

/** A timer the composition root owns. */
export interface BrowserIdleTimer {
  cancel(): void;
}

/**
 * When the agent browser stops on its own: after this long with nobody watching any page and nobody
 * acting on one. A forgotten browser would otherwise hold the agent profile for ever.
 */
export interface BrowserIdlePolicy {
  readonly timeoutMs: number;
  after(milliseconds: number, action: () => void): BrowserIdleTimer;
}

/**
 * What a guard may ask of the page it runs for, from inside that page's queue: which document it shows now (the
 * main frame's loaderId), read straight from the browser, never by queueing behind itself. Nothing when the
 * browser cannot tell.
 */
export interface BrowserGuardPage {
  document(): Promise<string | undefined>;
}

/**
 * Refuses an act from inside its page's own queue, immediately before it runs — a takeover that landed while it
 * waited, or an owner's value pending on or just typed into the page (the input bridge's holds).
 */
export type BrowserActGuard = (page: BrowserGuardPage) => Promise<void>;

/** The sessions the browser serves: whether one exists, and the display name a page is grouped under. */
export interface BrowserSessionDirectory {
  get(
    sessionId: string,
  ): Promise<{ readonly config?: { readonly name?: string | null; readonly teammate?: string } } | undefined>;
}

/** What can be done to ONE named page: the agent tools' browser verbs. */
export type BrowserPageAction = Extract<
  BrowserAction,
  {
    readonly action:
      | 'navigate'
      | 'click'
      | 'type'
      | 'read'
      | 'screenshot'
      | 'back'
      | 'forward'
      | 'reload'
      | 'hover'
      | 'drag'
      | 'mouse'
      | 'press'
      | 'scroll'
      | 'select'
      | 'check'
      | 'fill-form'
      | 'highlight';
  }
>;

/** What a lifecycle request answered, and the dialog the page is waiting on afterwards, if it has one. */
export interface BrowserLifecycleOutcome {
  readonly reply: BrowserPageLifecycleReply;
  readonly dialog?: BrowserDialogInfo;
}

/**
 * What the FILE tools do to one page. Deliberately not part of {@link BrowserAction}: that is the wire a
 * person's toolbar posts, and a host path must never be something it can carry. These come only from the
 * daemon's own file service, which has already confined every path.
 */
export type BrowserFileAction =
  | {
      readonly action: 'upload';
      readonly target: BrowserElementTarget;
      /** Absolute paths the file service resolved and size-checked. */
      readonly paths: readonly string[];
      readonly mode: BrowserUploadMode;
    }
  | { readonly action: 'download'; readonly downloadId?: string }
  | { readonly action: 'pdf' };

/** A file act's answer: the usual status and page, plus the file the browser staged when the act made one. */
export interface BrowserFileResult {
  readonly status: BrowserActionResult['status'];
  readonly result: BrowserPageActionSnapshot;
  readonly staged?: WorkerStagedFile;
}

/** An agent's own script on one page: the page's status, the page as it is now, and what the script returned. */
export interface BrowserScriptResult {
  readonly status: BrowserActionResult['status'];
  readonly result: BrowserPageActed;
  readonly text: string;
}

/** How a named page is opened. */
export interface BrowserOpenOptions {
  readonly url?: string;
  /** Who opened it, as the daemon attests it. */
  readonly openedBy?: SurfaceOpener;
  /** A throwaway context with its own cookies and storage, discarded when the page closes. */
  readonly incognito?: boolean;
}

export interface BrowserSubsystem extends BrowserViewerHost {
  /** This session's view of the machine's browser: its own pages, and the one its person is viewing. */
  status(sessionId: string): Promise<BrowserStatus>;
  /** A person's toolbar: everything acts on the page this session's person is viewing. */
  act(sessionId: string, action: BrowserAction): Promise<BrowserActionResult>;
  /**
   * Opens a page with a human NAME in its own window, starting the browser when it is not running. A
   * name already in use in this session is refused, and so is a page past the session's or the
   * machine's cap — refused, never hidden.
   */
  openPage(sessionId: string, name: string, options?: BrowserOpenOptions): Promise<BrowserPageSummary>;
  /**
   * Acts on this session's page with this name (or id) — and on nothing else: no tab is activated, and
   * a person viewing another page is never moved. `guard` runs inside the page's own queue,
   * immediately before anything happens, and may refuse.
   */
  actOnPage(
    sessionId: string,
    key: string,
    action: BrowserPageAction,
    guard?: BrowserActGuard,
  ): Promise<BrowserActionResult>;
  /**
   * A page-lifecycle request on this session's page: answer its dialog, wait a moment for a condition,
   * read its console or network log, or emulate a device. A dialog answer and a log read are NOT queued
   * behind the page's other work — the work in front of them may be stuck on that very dialog.
   */
  lifecycleOnPage(
    sessionId: string,
    key: string,
    request: BrowserPageLifecycleRequest,
    guard?: BrowserActGuard,
  ): Promise<BrowserLifecycleOutcome>;
  /** Names a page of this session that has no name — a popup its page opened — and credits `openedBy` with it. */
  adoptPage(sessionId: string, key: string, name: string, openedBy?: SurfaceOpener): Promise<BrowserPageSummary>;
  /**
   * An agent's own script on this session's page (`browser.eval`), in an isolated world: the same
   * queue, guard and rules as {@link actOnPage}. Whether the owner allows it is the caller's to check.
   */
  scriptOnPage(
    sessionId: string,
    key: string,
    script: PageScript,
    guard?: BrowserActGuard,
  ): Promise<BrowserScriptResult>;
  /** The file tools' acts on this session's page: the same queue, guard and rules as {@link actOnPage}. */
  filesOnPage(
    sessionId: string,
    key: string,
    action: BrowserFileAction,
    guard?: BrowserActGuard,
  ): Promise<BrowserFileResult>;
  /**
   * The input bridge's look, picture or write on this session's page with this name (or id), run in the page's
   * own queue so no act of the agent lands between the bridge's check and its write. Refuses (`not_found`) a
   * page that is not this session's, or a browser that is not running: the bridge reads that as "gone".
   */
  inputOnPage<T>(
    sessionId: string,
    key: string,
    work: (fields: BrowserInputFieldsPort, pageId: string) => Promise<T>,
  ): Promise<T>;
  /** Closes this session's page with this name (or id). An incognito page's whole context goes with it. */
  closePage(sessionId: string, key: string, guard?: BrowserActGuard): Promise<void>;
  /** A session ended: every page it owns closes, and every incognito context it held is discarded. */
  releaseSession(sessionId: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface Viewer {
  readonly sessionId: string;
  pageId: string;
  readonly frame: (frame: BrowserScreencastFrame) => void;
  readonly terminal: (signal: ViewerTerminalSignal) => void;
}

/** The machine's agent browser while it runs. Pages are in memory: they do not outlive it. */
interface Running {
  readonly driver: BrowserAutomation;
  readonly startedAt: string;
  /** The last page list the browser reported, every session's pages together. */
  snapshot: BrowserPageSnapshot;
  closed: boolean;
  readonly viewers: Set<Viewer>;
  /** Page id → the session it belongs to. A popup belongs to its opener's session. */
  readonly owners: Map<string, string>;
  /** Page id → human name. */
  readonly names: Map<string, string>;
  /** Page id → who opened it by name. */
  readonly openers: Map<string, SurfaceOpener>;
  /** Session id → the page that session's person is viewing — where their input and view go. */
  readonly viewed: Map<string, string>;
  /** Page id → viewport. */
  readonly viewports: Map<string, BrowserViewport>;
  idle?: BrowserIdleTimer;
}

/**
 * THE MACHINE'S ONE AGENT BROWSER, SHARED BY EVERY SESSION.
 *
 * One Chrome, over one dedicated agent profile (never a person's own Chrome profile): every agent on
 * the machine shares its cookies and sign-ins. Each page belongs to the session that opened it, opens
 * in its own window, and is visible to — and actable by — that session alone; an incognito page has its
 * own throwaway cookies and storage besides.
 *
 * THERE IS NO ACTIVE TAB. An agent's act names its page and moves nothing; a person's toolbar and
 * input go to the page THEIR session is viewing; a viewer streams that one page. So a person typing a
 * password into one tab and an agent driving another never cross, and neither waits for the other:
 * acts are serialized per PAGE, not per session or per browser.
 */
export class BrowserSessionService implements BrowserSubsystem {
  private run: Running | undefined;
  private starting: Promise<Running> | undefined;
  private readonly serial = new Map<string, Promise<void>>();
  /** Session id → the agent's spoken name (its first name, else its task title), as last read. */
  private readonly sessionNames = new Map<string, string>();

  constructor(
    private readonly sessions: BrowserSessionDirectory,
    private readonly launcher: BrowserSessionLauncher,
    private readonly now: () => number,
    private readonly idle?: BrowserIdlePolicy,
  ) {}

  async status(sessionId: string): Promise<BrowserStatus> {
    await this.requireSession(sessionId);
    const run = this.run;
    if (run === undefined) return this.stopped(sessionId);
    const viewed = this.viewedPage(run, sessionId);
    if (viewed !== undefined) run.snapshot = pageOf(await run.driver.location(viewed));
    return this.project(run, sessionId);
  }

  async act(sessionId: string, action: BrowserAction): Promise<BrowserActionResult> {
    await this.requireSession(sessionId);
    if (action.action === 'stop') {
      await this.releaseSession(sessionId);
      return { status: await this.status(sessionId) };
    }
    if (action.action === 'start' || action.action === 'open' || action.action === 'new-page') {
      const run = await this.ensure();
      const viewed = this.viewedPage(run, sessionId);
      if (action.action === 'new-page' || viewed === undefined) {
        const opened = await this.openIn(run, sessionId, {
          ...(action.action !== 'start' && action.url !== undefined ? { url: action.url } : {}),
          ...(action.action === 'new-page' && action.incognito === true ? { incognito: true } : {}),
        });
        await this.view(run, sessionId, opened.actedPageId);
        return { status: this.project(run, sessionId), result: opened };
      }
      if (action.action === 'start' || action.url === undefined) return { status: this.project(run, sessionId) };
      const url = action.url;
      return await this.onPage(run, viewed, async () => await run.driver.navigate(viewed, url), sessionId);
    }
    const run = this.requireRunning();
    if (action.action === 'activate-page' || action.action === 'close-page') {
      const page = this.requirePage(run, sessionId, action.pageId);
      if (action.action === 'activate-page') {
        await this.view(run, sessionId, page.id);
        return { status: await this.status(sessionId), result: { ...run.snapshot, actedPageId: page.id } };
      }
      await this.closeIn(run, sessionId, page.id);
      return { status: await this.status(sessionId) };
    }
    const viewed = this.viewedPage(run, sessionId);
    if (viewed === undefined) throw new BrowserSessionError('not_running', 'this session has no browser page open');
    return await this.onPage(run, viewed, async () => await this.perform(run, viewed, action), sessionId);
  }

  async openPage(sessionId: string, name: string, options: BrowserOpenOptions = {}): Promise<BrowserPageSummary> {
    await this.requireSession(sessionId);
    const run = await this.ensure();
    if (this.page(run, sessionId, name) !== undefined)
      throw new BrowserSessionError('conflict', `this session already has a browser page named ${name}`);
    const opened = await this.openIn(run, sessionId, options);
    run.names.set(opened.actedPageId, name);
    if (options.openedBy !== undefined) run.openers.set(opened.actedPageId, options.openedBy);
    return this.named(run, opened.actedPageId);
  }

  async actOnPage(
    sessionId: string,
    key: string,
    action: BrowserPageAction,
    guard?: BrowserActGuard,
  ): Promise<BrowserActionResult> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    const page = this.requirePage(run, sessionId, key);
    return await this.exclusive(page.id, async () => {
      await guard?.(this.guardPage(run, page.id));
      const result = await this.perform(run, page.id, action);
      run.snapshot = pageOf(result);
      this.touch(run);
      return { status: this.project(run, sessionId), result };
    });
  }

  async inputOnPage<T>(
    sessionId: string,
    key: string,
    work: (fields: BrowserInputFieldsPort, pageId: string) => Promise<T>,
  ): Promise<T> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    const page = this.requirePage(run, sessionId, key);
    return await this.exclusive(page.id, async () => {
      this.touch(run);
      return await work(run.driver, page.id);
    });
  }

  async lifecycleOnPage(
    sessionId: string,
    key: string,
    request: BrowserPageLifecycleRequest,
    guard?: BrowserActGuard,
  ): Promise<BrowserLifecycleOutcome> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    const page = this.requirePage(run, sessionId, key);
    const perform = async (): Promise<BrowserLifecycleOutcome> => {
      const answered = await run.driver.lifecycle(page.id, request);
      run.snapshot = pageOf(answered);
      if (request.op === 'emulate') {
        const { viewport, reset } = request.emulation;
        if (reset === true) run.viewports.delete(page.id);
        if (viewport !== undefined) run.viewports.set(page.id, viewport);
      }
      this.touch(run);
      return { reply: answered.lifecycle, ...(answered.dialog === undefined ? {} : { dialog: answered.dialog }) };
    };
    if (request.op === 'dialog' || request.op === 'console' || request.op === 'network') {
      await guard?.(this.guardPage(run, page.id));
      return await perform();
    }
    return await this.exclusive(page.id, async () => {
      await guard?.(this.guardPage(run, page.id));
      return await perform();
    });
  }

  async adoptPage(sessionId: string, key: string, name: string, openedBy?: SurfaceOpener): Promise<BrowserPageSummary> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    run.snapshot = pageOf(await run.driver.location());
    const page = this.requirePage(run, sessionId, key);
    const named = run.names.get(page.id);
    if (named !== undefined) throw new BrowserSessionError('conflict', `that page already has the name ${named}`);
    if (this.page(run, sessionId, name) !== undefined)
      throw new BrowserSessionError('conflict', `this session already has a browser page named ${name}`);
    run.owners.set(page.id, sessionId);
    run.names.set(page.id, name);
    if (openedBy !== undefined) run.openers.set(page.id, openedBy);
    return this.named(run, page.id);
  }

  async filesOnPage(
    sessionId: string,
    key: string,
    action: BrowserFileAction,
    guard?: BrowserActGuard,
  ): Promise<BrowserFileResult> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    const page = this.requirePage(run, sessionId, key);
    return await this.exclusive(page.id, async () => {
      await guard?.(this.guardPage(run, page.id));
      let staged: WorkerStagedFile | undefined;
      let result: BrowserPageActionSnapshot;
      if (action.action === 'upload')
        result = await run.driver.upload(page.id, action.target, action.paths, action.mode);
      else {
        const done =
          action.action === 'download'
            ? await run.driver.download(page.id, action.downloadId)
            : await run.driver.pdf(page.id);
        const { staged: file, ...snapshot } = done;
        staged = file;
        result = snapshot;
      }
      run.snapshot = pageOf(result);
      this.touch(run);
      return { status: this.project(run, sessionId), result, ...(staged === undefined ? {} : { staged }) };
    });
  }

  async scriptOnPage(
    sessionId: string,
    key: string,
    script: PageScript,
    guard?: BrowserActGuard,
  ): Promise<BrowserScriptResult> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    const page = this.requirePage(run, sessionId, key);
    return await this.exclusive(page.id, async () => {
      await guard?.(this.guardPage(run, page.id));
      const { text, ...result } = await run.driver.evaluate(page.id, script);
      run.snapshot = pageOf(result);
      this.touch(run);
      return { status: this.project(run, sessionId), result, text };
    });
  }

  async closePage(sessionId: string, key: string, guard?: BrowserActGuard): Promise<void> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    const page = this.requirePage(run, sessionId, key);
    await this.exclusive(page.id, async () => {
      await guard?.(this.guardPage(run, page.id));
      await this.closeIn(run, sessionId, page.id);
    });
  }

  async releaseSession(sessionId: string): Promise<void> {
    const run = this.run;
    if (run === undefined) return;
    for (const page of this.owned(run, sessionId))
      await this.exclusive(page.id, async () => await this.closeIn(run, sessionId, page.id)).catch(() => undefined);
    run.viewed.delete(sessionId);
  }

  async attachViewer(
    sessionId: string,
    frame: (frame: BrowserScreencastFrame) => void,
    terminal: (signal: ViewerTerminalSignal) => void,
  ): Promise<ViewerAttachment> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    const pageId = this.viewedPage(run, sessionId);
    if (pageId === undefined) throw new BrowserSessionError('not_running', 'this session has no browser page open');
    const viewer: Viewer = { sessionId, pageId, frame, terminal };
    run.viewers.add(viewer);
    try {
      await this.cast(run, viewer);
    } catch (error) {
      run.viewers.delete(viewer);
      throw error;
    }
    let detached = false;
    return {
      detach: () => {
        if (detached) return;
        detached = true;
        run.viewers.delete(viewer);
        void run.driver.stopScreencast(viewer.pageId, viewer.frame).catch(() => undefined);
        this.touch(run);
      },
    };
  }

  /** A person's input goes to the page THEIR session is viewing, and nowhere else. */
  async dispatchHumanInput(sessionId: string, input: BrowserInputEvent): Promise<void> {
    const run = this.requireRunning();
    const pageId = this.viewedPage(run, sessionId);
    if (pageId === undefined) throw new BrowserSessionError('not_running', 'this session has no browser page open');
    await run.driver.dispatchInput(pageId, input);
  }

  /** The machine browser as a whole: whether it runs, since when, and the proxy it started with. */
  overview(): BrowserStateView {
    const run = this.run;
    if (run === undefined) return { state: this.starting === undefined ? 'stopped' : 'starting' };
    return {
      state: 'running',
      startedAt: run.startedAt,
      ...(run.driver.proxy === undefined ? {} : { proxy: run.driver.proxy }),
    };
  }

  async closeAll(): Promise<void> {
    await this.stop();
  }

  /** The machine's browser, started on first need; concurrent first needs share one launch. */
  private async ensure(): Promise<Running> {
    if (this.run !== undefined) return this.run;
    this.starting ??= this.launch().finally(() => {
      this.starting = undefined;
    });
    return await this.starting;
  }

  private async launch(): Promise<Running> {
    let driver: BrowserAutomation;
    try {
      driver = await this.launcher.launch(DEFAULT_BROWSER_VIEWPORT);
      const run: Running = {
        driver,
        startedAt: new Date(this.now()).toISOString(),
        snapshot: pageOf(await driver.location()),
        closed: false,
        viewers: new Set(),
        owners: new Map(),
        names: new Map(),
        openers: new Map(),
        viewed: new Map(),
        viewports: new Map(),
      };
      this.run = run;
      void driver.unexpectedExit.then(() => this.ended(run));
      this.touch(run);
      return run;
    } catch (error) {
      throw error instanceof BrowserSessionError
        ? error
        : new BrowserSessionError('launch_failed', error instanceof Error ? error.message : 'browser launch failed');
    }
  }

  /** A new page for this session, in its own window, inside both caps. */
  private async openIn(
    run: Running,
    sessionId: string,
    options: BrowserOpenOptions,
  ): Promise<BrowserPageActionSnapshot> {
    return await this.exclusive('', async () => {
      // Read the pages fresh: a popup a click opened since the last act counts toward both caps.
      run.snapshot = pageOf(await run.driver.location());
      if (this.owned(run, sessionId).length >= BROWSER_MAX_PAGES)
        throw new BrowserSessionError(
          'capacity',
          `this session already has ${String(BROWSER_MAX_PAGES)} browser pages open; close one before opening another`,
        );
      // Every page that belongs to a session counts — the popups an agent's clicks opened included.
      if (this.sessionPages(run) >= BROWSER_MAX_MACHINE_PAGES)
        throw new BrowserSessionError(
          'capacity',
          `this machine's browser already has ${String(BROWSER_MAX_MACHINE_PAGES)} pages open; close one before opening another`,
        );
      const opened = await run.driver.newPage({
        ...(options.url === undefined ? {} : { url: options.url }),
        ...(options.incognito === true ? { incognito: true } : {}),
      });
      run.owners.set(opened.actedPageId, sessionId);
      run.snapshot = pageOf(opened);
      if (!run.viewed.has(sessionId)) run.viewed.set(sessionId, opened.actedPageId);
      this.touch(run);
      return opened;
    });
  }

  private async closeIn(run: Running, sessionId: string, pageId: string): Promise<void> {
    const result = await run.driver.closePage(pageId);
    run.snapshot = pageOf(result);
    run.owners.delete(pageId);
    run.names.delete(pageId);
    run.openers.delete(pageId);
    run.viewports.delete(pageId);
    for (const viewer of [...run.viewers])
      if (viewer.pageId === pageId) {
        run.viewers.delete(viewer);
        viewer.terminal({ code: 1000, reason: 'the page closed' });
      }
    if (run.viewed.get(sessionId) === pageId) {
      const next = this.owned(run, sessionId).at(-1);
      if (next === undefined) run.viewed.delete(sessionId);
      else run.viewed.set(sessionId, next.id);
    }
    this.touch(run);
  }

  /** Points this session's person at another of its pages, and moves its live viewers there. */
  private async view(run: Running, sessionId: string, pageId: string): Promise<void> {
    run.viewed.set(sessionId, pageId);
    for (const viewer of run.viewers)
      if (viewer.sessionId === sessionId && viewer.pageId !== pageId) {
        await run.driver.stopScreencast(viewer.pageId, viewer.frame).catch(() => undefined);
        viewer.pageId = pageId;
        await this.cast(run, viewer);
      }
  }

  private async cast(run: Running, viewer: Viewer): Promise<void> {
    await run.driver.startScreencast(
      viewer.pageId,
      run.viewports.get(viewer.pageId) ?? DEFAULT_BROWSER_VIEWPORT,
      viewer.frame,
    );
  }

  private async onPage(
    run: Running,
    pageId: string,
    work: () => Promise<BrowserPageActionSnapshot>,
    sessionId: string,
  ): Promise<BrowserActionResult> {
    return await this.exclusive(pageId, async () => {
      const result = withoutDialog(await work());
      run.snapshot = pageOf(result);
      this.touch(run);
      return { status: this.project(run, sessionId), result };
    });
  }

  private async perform(
    run: Running,
    pageId: string,
    action: Exclude<BrowserAction, { action: 'start' | 'open' | 'stop' | 'new-page' | 'activate-page' | 'close-page' }>,
  ): Promise<BrowserPageActionSnapshot> {
    switch (action.action) {
      case 'navigate':
        return await run.driver.navigate(pageId, action.url);
      case 'click':
        return await run.driver.click(pageId, requiredTarget(action), {
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.double === true ? { double: true } : {}),
          ...(action.modifiers === undefined ? {} : { modifiers: action.modifiers }),
        });
      case 'type':
        return await run.driver.type(pageId, requiredElement(action), action.text, {
          ...(action.submit === true ? { submit: true } : {}),
          ...(action.slowly === true ? { slowly: true } : {}),
        });
      case 'read': {
        const target = optionalElement(action);
        return await run.driver.read(pageId, {
          ...(target === undefined ? {} : { target }),
          mode: browserReadModeOf(action),
          ...(action.find === undefined ? {} : { find: action.find }),
          ...(action.depth === undefined ? {} : { depth: action.depth }),
          ...(action.boxes === true ? { boxes: true } : {}),
        });
      }
      case 'screenshot': {
        const target = optionalElement(action);
        return await run.driver.screenshot(pageId, {
          ...(target === undefined ? {} : { target }),
          ...(action.fullPage === true ? { fullPage: true } : {}),
          ...(action.format === undefined ? {} : { format: action.format }),
        });
      }
      case 'hover':
      case 'drag':
      case 'mouse':
      case 'press':
      case 'scroll':
      case 'select':
      case 'check':
      case 'fill-form':
      case 'highlight':
        return await run.driver.pointer(pageId, action);
      case 'back':
        return await run.driver.back(pageId);
      case 'forward':
        return await run.driver.forward(pageId);
      case 'reload':
        return await run.driver.reload(pageId);
      case 'resize':
        run.viewports.set(pageId, { width: action.width, height: action.height });
        return await run.driver.resize(pageId, { width: action.width, height: action.height });
      case 'human-activity': {
        const snapshot = await run.driver.location(pageId);
        return { ...snapshot, actedPageId: pageId };
      }
    }
  }

  private async stop(): Promise<void> {
    const run = this.run;
    if (run === undefined) return;
    this.run = undefined;
    run.closed = true;
    run.idle?.cancel();
    for (const viewer of run.viewers) viewer.terminal({ code: 1000, reason: 'browser stopped' });
    run.viewers.clear();
    await run.driver.close().catch(() => undefined);
  }

  private ended(run: Running): void {
    if (run.closed || this.run !== run) return;
    this.run = undefined;
    run.closed = true;
    run.idle?.cancel();
    for (const viewer of run.viewers) viewer.terminal({ code: 1011, reason: 'browser worker exited' });
    run.viewers.clear();
  }

  /** The session a page belongs to: its own record, or its opener's (a popup is its opener's). */
  private ownerOf(run: Running, page: BrowserPageSummary, depth = 0): string | undefined {
    const own = run.owners.get(page.id);
    if (own !== undefined || page.openerId === undefined || depth > 8) return own;
    const opener = run.snapshot.pages.find(candidate => candidate.id === page.openerId);
    return opener === undefined ? undefined : this.ownerOf(run, opener, depth + 1);
  }

  /** Pages that belong to some session (popups included) — what the machine cap counts. */
  private sessionPages(run: Running): number {
    return run.snapshot.pages.filter(page => this.ownerOf(run, page) !== undefined).length;
  }

  /** This session's pages, among the pages the browser reported last. */
  private owned(run: Running, sessionId: string): BrowserPageSummary[] {
    return run.snapshot.pages.filter(page => this.ownerOf(run, page) === sessionId);
  }

  /** This session's page with this name or id — never another session's. */
  private page(run: Running, sessionId: string, key: string): BrowserPageSummary | undefined {
    return this.owned(run, sessionId).find(page => page.id === key || run.names.get(page.id) === key);
  }

  private requirePage(run: Running, sessionId: string, key: string): BrowserPageSummary {
    const page = this.page(run, sessionId, key);
    if (page === undefined) throw new BrowserSessionError('not_found', `there is no browser page named ${key}`);
    return page;
  }

  private requireRunning(): Running {
    const run = this.run;
    if (run === undefined) throw new BrowserSessionError('not_running', 'the browser is not running');
    return run;
  }

  /** The page this session's person is viewing, if it still exists. */
  private viewedPage(run: Running, sessionId: string): string | undefined {
    const viewed = run.viewed.get(sessionId);
    if (viewed !== undefined && this.owned(run, sessionId).some(page => page.id === viewed)) return viewed;
    const fallback = this.owned(run, sessionId).at(-1)?.id;
    if (fallback === undefined) run.viewed.delete(sessionId);
    else run.viewed.set(sessionId, fallback);
    return fallback;
  }

  /** One page as the wire shows it, carrying its name and opener when it has them. */
  /** What a guard may ask of one page: its document, straight from the driver. */
  private guardPage(run: Running, pageId: string): BrowserGuardPage {
    return {
      document: async () =>
        await run.driver
          .inputDocument(pageId)
          .then(found => found.navigationId)
          .catch(() => undefined),
    };
  }

  private named(run: Running, pageId: string): BrowserPageSummary {
    const page = run.snapshot.pages.find(candidate => candidate.id === pageId) as BrowserPageSummary;
    const name = run.names.get(page.id);
    const openedBy = run.openers.get(page.id);
    const owner = this.ownerOf(run, page);
    const ownerName = owner === undefined ? undefined : this.sessionNames.get(owner);
    return {
      ...page,
      ...(name === undefined ? {} : { name }),
      ...(openedBy === undefined ? {} : { openedBy }),
      ...(owner === undefined ? {} : { ownerSessionId: owner }),
      ...(ownerName === undefined ? {} : { ownerName }),
    };
  }

  private project(run: Running, sessionId: string): BrowserStatus & { readonly state: 'running' } {
    const pages = this.owned(run, sessionId).map(page => this.named(run, page.id));
    const base = {
      state: 'running' as const,
      sessionId,
      viewport: DEFAULT_BROWSER_VIEWPORT,
      viewers: [...run.viewers].filter(viewer => viewer.sessionId === sessionId).length,
      persistentProfile: true as const,
      profileKind: 'shared' as const,
      idleTimeoutSeconds: Math.round((this.idle?.timeoutMs ?? 0) / 1_000),
      startedAt: run.startedAt,
      capacity: { running: this.sessionPages(run), maximum: BROWSER_MAX_MACHINE_PAGES },
      ...(run.driver.proxy === undefined ? {} : { proxy: run.driver.proxy }),
    };
    const viewed = this.viewedPage(run, sessionId);
    const active = pages.find(page => page.id === viewed);
    if (active === undefined) return { ...base, pages: [] };
    const described = run.snapshot.activePageId === active.id;
    return {
      ...base,
      viewport: run.viewports.get(active.id) ?? DEFAULT_BROWSER_VIEWPORT,
      url: active.url,
      title: active.title,
      pages: pages as [BrowserPageSummary, ...BrowserPageSummary[]],
      activePageId: active.id,
      pageState: described ? run.snapshot.pageState : 'ready',
      ...(described && run.snapshot.pageError !== undefined ? { pageError: run.snapshot.pageError } : {}),
      canGoBack: described && run.snapshot.canGoBack,
      canGoForward: described && run.snapshot.canGoForward,
    };
  }

  private stopped(sessionId: string): BrowserStatus {
    return {
      state: 'stopped',
      sessionId,
      viewport: DEFAULT_BROWSER_VIEWPORT,
      viewers: 0,
      persistentProfile: true,
      profileKind: 'shared',
      idleTimeoutSeconds: Math.round((this.idle?.timeoutMs ?? 0) / 1_000),
      pages: [],
      capacity: { running: 0, maximum: BROWSER_MAX_MACHINE_PAGES },
    };
  }

  /**
   * Restarts the browser's idle clock. When it runs out with nobody watching any page, the browser
   * stops; with a viewer attached, the clock simply starts again.
   */
  private touch(run: Running): void {
    if (this.idle === undefined) return;
    const idle = this.idle;
    run.idle?.cancel();
    run.idle = idle.after(idle.timeoutMs, () => {
      if (this.run !== run) return;
      if (run.viewers.size > 0) this.touch(run);
      else void this.stop();
    });
  }

  private async requireSession(sessionId: string): Promise<void> {
    const session = await this.sessions.get(sessionId);
    if (session === undefined) throw new BrowserSessionError('not_found', 'the session does not exist');
    const name = session.config?.name;
    if (typeof name === 'string' && name !== '')
      this.sessionNames.set(
        sessionId,
        agentSpokenName({
          name,
          ...(session.config?.teammate === undefined ? {} : { teammate: session.config.teammate }),
        }),
      );
  }

  /** Work on one page runs in order; work on different pages runs side by side. `''` is the browser. */
  private async exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    this.serial.set(
      key,
      previous.then(() => next),
    );
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.serial.get(key) === next) this.serial.delete(key);
    }
  }
}

/** The dialog a worker reports is for an agent's tools; a person's response has no field for it. */
function withoutDialog<T extends BrowserPageActionSnapshot>(result: T): T {
  if (!('dialog' in result)) return result;
  const { dialog: _dialog, ...rest } = result as T & { dialog?: unknown };
  return rest as T;
}

/** The dialog an act's result carries, if the worker reported one the wire knows. */
export function pendingDialogOf(result: unknown): BrowserDialogInfo | undefined {
  const dialog = BrowserDialogInfoSchema.safeParse((result as { dialog?: unknown } | undefined)?.dialog);
  return dialog.success ? dialog.data : undefined;
}

/**
 * The page a STATUS reports, and nothing an action added to it. What an action acted on, the text it
 * read and the screenshot it took belong to that one response: carried into the remembered snapshot
 * they made every later status fail the strict wire schema (`actedPageId` is not a status field), and
 * kept a multi-megabyte screenshot alive for the life of the browser.
 */
function pageOf(result: BrowserPageSnapshot): BrowserPageSnapshot {
  return {
    url: result.url,
    title: result.title,
    pages: result.pages,
    activePageId: result.activePageId,
    pageState: result.pageState,
    ...(result.pageError === undefined ? {} : { pageError: result.pageError }),
    canGoBack: result.canGoBack,
    canGoForward: result.canGoForward,
  };
}

/**
 * The target an act names. The action schema already holds every act to its target rule, so a missing
 * or wrong-kind target here is a defect in whoever built the action, not a caller's mistake.
 */
function requiredTarget(fields: BrowserTargetFields): BrowserTarget {
  const target = browserTargetOf(fields);
  if (target === undefined) throw new Error('a browser act was built without its target');
  return target;
}

function requiredElement(fields: BrowserTargetFields): BrowserElementTarget {
  const target = optionalElement(fields);
  if (target === undefined) throw new Error('a browser act was built without its target');
  return target;
}

function optionalElement(fields: BrowserTargetFields): BrowserElementTarget | undefined {
  const target = browserTargetOf(fields);
  if (target?.kind === 'point') throw new Error('a browser act that takes an element was built with a point');
  return target;
}
