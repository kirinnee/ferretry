import { openerGroup, sameOriginOrUnplaced } from './opener-group.ts';
import { mergeTotals, type NavigationEvidence, type NavigationTotals } from '../target/lib/navigation-evidence.ts';
import { type Instant, instantFromEpochMs } from '@ferretry/std';
import { BROWSER_MAX_MACHINE_PAGES, BROWSER_MAX_PAGES, type BrowserStateView } from '../../contract/index.ts';
import {
  type BrowserAction,
  type BrowserActionResult,
  type BrowserInputEvent,
  type BrowserPageActionSnapshot,
  type BrowserPageSnapshot,
  type BrowserPageSummary,
  type BrowserScreencastFrame,
  type BrowserStatus,
  type BrowserViewport,
} from '../../contract/wire/browser.ts';
import {
  type BrowserDialogInfo,
  BrowserDialogInfoSchema,
  type BrowserPageLifecycleReply,
  type BrowserPageLifecycleRequest,
} from '../../contract/wire/page-lifecycle.ts';
import {
  type BrowserElementTarget,
  type BrowserTarget,
  type BrowserTargetFields,
  browserReadModeOf,
  browserTargetOf,
} from '../../contract/wire/target.ts';
import { type SurfaceOpener } from '../../contract/wire/surface.ts';
import type { BrowserAutomation, BrowserPageActed } from './automation.ts';
import type { BrowserCopyPort } from './copy-contracts.ts';
import type { BrowserInputFieldsPort } from '../target/lib/contracts.ts';
import type { BrowserUploadMode } from './page-acts.ts';
import type { PageScript } from '../../contract/wire/page-script.ts';
import type { BrowserViewerHost, ViewerAttachment, ViewerTerminalSignal } from '../stream/viewer-contracts.ts';
import type { WorkerStagedFile } from '../worker/protocol.ts';
import { type BrowserSignInWatch, pageActLeavesSignIn, toolbarActLeavesSignIn } from '../target/sign-in/watch.ts';

const DEFAULT_BROWSER_VIEWPORT: BrowserViewport = { width: 1280, height: 800 };

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
interface BrowserIdleTimer {
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
  /** The host the page is on now, read from the live page inside its queue; `undefined` when it can't be read. */
  host?(): Promise<string | undefined>;
  /** The host of the page AND of every frame in it (`undefined` when any cannot be told), read inside its queue. */
  hosts?(): Promise<readonly (string | undefined)[] | undefined>;
  /** What a read of the page and its frames could show now (visible text, accessibility tree, markup), read inside its queue; `undefined` when it can't be read. */
  text?(): Promise<string | undefined>;
  /**
   * Whether the page — or any window of its opener group — shows a live pairing code (it, or a same-origin frame of it,
   * carries the pairing-screen marker), and how many codes have been shown in them so far: read from the live pages by a
   * DOM search, never a page script. Marked, with a count no document has, when the browser cannot say: a guard that
   * refuses on it FAILS CLOSED. Absent: nothing can ask, and a guard that needs it refuses.
   */
  pairingState?(): Promise<BrowserPairingState>;
}

/** The answer when the pages cannot be read, or one of them shows a code: marked, and counts no real group has. */
const UNREADABLE_PAIRING_STATE: BrowserPairingState = {
  marked: true,
  seen: -1,
  pages: -1,
  targets: [],
  totals: { links: {}, lost: 0 },
};

/** What the live pages say about a pairing code (see {@link BrowserGuardPage.pairingState}). */
export interface BrowserPairingState {
  readonly marked: boolean;
  /** The sum of the sighting counts of the page's group; `-1` when it could not be read. */
  readonly seen: number;
  /** How many pages the group had: a window that closed or opened meanwhile changes it. */
  readonly pages: number;
  /**
   * Each page of the group with where the BROWSER says it has been (`../target/lib/navigation-evidence.ts`): not a DOM
   * fact, so a navigation or a swapped frame cannot take it away. A page whose evidence cannot be had is an unreadable
   * group, never an entry without one.
   */
  readonly targets: readonly { readonly id: string; readonly nav: NavigationEvidence }[];
  /**
   * What the WORKER has counted across every page it has watched, the closed and the departed too (pairing links by
   * origin, navigations lost): the group's own pages say it, and so would any other. It only goes up, so a page that left
   * the group or closed meanwhile cannot take a change out of it.
   */
  readonly totals: NavigationTotals;
}

/**
 * Refuses an act from inside its page's own queue, immediately before it runs — a takeover that landed while it
 * waited, or an owner's value pending on or just typed into the page (the input bridge's holds).
 */
export type BrowserActGuard = (page: BrowserGuardPage) => Promise<void | BrowserActAfter>;

/**
 * What a guard hands back to run AFTER its act, in the same queue slot and before the act's answer (or its failure)
 * leaves: it may refuse, and then neither the answer nor the failure's own words are shown. The runtime calls it once,
 * whether the act succeeded or threw, with the page as it is by then.
 */
export type BrowserActAfter = (page: BrowserGuardPage) => Promise<void>;

/**
 * What a ferret's act on its WHOLE browser must pass for each page it touches, run inside that page's own queue and told
 * which page it is about to touch — so what was checked is exactly what the act then does, with no gap between them.
 */
export type BrowserPageGuard = (pageId: string, page: BrowserGuardPage) => Promise<void>;

/** What a toolbar act may carry besides the action: a ferret's guard, and the page its caller already resolved. */
export interface BrowserActOptions {
  readonly guard?: BrowserPageGuard;
  /**
   * The page the caller resolved for this act (its hold target, its check). When the session now views another page the
   * act is refused with a conflict instead of landing on a page nobody checked.
   */
  readonly pinned?: string;
  /** Who a page this act opens belongs to, as the daemon attests it: a ferret's own page is its own, never a person's. */
  readonly openedBy?: SurfaceOpener;
}

/** Told when a page of a session closes, whoever closed it (a tool, the toolbar, the session's end, the browser stopping). */
export interface BrowserPageClosed {
  closed(sessionId: string, pageId: string): void;
}

/** The ferrets the browser serves: whether one exists, and the spoken name a page is grouped under (Ferrets' own). */
export interface BrowserSessionDirectory {
  get(sessionId: string): Promise<{ readonly name?: string } | undefined>;
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
  /** The origin of the world the script actually ran in, read before the agent's code ran; absent when unknown. */
  readonly scriptOrigin?: string;
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
  /**
   * One toolbar act. `options` carries the ferret's whole-browser guard and the page its caller resolved; `content` is the
   * pairing-screen guard an agent read of the page runs, inside the page's queue right after the `options` guard.
   */
  act(
    sessionId: string,
    action: BrowserAction,
    options?: BrowserActOptions,
    content?: BrowserActGuard,
  ): Promise<BrowserActionResult>;
  /**
   * Empties the browser's clipboard: `true` only when it was CONFIRMED empty. A browser that is not running holds none.
   */
  clearClipboard(): Promise<boolean>;
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
  /**
   * The host of this session's page `key` and of every frame in it, read from the live page and not through its queue (nothing
   * is acted on): for what a LISTING or a status may say of a page a sealed value covers. `undefined` when the browser is not
   * running or any host cannot be told (the caller then fails closed).
   */
  pageHosts(sessionId: string, key: string): Promise<readonly (string | undefined)[] | undefined>;
  /** Closes this session's page with this name (or id). An incognito page's whole context goes with it. */
  closePage(sessionId: string, key: string, guard?: BrowserActGuard): Promise<void>;
  /** A session ended: every page it owns closes, and every incognito context it held is discarded. */
  releaseSession(sessionId: string, guard?: BrowserPageGuard): Promise<void>;
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
  readonly startedAt: Instant;
  /** The last page list the browser reported, every session's pages together. */
  snapshot: BrowserPageSnapshot;
  /**
   * Every page this run has seen and not seen go: what a page that vanished from a fresh read is reconciled against.
   * Kept apart from `snapshot` because an act's answer can carry an older page list than the one before it.
   */
  readonly seen: Map<string, BrowserPageSummary>;
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
    /** Told when an act may have changed who a page signs in, whoever made it (`../target/sign-in/watch.ts`). */
    private readonly signIns?: BrowserSignInWatch,
    /** Told when a page closes: the daemon half publishes `PageChanged` `closed`. A wake-up, so it never fails a close. */
    private readonly pageClosed?: BrowserPageClosed,
  ) {}

  async status(sessionId: string): Promise<BrowserStatus> {
    await this.requireSession(sessionId);
    const run = this.run;
    if (run === undefined) return this.stopped(sessionId);
    const viewed = this.viewedPage(run, sessionId);
    if (viewed !== undefined) {
      // A viewed page that closed inside Chrome cannot describe the list: ask for the list itself.
      const listed = await run.driver.location(viewed).catch(async () => await run.driver.location());
      this.observe(run, pageOf(listed), true);
    }
    return this.project(run, sessionId);
  }

  async act(
    sessionId: string,
    action: BrowserAction,
    options: BrowserActOptions = {},
    content?: BrowserActGuard,
  ): Promise<BrowserActionResult> {
    await this.requireSession(sessionId);
    const { guard, pinned, openedBy } = options;
    if (action.action === 'stop') {
      // Every page the stop will close is asked FIRST: one that is not the caller's to close refuses the whole stop and
      // nothing is closed. Each is asked again in its own queue as it closes.
      if (guard !== undefined && this.run !== undefined) {
        const run = this.run;
        for (const page of this.owned(run, sessionId)) await guard(page.id, this.guardPage(run, page.id));
      }
      this.signIns?.forget(sessionId);
      await this.releaseSession(sessionId, guard);
      return { status: await this.status(sessionId) };
    }
    if (action.action === 'start' || action.action === 'open' || action.action === 'new-page') {
      const run = await this.ensure();
      const viewed = this.viewedPage(run, sessionId);
      if (action.action !== 'new-page' && viewed !== undefined) this.assertPinned(pinned, viewed);
      if (action.action === 'new-page' || viewed === undefined) {
        const opened = await this.openIn(run, sessionId, {
          ...(action.action !== 'start' && action.url !== undefined ? { url: action.url } : {}),
          ...(action.action === 'new-page' && action.incognito === true ? { incognito: true } : {}),
        });
        if (openedBy !== undefined) run.openers.set(opened.actedPageId, openedBy);
        await this.view(run, sessionId, opened.actedPageId);
        return { status: this.project(run, sessionId), result: opened };
      }
      if (action.action === 'start' || action.url === undefined) return { status: this.project(run, sessionId) };
      const url = action.url;
      return await this.onPage(
        run,
        viewed,
        async () => {
          this.signIns?.cleared(sessionId, viewed);
          return await run.driver.navigate(viewed, url);
        },
        sessionId,
        guard,
      );
    }
    const run = this.requireRunning();
    if (action.action === 'activate-page' || action.action === 'close-page') {
      const page = this.requirePage(run, sessionId, action.pageId);
      // A ferret's act waits its turn in the page's queue and is asked there; a person's never has, and still does not.
      const turn = async (work: () => Promise<void>): Promise<void> =>
        guard === undefined ? await work() : await this.exclusive(page.id, work);
      if (action.action === 'activate-page') {
        await turn(async () => {
          await guard?.(page.id, this.guardPage(run, page.id));
          await this.view(run, sessionId, page.id);
        });
        return { status: await this.status(sessionId), result: { ...run.snapshot, actedPageId: page.id } };
      }
      await turn(async () => {
        await guard?.(page.id, this.guardPage(run, page.id));
        this.signIns?.cleared(sessionId, page.id);
        await this.closeIn(run, sessionId, page.id);
      });
      return { status: await this.status(sessionId) };
    }
    const viewed = this.viewedPage(run, sessionId);
    if (viewed === undefined) throw new BrowserSessionError('not_running', 'this session has no browser page open');
    this.assertPinned(pinned, viewed);
    // Who posted it is not known (the owner's address bar or a ferret's `fy browser`): anything but a read clears who
    // the page signs in, before it runs, so an act that fails partway leaves nothing behind either.
    return await this.onPage(
      run,
      viewed,
      async () => {
        if (!toolbarActLeavesSignIn(action)) this.signIns?.cleared(sessionId, viewed);
        return await this.perform(run, viewed, action);
      },
      sessionId,
      guard,
      content,
    );
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
      return await this.guarded(guard, run, page.id, async () => {
        // Cleared BEFORE an act that may change who the page signs in, and after ANY act that failed partway (a fill that
        // typed the email and then broke, an Enter that timed out after the page moved): the agent tools put a record
        // back only from what they saw a finished act do.
        if (!pageActLeavesSignIn(action)) this.signIns?.cleared(sessionId, page.id);
        let result: BrowserPageActionSnapshot;
        try {
          result = await this.perform(run, page.id, action);
        } catch (error) {
          this.signIns?.cleared(sessionId, page.id);
          throw error;
        }
        this.observe(run, pageOf(result));
        this.touch(run);
        return { status: this.project(run, sessionId), result };
      });
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

  async pageHosts(sessionId: string, key: string): Promise<readonly (string | undefined)[] | undefined> {
    const run = this.run;
    if (run === undefined || run.closed) return undefined;
    const page = this.requirePage(run, sessionId, key);
    return await this.guardPage(run, page.id).hosts?.();
  }

  /** Secure copy's read of one page, in that page's own queue (copy-contracts.ts). */
  async copyOnPage<T>(
    sessionId: string,
    key: string,
    {
      work,
      guard,
    }: { readonly work: (copy: BrowserCopyPort, pageId: string) => Promise<T>; readonly guard?: BrowserActGuard },
  ): Promise<T> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    const page = this.requirePage(run, sessionId, key);
    return await this.exclusive(page.id, async () => {
      // The same in-queue check an agent's act gets: a takeover or a hold that landed while the copy waited wins.
      await guard?.(this.guardPage(run, page.id));
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
      // Answering a dialog may let the page leave (a beforeunload) or hand it a typed answer (a prompt).
      if (request.op === 'dialog') this.signIns?.cleared(sessionId, page.id);
      const answered = await run.driver.lifecycle(page.id, request);
      this.observe(run, pageOf(answered));
      if (request.op === 'emulate') {
        const { viewport, reset } = request.emulation;
        if (reset === true) run.viewports.delete(page.id);
        if (viewport !== undefined) run.viewports.set(page.id, viewport);
      }
      this.touch(run);
      return { reply: answered.lifecycle, ...(answered.dialog === undefined ? {} : { dialog: answered.dialog }) };
    };
    if (request.op === 'dialog' || request.op === 'console' || request.op === 'network')
      return await this.guarded(guard, run, page.id, perform);
    return await this.exclusive(page.id, async () => await this.guarded(guard, run, page.id, perform));
  }

  async adoptPage(sessionId: string, key: string, name: string, openedBy?: SurfaceOpener): Promise<BrowserPageSummary> {
    await this.requireSession(sessionId);
    const run = this.requireRunning();
    this.observe(run, pageOf(await run.driver.location()), true);
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
      return await this.guarded(guard, run, page.id, async () => {
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
        this.observe(run, pageOf(result));
        this.touch(run);
        return { status: this.project(run, sessionId), result, ...(staged === undefined ? {} : { staged }) };
      });
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
      return await this.guarded(guard, run, page.id, async () => {
        // A script can type or choose an account on any page of the session: who they sign in is no longer known.
        this.signIns?.forget(sessionId);
        const { text, scriptOrigin, ...result } = await run.driver.evaluate(page.id, script);
        this.observe(run, pageOf(result));
        this.touch(run);
        return {
          status: this.project(run, sessionId),
          result,
          text,
          ...(scriptOrigin === undefined ? {} : { scriptOrigin }),
        };
      });
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

  async releaseSession(sessionId: string, guard?: BrowserPageGuard): Promise<void> {
    const run = this.run;
    if (run === undefined) return;
    for (const page of this.owned(run, sessionId))
      await this.exclusive(page.id, async () => {
        // A refusal is the caller's to hear; only a close that failed is let go, as a session's end always did.
        await guard?.(page.id, this.guardPage(run, page.id));
        await this.closeIn(run, sessionId, page.id).catch(() => undefined);
      });
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
    // A person typing or pressing in the live view (an account tile in a chooser, the "pick the account" hand-off) may be
    // signing someone else in: who the session's pages sign in is no longer known. A move, a wheel or a release is not.
    if (input.kind !== 'mouse' || input.type === 'mousePressed') this.signIns?.forget(sessionId);
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

  async clearClipboard(): Promise<boolean> {
    const run = this.run;
    // No browser, no clipboard of its: a restarted private browser starts empty.
    if (run === undefined) return true;
    return await run.driver.clearClipboard().catch(() => false);
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
      const snapshot = pageOf(await driver.location());
      const run: Running = {
        driver,
        startedAt: instantFromEpochMs(this.now()),
        snapshot,
        seen: new Map(snapshot.pages.map(page => [page.id, page])),
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
      this.observe(run, pageOf(await run.driver.location()), true);
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
      this.observe(run, pageOf(opened));
      if (!run.viewed.has(sessionId)) run.viewed.set(sessionId, opened.actedPageId);
      this.touch(run);
      return opened;
    });
  }

  private async closeIn(run: Running, sessionId: string, pageId: string): Promise<void> {
    const result = await run.driver.closePage(pageId);
    // The close answers the page list without the page, and observing it ends the page; a page the answer still lists
    // (a browser that lags) is ended here all the same.
    this.observe(run, pageOf(result), true);
    if (run.seen.has(pageId) || run.owners.has(pageId)) this.release(run, sessionId, pageId);
    this.touch(run);
  }

  /**
   * Takes in a page list the browser just described. A FRESH list (`status`, a new page, an adoption) is the whole
   * truth about which pages exist, so a page this run saw before and that is not in it closed inside Chrome (the
   * website, the real window, a crash): it ends like any other close. An act's answer only adds what it names.
   */
  private observe(run: Running, next: BrowserPageSnapshot, fresh = false): void {
    for (const page of next.pages) run.seen.set(page.id, page);
    if (fresh) {
      const present = new Set(next.pages.map(page => page.id));
      const gone = [...run.seen.values()].filter(page => !present.has(page.id));
      // Who owned each is read before any of them is forgotten: a popup is its opener's, and the opener may be gone too.
      const owners = gone.map(page => [page, this.ownerOf(run, page)] as const);
      for (const [page, owner] of owners) this.release(run, owner, page.id);
    }
    run.snapshot = next;
  }

  /** A page ended, however it ended: its records, its viewers, and who watches for a close all hear of it. */
  private release(run: Running, sessionId: string | undefined, pageId: string): void {
    // A live popup is its opener's only by lineage; with the opener gone nothing resolves its session, so a stop or a
    // crash would skip it and leave its takeover standing. It keeps its session's ownership on itself before the
    // opener's records go.
    if (sessionId !== undefined)
      for (const page of run.seen.values())
        if (page.openerId === pageId && !run.owners.has(page.id)) run.owners.set(page.id, sessionId);
    run.seen.delete(pageId);
    run.owners.delete(pageId);
    run.names.delete(pageId);
    run.openers.delete(pageId);
    run.viewports.delete(pageId);
    for (const viewer of [...run.viewers])
      if (viewer.pageId === pageId) {
        run.viewers.delete(viewer);
        viewer.terminal({ code: 1000, reason: 'the page closed' });
      }
    if (sessionId === undefined) return;
    if (run.viewed.get(sessionId) === pageId) {
      const next = this.owned(run, sessionId)
        .filter(page => page.id !== pageId)
        .at(-1);
      if (next === undefined) run.viewed.delete(sessionId);
      else run.viewed.set(sessionId, next.id);
    }
    this.told(sessionId, pageId);
  }

  /** Tells whoever watches that a page closed; a watcher that throws does not undo the close. */
  private told(sessionId: string, pageId: string): void {
    try {
      this.pageClosed?.closed(sessionId, pageId);
    } catch {
      // A wake-up only: the port is the truth.
    }
  }

  /** Every page a session owned closed with the browser: the adopted ones, and the popups nobody adopted too. */
  private toldAll(run: Running): void {
    const owned = new Map(run.owners);
    for (const page of run.seen.values()) {
      const owner = this.ownerOf(run, page);
      if (owner !== undefined) owned.set(page.id, owner);
    }
    for (const [pageId, sessionId] of owned) this.told(sessionId, pageId);
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
    guard?: BrowserPageGuard,
    content?: BrowserActGuard,
  ): Promise<BrowserActionResult> {
    return await this.exclusive(pageId, async () => {
      // The page this act was resolved to, asked in ITS queue right before the act: nothing lands between the two. The
      // ferret's whole-browser guard runs first; the pairing-screen guard (`content`) right after, and its after-check
      // once the act is over.
      await guard?.(pageId, this.guardPage(run, pageId));
      const result = withoutDialog(await this.guarded(content, run, pageId, work));
      this.observe(run, pageOf(result));
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
    this.toldAll(run);
  }

  private ended(run: Running): void {
    if (run.closed || this.run !== run) return;
    this.run = undefined;
    run.closed = true;
    run.idle?.cancel();
    for (const viewer of run.viewers) viewer.terminal({ code: 1011, reason: 'browser worker exited' });
    run.viewers.clear();
    this.toldAll(run);
  }

  /** The session a page belongs to: its own record, or its opener's (a popup is its opener's). */
  private ownerOf(run: Running, page: BrowserPageSummary, depth = 0): string | undefined {
    const own = run.owners.get(page.id);
    if (own !== undefined || page.openerId === undefined || depth > 8) return own;
    const opener = run.seen.get(page.openerId);
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

  /** The page the caller resolved is the page this session views now, or the act is refused rather than land elsewhere. */
  private assertPinned(pinned: string | undefined, viewed: string): void {
    if (pinned !== undefined && pinned !== viewed)
      throw new BrowserSessionError('conflict', 'the page this was meant for is no longer the one in view; try again');
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
  /**
   * Runs one act inside its page's queue between its guard and the guard's after-check. The guard runs first and may
   * refuse; if it hands back an after-check, that runs once the act is over — success or failure — and a refusal there
   * replaces both (an act that read while a code came on screen shows nothing of what it read, nor of why it failed).
   */
  private async guarded<T>(
    guard: BrowserActGuard | undefined,
    run: Running,
    pageId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const page = this.guardPage(run, pageId);
    const after = await guard?.(page);
    let result: T;
    try {
      result = await work();
    } catch (error) {
      await after?.(page);
      throw error;
    }
    await after?.(page);
    return result;
  }

  private guardPage(run: Running, pageId: string): BrowserGuardPage {
    return {
      pairingState: async () => await this.pairingStateOf(run, pageId),
      document: async () =>
        await run.driver
          .inputDocument(pageId)
          .then(found => found.navigationId)
          .catch(() => undefined),
      host: async () =>
        await run.driver
          .inputDocument(pageId)
          .then(found => found.host)
          .catch(() => undefined),
      hosts: async () =>
        await run.driver
          .inputDocument(pageId)
          .then(found =>
            found.host === undefined || found.framesUnreadable === true
              ? undefined
              : [found.host, ...(found.frameHosts ?? [])],
          )
          .catch(() => undefined),
      text: async () => await run.driver.inputText?.(pageId).catch(() => undefined),
    };
  }

  /**
   * What the page and every window that can reach it say about a pairing code. A script in a page reaches the pages
   * related to it by `window.opener` and by the popups it opened (same-origin ones fully), so the whole opener group is
   * asked, not only the page that was named: the page that is NOT marked may hold a handle on one that is. Anything that
   * cannot be read, including the group itself, is marked (fail closed).
   */
  private async pairingStateOf(run: Running, pageId: string): Promise<BrowserPairingState> {
    try {
      this.observe(run, pageOf(await run.driver.location()), true);
      // The opener group, and EVERY page of the browser on the named page's origin (or on one nobody can place): a window
      // with no opener can still be same-origin with a document that shows a code, and the lack of a link is no proof it
      // cannot reach it. Pages on other origins cannot script this one's documents and are left out.
      const named = run.snapshot.pages.find(candidate => candidate.id === pageId)?.url;
      const related = run.snapshot.pages
        .filter(candidate => sameOriginOrUnplaced(candidate.url, named))
        .map(each => each.id);
      const group = [...new Set([...openerGroup(run.snapshot.pages, pageId), ...related])];
      let seen = 0;
      let totals: NavigationTotals | undefined;
      const targets: { id: string; nav: NavigationEvidence }[] = [];
      for (const id of group) {
        const found = await run.driver.inputDocument(id);
        if (found.pairingScreen === true) return UNREADABLE_PAIRING_STATE;
        if (typeof found.pairingSeen !== 'number' || found.pairingSeen < 0) return UNREADABLE_PAIRING_STATE;
        if (found.navigation === undefined) return UNREADABLE_PAIRING_STATE;
        seen += found.pairingSeen;
        totals = totals === undefined ? found.navigation.totals : mergeTotals(totals, found.navigation.totals);
        targets.push({ id, nav: found.navigation });
      }
      // No page to ask is no totals to read: a look that cannot say what the worker has counted is a look that refuses.
      if (totals === undefined) return UNREADABLE_PAIRING_STATE;
      return { marked: false, seen, pages: group.length, targets, totals };
    } catch {
      return UNREADABLE_PAIRING_STATE;
    }
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
    const name = session.name;
    if (typeof name === 'string' && name !== '') this.sessionNames.set(sessionId, name);
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
