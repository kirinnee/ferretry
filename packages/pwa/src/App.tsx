import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { NewSessionPage } from './components/new-session-page.tsx';
import { SessionsPage } from './components/sessions-page.tsx';
import { GlobalAnalyticsPage } from './features/analytics/global-analytics-page.tsx';
import { LearningPage } from './features/learning/learning-page.tsx';
import { PairingScreen } from './features/pairing/pairing-screen.tsx';
import { NotificationSettingsView } from './features/settings/notification-settings.tsx';
import { SettingsPage } from './features/settings/settings-page.tsx';
import { WardenAttention } from './features/warden/warden-attention.tsx';
import { WardenConfigSurface } from './features/warden/warden-config-card.tsx';
import { WardenStrip } from './features/warden/warden-strip.tsx';
import { useAppViewport } from './hooks/use-app-viewport.ts';
import {
  type NotificationControlsHost,
  useNotificationControls,
  useNotificationWatch,
} from './hooks/use-notifications.ts';
import { useServiceWorkerUpdate } from './hooks/use-service-worker-update.ts';
import { useSttSettings } from './hooks/use-stt-settings.ts';
import { useWardenStatus } from './hooks/use-warden-status.ts';
import type { DaemonConnection } from './lib/daemon-connection.ts';
import type {
  NotificationPermissionState,
  NotificationRegistrationLike,
  NotificationSurface,
  PageNotificationLike,
} from './lib/notify.ts';
import { installPortraitLock } from './lib/orientation-lock.ts';
import { browserQrScanHost, type QrDetectorLike, type QrScanHost } from './lib/pair-scan.ts';
import { type PairingArrival, pairingArrival } from './lib/pairing.ts';
import {
  type DaemonPageProps,
  PageHost,
  type PageHostSlots,
  type SessionChatPageProps,
} from './lib/pages/page-host.tsx';
import { daemonSessionsPath, daemonWardenPath, type PageRoute, routePageKey } from './lib/pages/routes.ts';
import { WardenPage } from './lib/pages/warden-page.tsx';
import { clearForegroundPinScope, getForegroundPinScope, setForegroundPinScope } from './lib/pin-bridge.ts';
import { type PushEnrolment, type PushRegistrationLike, supportsWebPush } from './lib/push-enrolment.ts';
import { RouterProvider, useRouter } from './lib/router.tsx';
import { StoreProvider, useAppStore, useConnectionSnapshot } from './lib/store.tsx';
import { AppBar, appBarDestinationForRoute, type Crumb } from './shell/app-bar.tsx';
import { ChunkErrorBoundary } from './shell/chunk-error-boundary.tsx';
import { CommandPalette } from './shell/command-palette.tsx';
import { paletteSessionEntries } from './shell/palette-model.ts';
import { ThemeToggle } from './shell/theme-toggle.tsx';

/**
 * Wraps a one-shot document-lifetime side effect, latching only on SUCCESS.
 *
 * The latch exists because React runs a mount effect twice under StrictMode and
 * the wrapped installers attach permanent listeners. Setting it BEFORE the call
 * is the trap: a refusal would then consume the only attempt the tab ever
 * makes, and the feature would stay off for the life of the document with
 * nothing to show for it. A throw is swallowed for the same reason — these are
 * progressive enhancements, and one that cannot install must degrade rather
 * than take the shell down with it.
 *
 * A closure rather than a module-level flag so the behaviour is provable: the
 * failure-then-retry sequence needs a fresh latch, which a module global cannot
 * give a second test in the same process.
 */
export const installOnce = (install: () => void): (() => boolean) => {
  let installed = false;
  return () => {
    if (installed) return false;
    try {
      install();
    } catch {
      return false;
    }
    installed = true;
    return true;
  };
};

const installPortraitLockOnce = installOnce(installPortraitLock);

/**
 * Does this event target own the keystroke?
 *
 * The palette shortcut is registered in the CAPTURE phase on `window`, so a
 * field cannot decline it by handling the event first. Text entry therefore has
 * to be recognised here: Ctrl+K is "delete to end of line" in every readline
 * and GTK text field, and swallowing it inside the composer would break editing
 * to open a palette nobody asked for.
 *
 * Structural, not `instanceof`: the event may originate in another realm — an
 * embedded document, a test DOM — where `instanceof HTMLElement` is false for a
 * perfectly ordinary `<input>`.
 */
export const isTextEntryTarget = (target: EventTarget | null): boolean => {
  const element = target as { readonly tagName?: unknown; readonly isContentEditable?: unknown } | null;
  if (element === null || typeof element !== 'object') return false;
  if (element.isContentEditable === true) return true;
  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
};

const notificationPermission = (): NotificationPermissionState =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

export const browserNotificationSurface = (
  navigate: (path: string) => void,
  permissionChanged: (permission: NotificationPermissionState) => void,
): NotificationSurface => ({
  permission: notificationPermission,
  requestPermission: async () => {
    if (typeof Notification === 'undefined') return 'unsupported';
    const permission = await Notification.requestPermission();
    permissionChanged(permission);
    return permission;
  },
  registration: async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
    const registration = await navigator.serviceWorker.getRegistration();
    return (registration as unknown as NotificationRegistrationLike | undefined) ?? null;
  },
  showOnPage:
    typeof Notification === 'undefined'
      ? null
      : (title, options) => new Notification(title, options as NotificationOptions) as unknown as PageNotificationLike,
  navigate,
});

export const browserPushEnrolment = (): PushEnrolment | null => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  if (
    !supportsWebPush({
      secureContext: globalThis.isSecureContext === true,
      serviceWorker: 'serviceWorker' in navigator,
      pushManager: 'PushManager' in window,
    })
  )
    return null;
  return {
    registration: async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration === undefined || !('pushManager' in registration)) {
        throw new Error('this build has no active service worker registration');
      }
      return registration as unknown as PushRegistrationLike;
    },
    deviceName: () => 'Ferretry PWA',
  };
};

const NotificationControlsContext = createContext<NotificationControlsHost | null>(null);

const useNotificationControlsHost = (): NotificationControlsHost => {
  const host = useContext(NotificationControlsContext);
  if (host === null) throw new Error('notification controls require the app shell');
  return host;
};

const pageCrumbs = (route: PageRoute): readonly Crumb[] => {
  if (route.kind === 'connection-picker') return [{ label: 'Daemons' }];
  const sessions = daemonSessionsPath(route.daemonId);
  switch (route.kind) {
    case 'sessions':
      return [{ label: 'Sessions' }];
    case 'new-session':
      return [{ href: sessions, label: 'Sessions' }, { label: 'New' }];
    case 'session':
      return [{ href: sessions, label: 'Sessions' }, { label: route.sessionId }];
    case 'settings':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Settings' }];
    case 'warden':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Warden' }];
    case 'analytics':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Analytics' }];
    case 'learning':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Learning' }];
  }
};

/**
 * What a screen reader hears after an in-app navigation.
 *
 * Derived from the crumbs rather than written twice, so the announcement can
 * never name a different page from the one the app bar shows. The daemon id is
 * deliberately absent: it is a fingerprint, not a place, and the crumb trail is
 * already the reader's location.
 */
export const routeAnnouncement = (route: PageRoute): string =>
  pageCrumbs(route)
    .map(crumb => crumb.label)
    .join(', ');

/**
 * The camera, wired to the real browser — or `null`, which is an honest answer.
 *
 * Two capabilities are needed and neither is universal: `getUserMedia` is
 * ABSENT (not merely refused) outside a secure context, and `BarcodeDetector`
 * ships in Chromium and not in WebKit. A browser missing either gets no scan
 * button at all rather than one that fails when pressed; the pairing screen
 * shows its paste field instead.
 */
export const browserQrScan = (): QrScanHost | null => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  const detector = (window as { BarcodeDetector?: new (options: { formats: string[] }) => QrDetectorLike })
    .BarcodeDetector;
  const host = browserQrScanHost({
    media: navigator.mediaDevices,
    detector: detector === undefined ? undefined : () => new detector({ formats: ['qr_code'] }),
    delay: async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds)),
  });
  return host.supported ? host : null;
};

/** The pairing link this tab was opened with, if it was opened with one. */
const arrivalFromLocation = (): PairingArrival => pairingArrival(window.location.href);

function ConnectionPicker() {
  const store = useAppStore();
  const snapshot = useConnectionSnapshot();
  const { navigate } = useRouter();
  // Read ONCE, at mount. A later render must not re-read an address the screen
  // has already emptied, and must not resurrect a code the reader declined.
  const [arrival] = useState(arrivalFromLocation);
  const scanHost = useMemo(browserQrScan, []);
  // The single-use code leaves the address bar as soon as the screen holds it,
  // so it cannot be reloaded, bookmarked, shared or screenshotted afterwards.
  // `replaceState`, not `pushState`: a back button that restored the code would
  // undo exactly this.
  const takeArrival = useCallback(() => {
    window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
  }, []);
  return (
    <PairingScreen
      arrival={arrival}
      scanHost={scanHost}
      onArrivalTaken={takeArrival}
      connections={snapshot.connections}
      selectedDaemonId={snapshot.selectedDaemonId}
      onPair={async seed => {
        const connection = await store.pair(seed);
        navigate(daemonSessionsPath(connection.daemonId));
      }}
      onSelect={daemonId => {
        store.connections.select(daemonId);
        navigate(daemonSessionsPath(daemonId));
      }}
      onRemove={daemonId => {
        store.connections.remove(daemonId);
      }}
    />
  );
}

function SessionsRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const readWardenStatus = useCallback(
    async (daemon: DaemonConnection) => await (await store.clients.client(daemon)).wardenStatus(),
    [store.clients],
  );
  return (
    <SessionsPage
      connection={connection}
      fleet={store.fleet}
      controls={store.controls}
      projects={store.projects}
      usage={store.usage}
      wardenStatus={readWardenStatus}
      onOpenWardenReport={() => navigate(daemonWardenPath(connection.daemonId))}
      onNavigate={navigate}
    />
  );
}

function NewSessionRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const { navigate } = useRouter();
  return (
    <NewSessionPage
      connection={connection}
      startSession={async (daemon, request) => await (await store.clients.client(daemon)).start(request)}
      onNavigate={navigate}
    />
  );
}

type SessionState = 'opening' | 'connected' | 'failed';

/**
 * One sentence per state, in a table rather than nested ternaries, because the
 * live region below must render exactly one of them and swapping the SENTENCE
 * is the whole mechanism — see the comment on the region itself.
 */
const SESSION_STATE_MESSAGE: Record<SessionState, string> = {
  opening: 'Opening this daemon-scoped session…',
  connected: 'This session is connected. The conversation workspace is not assembled in this build yet.',
  failed: 'This session could not be opened.',
};

function SessionRoute({ connection, scope }: SessionChatPageProps) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const { daemonId, sessionId } = scope;
  const subscribe = useCallback((listener: () => void) => store.fleet.subscribe(listener), [store.fleet]);
  const snapshot = useCallback(() => store.fleet.getSnapshot(), [store.fleet]);
  const fleet = useSyncExternalStore(subscribe, snapshot);
  const session = fleet.daemons.get(scope.daemonId)?.byId.get(scope.sessionId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    void store.fleet.fetchSession(connection, { daemonId, sessionId }).catch(reason => {
      if (current) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      current = false;
    };
  }, [connection, daemonId, sessionId, store.fleet]);

  useEffect(() => {
    const foreground = { daemonId, sessionId };
    setForegroundPinScope(foreground);
    return () => clearForegroundPinScope(foreground);
  }, [daemonId, sessionId]);

  const sessionState: SessionState = error !== null ? 'failed' : session === undefined ? 'opening' : 'connected';

  return (
    <main
      className="mx-auto flex h-full w-full max-w-[980px] flex-col gap-3 overflow-y-auto py-3"
      data-daemon={scope.daemonId}
      data-session={scope.sessionId}
    >
      <button type="button" className="kt-btn self-start" onClick={() => navigate(daemonSessionsPath(scope.daemonId))}>
        ← Sessions
      </button>
      <section className="kt-panel p-panel" aria-labelledby="session-route-heading">
        <h1 id="session-route-heading" className="m-0 font-display text-display font-bold tracking-display">
          {session?.config.teammate || session?.config.name || scope.sessionId}
        </h1>
        {/*
          BOTH LIVE REGIONS STAY MOUNTED. A live region only announces changes
          that happen while it is already on the page, so a region added in the
          same commit that fills it — or removed in the same commit that
          replaces its text — announces nothing at all. Only the SENTENCE
          changes here, and the alert stays present-but-empty until there is a
          reason to put something in it.
        */}
        <p className="mb-0 text-ui text-muted" role="status" aria-live="polite" data-session-state={sessionState}>
          {SESSION_STATE_MESSAGE[sessionState]}
        </p>
        <p className={error === null ? 'sr-only' : 'mb-0 mt-1 text-ui text-err'} role="alert" data-session-error="">
          {error === null ? '' : `Could not open this session: ${error}`}
        </p>
      </section>
    </main>
  );
}

function SettingsRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const dictation = useSttSettings(store.stt);
  const notifications = useNotificationControls(useNotificationControlsHost(), connection);
  return (
    <SettingsPage
      daemonId={connection.daemonId}
      controls={store.controls}
      dictation={{ daemon: connection, ...dictation }}
      notifications={
        <NotificationSettingsView
          permission={notifications.permission}
          enabled={notifications.enabled}
          preferences={notifications.preferences}
          delivery={notifications.delivery}
          deliveryMessage={notifications.deliveryMessage}
          devices={notifications.devices}
          currentDeviceId={notifications.currentDeviceId}
          onEnabled={notifications.setEnabled}
          onPreferences={notifications.setPreferences}
          onRevokeDevice={notifications.revokeDevice}
        />
      }
      onNavigate={navigate}
    />
  );
}

function WardenStatusRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const read = useCallback(
    async (daemon: DaemonConnection) => await (await store.clients.client(daemon)).wardenStatus(),
    [store.clients],
  );
  return <WardenStrip status={useWardenStatus(connection, read)} />;
}

function WardenAttentionRoute({ connection }: DaemonPageProps) {
  return (
    <WardenAttention
      connection={connection}
      state={{ status: 'error', reason: 'The dedicated attention report feed is not available in this build.' }}
    />
  );
}

function WardenConfigurationRoute({ connection }: DaemonPageProps) {
  return <WardenConfigSurface connection={connection} />;
}

function WardenVerdictsRoute() {
  return (
    <section className="kt-panel p-panel" aria-labelledby="warden-verdicts-heading">
      <h2 id="warden-verdicts-heading" className="m-0 text-title font-semibold">
        Recent verdicts
      </h2>
      <p className="mb-0 text-ui text-muted">No daemon verdict feed is available in this build.</p>
    </section>
  );
}

const WARDEN_SLOTS = {
  Attention: WardenAttentionRoute,
  Status: WardenStatusRoute,
  Configuration: WardenConfigurationRoute,
  Verdicts: WardenVerdictsRoute,
} as const;

function WardenRoute({ connection }: DaemonPageProps) {
  return <WardenPage connection={connection} slots={WARDEN_SLOTS} />;
}

function AnalyticsRoute({ connection }: DaemonPageProps) {
  return <GlobalAnalyticsPage connection={connection} />;
}

function LearningRoute({ connection }: DaemonPageProps) {
  return <LearningPage connection={connection} />;
}

const PAGE_SLOTS: PageHostSlots = {
  ConnectionPicker,
  Sessions: SessionsRoute,
  NewSession: NewSessionRoute,
  SessionChat: SessionRoute,
  Settings: SettingsRoute,
  Warden: WardenRoute,
  Analytics: AnalyticsRoute,
  Learning: LearningRoute,
};

/** The mounted shell; exported so render tests can inject the router and store providers. */
export function AppShell() {
  useAppViewport();
  const store = useAppStore();
  const connectionSnapshot = useConnectionSnapshot();
  const { route, navigate } = useRouter();
  const pageRoute: PageRoute = route.kind === 'legacy-tasks-redirect' ? route.to : route;
  const connection =
    pageRoute.kind === 'connection-picker'
      ? undefined
      : connectionSnapshot.connections.find(candidate => candidate.daemonId === pageRoute.daemonId);
  const [permission, setPermission] = useState<NotificationPermissionState>(notificationPermission);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    installPortraitLockOnce();
  }, []);

  const workerEnvironment = useMemo(
    () => ({
      release: 'static',
      // Registration remains off until the build owns a generated worker asset.
      container: null,
      doc: document,
      win: window,
      reload: () => window.location.reload(),
      onError: () => undefined,
    }),
    [],
  );
  const { updateReady, applyUpdate, raiseRecovery } = useServiceWorkerUpdate(workerEnvironment);

  const notificationSurface = useMemo(() => browserNotificationSurface(navigate, setPermission), [navigate]);
  const notificationControlsHost = useMemo<NotificationControlsHost>(
    () => ({
      preferences: store.notificationPreferences,
      surface: notificationSurface,
      service: store.pushService,
      devices: store.pushDevices,
      enrolment: browserPushEnrolment(),
    }),
    [notificationSurface, store.notificationPreferences, store.pushDevices, store.pushService],
  );
  const notificationWatchHost = useMemo(
    () => ({
      sessions: {
        subscribe: (listener: () => void) => store.fleet.subscribe(listener),
        snapshot: () => store.fleet.getSnapshot(),
      },
      preferences: store.notificationPreferences,
      surface: notificationSurface,
      hidden: () => document.hidden,
      foregroundSession: getForegroundPinScope,
      now: Date.now,
    }),
    [notificationSurface, store.fleet, store.notificationPreferences],
  );
  useNotificationWatch(notificationWatchHost, permission);

  const subscribeFleet = useCallback((listener: () => void) => store.fleet.subscribe(listener), [store.fleet]);
  const fleetSnapshot = useCallback(() => store.fleet.getSnapshot(), [store.fleet]);
  const fleet = useSyncExternalStore(subscribeFleet, fleetSnapshot);
  const [palette, setPalette] = useState({ open: false, focusSignal: 0 });
  const openPalette = useCallback(
    () => setPalette(current => ({ open: true, focusSignal: current.focusSignal + 1 })),
    [],
  );
  const closePalette = useCallback(() => setPalette(current => ({ ...current, open: false })), []);

  /**
   * ROUTE CHANGES ARE ANNOUNCED AND TAKE FOCUS.
   *
   * A pushState navigation is invisible to assistive technology: nothing
   * reloads, and `PageHost` unmounts the control that was clicked, so focus
   * silently falls back to `<body>` and a keyboard reader restarts from the top
   * of the document on every navigation. Focusing a named region at the head of
   * the shell restores the "new page" contract a real navigation would have
   * given for free, and because that region is also the live region, the same
   * change announces where the reader has arrived.
   *
   * NOT ON FIRST PAINT. The initial render is a page load, not a navigation:
   * the browser has already placed focus, and stealing it would skip whatever
   * the reader was given.
   */
  const pageKey = routePageKey(pageRoute);
  const routeAnnouncer = useRef<HTMLParagraphElement>(null);
  // Seed the previous key during render instead of latching the first effect.
  // StrictMode replays mount effects in development; an effect-owned latch
  // mistakes that replay for a navigation and steals focus on first paint.
  const previousPageKey = useRef(pageKey);
  useEffect(() => {
    if (previousPageKey.current === pageKey) return;
    previousPageKey.current = pageKey;
    routeAnnouncer.current?.focus();
  }, [pageKey]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'k' && event.key !== 'K') return;
      if (event.shiftKey || event.altKey || (!event.metaKey && !event.ctrlKey)) return;
      if (isTextEntryTarget(event.target)) return;
      event.preventDefault();
      openPalette();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openPalette]);

  let content: ReactNode;
  if (pageRoute.kind === 'connection-picker') {
    content = (
      <div className="kt-shell overflow-y-auto">
        <ConnectionPicker />
      </div>
    );
  } else if (connection === undefined) {
    content = (
      <div className="kt-shell overflow-y-auto">
        <p className="mx-auto mb-0 mt-3 w-full max-w-[680px] px-3 text-ui text-warn" role="alert">
          That daemon is not paired in this browser. Choose an existing pairing or add it again.
        </p>
        <ConnectionPicker />
      </div>
    );
  } else {
    const sessions = fleet.daemons.get(connection.daemonId)?.sessions ?? [];
    content = (
      <div className="kt-shell flex flex-col overflow-hidden">
        <AppBar
          crumbs={pageCrumbs(pageRoute)}
          daemon={connection.daemonId}
          onOpenPalette={openPalette}
          sessionCount={sessions.length}
          updateReady={updateReady}
          onApplyUpdate={applyUpdate}
          active={appBarDestinationForRoute(pageRoute)}
          onNavigate={navigate}
          themeToggle={<ThemeToggle />}
        />
        <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3">
          <ChunkErrorBoundary onChunkError={raiseRecovery} onReload={applyUpdate}>
            <PageHost key={pageKey} route={pageRoute} connection={connection} slots={PAGE_SLOTS} />
          </ChunkErrorBoundary>
        </div>
        <CommandPalette
          open={palette.open}
          focusSignal={palette.focusSignal}
          onClose={closePalette}
          daemon={connection.daemonId}
          sessions={paletteSessionEntries(sessions)}
          onNavigate={navigate}
        />
      </div>
    );
  }

  return (
    <NotificationControlsContext.Provider value={notificationControlsHost}>
      {/*
        FIRST IN DOM ORDER, so the Tab that follows a route change lands on the
        new page's own chrome rather than back at the top of the old one.
        `tabIndex={-1}` makes it programmatically focusable without adding a tab
        stop of its own, and `sr-only` keeps it out of the visual design.
      */}
      <p
        ref={routeAnnouncer}
        tabIndex={-1}
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-route={pageKey}
      >
        {routeAnnouncement(pageRoute)}
      </p>
      {content}
    </NotificationControlsContext.Provider>
  );
}

/** Public client-only root. Providers live here; `main.tsx` only calls `createRoot`. */
export function App() {
  return (
    <RouterProvider>
      <StoreProvider>
        <AppShell />
      </StoreProvider>
    </RouterProvider>
  );
}
