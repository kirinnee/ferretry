import { BrowserIdentityKeySchema, type BrowserStateView, DEFAULT_BROWSER_IDENTITY } from '../../contract/index.ts';
import type {
  BrowserAction,
  BrowserActionResult,
  BrowserInputEvent,
  BrowserPageSummary,
  BrowserScreencastFrame,
  BrowserStatus,
} from '../../contract/wire/browser.ts';
import type { BrowserPageLifecycleRequest } from '../../contract/wire/page-lifecycle.ts';
import type { PageScript } from '../../contract/wire/page-script.ts';
import type { SurfaceOpener } from '../../contract/wire/surface.ts';
import type { BrowserInputFieldsPort } from '../target/lib/contracts.ts';
import type { BrowserCopyPort } from './copy-contracts.ts';
import { isBrowserPageId } from './page-id.ts';
import type { ViewerAttachment, ViewerRef, ViewerTerminalSignal } from '../stream/viewer-contracts.ts';
import {
  type BrowserActGuard,
  type BrowserActOptions,
  type BrowserFileAction,
  type BrowserFileResult,
  type BrowserLifecycleOutcome,
  type BrowserOpenOptions,
  type BrowserPageAction,
  type BrowserPageGuard,
  type BrowserPageQuota,
  type BrowserScriptResult,
  BrowserSessionError,
  type BrowserSessionService,
  type BrowserSubsystem,
} from './service.ts';

/** What the router needs from the composition root. */
export interface IdentityBrowsersOptions {
  /** One identity's browser service, bound to that identity's launcher; the quota is the router's own (the caps are machine-wide). */
  readonly make: (identity: string, quota: BrowserPageQuota) => BrowserSessionService;
  /** How many identities may have a Chrome at once, read at every start. */
  readonly maxRunning: () => number;
  /** Whether `browsers.yaml` names this identity, read at every open: a retired one, whose profile may still be on disk, is not. The built-in `agent` needs no entry. */
  readonly configured: (identity: string) => boolean;
}

/**
 * EVERY IDENTITY'S BROWSER, BEHIND THE ONE SURFACE THE REST OF BROWSERS ALREADY USES.
 *
 * An identity is its own Chrome, its own profile, its own proxy and its own screen (`../worker/launcher.ts`), and each
 * runs in a {@link BrowserSessionService} of its own — so one identity stopping, crashing or going idle closes only its
 * own pages, and two identities are driven side by side with nothing queued behind each other. This holds those
 * services and routes each call to the right one: a page by the identity that opened it, a new page by the identity the
 * caller named (else the one the session is already using, else the default), a screen by the identity it was attached to.
 *
 * The caps are the machine's, not an identity's: a session still has at most 20 pages and the machine 60, counted across
 * every identity. A new cap, `maxRunning`, keeps the box usable — one identity more than that is refused in a sentence that
 * names the ones running — and a page name stays unique within a session whichever identity holds it.
 */
export class IdentityBrowsers implements BrowserSubsystem {
  private readonly services = new Map<string, BrowserSessionService>();
  private readonly naming = new Map<string, Set<string>>();
  private readonly admissions = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  /** Identities a start has been asked for and has not answered yet: they count as running from the moment of the ask. */
  private readonly starting = new Map<string, number>();
  /** Every live screen, by the id the stream told its client: which identity's Chrome it is on, and the attachment it holds there. */
  private readonly screens = new Map<string, Screen>();
  /** The identity each session last opened a page in: where a call that names none goes. */
  private readonly last = new Map<string, string>();
  private readonly quota: BrowserPageQuota = {
    session: sessionId => this.sum(service => service.sessionPageCount(sessionId)),
    machine: () => this.sum(service => service.machinePageCount()),
  };

  constructor(private readonly options: IdentityBrowsersOptions) {}

  async status(sessionId: string, viewer?: ViewerRef): Promise<BrowserStatus> {
    const home = this.homeOf(sessionId, viewer);
    const main = tagged(home, await this.serviceOf(home).status(sessionId, this.viewerIn(home, viewer)));
    const others = [...this.services].filter(([identity, service]) => identity !== home && this.running(service));
    if (others.length === 0) return main;
    const rest = await Promise.all(
      others.map(async ([identity, service]) => tagged(identity, await service.status(sessionId))),
    );
    const pages = [...main.pages, ...rest.flatMap(status => status.pages)];
    return {
      ...main,
      pages: pages as unknown as typeof main.pages,
      viewers: [main, ...rest].reduce((total, status) => total + status.viewers, 0),
      capacity: { ...main.capacity, running: this.quota.machine() },
    } as BrowserStatus;
  }

  async attachViewer(
    sessionId: string,
    onFrame: (frame: BrowserScreencastFrame) => void,
    onTerminal: (signal: ViewerTerminalSignal) => void,
    caller: string,
  ): Promise<ViewerAttachment> {
    const identity = this.homeOf(sessionId);
    const attached = await this.serviceOf(identity).attachViewer(sessionId, onFrame, onTerminal, caller);
    // The id the stream tells its client is the first attachment's, and stays this screen's for life, wherever it moves.
    const id = attached.viewerId;
    const screen: Screen = { sessionId, identity, attached, onFrame, onTerminal, caller, moving: Promise.resolve() };
    this.screens.set(id, screen);
    return {
      viewerId: id,
      detach: () => {
        this.screens.delete(id);
        screen.attached.detach();
      },
    };
  }

  async dispatchHumanInput(
    sessionId: string,
    input: BrowserInputEvent,
    viewer: ViewerRef,
    page?: string,
  ): Promise<void> {
    const identity = this.screenOf(viewer) ?? DEFAULT_BROWSER_IDENTITY;
    await this.serviceOf(identity).dispatchHumanInput(
      sessionId,
      input,
      this.viewerIn(identity, viewer) ?? viewer,
      page,
    );
  }

  async act(
    sessionId: string,
    action: BrowserAction,
    options: BrowserActOptions = {},
    content?: BrowserActGuard,
  ): Promise<BrowserActionResult> {
    if (action.action === 'stop') {
      // A stop is the session's own: every identity it holds pages in lets go, and each closes its Chrome once nothing needs it.
      for (const service of [...this.services.values()]) await service.act(sessionId, action, options, content);
      return { status: await this.status(sessionId) };
    }
    if (action.action === 'start' || action.action === 'open' || action.action === 'new-page') {
      const identity = this.current(this.named(options.identity) ?? this.homeOf(sessionId, options.viewer));
      const acted = await this.admit(identity, async () => {
        const answered = await this.serviceOf(identity).act(
          sessionId,
          action,
          this.optionsIn(identity, options),
          content,
        );
        this.last.set(sessionId, identity);
        return answered;
      });
      return acted;
    }
    const pageId = 'pageId' in action && typeof action.pageId === 'string' ? action.pageId : undefined;
    // A page the act names is in the identity that holds it; an act on "the page this screen shows" is the screen's own identity's.
    const identity = this.holder(sessionId, pageId) ?? this.screenOf(options.viewer) ?? this.homeOf(sessionId);
    // Showing a page of another identity moves the screen to that identity's Chrome: one live display, whichever browser the page is in.
    if (action.action === 'activate-page' && options.viewer !== undefined) await this.follow(options.viewer, identity);
    return await this.serviceOf(identity).act(sessionId, action, this.optionsIn(identity, options), content);
  }

  async clearClipboard(): Promise<boolean> {
    const cleared = await Promise.all([...this.services.values()].map(async service => await service.clearClipboard()));
    return cleared.every(Boolean);
  }

  async openPage(sessionId: string, name: string, options: BrowserOpenOptions = {}): Promise<BrowserPageSummary> {
    return await this.withName(sessionId, name, async () => {
      const identity = this.current(this.named(options.identity) ?? this.homeOf(sessionId));
      return await this.admit(identity, async () => {
        const opened = await this.serviceOf(identity).openPage(sessionId, name, options);
        this.last.set(sessionId, identity);
        return opened;
      });
    });
  }

  async actOnPage(
    sessionId: string,
    key: string,
    action: BrowserPageAction,
    guard?: BrowserActGuard,
  ): Promise<BrowserActionResult> {
    return await this.pageService(sessionId, key).actOnPage(sessionId, key, action, guard);
  }

  async lifecycleOnPage(
    sessionId: string,
    key: string,
    request: BrowserPageLifecycleRequest,
    guard?: BrowserActGuard,
  ): Promise<BrowserLifecycleOutcome> {
    return await this.pageService(sessionId, key).lifecycleOnPage(sessionId, key, request, guard);
  }

  async adoptPage(sessionId: string, key: string, name: string, openedBy?: SurfaceOpener): Promise<BrowserPageSummary> {
    return await this.withName(
      sessionId,
      name,
      async () => await this.pageService(sessionId, key).adoptPage(sessionId, key, name, openedBy),
    );
  }

  async scriptOnPage(
    sessionId: string,
    key: string,
    script: PageScript,
    guard?: BrowserActGuard,
  ): Promise<BrowserScriptResult> {
    return await this.pageService(sessionId, key).scriptOnPage(sessionId, key, script, guard);
  }

  async filesOnPage(
    sessionId: string,
    key: string,
    action: BrowserFileAction,
    guard?: BrowserActGuard,
  ): Promise<BrowserFileResult> {
    return await this.pageService(sessionId, key).filesOnPage(sessionId, key, action, guard);
  }

  async inputOnPage<T>(
    sessionId: string,
    key: string,
    work: (fields: BrowserInputFieldsPort, pageId: string) => Promise<T>,
  ): Promise<T> {
    return await this.pageService(sessionId, key).inputOnPage(sessionId, key, work);
  }

  /** Secure copy's read of one page, in the queue of the identity's browser that holds it. */
  async copyOnPage<T>(
    sessionId: string,
    key: string,
    options: {
      readonly work: (copy: BrowserCopyPort, pageId: string) => Promise<T>;
      readonly guard?: BrowserActGuard;
    },
  ): Promise<T> {
    return await this.pageService(sessionId, key).copyOnPage(sessionId, key, options);
  }

  async pageHosts(sessionId: string, key: string): Promise<readonly (string | undefined)[] | undefined> {
    return await this.pageService(sessionId, key).pageHosts(sessionId, key);
  }

  async closePage(sessionId: string, key: string, guard?: BrowserActGuard): Promise<void> {
    await this.pageService(sessionId, key).closePage(sessionId, key, guard);
  }

  async releaseSession(sessionId: string, guard?: BrowserPageGuard): Promise<void> {
    for (const service of [...this.services.values()]) await service.releaseSession(sessionId, guard);
    this.last.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    this.closing ??= (async () => {
      await Promise.allSettled([...this.admissions]);
      await Promise.all([...this.services.values()].map(async service => await service.closeAll()));
    })().finally(() => {
      this.closing = undefined;
    });
    await this.closing;
  }

  /** Closes ONE identity's Chrome and its pages, leaving every other identity's browser as it was (the login window for that identity). */
  async closeIdentity(identity: string): Promise<void> {
    await this.services.get(identity)?.closeAll();
  }

  /** Whether any identity's browser runs, since when (the earliest), and the proxy the first of them started with. */
  overview(): BrowserStateView {
    const running = [...this.services.values()]
      .map(service => service.overview())
      .filter(view => view.state === 'running');
    const first = running[0];
    if (first !== undefined && first.state === 'running') {
      return running.reduce((best, view) =>
        view.state === 'running' && best.state === 'running' && (view.startedAt ?? '') < (best.startedAt ?? '')
          ? view
          : best,
      );
    }
    const starting = [...this.services.values()].some(service => service.overview().state === 'starting');
    return { state: starting || this.starting.size > 0 ? 'starting' : 'stopped' };
  }

  /** The identities whose Chrome runs, or is being started, right now. */
  runningIdentities(): readonly string[] {
    return [...this.services]
      .filter(([identity, service]) => this.running(service) || (this.starting.get(identity) ?? 0) > 0)
      .map(([identity]) => identity);
  }

  /** Counts a start against `maxRunning` from the moment it is asked, so two at once cannot both slip under it. */
  private async admit<T>(identity: string, work: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) throw new BrowserSessionError('not_running', 'the browsers are stopping');
    const live = this.runningIdentities();
    const limit = this.options.maxRunning();
    if (!live.includes(identity) && live.length >= limit)
      throw new BrowserSessionError(
        'capacity',
        `${live.length === 1 ? 'The browser identity' : 'The browser identities'} ${live.join(', ')} ${live.length === 1 ? 'is' : 'are'} already running, and at most ${String(limit)} may run at once; close the pages of one of them (or raise maxRunning in the Browsers settings) before opening ${identity}`,
      );
    this.starting.set(identity, (this.starting.get(identity) ?? 0) + 1);
    const admitted = work();
    this.admissions.add(admitted);
    try {
      return await admitted;
    } finally {
      this.admissions.delete(admitted);
      const left = (this.starting.get(identity) ?? 1) - 1;
      if (left <= 0) this.starting.delete(identity);
      else this.starting.set(identity, left);
    }
  }

  /** An identity's service, made on first need. */
  private serviceOf(identity: string): BrowserSessionService {
    let service = this.services.get(identity);
    if (service === undefined) {
      service = this.options.make(identity, this.quota);
      this.services.set(identity, service);
    }
    return service;
  }

  /** The service holding this session's page `key`: the identity that opened it. A page nobody holds answers as the default identity's browser does. */
  private pageService(sessionId: string, key: string): BrowserSessionService {
    return this.serviceOf(this.holder(sessionId, key) ?? this.homeOf(sessionId));
  }

  /** The identity whose browser holds this session's page with this name or id. */
  private holder(sessionId: string, key: string | undefined): string | undefined {
    if (key === undefined) return undefined;
    return (
      [...this.services].find(([, service]) => service.ownsId(sessionId, key))?.[0] ??
      [...this.services].find(([, service]) => service.owns(sessionId, key))?.[0]
    );
  }

  /** Reserve synchronously before either operation yields, across all identities and both naming paths. */
  private async withName<T>(sessionId: string, name: string, work: () => Promise<T>): Promise<T> {
    let pending = this.naming.get(sessionId);
    if (isBrowserPageId(name) || pending?.has(name) === true || this.holder(sessionId, name) !== undefined)
      throw new BrowserSessionError(
        'conflict',
        `this session already has a browser page named ${name}, or that name is reserved for page ids`,
      );
    if (pending === undefined) {
      pending = new Set();
      this.naming.set(sessionId, pending);
    }
    pending.add(name);
    try {
      return await work();
    } finally {
      pending.delete(name);
      if (pending.size === 0) this.naming.delete(sessionId);
    }
  }

  /** Where a call that names no page and no identity goes: the identity the session last used while it still holds pages there, else any that holds one, else its last (or the default). */
  private homeOf(sessionId: string, viewer?: ViewerRef): string {
    const screen = this.screenOf(viewer);
    if (screen !== undefined) return screen;
    const last = this.last.get(sessionId);
    const holding = [...this.services].filter(([, service]) => service.sessionPageCount(sessionId) > 0);
    if (last !== undefined && holding.some(([identity]) => identity === last)) return last;
    return holding[0]?.[0] ?? last ?? DEFAULT_BROWSER_IDENTITY;
  }

  private screenOf(viewer: ViewerRef | undefined): string | undefined {
    return viewer === undefined ? undefined : this.screens.get(viewer.id)?.identity;
  }

  /** The screen as the identity's own service knows it: its attachment there carries its own id. Absent when the screen is on another identity's Chrome. */
  private viewerIn(identity: string, viewer: ViewerRef | undefined): ViewerRef | undefined {
    const screen = viewer === undefined ? undefined : this.screens.get(viewer.id);
    if (viewer === undefined || screen === undefined) return viewer;
    return screen.identity === identity ? { ...viewer, id: screen.attached.viewerId } : undefined;
  }

  private optionsIn(identity: string, options: BrowserActOptions): BrowserActOptions {
    if (options.viewer === undefined) return options;
    const { viewer: _screen, ...rest } = options;
    const own = this.viewerIn(identity, options.viewer);
    return own === undefined ? rest : { ...rest, viewer: own };
  }

  /** Moves a screen to another identity's Chrome: attached there first, then let go of where it was, so it never goes dark between. */
  private async follow(viewer: ViewerRef, identity: string): Promise<void> {
    const screen = this.screens.get(viewer.id);
    if (screen === undefined) return;
    const move = screen.moving.then(async () => {
      if (screen.identity === identity) return;
      const next = await this.serviceOf(identity).attachViewer(
        screen.sessionId,
        screen.onFrame,
        screen.onTerminal,
        screen.caller,
      );
      const previous = screen.attached;
      screen.attached = next;
      screen.identity = identity;
      previous.detach();
    });
    screen.moving = move.catch(() => undefined);
    await move;
  }

  /** A named identity must be a key `browsers.yaml` could hold AND one it does hold (or the built-in); anything else is refused where it is named, before any Chrome or profile is touched. */
  private named(identity: string | undefined): string | undefined {
    if (identity === undefined) return undefined;
    if (!BrowserIdentityKeySchema.safeParse(identity).success)
      throw new BrowserSessionError('not_found', `there is no browser identity named ${identity}`);
    return this.current(identity);
  }

  /** The identity as the configuration stands NOW, asked at every open, new page and start and never remembered: one retired since the session last used it is refused, whatever its profile folder still holds. */
  private current(identity: string): string {
    if (identity !== DEFAULT_BROWSER_IDENTITY && !this.options.configured(identity))
      throw new BrowserSessionError(
        'not_found',
        `there is no browser identity named ${identity}; add it under identities in browsers.yaml first`,
      );
    return identity;
  }

  private running(service: BrowserSessionService): boolean {
    return ['running', 'starting', 'stopping'].includes(service.overview().state);
  }

  private sum(count: (service: BrowserSessionService) => number): number {
    return [...this.services.values()].reduce((total, service) => total + count(service), 0);
  }
}

/** A status with each page told which identity's Chrome holds it: the daemon knows, so the page, the panel and the agent's list can say. */
function tagged(identity: string, status: BrowserStatus): BrowserStatus {
  return { ...status, pages: status.pages.map(page => ({ ...page, identity })) } as BrowserStatus;
}

/** One live screen: where it is now, and what it takes to put it on another identity's Chrome. */
interface Screen {
  readonly sessionId: string;
  identity: string;
  attached: ViewerAttachment;
  readonly onFrame: (frame: BrowserScreencastFrame) => void;
  readonly onTerminal: (signal: ViewerTerminalSignal) => void;
  readonly caller: string;
  moving: Promise<void>;
}
