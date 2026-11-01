/**
 * ONE BROWSER SURFACE, TWO EXPLICIT ENGINES — the render. Ported from
 * `ui/src/components/UnifiedBrowserSurface.tsx`; its decisions live in
 * `unified-browser-model.ts`.
 *
 * `preview` is the deployed, process-free iframe reader. `remote` is the
 * session's persistent Chrome on the paired daemon. The single toolbar is
 * deliberately engine-agnostic: its address and navigation controls operate on
 * whichever history the reader selected, and switching engines never discards
 * the other one's position.
 *
 * Frame refusal cannot be detected across origins, so this surface never waits
 * for a fake timeout and never silently changes engines. The selector is stable,
 * the preview warning is honest, and "Open in real browser" is always one tap
 * away.
 *
 * ONE BAR, NOT FIVE. The page's name (and its pages), the address, ONE state chip,
 * back / forward / reload and a ⋯ menu are a single row (`BrowserBar`). What used to be
 * a status row, a controls row, a banner and a footer is a fact the chip ranks
 * (`browser-bar-model.ts`) or an entry in the menu. A notice that matters — a page
 * held for the owner, a hand-over ask, a human check, a failure — stays in the bar as
 * the chip, with its detail and its action one tap away.
 *
 * There is exactly ONE page list and it is the bar's page menu, driven by the
 * daemon's own Chrome pages. Preview keeps an independent linear history and
 * invents no tabs of its own.
 *
 * NO ENGINE IS FORKED HERE. The remote half is `RemoteBrowserPane` hosted: it draws
 * no row of its own, and the bar dispatches through the pane's single
 * `useRemoteBrowser` instance, so there is one poll, one snapshot and one Chrome
 * per pairing — never a second transport racing the first.
 *
 * MULTI-DAEMON. The daemon is an explicit runtime prop and its scope must name
 * it; a mismatched pair is refused before any transport exists. Nothing here
 * reads the page origin, a build-time default or a bundled daemon identity.
 *
 * A RE-PAIR IS A LIVENESS BOUNDARY, NOT AN IDENTITY ONE. `daemonId` survives a
 * re-pair while the base URL and device token rotate, so the reader is looking
 * at the same session on the same daemon over a NEW grant. The engine memory,
 * keyed by `(daemonId, sessionId)`, is durable and stays; a login request, a
 * published pane view and the pixels behind it are credentialed and do not.
 */

import type { BrowserAction } from '@ferretry/protocol';
import {
  ArrowLeft,
  ArrowRight,
  ClipboardPaste,
  ExternalLink,
  Expand,
  Globe2,
  Hand,
  Maximize2,
  Minimize2,
  Monitor,
  Network,
  Power,
  PowerOff,
  RefreshCw,
  Scan,
  ShieldAlert,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';

import type { BrowserLoginSnapshot } from '../../lib/browser-login.ts';
import { type DaemonConnection, sameDaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSessionKey, type DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { Button } from '../../shell/primitives.tsx';
import type { SurfaceFullscreen } from '../workspace/surface-frame.tsx';
import { BrowserBar } from './browser-bar.tsx';
import { type BrowserBarControl, browserChip } from './browser-bar-model.ts';
import { BrowserChallengeBanner, shownChallenge } from './browser-challenge-banner.tsx';
import { BrowserSurfaceList, browserPageLabel } from './browser-surface-list.tsx';
import { browserDestination, type BrowserDestination } from './in-app-browser-model.ts';
import { InAppBrowserFrame, type InAppBrowserFrameProps } from './in-app-browser.tsx';
import { remoteBrowserPage, remoteBrowserProxyTitle } from './remote-browser-chrome.tsx';
import { useSettledBusy } from './use-settled-busy.ts';
import { RemoteBrowserPane, type RemoteBrowserPaneProps, type RemoteBrowserPaneState } from './remote-browser-pane.tsx';
import {
  browserSessionMemory,
  createPreviewHistory,
  currentBrowserUrl,
  currentPreviewEntry,
  movePreviewHistory,
  previewCanGoBack,
  previewCanGoForward,
  pushPreviewHistory,
  rememberBrowserEngine,
  rememberBrowserIncoming,
  resolveBrowserAddress,
  shouldAdoptIncomingLink,
  type BrowserEngine,
  type BrowserSessionMemory,
  type RemoteBrowserLocation,
} from './unified-browser-model.ts';

/**
 * The two engines, as injectable dependencies. Both are real components in the
 * app; a test substitutes them to drive the toolbar without a daemon and without
 * an embedded frame reaching for the network.
 */
export interface UnifiedBrowserDependencies {
  readonly PreviewFrame: ComponentType<InAppBrowserFrameProps>;
  readonly RemotePane: ComponentType<RemoteBrowserPaneProps>;
}

export const DEFAULT_UNIFIED_BROWSER_DEPENDENCIES: UnifiedBrowserDependencies = {
  PreviewFrame: InAppBrowserFrame,
  RemotePane: RemoteBrowserPane,
};

export interface UnifiedBrowserSurfaceProps {
  readonly daemon: DaemonConnection;
  /** Must name `daemon`; a scope from another daemon is a programming error. */
  readonly scope: DaemonSessionScope;
  /** Null when the Browser surface is opened before any transcript link. */
  readonly destination?: BrowserDestination | null;
  readonly presentation: 'pane' | 'sheet';
  readonly titleId: string;
  readonly onClose: () => void;
  /** False for a retained-but-hidden surface: Chrome persists, the display detaches. */
  readonly isActive?: boolean;
  /**
   * Opens the daemon-global browser login window, bound by the host to the
   * selected daemon. Without it the surface offers no login action rather than
   * implying it can reach one.
   */
  readonly onOpenLoginWindow?: () => Promise<BrowserLoginSnapshot>;
  readonly dependencies?: UnifiedBrowserDependencies;
  /** What the session workspace knows that this surface cannot: the page's name, who drives it, its pages. */
  readonly host?: BrowserBarHost;
}

/**
 * The host's side of the bar. Every field is optional in spirit: a surface with no host is a plain browser,
 * with the daemon's own Chrome pages in the page menu and no one to take over from.
 */
export interface BrowserBarHost {
  /** What the page is called (`app` in `%browser:app`). */
  readonly name: string;
  /** The session's pages, as the host lists them. Absent: the daemon's own Chrome pages are listed here. */
  readonly pages?: ReactNode;
  readonly control?: BrowserBarControl & {
    readonly onTakeOver: () => void;
    readonly onHandBack: () => void;
    readonly onDismissAsk?: () => void;
  };
  readonly fullscreen?: SurfaceFullscreen;
}

const NO_CONTROL: BrowserBarControl = { driver: null, ask: null, takenOver: false };

/** The `open` action that resumes Chrome, carrying a link only when one is due. */
const resumeRemote = (memory: BrowserSessionMemory | null, destination: BrowserDestination | null): BrowserAction =>
  shouldAdoptIncomingLink(memory, destination) && destination !== null
    ? { action: 'open', url: destination.href }
    : { action: 'open' };

const loginFailure = (caught: unknown): string =>
  caught instanceof Error ? caught.message : 'Could not open the browser login window.';

/**
 * Do two published pane states mean the same thing to THIS surface?
 *
 * The pane republishes a fresh wrapper object every time its effect runs, and a
 * fresh `runAction` whenever its own `scope`/`daemon`/`transport` props change
 * identity — which a host that rebuilds those props each render does on every
 * pass. Re-rendering on the wrapper would feed that churn straight back into the
 * pane and loop without bound. Only the fields that reach the bar
 * decide a render; the dispatcher is kept imperatively and is always the newest.
 */
const sameRemoteView = (previous: RemoteBrowserPaneState | null, next: RemoteBrowserPaneState): boolean =>
  previous !== null &&
  previous.status === next.status &&
  previous.busy === next.busy &&
  previous.error === next.error &&
  previous.connection === next.connection &&
  previous.fit === next.fit &&
  previous.viewportMode === next.viewportMode;

/** The first value with something in it: a control's name must never read blank. */
const firstNonEmpty = (...values: readonly (string | undefined)[]): string =>
  values.find(value => value !== undefined && value !== '') ?? '';

export function UnifiedBrowserSurface({
  daemon,
  scope,
  destination = null,
  presentation,
  titleId,
  onClose,
  isActive = true,
  onOpenLoginWindow,
  dependencies = DEFAULT_UNIFIED_BROWSER_DEPENDENCIES,
  host,
}: UnifiedBrowserSurfaceProps) {
  // Fail here rather than deep inside a request: a mismatched pair would drive
  // one daemon's Chrome under another daemon's name, which is the exact bug the
  // (daemonId, sessionId) scope exists to make impossible.
  if (daemon.daemonId !== scope.daemonId) throw new Error('unified browser scope must belong to the paired daemon');

  const { PreviewFrame, RemotePane } = dependencies;

  const [engine, setEngine] = useState<BrowserEngine>(() => browserSessionMemory(scope)?.engine ?? 'preview');
  const [previewHistory, setPreviewHistory] = useState(() => createPreviewHistory(destination));
  const [remote, setRemote] = useState<RemoteBrowserPaneState | null>(null);
  const [address, setAddress] = useState(destination?.href ?? '');
  const [loginBusy, setLoginBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editingRef = useRef(false);
  const incomingRef = useRef<BrowserDestination | null>(destination);
  const remoteRef = useRef<RemoteBrowserPaneState | null>(null);
  const pendingRemoteRef = useRef<BrowserAction | null>(null);
  const pairingRef = useRef<{ readonly connection: DaemonConnection; readonly scopeKey: string } | null>(null);
  /** Bumped on every re-scope AND every re-pair, exactly as `useRemoteBrowser`
   *  does, so credentialed work launched for one pairing can tell it no longer
   *  speaks for this surface. */
  const livenessEpochRef = useRef(0);
  const mountedRef = useRef(true);

  const scopeKey = daemonSessionKey(scope);
  const previousPairing = pairingRef.current;
  // TWO DIFFERENT IDENTITIES, and conflating them is the bug this separates.
  //
  //   IDENTITY  — `(daemonId, sessionId)`. What the reader is looking at. It
  //     alone selects the durable engine memory, and only a change to it may
  //     discard the preview reader's own client-side position.
  //   LIVENESS  — that scope PLUS the connection. A daemon id is DURABLE ACROSS
  //     A RE-PAIR, which is exactly when the base URL or the device token
  //     rotates; nothing holding the old credential may report into the new
  //     pairing, even though the reader is looking at the same session.
  const rescoped = previousPairing !== null && previousPairing.scopeKey !== scopeKey;
  const repaired = previousPairing !== null && !sameDaemonConnection(previousPairing.connection, daemon);
  // Applied during render, exactly as the pane and its hook do: a re-scoped or
  // re-paired surface must never show the previous connection's position, not
  // even for the frame before the new one answers.
  if (previousPairing === null || rescoped || repaired) {
    pairingRef.current = { connection: daemon, scopeKey };
    livenessEpochRef.current += 1;
    const memory = browserSessionMemory(scope);
    const restored = memory?.engine ?? 'preview';
    const history = createPreviewHistory(destination);
    if (rescoped || repaired) {
      // Liveness, for both: the remote view came from a connection that no
      // longer speaks here, and the busy treatment belongs to the daemon that
      // was actually asked. Leaving it on would tell the reader THIS pairing is
      // opening a login window nobody asked it for; the old request's `finally`
      // is fenced off by the epoch above.
      setRemote(null);
      setError(null);
      setLoginBusy(false);
      remoteRef.current = null;
      // AND THE QUEUE, which is the same staleness one step further back. An
      // action the reader aimed at the previous pairing sits here whenever they
      // acted before that pane first published its dispatcher; leaving it would
      // have the NEXT pane run it the moment it publishes — a navigation or a
      // reload delivered to a daemon nobody aimed it at. Clearing the ref
      // during this render is early enough that anything dispatched afterwards
      // belongs to the new pairing and is still queued normally.
      pendingRemoteRef.current = null;
    }
    if (rescoped) {
      // Identity, only for a genuine re-scope. A re-pair is the SAME session on
      // the same daemon id, so its preview history and remembered engine are
      // still the reader's place and are deliberately left standing.
      setEngine(restored);
      setPreviewHistory(history);
      setAddress(currentBrowserUrl(restored, currentPreviewEntry(history), null));
      incomingRef.current = destination;
      // A remembered remote engine survives a phone sheet unmount: reattach to
      // the page Chrome was left on, and adopt the incoming link only when the
      // app changed it while this scope had no surface. The pane is not mounted
      // yet, so the action waits for its dispatcher rather than taking a second
      // route. A re-pair queues nothing in its place: the pane re-polls the new
      // connection by itself, and re-opening Chrome is not something the reader
      // asked for.
      pendingRemoteRef.current = restored === 'remote' ? resumeRemote(memory, destination) : null;
    }
    if (previousPairing === null) {
      incomingRef.current = destination;
      remoteRef.current = null;
      pendingRemoteRef.current = restored === 'remote' ? resumeRemote(memory, destination) : null;
    }
  }

  const previewEntry = currentPreviewEntry(previewHistory);
  const remotePage = remoteBrowserPage(remote?.status ?? null);
  const remoteLocation: RemoteBrowserLocation | null =
    remotePage === null ? null : { url: remotePage.url, title: remotePage.title };
  const currentUrl = currentBrowserUrl(engine, previewEntry, remoteLocation);
  const remoteBusy = engine === 'remote' && remote?.busy === true;

  const dispatchRemote = useCallback((action: BrowserAction): void => {
    const published = remoteRef.current;
    if (published === null) {
      pendingRemoteRef.current = action;
      return;
    }
    published.runAction(action);
  }, []);

  const remoteStateChanged = useCallback((state: RemoteBrowserPaneState): void => {
    const previous = remoteRef.current;
    // The imperative dispatcher is ALWAYS refreshed: a retained `runAction`
    // closes over the pane's previous props, so the toolbar would drive a
    // transport the pane has already replaced.
    remoteRef.current = state;
    // Rendering, though, follows only what the toolbar reads. See
    // `sameRemoteView`: republishing an equivalent view is not a change, and
    // treating it as one lets the pane's own render churn loop through here.
    if (!sameRemoteView(previous, state)) setRemote(state);
    const pending = pendingRemoteRef.current;
    if (pending === null) return;
    pendingRemoteRef.current = null;
    state.runAction(pending);
  }, []);

  // A surface that has gone away must not be told anything by a request it
  // launched. Assigned on mount rather than only at declaration, because a
  // remount reuses this instance's refs.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Remembered for the NEXT mount: which link this scope last received, so a
  // remount can tell "the app pointed me somewhere new while I was gone" from
  // "the sheet reopened on the same stored destination".
  useEffect(() => {
    rememberBrowserIncoming(scope, destination);
  }, [destination, scope]);

  // A transcript link tap feeds a new destination into the mounted surface. The
  // selected engine receives it; the other engine's history is untouched.
  useEffect(() => {
    if (incomingRef.current === destination) return;
    incomingRef.current = destination;
    if (destination === null) return;
    if (engine === 'preview') {
      setPreviewHistory(history => pushPreviewHistory(history, destination));
      return;
    }
    dispatchRemote({ action: 'open', url: destination.href });
  }, [destination, dispatchRemote, engine]);

  // Truthful, but never destructive: the bar refills from whichever engine is
  // selected, and never over an address the reader is still typing.
  useEffect(() => {
    if (!editingRef.current) setAddress(currentUrl);
  }, [currentUrl]);

  const chooseEngine = (next: BrowserEngine): void => {
    if (next === engine) return;
    setEngine(next);
    rememberBrowserEngine(scope, next);
    if (next === 'preview') {
      // Chrome keeps running on the daemon; this surface simply stops showing
      // it, and forgets a position that a re-scope could otherwise stale-render.
      remoteRef.current = null;
      pendingRemoteRef.current = null;
      setRemote(null);
      return;
    }
    // The selector resumes Chrome's independent history. Copying the preview
    // address is a separate, explicit action: "Open in real browser" below.
    dispatchRemote({ action: 'open' });
  };

  const navigate = (): void => {
    const resolution = resolveBrowserAddress(address, currentUrl === '' ? undefined : currentUrl);
    if (resolution.kind === 'error') {
      setError(resolution.message);
      return;
    }
    setError(null);
    setAddress(resolution.destination.href);
    if (engine === 'preview') {
      setPreviewHistory(history => pushPreviewHistory(history, resolution.destination));
      return;
    }
    dispatchRemote({ action: 'navigate', url: resolution.destination.href });
  };

  const goBack = (): void => {
    if (engine === 'preview') setPreviewHistory(history => movePreviewHistory(history, -1));
    else dispatchRemote({ action: 'back' });
  };

  const goForward = (): void => {
    if (engine === 'preview') setPreviewHistory(history => movePreviewHistory(history, 1));
    else dispatchRemote({ action: 'forward' });
  };

  const reload = (): void => {
    if (engine === 'preview') setPreviewHistory(history => ({ ...history, revision: history.revision + 1 }));
    else dispatchRemote({ action: 'reload' });
  };

  const openInRealBrowser = (): void => {
    const target = browserDestination(currentUrl) ?? previewEntry;
    if (engine !== 'remote') {
      setEngine('remote');
      rememberBrowserEngine(scope, 'remote');
    }
    if (target !== null) setAddress(target.href);
    dispatchRemote(target === null ? { action: 'open' } : { action: 'open', url: target.href });
  };

  const openLoginWindow = async (open: () => Promise<BrowserLoginSnapshot>): Promise<void> => {
    // The login window belongs to ONE paired daemon. Capture which surface and
    // which scope asked, so a slow or failing request cannot report itself into
    // a surface that has since been re-scoped to another daemon or unmounted —
    // the same fence `useRemoteBrowser` puts around its own in-flight actions.
    const epochAtLaunch = livenessEpochRef.current;
    const stillOurs = (): boolean => mountedRef.current && epochAtLaunch === livenessEpochRef.current;
    setLoginBusy(true);
    setError(null);
    try {
      const snapshot = await open();
      if (!stillOurs()) return;
      if (snapshot.state === 'unknown' || snapshot.state === 'error')
        setError(snapshot.error ?? 'Could not open the browser login window.');
    } catch (caught) {
      if (stillOurs()) setError(loginFailure(caught));
    } finally {
      if (stillOurs()) setLoginBusy(false);
    }
  };

  const externalDestination = browserDestination(currentUrl);
  const engineName = engine === 'preview' ? 'preview' : 'real browser';
  // A daemon that has not reported history capability yet must not disable the
  // controls: absent means UNKNOWN, only an explicit `false` means "cannot".
  const backDisabled = engine === 'preview' ? !previewCanGoBack(previewHistory) : remotePage?.canGoBack === false;
  const forwardDisabled =
    engine === 'preview' ? !previewCanGoForward(previewHistory) : remotePage?.canGoForward === false;
  const loading = engine === 'remote' && remotePage?.pageState === 'loading';
  const working = useSettledBusy(remoteBusy || loading);
  const Heading = presentation === 'pane' ? 'h2' : 'h1';
  const control = host?.control ?? NO_CONTROL;
  const challenge = engine === 'remote' ? shownChallenge(remote?.status ?? null) : null;
  const heldErrors = [error, engine === 'remote' ? (remote?.error ?? null) : null].filter(
    (message): message is string => message !== null,
  );
  const chip = browserChip({
    engine,
    status: engine === 'remote' ? (remote?.status ?? null) : null,
    connection: remote?.connection ?? 'detached',
    busy: remoteBusy,
    errors: heldErrors,
    challenge,
    control,
  });
  const activePage = remotePage?.pages.find(candidate => candidate.id === remotePage.activePageId);
  const barName = host?.name ?? (activePage === undefined ? 'Browser' : browserPageLabel(activePage));
  const status = engine === 'remote' ? (remote?.status ?? null) : null;
  const running = status?.state === 'running';
  const menuTitle = firstNonEmpty(remoteLocation?.title, currentUrl, 'Browser controls');
  const canTakeOver =
    host?.control !== undefined && !control.takenOver && (control.driver !== null || control.ask !== null);

  const dismissErrors = (): void => {
    setError(null);
    remote?.clearError();
  };

  // The page list: the host's, or — for a surface with no host — the daemon's own Chrome pages.
  const pages: ReactNode =
    host?.pages ??
    (engine === 'remote' && remote !== null ? (
      <BrowserSurfaceList
        driverFor={() => null}
        onClosePage={candidate => dispatchRemote({ action: 'close-page', pageId: candidate.id })}
        onNewPage={() => dispatchRemote({ action: 'new-page' })}
        onOpenPage={candidate => dispatchRemote({ action: 'activate-page', pageId: candidate.id })}
        selectedPageId={remotePage?.activePageId ?? ''}
        status={status}
        takenOver={() => false}
      />
    ) : undefined);

  const takeOver =
    host?.control === undefined ? null : (
      <Button
        type="button"
        variant="primary"
        onClick={host.control.onTakeOver}
        className="min-h-[44px] w-full justify-center gap-xs"
      >
        <Hand size={16} aria-hidden="true" className="shrink-0" />
        Take over
      </Button>
    );
  const handBack =
    host?.control === undefined ? null : (
      <Button
        type="button"
        variant="primary"
        onClick={host.control.onHandBack}
        className="min-h-[44px] w-full justify-center gap-xs"
      >
        <Undo2 size={16} aria-hidden="true" className="shrink-0" />
        Hand back
      </Button>
    );

  const chipDetail = (
    <div className="grid gap-2 text-meta leading-base text-fg" data-browser-chip-kind={chip.kind}>
      {chip.kind === 'challenge' && challenge !== null ? (
        <BrowserChallengeBanner challenge={challenge} />
      ) : (
        <p className="m-0 font-medium">{chip.summary}</p>
      )}
      {chip.kind === 'owner' && (
        <p className="m-0 text-muted">The agent cannot type into this page until you hand it back.</p>
      )}
      {chip.kind === 'ask' && control.ask !== null && (
        <p className="m-0 text-muted">{control.ask.agent} handed this page to you.</p>
      )}
      {chip.kind === 'error' &&
        [
          ...heldErrors,
          ...(remotePage?.pageError === undefined || heldErrors.includes(remotePage.pageError)
            ? []
            : [remotePage.pageError]),
        ]
          .filter(message => message !== chip.summary)
          .map(message => (
            <p key={message} role="alert" className="m-0 break-words text-err">
              {message}
            </p>
          ))}
      {chip.kind === 'disconnected' && (
        <p className="m-0 text-muted">The page is still running on the machine. This view keeps trying to reconnect.</p>
      )}
      {chip.kind === 'stopped' && (
        <Button
          type="button"
          variant="primary"
          disabled={remoteBusy}
          onClick={() => dispatchRemote({ action: 'start' })}
          className="min-h-[44px] w-full justify-center gap-xs"
        >
          <Power size={16} aria-hidden="true" className="shrink-0" />
          Start browser
        </Button>
      )}
      {(chip.kind === 'ask' || chip.kind === 'challenge' || chip.kind === 'agent') && canTakeOver ? takeOver : null}
      {chip.kind === 'owner' ? handBack : null}
      {chip.kind === 'ask' && host?.control?.onDismissAsk !== undefined && (
        <Button type="button" onClick={host.control.onDismissAsk} className="min-h-[44px] w-full justify-center">
          Dismiss
        </Button>
      )}
      {chip.kind === 'error' && (
        <Button type="button" onClick={dismissErrors} className="min-h-[44px] w-full justify-center">
          Dismiss
        </Button>
      )}
    </div>
  );

  const item = 'min-h-[44px] w-full !justify-start gap-xs sm:min-h-[36px]';
  const menu = (
    <>
      <fieldset
        aria-label="Browser engine"
        className="flex items-center rounded-control border border-strong bg-surface-2 p-0.5"
      >
        <Button
          type="button"
          variant={engine === 'preview' ? 'primary' : 'ghost'}
          aria-pressed={engine === 'preview'}
          onClick={() => chooseEngine('preview')}
          className="min-h-[44px] flex-1 justify-center px-2"
        >
          Preview
        </Button>
        <Button
          type="button"
          variant={engine === 'remote' ? 'primary' : 'ghost'}
          aria-pressed={engine === 'remote'}
          onClick={() => chooseEngine('remote')}
          className="min-h-[44px] flex-1 justify-center px-2"
        >
          Real
        </Button>
      </fieldset>

      <div className="mt-2 text-meta leading-base text-muted">
        {engine === 'preview' ? (
          <p className="m-0 flex items-start gap-xs">
            <ShieldAlert size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-warn" />
            <span>
              Preview accepts the address, but a site can refuse to load in an embedded reader and this reader cannot
              tell when it does. Real is the full interactive browser.
            </span>
          </p>
        ) : (
          <div className="grid gap-1">
            <p className="m-0 flex items-start gap-xs">
              <Monitor size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
              <span className="min-w-0 break-words">
                {remoteBusy
                  ? 'Working…'
                  : loading
                    ? 'Loading page…'
                    : firstNonEmpty(remoteLocation?.title, 'Shared Chrome · persistent session')}
              </span>
            </p>
            {status !== null && (
              <p className="m-0" data-browser-governor="">
                {status.viewport.width}×{status.viewport.height} · {status.viewers} viewer
                {status.viewers === 1 ? '' : 's'} · {Math.round(status.idleTimeoutSeconds / 60)}m idle stop
                {status.lastActor === undefined
                  ? ''
                  : ` · last input ${status.lastActor.kind === 'human' ? 'you' : 'agent'} (${status.lastActor.action})`}
              </p>
            )}
            {status?.state === 'running' && status.proxy !== undefined && (
              <p
                className="m-0 flex items-start gap-xs"
                data-browser-proxy-chip=""
                title={remoteBrowserProxyTitle(status.proxy)}
              >
                <Network size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
                <span>Via proxy {status.proxy.url}</span>
              </p>
            )}
          </div>
        )}
      </div>

      <div className="mt-2 grid gap-1 border-t border-border-soft pt-2">
        <Button
          type="button"
          variant="ghost"
          disabled={remoteBusy || forwardDisabled}
          onClick={goForward}
          className={`${item} sm:hidden`}
        >
          <ArrowRight size={16} aria-hidden="true" className="shrink-0" />
          Forward
        </Button>
        {engine === 'remote' && remote !== null && (
          <>
            {running ? (
              <Button
                type="button"
                variant="danger"
                disabled={remoteBusy}
                onClick={() => dispatchRemote({ action: 'stop' })}
                className={item}
              >
                <PowerOff size={16} aria-hidden="true" className="shrink-0" />
                Stop browser
              </Button>
            ) : (
              <Button
                variant="ghost"
                type="button"
                disabled={remoteBusy || status?.state === 'starting'}
                onClick={() => dispatchRemote({ action: 'start' })}
                className={item}
              >
                <Power size={16} aria-hidden="true" className="shrink-0" />
                Start browser
              </Button>
            )}
            <Button
              variant="ghost"
              type="button"
              disabled={!running || remote.connection !== 'connected'}
              onClick={remote.pasteFromClipboard}
              className={item}
            >
              <ClipboardPaste size={16} aria-hidden="true" className="shrink-0" />
              Paste
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={!running}
              aria-pressed={remote.fit}
              onClick={remote.toggleFit}
              className={item}
            >
              <Expand size={16} aria-hidden="true" className="shrink-0" />
              {remote.fit ? 'Fit' : '1:1'}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={!running}
              aria-pressed={remote.viewportMode === 'desktop'}
              onClick={remote.toggleViewportMode}
              className={item}
              title="On a phone, desktop fit keeps a 1280×800 viewport and scales it to width"
            >
              {remote.viewportMode === 'desktop' ? (
                <Monitor size={16} aria-hidden="true" className="shrink-0" />
              ) : (
                <Scan size={16} aria-hidden="true" className="shrink-0" />
              )}
              {remote.viewportMode === 'desktop' ? 'Desktop fit' : 'Responsive'}
            </Button>
          </>
        )}
        {canTakeOver && host?.control !== undefined && (
          <Button variant="ghost" type="button" onClick={host.control.onTakeOver} className={item}>
            <Hand size={16} aria-hidden="true" className="shrink-0" />
            Take over
          </Button>
        )}
        {control.takenOver && host?.control !== undefined && (
          <Button variant="ghost" type="button" onClick={host.control.onHandBack} className={item}>
            <Undo2 size={16} aria-hidden="true" className="shrink-0" />
            Hand back
          </Button>
        )}
        {host?.fullscreen !== undefined && (
          <Button
            variant="ghost"
            type="button"
            aria-pressed={host.fullscreen.active}
            onClick={host.fullscreen.toggle}
            className={item}
            aria-label={host.fullscreen.active ? 'Exit full screen' : 'Full screen'}
            title={host.fullscreen.active ? 'Exit full screen (Esc, or Shift+Esc while typing in it)' : 'Full screen'}
          >
            {host.fullscreen.active ? (
              <Minimize2 size={16} aria-hidden="true" className="shrink-0" />
            ) : (
              <Maximize2 size={16} aria-hidden="true" className="shrink-0" />
            )}
            {host.fullscreen.active ? 'Exit full screen' : 'Full screen'}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={remoteBusy}
          onClick={openInRealBrowser}
          className={item}
          aria-label="Open in real browser"
          title="Open this address in the persistent real browser"
        >
          <Monitor size={16} aria-hidden="true" className="shrink-0" />
          <span className="truncate">Open in real browser</span>
        </Button>
        {externalDestination === null ? (
          // A real disabled control, not a decorated span: an
          // aria-disabled div is unreachable and unannounced.
          <Button
            type="button"
            variant="ghost"
            disabled
            className={item}
            aria-label="This browser address cannot be opened externally"
          >
            <ExternalLink size={16} aria-hidden="true" className="shrink-0" />
            <span className="truncate">Open externally</span>
          </Button>
        ) : (
          <a
            href={externalDestination.href}
            target="_blank"
            rel="noreferrer"
            className={`kt-btn ${item}`}
            data-variant="ghost"
            aria-label="Open externally in a new tab"
            title="Open externally"
          >
            <ExternalLink size={16} aria-hidden="true" className="shrink-0" />
            <span className="truncate">Open externally</span>
          </a>
        )}
        <Button
          type="button"
          onClick={onClose}
          variant="ghost"
          className={item}
          aria-label="Done browsing"
          title="Done"
        >
          <X size={16} aria-hidden="true" className="shrink-0" />
          <span>Done</span>
        </Button>
      </div>
    </>
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-surface" aria-label="Browser">
      {/* Visually hidden: the bar carries the controls, but the host's
          aria-labelledby still resolves to a real "Browser" name. */}
      <Heading id={titleId} className="sr-only">
        Browser
      </Heading>
      <BrowserBar
        name={barName}
        address={address}
        onAddressChange={setAddress}
        onAddressFocus={() => {
          editingRef.current = true;
        }}
        // Typed text is NOT reset on blur: tapping Go blurs this input first, and restoring the
        // previous URL there submitted the OLD address. Only the editing flag is cleared.
        onAddressBlur={() => {
          editingRef.current = false;
        }}
        onNavigate={navigate}
        navigateDisabled={remoteBusy || address.trim() === ''}
        chip={chip}
        chipDetail={chipDetail}
        back={{
          label: `Back in ${engineName}`,
          disabled: remoteBusy || backDisabled,
          onClick: goBack,
          icon: <ArrowLeft size={16} aria-hidden="true" />,
        }}
        forward={{
          label: `Forward in ${engineName}`,
          disabled: remoteBusy || forwardDisabled,
          onClick: goForward,
          icon: <ArrowRight size={16} aria-hidden="true" />,
        }}
        reload={{
          label: `Reload ${engineName}`,
          disabled: remoteBusy,
          onClick: reload,
          icon: <RefreshCw size={16} aria-hidden="true" />,
        }}
        menu={menu}
        menuTitle={menuTitle}
        {...(pages === undefined ? {} : { pages })}
        working={engine === 'remote' && working}
        resetKey={scopeKey}
      />
      {error !== null && (
        <div role="alert" className="sr-only">
          {error}
        </div>
      )}

      {engine === 'remote' ? (
        <RemotePane daemon={daemon} scope={scope} isActive={isActive} hosted onStateChange={remoteStateChanged} />
      ) : previewEntry !== null ? (
        // Keyed by address AND revision: re-opening the address the reader is
        // already on is a reload request, and only a changed key remounts the
        // frame. Nothing else can make a cross-origin frame reload.
        <PreviewFrame key={`${previewEntry.href}:${previewHistory.revision}`} destination={previewEntry} />
      ) : (
        <section
          className="flex min-h-[240px] flex-1 items-center justify-center bg-surface-2 px-panel py-8 text-center"
          aria-label="Browser home"
        >
          <div className="max-w-xs">
            <Globe2 size={32} aria-hidden="true" className="mx-auto text-accent" />
            <h3 className="mb-0 mt-3 font-display text-title font-semibold tracking-display text-fg">Where to?</h3>
            <p className="mb-0 mt-2 text-ui leading-base text-muted">
              Enter a URL or search terms above. Nothing opens until you choose where to go.
            </p>
            {onOpenLoginWindow !== undefined && (
              <div className="mt-4 border-t border-border-soft pt-3 text-left">
                <p className="m-0 text-meta leading-base text-muted">Need to sign in to the shared browser?</p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={loginBusy}
                  onClick={() => void openLoginWindow(onOpenLoginWindow)}
                  className="mt-2 min-h-[44px] w-full justify-center"
                >
                  {loginBusy ? 'Opening login window…' : 'Open browser login window'}
                </Button>
              </div>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
