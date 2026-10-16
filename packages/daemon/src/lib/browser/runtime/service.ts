import {
  BROWSER_MAX_INSTANCES,
  type BrowserAction,
  type BrowserActionResult,
  type BrowserInputEvent,
  type BrowserPageActionSnapshot,
  type BrowserPageSnapshot,
  type BrowserPageSummary,
  type BrowserScreencastFrame,
  type BrowserStatus,
  type BrowserViewport,
} from '@ferretry/protocol';
import type { BrowserAutomation } from '../transport/automation-contracts.ts';
import type { BrowserViewerHost, ViewerAttachment, ViewerTerminalSignal } from '../transport/viewer-contracts.ts';

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

export interface BrowserSessionLauncher {
  launch(sessionId: string, viewport: BrowserViewport): Promise<BrowserAutomation>;
}

export interface BrowserSessionDirectory {
  get(sessionId: string): Promise<unknown | undefined>;
}

/** What can be done to ONE named page: the agent tools' browser verbs. */
export type BrowserPageAction = Extract<
  BrowserAction,
  { readonly action: 'navigate' | 'click' | 'type' | 'read' | 'screenshot' }
>;

export interface BrowserSubsystem extends BrowserViewerHost {
  status(sessionId: string): Promise<BrowserStatus>;
  act(sessionId: string, action: BrowserAction): Promise<BrowserActionResult>;
  /**
   * Opens a page with a human NAME, starting the browser when it is not running. The first page of a
   * browser this call started is the blank tab Chrome opened with, so it is named rather than left
   * beside the new one. A name already in use in this session is refused.
   */
  openPage(sessionId: string, name: string, url?: string): Promise<BrowserPageSummary>;
  /** Acts on the page with this name (or id), making it the active tab first. */
  actOnPage(sessionId: string, key: string, action: BrowserPageAction): Promise<BrowserActionResult>;
  /** Closes the page with this name (or id). */
  closePage(sessionId: string, key: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface Viewer {
  readonly frame: (frame: BrowserScreencastFrame) => void;
  readonly terminal: (signal: ViewerTerminalSignal) => void;
}

interface Running {
  readonly sessionId: string;
  readonly driver: BrowserAutomation;
  viewport: BrowserViewport;
  readonly startedAt: string;
  readonly viewers: Set<Viewer>;
  snapshot: BrowserPageSnapshot;
  closed: boolean;
  /**
   * Page id → human name. In memory, because a page does not outlive the browser process that holds
   * it: when the browser stops, its pages and their names go together.
   */
  readonly names: Map<string, string>;
}

/**
 * The per-session browser owner. It is deliberately the one implementation of BrowserViewerHost:
 * HTTP actions and a viewer socket therefore address the same worker, tabs and profile-backed page.
 */
export class BrowserSessionService implements BrowserSubsystem {
  private readonly running = new Map<string, Running>();
  private readonly serial = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: BrowserSessionDirectory,
    private readonly launcher: BrowserSessionLauncher,
    private readonly now: () => number,
  ) {}

  async status(sessionId: string): Promise<BrowserStatus> {
    await this.requireSession(sessionId);
    const run = this.running.get(sessionId);
    return run === undefined ? this.stopped(sessionId) : this.project(run);
  }

  async act(sessionId: string, action: BrowserAction): Promise<BrowserActionResult> {
    await this.requireSession(sessionId);
    return await this.exclusive(sessionId, async () => {
      if (action.action === 'start' || action.action === 'open') {
        const run = await this.ensure(sessionId);
        const result =
          action.action === 'open' && action.url !== undefined ? await run.driver.navigate(action.url) : undefined;
        if (result) run.snapshot = result;
        return result === undefined ? { status: this.project(run) } : { status: this.project(run), result };
      }
      if (action.action === 'stop') {
        await this.stop(sessionId);
        return { status: this.stopped(sessionId) };
      }
      const run = this.running.get(sessionId);
      if (!run) throw new BrowserSessionError('not_running', 'the session browser is not running');
      const result = await this.perform(run, action);
      run.snapshot = result;
      return { status: this.project(run), result };
    });
  }

  async openPage(sessionId: string, name: string, url?: string): Promise<BrowserPageSummary> {
    await this.requireSession(sessionId);
    return await this.exclusive(sessionId, async () => {
      const fresh = !this.running.has(sessionId);
      const run = await this.ensure(sessionId);
      if (this.page(run, name) !== undefined)
        throw new BrowserSessionError('conflict', `this session already has a browser page named ${name}`);
      const blank = fresh ? run.snapshot.pages[0] : undefined;
      if (blank === undefined) {
        run.snapshot = await run.driver.newPage(url);
        run.names.set(run.snapshot.activePageId, name);
      } else {
        run.names.set(blank.id, name);
        if (url !== undefined) run.snapshot = await run.driver.navigate(url);
      }
      return this.named(run, run.snapshot.activePageId);
    });
  }

  async actOnPage(sessionId: string, key: string, action: BrowserPageAction): Promise<BrowserActionResult> {
    await this.requireSession(sessionId);
    return await this.exclusive(sessionId, async () => {
      const run = this.requireRunning(sessionId);
      const page = this.requirePage(run, key);
      if (run.snapshot.activePageId !== page.id) run.snapshot = await run.driver.activatePage(page.id);
      const result = await this.perform(run, action);
      run.snapshot = result;
      return { status: this.project(run), result };
    });
  }

  async closePage(sessionId: string, key: string): Promise<void> {
    await this.requireSession(sessionId);
    await this.exclusive(sessionId, async () => {
      const run = this.requireRunning(sessionId);
      const page = this.requirePage(run, key);
      run.snapshot = await run.driver.closePage(page.id);
      run.names.delete(page.id);
    });
  }

  async attachViewer(
    sessionId: string,
    frame: (frame: BrowserScreencastFrame) => void,
    terminal: (signal: ViewerTerminalSignal) => void,
  ): Promise<ViewerAttachment> {
    await this.requireSession(sessionId);
    return await this.exclusive(sessionId, async () => {
      const run = this.running.get(sessionId);
      if (!run) throw new BrowserSessionError('not_running', 'the session browser is not running');
      const viewer: Viewer = { frame, terminal };
      run.viewers.add(viewer);
      try {
        await run.driver.startScreencast(run.viewport, received => {
          for (const listener of run.viewers) listener.frame(received);
        });
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
          if (run.viewers.size === 0) void run.driver.stopScreencast().catch(() => undefined);
        },
      };
    });
  }

  async dispatchHumanInput(sessionId: string, input: BrowserInputEvent): Promise<void> {
    const run = this.running.get(sessionId);
    if (!run) throw new BrowserSessionError('not_running', 'the session browser is not running');
    await run.driver.dispatchInput(input);
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.running.keys()].map(
        async sessionId => await this.exclusive(sessionId, async () => await this.stop(sessionId)),
      ),
    );
  }

  private async ensure(sessionId: string): Promise<Running> {
    const existing = this.running.get(sessionId);
    if (existing) return existing;
    if (this.running.size >= BROWSER_MAX_INSTANCES)
      throw new BrowserSessionError(
        'capacity',
        `this daemon already has ${BROWSER_MAX_INSTANCES} session browsers running`,
      );
    let driver: BrowserAutomation;
    try {
      driver = await this.launcher.launch(sessionId, DEFAULT_BROWSER_VIEWPORT);
      const snapshot = await driver.location();
      const run: Running = {
        sessionId,
        driver,
        viewport: DEFAULT_BROWSER_VIEWPORT,
        startedAt: new Date(this.now()).toISOString(),
        viewers: new Set(),
        snapshot,
        closed: false,
        names: new Map(),
      };
      this.running.set(sessionId, run);
      void driver.unexpectedExit.then(() => this.ended(run));
      return run;
    } catch (error) {
      throw error instanceof BrowserSessionError
        ? error
        : new BrowserSessionError('launch_failed', error instanceof Error ? error.message : 'browser launch failed');
    }
  }

  private async perform(
    run: Running,
    action: Exclude<BrowserAction, { action: 'start' | 'open' | 'stop' }>,
  ): Promise<BrowserPageActionSnapshot> {
    switch (action.action) {
      case 'navigate':
        return await run.driver.navigate(action.url);
      case 'click':
        return await run.driver.click(action.selector);
      case 'type':
        return await run.driver.type(action.selector, action.text);
      case 'read':
        return await run.driver.read(action.selector, action.mode);
      case 'screenshot':
        return await run.driver.screenshot();
      case 'back':
        return await run.driver.back();
      case 'forward':
        return await run.driver.forward();
      case 'reload':
        return await run.driver.reload();
      case 'new-page':
        return await run.driver.newPage(action.url);
      case 'activate-page':
        return await run.driver.activatePage(action.pageId);
      case 'close-page':
        return await run.driver.closePage(action.pageId);
      case 'resize':
        run.viewport = { width: action.width, height: action.height };
        return await run.driver.resize(run.viewport);
      case 'human-activity': {
        const snapshot = await run.driver.location();
        return { ...snapshot, actedPageId: snapshot.activePageId };
      }
    }
  }

  private async stop(sessionId: string): Promise<void> {
    const run = this.running.get(sessionId);
    if (!run) return;
    this.running.delete(sessionId);
    run.closed = true;
    for (const viewer of run.viewers) viewer.terminal({ code: 1000, reason: 'browser stopped' });
    run.viewers.clear();
    await run.driver.close().catch(() => undefined);
  }

  private ended(run: Running): void {
    if (run.closed || this.running.get(run.sessionId) !== run) return;
    this.running.delete(run.sessionId);
    run.closed = true;
    for (const viewer of run.viewers) viewer.terminal({ code: 1011, reason: 'browser worker exited' });
    run.viewers.clear();
  }

  /** The page this name or id addresses, among the pages the browser reported last. */
  private page(run: Running, key: string): BrowserPageSummary | undefined {
    return run.snapshot.pages.find(page => page.id === key || run.names.get(page.id) === key);
  }

  private requirePage(run: Running, key: string): BrowserPageSummary {
    const page = this.page(run, key);
    if (page === undefined) throw new BrowserSessionError('not_found', `there is no browser page named ${key}`);
    return page;
  }

  private requireRunning(sessionId: string): Running {
    const run = this.running.get(sessionId);
    if (!run) throw new BrowserSessionError('not_running', 'the session browser is not running');
    return run;
  }

  /** One page as the wire shows it, carrying its name when it has one. */
  private named(run: Running, pageId: string): BrowserPageSummary {
    const page = this.requirePage(run, pageId);
    const name = run.names.get(page.id);
    return name === undefined ? page : { ...page, name };
  }

  private project(run: Running): BrowserStatus {
    return {
      ...run.snapshot,
      pages: run.snapshot.pages.map(page => this.named(run, page.id)),
      state: 'running',
      sessionId: run.sessionId,
      viewport: run.viewport,
      viewers: run.viewers.size,
      persistentProfile: true,
      profileKind: 'shared',
      idleTimeoutSeconds: 0,
      startedAt: run.startedAt,
      capacity: { running: this.running.size, maximum: BROWSER_MAX_INSTANCES },
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
      idleTimeoutSeconds: 0,
      pages: [],
      capacity: { running: this.running.size, maximum: BROWSER_MAX_INSTANCES },
    };
  }

  private async requireSession(sessionId: string): Promise<void> {
    if ((await this.sessions.get(sessionId)) === undefined)
      throw new BrowserSessionError('not_found', 'the session does not exist');
  }

  private async exclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => {
      release = resolve;
    });
    this.serial.set(
      sessionId,
      previous.then(() => next),
    );
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.serial.get(sessionId) === next) this.serial.delete(sessionId);
    }
  }
}
