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
  /** Identities a start has been asked for and has not answered yet: they count as running from the moment of the ask. */
  private readonly starting = new Map<string, number>();
  private readonly screens = new Map<string, string>();
  /** The identity each session last opened a page in: where a call that names none goes. */
  private readonly last = new Map<string, string>();
  private readonly quota: BrowserPageQuota = {
    session: sessionId => this.sum(service => service.sessionPageCount(sessionId)),
    machine: () => this.sum(service => service.machinePageCount()),
  };

  constructor(private readonly options: IdentityBrowsersOptions) {}

  async status(sessionId: string, viewer?: ViewerRef): Promise<BrowserStatus> {
    const home = this.homeOf(sessionId, viewer);
    const main = await this.serviceOf(home).status(sessionId, viewer);
    const others = [...this.services].filter(([identity, service]) => identity !== home && this.running(service));
    if (others.length === 0) return main;
    const rest = await Promise.all(others.map(async ([, service]) => await service.status(sessionId)));
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
    this.screens.set(attached.viewerId, identity);
    return {
      viewerId: attached.viewerId,
      detach: () => {
        this.screens.delete(attached.viewerId);
        attached.detach();
      },
    };
  }

  async dispatchHumanInput(sessionId: string, input: BrowserInputEvent, viewer: ViewerRef): Promise<void> {
    await this.serviceOf(this.screens.get(viewer.id) ?? DEFAULT_BROWSER_IDENTITY).dispatchHumanInput(
      sessionId,
      input,
      viewer,
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
      const identity = this.named(options.identity) ?? this.homeOf(sessionId, options.viewer);
      const acted = await this.admit(identity, async () => {
        const answered = await this.serviceOf(identity).act(sessionId, action, options, content);
        this.last.set(sessionId, identity);
        return answered;
      });
      return acted;
    }
    const pageId = 'pageId' in action && typeof action.pageId === 'string' ? action.pageId : undefined;
    const identity = this.screenOf(options.viewer) ?? this.holder(sessionId, pageId) ?? this.homeOf(sessionId);
    return await this.serviceOf(identity).act(sessionId, action, options, content);
  }

  async clearClipboard(): Promise<boolean> {
    const cleared = await Promise.all([...this.services.values()].map(async service => await service.clearClipboard()));
    return cleared.every(Boolean);
  }

  async openPage(sessionId: string, name: string, options: BrowserOpenOptions = {}): Promise<BrowserPageSummary> {
    // A name is the session's, whichever identity's browser holds the page it names.
    if (this.holder(sessionId, name) !== undefined)
      throw new BrowserSessionError('conflict', `this session already has a browser page named ${name}`);
    const identity = this.named(options.identity) ?? this.homeOf(sessionId);
    return await this.admit(identity, async () => {
      const opened = await this.serviceOf(identity).openPage(sessionId, name, options);
      this.last.set(sessionId, identity);
      return opened;
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
    return await this.pageService(sessionId, key).adoptPage(sessionId, key, name, openedBy);
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
    await Promise.all([...this.services.values()].map(async service => await service.closeAll()));
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
    const live = this.runningIdentities();
    const limit = this.options.maxRunning();
    if (!live.includes(identity) && live.length >= limit)
      throw new BrowserSessionError(
        'capacity',
        `${live.length === 1 ? 'The browser identity' : 'The browser identities'} ${live.join(', ')} ${live.length === 1 ? 'is' : 'are'} already running, and at most ${String(limit)} may run at once; close the pages of one of them (or raise maxRunning in the Browsers settings) before opening ${identity}`,
      );
    this.starting.set(identity, (this.starting.get(identity) ?? 0) + 1);
    try {
      return await work();
    } finally {
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
    return [...this.services].find(([, service]) => service.owns(sessionId, key))?.[0];
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
    return viewer === undefined ? undefined : this.screens.get(viewer.id);
  }

  /** A named identity must be a key `browsers.yaml` could hold; anything else is refused where it is named. */
  private named(identity: string | undefined): string | undefined {
    if (identity === undefined) return undefined;
    if (!BrowserIdentityKeySchema.safeParse(identity).success)
      throw new BrowserSessionError('not_found', `there is no browser identity named ${identity}`);
    return identity;
  }

  private running(service: BrowserSessionService): boolean {
    return service.overview().state === 'running';
  }

  private sum(count: (service: BrowserSessionService) => number): number {
    return [...this.services.values()].reduce((total, service) => total + count(service), 0);
  }
}
