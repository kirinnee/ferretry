import { DoctorReportSchema, HealthViewSchema, type WardenVerdictsView } from '@ferretry/protocol';
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
import { ImportedHistoryPage } from './components/imported-history-page.tsx';
import { liveStreamState } from './components/live-stream-indicator.tsx';
import { NewSessionPage } from './components/new-session-page.tsx';
import {
  type SessionEventStreamControl,
  type SessionEventStreamEnvironment,
  type SessionEventStreamStatus,
  startSessionEventStream,
} from './components/session-event-stream-model.ts';
import {
  type SessionWorkspaceRefreshControl,
  type SessionWorkspaceRefreshEnvironment,
  startSessionWorkspaceRefresh,
  type transcriptEntriesFromLog,
} from './components/session-workspace-model.ts';
import { SessionsPage } from './components/sessions-page.tsx';
import { GlobalAnalyticsPage } from './features/analytics/global-analytics-page.tsx';
import { fleetSettingsTab } from './features/fleet/fleet-configuration-surface.tsx';
import { fleetSignInTab } from './features/fleet/fleet-sign-in-section.tsx';
import { LearningPage } from './features/learning/learning-page.tsx';
import { browserClipboardWriter } from './features/onboarding/copy-button.tsx';
import { detectDeviceKind } from './features/onboarding/device-kind.ts';
import { firstRunEntry } from './features/onboarding/first-run-entry.ts';
import { CHECKING_HOSTED_RELAY, type HostedRelayFallback } from './features/onboarding/hosted-relay.ts';
import { detectInstallChannel } from './features/onboarding/onboarding-model.ts';
import { OnboardingPage } from './features/onboarding/onboarding-page.tsx';
import { OnboardingProgressStore, resetOnboardingProgress } from './features/onboarding/onboarding-progress.ts';
import { setupHandoffFromHref } from './features/onboarding/setup-handoff.ts';
import type { SetupSharePort } from './features/onboarding/setup-handoff-panel.tsx';
import { PairingScreen } from './features/pairing/pairing-screen.tsx';
import { ProjectDetailPage } from './features/projects/project-detail.tsx';
import { ProjectsPage } from './features/projects/projects-page.tsx';
import { SessionSearchControl, SessionSearchProvider } from './features/session-search/session-search.tsx';
import { CgroupConfigSurface } from './features/settings/cgroup-settings.tsx';
import { dictationShortcutLabel } from './features/settings/dictation-shortcut.ts';
import { DoctorSettings } from './features/settings/doctor-settings.tsx';
import { NotificationSettingsView } from './features/settings/notification-settings.tsx';
import { pricingSettingsTab } from './features/settings/pricing-settings.tsx';
import { settingsPaletteEntries } from './features/settings/settings-catalog.ts';
import { SettingsPage } from './features/settings/settings-page.tsx';
import { WardenAttention } from './features/warden/warden-attention.tsx';
import { WardenConfigSurface } from './features/warden/warden-config-card.tsx';
import { WardenReportDialog, type WardenReportDialogRequest } from './features/warden/warden-report-dialog.tsx';
import { WardenStrip } from './features/warden/warden-strip.tsx';
import { WardenVerdicts } from './features/warden/warden-verdicts.tsx';
import { useActiveCarrier } from './hooks/use-active-carrier.ts';
import { useAppViewport } from './hooks/use-app-viewport.ts';
import { useInputModality } from './hooks/use-input-modality.ts';
import { useAttentionSession, useAttentionSnapshot } from './hooks/use-attention.ts';
import { useLayoutMode } from './hooks/use-layout-mode.ts';
import {
  type NotificationControlsHost,
  useNotificationControls,
  useNotificationWatch,
} from './hooks/use-notifications.ts';
import { useServiceWorkerUpdate } from './hooks/use-service-worker-update.ts';
import { useSttSettings } from './hooks/use-stt-settings.ts';
import { useWardenStatus } from './hooks/use-warden-status.ts';
import { type DaemonConnection, type DaemonId, daemonCarriers, sameDaemonConnection } from './lib/daemon-connection.ts';
import { daemonSessionScope } from './lib/daemon-scope.ts';
import type {
  NotificationPermissionState,
  NotificationRegistrationLike,
  NotificationSurface,
  PageNotificationLike,
} from './lib/notify.ts';
import { installPortraitLock } from './lib/orientation-lock.ts';
import {
  type DaemonPageProps,
  PageHost,
  type PageHostSlots,
  type ProjectDetailPageProps,
  type SessionChatPageProps,
} from './lib/pages/page-host.tsx';
import {
  connectionPickerPath,
  daemonSessionsPath,
  daemonSettingsPath,
  daemonWardenPath,
  type PageRoute,
  routePageKey,
  setupPath,
} from './lib/pages/routes.ts';
import { browserTerminalDeckDependencies } from './components/session-terminal-deck.tsx';
import { SessionChatPage } from './lib/pages/session-chat-page.tsx';
import { WardenPage } from './lib/pages/warden-page.tsx';
import { browserQrScanHost, type QrDetectorLike, type QrScanHost } from './lib/pair-scan.ts';
import { type PairingArrival, pairingArrival } from './lib/pairing.ts';
import { clearForegroundPinScope, getForegroundPinScope, setForegroundPinScope } from './lib/pin-bridge.ts';
import { type PushEnrolment, type PushRegistrationLike, supportsWebPush } from './lib/push-enrolment.ts';
import { RouterProvider, useRouter } from './lib/router.tsx';
import { StoreProvider, useAppStore, useConnectionSnapshot } from './lib/store.tsx';
import { AppBar, appBarDestinationForRoute, type Crumb } from './shell/app-bar.tsx';
import { ChunkErrorBoundary } from './shell/chunk-error-boundary.tsx';
import { CommandPalette, type PaletteSettingsSource } from './shell/command-palette.tsx';
import { paletteSessionEntries } from './shell/palette-model.ts';
import { PullToPaletteRegion } from './shell/pull-to-palette-region.tsx';
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

interface ShortcutTargetLike {
  closest?(selector: string): unknown;
}

/** A modal owns every chord dispatched from inside it, including from buttons. */
const isModalShortcutTarget = (target: EventTarget | null): boolean => {
  if (target === null || typeof target !== 'object') return false;
  const closest = (target as ShortcutTargetLike).closest;
  return typeof closest === 'function' && closest.call(target, 'dialog, [role="dialog"], [aria-modal="true"]') !== null;
};

/**
 * The two text-entry places where current-session Cmd/Ctrl+K is intentional.
 *
 * The composer is where a session reader normally stands, and the search box
 * itself supports the ordinary re-select gesture. Every other editable field
 * keeps its native chord even on a session route.
 */
const isSessionSearchShortcutTarget = (target: EventTarget | null): boolean => {
  if (target === null || typeof target !== 'object') return false;
  const closest = (target as ShortcutTargetLike).closest;
  return (
    typeof closest === 'function' && closest.call(target, 'form.fy-composer, [data-current-session-search]') !== null
  );
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
  if (route.kind === 'setup') return [{ label: 'Set up' }];
  const sessions = daemonSessionsPath(route.daemonId);
  switch (route.kind) {
    case 'sessions':
      return [{ label: 'Sessions' }];
    case 'new-session':
      return [{ href: sessions, label: 'Sessions' }, { label: 'New' }];
    case 'projects':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Projects' }];
    case 'project-detail':
      return [
        { href: sessions, label: 'Sessions' },
        { href: `${sessions}/projects`, label: 'Projects' },
        { label: 'Project' },
      ];
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
    case 'imported-history':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Imported history' }];
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

/**
 * The one-time code leaves the address bar as soon as a screen holds it, so it
 * cannot be reloaded, bookmarked, shared or screenshotted afterwards.
 * `replaceState`, not `pushState`: a back button that restored the code would
 * undo exactly this.
 */
const takeArrivalFromLocation = (): void => {
  window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}`);
};

/** The real clipboard, resolved once: the setup screen is the only page that copies. */
const clipboardWriter = browserClipboardWriter();

/**
 * The OS share sheet, or nothing.
 *
 * Absent on most desktops and on Firefox everywhere, so it is resolved rather
 * than assumed: a Share button that throws when pressed is worse than one that
 * was never drawn, and the hand-off panel already offers copy and the printed
 * link beside it.
 */
const browserSetupShare = (): SetupSharePort | undefined => {
  const share = navigator.share;
  return typeof share === 'function' ? async payload => await share.call(navigator, payload) : undefined;
};

const SETUP_ROUTE: PageRoute = { kind: 'setup' };

function ConnectionPicker() {
  const store = useAppStore();
  const snapshot = useConnectionSnapshot();
  const { navigate } = useRouter();
  // Read ONCE, at mount. A later render must not re-read an address the screen
  // has already emptied, and must not resurrect a code the reader declined.
  const [arrival] = useState(arrivalFromLocation);
  const scanHost = useMemo(browserQrScan, []);
  const takeArrival = useCallback(takeArrivalFromLocation, []);
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
      /*
       * ADDING A MACHINE REPLAYS THE WHOLE THING.
       *
       * Somebody here has a working pairing, so their stored progress says
       * "finished" — for a DIFFERENT host. Every new machine is a first-time
       * setup for that machine: it needs the install, the daemon, the carrier
       * choice and the pairing again, and resuming the last screen of a journey
       * they completed for a laptop is the one thing that cannot help them. So
       * the place is forgotten first, and the setup route opens on its question.
       */
      onOpenSetup={() => {
        resetOnboardingProgress();
        navigate(setupPath());
      }}
    />
  );
}

/**
 * FIRST RUN, COMPOSED.
 *
 * The stepper owns the journey; everything daemon-shaped still comes from the
 * same store seam the picker uses, and the pair stage is the SAME
 * `PairingScreen` — embedded rather than forked, so its confirmation, failure
 * and single-use-code behaviour are the ones already proved.
 *
 * The two navigations differ on purpose. Selecting an existing daemon leaves
 * immediately, exactly as it does from the picker; pairing during setup does
 * NOT, because the reader has one stage left and being teleported out of it
 * would hide the only screen that says they are finished.
 */
function SetupGuide() {
  const store = useAppStore();
  const snapshot = useConnectionSnapshot();
  const { navigate } = useRouter();
  const [arrival] = useState(arrivalFromLocation);
  const scanHost = useMemo(browserQrScan, []);
  const takeArrival = useCallback(takeArrivalFromLocation, []);
  /*
   * A tab opened FROM a pairing link IS the "I have a link" reader, whatever
   * storage remembers — it demonstrably has one. So the arrival answers the
   * chooser's question on their behalf rather than asking somebody holding a
   * live, two-minute code which of three people they are.
   *
   * `paired` is read here, at hydration, and deliberately not tracked: it
   * decides only whether a stored "finished" is believable for a browser that
   * holds no daemon. A pairing removed later, with the last stage already on
   * the glass, is that stage's own problem to state honestly.
   */
  /*
   * WHAT THIS DEVICE IS, AND WHERE ANOTHER ONE LEFT OFF.
   *
   * Both are read once, at mount, from the real browser. The device decides
   * which answers the chooser may offer — a phone is never offered a role that
   * needs a terminal — and the hand-off decides where this visit opens when
   * somebody carried a half-finished setup here from their other device.
   */
  const device = useMemo(() => detectDeviceKind(navigator), []);
  const [handoff] = useState(() => setupHandoffFromHref(window.location.href));
  const [progress] = useState(
    () =>
      new OnboardingProgressStore({
        device,
        paired: snapshot.connections.length > 0,
        ...(handoff === undefined ? {} : { handoff }),
        ...(arrival.kind === 'none' ? {} : { entry: { route: 'add-client' as const, step: 'scan' as const } }),
      }),
  );
  const channel = useMemo(() => detectInstallChannel(navigator.userAgent), []);
  const selected = snapshot.selectedDaemonId;
  /*
   * IS THE DEFAULT RELAY ADVERTISING ITSELF RIGHT NOW?
   *
   * Asked once per visit to this screen, through the store’s injected fetcher so
   * no suite dials out, and never from a compiled address — the origin is the
   * build constant `hosted-relay.ts` documents. The read cannot reject, so there
   * is no failure branch: “could not find out” arrives as a state and the chooser
   * says so in those words rather than offering a carrier that may be switched off.
   *
   * `live` rather than an AbortController: the answer is a fact about the service,
   * not about this component, so cancelling would save nothing and re-asking on a
   * remount is the point. What must not happen is a set after unmount.
   */
  const [fallback, setFallback] = useState<HostedRelayFallback>(CHECKING_HOSTED_RELAY);
  useEffect(() => {
    let live = true;
    void store.readDefaultRelay().then(answer => {
      if (live) setFallback(answer);
    });
    return () => {
      live = false;
    };
  }, [store]);
  return (
    <OnboardingPage
      progress={progress}
      write={clipboardWriter}
      channel={channel}
      fleetReady={selected !== null}
      fallback={fallback}
      /*
       * THE ORIGIN IS A RUNTIME FACT, NEVER A BUILD CONSTANT. A hand-off link
       * is built from the address this page was actually served from — there is
       * no hosted address in this bundle, and anyone may deploy it themselves.
       */
      href={window.location.href}
      share={browserSetupShare()}
      onOpenFleet={() => {
        // The selected daemon IS the one just paired: adding a connection
        // selects it. Never a hardcoded prefix — the app's own route helper.
        if (selected !== null) navigate(daemonSessionsPath(selected));
      }}
      renderPairing={({ onPaired }) => (
        <PairingScreen
          embedded
          arrival={arrival}
          scanHost={scanHost}
          onArrivalTaken={takeArrival}
          connections={snapshot.connections}
          selectedDaemonId={selected}
          onPair={async seed => {
            await store.pair(seed);
            onPaired();
          }}
          onSelect={daemonId => {
            store.connections.select(daemonId);
            navigate(daemonSessionsPath(daemonId));
          }}
          onRemove={daemonId => {
            store.connections.remove(daemonId);
          }}
        />
      )}
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
      accounts={store.accountPicker}
      connection={connection}
      fleet={store.fleet}
      projects={store.projects}
      startSession={async (daemon, request) => await (await store.clients.client(daemon)).start(request)}
      usage={store.usage}
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
  connected: 'This session is connected.',
  failed: 'This session could not be opened.',
};

const browserWorkspaceRefreshEnvironment: SessionWorkspaceRefreshEnvironment = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: handle => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>),
  onVisibility: callback => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', callback);
    return () => document.removeEventListener('visibilitychange', callback);
  },
};

const browserEventStreamEnvironment: SessionEventStreamEnvironment = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  random: () => Math.random(),
};

function SessionRoute({ connection, scope }: SessionChatPageProps) {
  const store = useAppStore();
  // Memoised on the router rather than rebuilt per render: the deck remounts when its dependencies
  // object changes identity, and a remount mid-session tears down a live shell.
  //
  // THE MEASURED CARRIER IS THE THIRD ARGUMENT, AND IT WAS NOT PASSED. `browserTerminalDeckDependencies`
  // declares it, `browserTerminalStreamAttach` gates the DIRECT branch on it, and the default is
  // `() => undefined` — so the composition root left the production deck permanently answering "no
  // carrier measured", which turns every direct attach into the retryable `TERMINAL_STREAM_NO_CARRIER`
  // and leaves a direct session's terminals cycling the deck's backoff instead of opening a socket.
  // It is a GETTER rather than the subscribed `measuredCarrier` below on purpose: a carrier is a
  // measurement read per attach, and depending on the subscribed value here would give this memo a
  // new identity the moment a walk decides — remounting the deck and tearing down the live shell the
  // memo exists to protect.
  const terminalDeck = useMemo(
    () =>
      browserTerminalDeckDependencies(
        store.carrier.fetch,
        async (daemon, request) => await store.carrier.openStream(daemon, request),
        () => store.carrier.activeMethod(scope.daemonId),
      ),
    [scope.daemonId, store.carrier],
  );
  const { navigate } = useRouter();
  const layout = useLayoutMode();
  const dictation = useSttSettings(store.stt);
  const { daemonId, sessionId } = scope;
  // The session's Attention, read through the ONE daemon-scoped client the app
  // store owns — same carrier as every generated call, and invalidated with the
  // pairing rather than outliving it.
  const attentionStatus = useAttentionSession(store.attention, connection, scope);
  const attentionSnapshot = useAttentionSnapshot(store.attention, scope);
  const attention = useMemo(
    () => ({ client: store.attention, snapshot: attentionSnapshot, status: attentionStatus }),
    [store.attention, attentionSnapshot, attentionStatus],
  );
  const subscribe = useCallback((listener: () => void) => store.fleet.subscribe(listener), [store.fleet]);
  const snapshot = useCallback(() => store.fleet.getSnapshot(), [store.fleet]);
  const fleet = useSyncExternalStore(subscribe, snapshot);
  const controls = useSyncExternalStore(store.controls.subscribe, () => store.controls.controls(daemonId));
  // THE mapping from the persisted device preference to the composer's rule,
  // written once. It is memoised on the three booleans rather than rebuilt on
  // every render because the composer rebuilds its providers from it, and a
  // fresh object each render would abort an open list on every keystroke.
  const composerSuggestions = useMemo(
    () => ({
      mentionSuggestions: controls.mentionSuggestions,
      directReferenceSuggestions: controls.directReferenceSuggestions,
      skillSuggestions: controls.skillSuggestions,
    }),
    [controls.mentionSuggestions, controls.directReferenceSuggestions, controls.skillSuggestions],
  );
  const fleetSlice = fleet.daemons.get(scope.daemonId);
  const session = fleetSlice?.byId.get(scope.sessionId);
  const [entries, setEntries] = useState<ReturnType<typeof transcriptEntriesFromLog>>([]);
  const [client, setClient] = useState<Awaited<ReturnType<typeof store.clients.client>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The highest event sequence this browser has actually received. `0` means none yet. */
  const [liveCursor, setLiveCursor] = useState(0);
  /**
   * The same number, held where a RESUBSCRIPTION can read it.
   *
   * A ref rather than the state, because the effect below must not depend on the cursor: depending
   * on it would tear down and reopen the socket on every single event, which is worse than the
   * defect it would be fixing. State is what the DOM renders; this is what a new stream resumes from
   * when the client or the measured carrier is replaced under a session that stays open. It is per
   * session without ever being reset, because the page host keys this whole route on the
   * daemon-session seam: moving to another session mounts another route with a cursor of its own.
   */
  const liveCursorRef = useRef(0);
  const [streamStatus, setStreamStatus] = useState<SessionEventStreamStatus>('connecting');
  const streamControl = useRef<SessionEventStreamControl | null>(null);
  /**
   * The carrier this daemon's traffic is MEASURED on, subscribed rather than read once.
   *
   * `useActiveCarrier` re-renders when the router publishes a new answer, which is what makes the
   * live-feed effect below re-run the moment a walk decides — and what lets this route state the
   * carrier on a surface that is mounted whenever a session is open. `ActiveCarrierCard` says the
   * same thing at length, but it lives in Settings, and a reader (or a harness) looking at a session
   * should not have to navigate away to find out how its bytes are travelling.
   */
  const measuredCarrier = useActiveCarrier(store.carrier, daemonId);
  const carrierKind = measuredCarrier?.ok === true ? measuredCarrier.method.kind : 'none';
  const refreshControl = useRef<SessionWorkspaceRefreshControl | null>(null);

  useEffect(() => {
    let current = true;
    let control: SessionWorkspaceRefreshControl | null = null;
    setError(null);
    setEntries([]);
    setClient(null);
    void store.clients
      .client(connection)
      .then(api => {
        if (!current) return;
        setClient(api);
        const attentionScope = daemonSessionScope(connection, sessionId);
        control = startSessionWorkspaceRefresh({
          api: {
            // Attention shares the workspace's one visibility-aware refresh
            // owner. Its own status reports a failed board read, so a failure
            // here must not relabel a successful transcript as unreadable.
            logs: async id => {
              void store.attention.revalidate(connection, attentionScope).catch(() => undefined);
              return await api.logs(id);
            },
            get: async id => await store.fleet.fetchSession(connection, { daemonId, sessionId: id }),
          },
          sessionId,
          environment: browserWorkspaceRefreshEnvironment,
          onTranscript: setEntries,
          // fetchSession publishes the same proved view into the daemon-scoped
          // fleet cache; publishing it again here would force two shell renders.
          onSession: () => undefined,
          onError: setError,
        });
        refreshControl.current = control;
      })
      .catch(reason => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      current = false;
      control?.stop();
      if (refreshControl.current === control) refreshControl.current = null;
    };
  }, [connection, daemonId, sessionId, store.attention, store.clients, store.fleet]);

  /**
   * THE LIVE FEED, AND THE FIRST THING IN THIS APP THAT CONSUMES ONE.
   *
   * `/v1/events` has been mounted on the daemon and read by nothing: the transcript arrives on a
   * three-second poll, which is honest and is not live. Subscribing here makes an arriving event
   * refresh the transcript at once, and it is the same subscription on either carrier — the typed
   * client's transport opens a `wss://` socket on direct and a §14 stream session on a relay, and
   * this effect does not know which.
   *
   * A FAILED STREAM IS NOT AN ERROR THE READER IS SHOWN, and it is not a silence either. The poll is
   * still running underneath and still refreshing, so losing the feed makes the screen slower rather
   * than wrong and reporting it as a session failure would take a working workspace away over a lost
   * optimisation. What it IS is a state, said plainly beside the pane openers — because the defect
   * this route shipped with was not that a lost stream was fatal, it was that a lost stream was
   * invisible, and a reader with no way to know also had no way to act.
   *
   * RECONNECTION BELONGS TO `startSessionEventStream`, WHICH THIS EFFECT NO LONGER DECIDES. A socket
   * that dies changes none of this effect's dependencies — that is exactly why the original one-shot
   * subscription could never come back — so a retry written here would have to be a timer inside a
   * React effect that no test can drive. Read that model for what a close, a silence or the reader's
   * own Reconnect does; this effect only decides WHEN a subscription may exist at all.
   *
   * The cursor is what a harness polls: it only ever moves forward, and it is non-empty exactly once
   * something has arrived — so "an event reached this browser" is readable without matching copy.
   */
  useEffect(() => {
    // NOT UNTIL A CARRIER HAS BEEN MEASURED, and that is the whole fix rather than a guard. A
    // carrier is decided by the first request that walks, so this effect can run before any walk has
    // finished — and a subscription opened then takes the direct branch and opens a socket at an
    // address a relayed browser cannot reach. The model would now retry that address until its
    // budget ran out and then tell the reader the daemon is offline, which makes waiting for the
    // measurement MORE necessary rather than less.
    //
    // THE DEPENDENCY IS THE CHOICE OBJECT, NOT ITS KIND. Depending on the kind alone would leave a
    // stream subscribed to a carrier the router has replaced whenever the replacement happens to be
    // the same kind — relay A for relay B. That is not reachable through today's router, which only
    // ever replaces a winner by way of `undefined`, but "not reachable today" is a fact about one
    // call site rather than about this effect, and the object costs nothing to depend on.
    if (client === null || measuredCarrier?.ok !== true) return;
    const stream = startSessionEventStream({
      api: client,
      sessionId,
      after: liveCursorRef.current,
      environment: browserEventStreamEnvironment,
      onEvent: event => {
        liveCursorRef.current = Math.max(liveCursorRef.current, event.sequence);
        setLiveCursor(current => Math.max(current, event.sequence));
        void refreshControl.current?.refresh(true);
      },
      onStatus: setStreamStatus,
    });
    streamControl.current = stream;
    setStreamStatus(stream.status());
    return () => {
      stream.stop();
      if (streamControl.current === stream) streamControl.current = null;
    };
  }, [client, measuredCarrier, sessionId]);

  /**
   * The reader's way back, and it is a REF rather than the control itself on purpose: a callback
   * that depended on the live stream object would change identity on every resubscription and
   * re-render the whole chat page with it.
   */
  const reconnectStream = useCallback(() => {
    streamControl.current?.reconnect();
  }, []);
  /**
   * WHAT THE CHIP READS, DERIVED FROM THE SAME TWO VALUES THE EFFECT ABOVE GATES ON.
   *
   * `streamStatus` alone was not enough and the gap was silent. When the effect's guard stops being
   * satisfied — the client is replaced with `null`, or a later carrier walk answers `ok: false` for a
   * daemon that was reachable a minute ago — React runs the cleanup and then the effect RETURNS
   * EARLY. The subscription is gone and `setStreamStatus` is never reached, so the state kept saying
   * whatever it last said. A page that had been `live` went on saying `live` with nothing behind it,
   * which is precisely the defect this whole route was changed to end.
   *
   * Deriving it instead of remembering it makes that disagreement unrepresentable: the status is only
   * consulted while a subscription may exist, and the two host facts are the same expression the
   * effect uses rather than a second copy that could drift from it.
   */
  const subscribed = client !== null && measuredCarrier?.ok === true;
  const liveStream = useMemo(
    () => ({
      status: liveStreamState(subscribed, measuredCarrier?.ok === false, streamStatus),
      onReconnect: reconnectStream,
    }),
    [measuredCarrier, reconnectStream, streamStatus, subscribed],
  );

  useEffect(() => {
    const foreground = { daemonId, sessionId };
    setForegroundPinScope(foreground);
    return () => clearForegroundPinScope(foreground);
  }, [daemonId, sessionId]);

  const sessionState: SessionState = session !== undefined ? 'connected' : error !== null ? 'failed' : 'opening';
  const sessionIssue = error === null ? null : `Session workspace issue: ${error}`;
  const refresh = useCallback(() => {
    void refreshControl.current?.refresh(true);
  }, []);
  const publishSession = useCallback(
    (view: NonNullable<typeof session>) => {
      if (view.config.id === sessionId) store.fleet.upsertSession(daemonId, view);
    },
    [daemonId, sessionId, store.fleet],
  );

  return (
    <div
      className="h-full min-h-0 w-full"
      data-daemon={scope.daemonId}
      data-session={scope.sessionId}
      // The live feed's cursor: `0` until an event has arrived, then monotonic. A harness proving
      // that a stream reached this browser polls this rather than watching the transcript's text,
      // which changes for reasons that have nothing to do with the carrier.
      data-live-events={String(liveCursor)}
      data-carrier-kind={carrierKind}
    >
      {/* These live regions outlive every loading/error/content swap. */}
      <p className="sr-only" role="status" aria-live="polite" data-session-state={sessionState}>
        {SESSION_STATE_MESSAGE[sessionState]}
      </p>
      <p className="sr-only" role="alert" data-session-error="">
        {sessionIssue ?? ''}
      </p>
      {session !== undefined && client !== null ? (
        <SessionChatPage
          accountPicker={store.accountPicker}
          browserLogin={store.browserLogin}
          attention={attention}
          chatWidth={controls.chatWidth}
          composerEnterKey={controls.composerEnterKey}
          composerFetch={store.carrier.fetch}
          composerSuggestions={composerSuggestions}
          composerVimMode={controls.composerVimMode}
          // THE TERMINAL DECK TRAVELS THE CARRIER TOO. Its HTTP control plane — list, create,
          // rename, close, and the ticket purchase — defaulted to the raw network, so on a
          // relay-only network a reader opening a shell got a bare `Failed to fetch` from an
          // address the relay exists because the browser cannot reach it. Its live stream is bound
          // the same way: `openStream` answers a §14 stream session on a rendezvous and `null` on
          // direct, so the deck asks one question and gets whichever carrier is live.
          deck={terminalDeck}
          dictationSettings={dictation.settings}
          client={client}
          connection={connection}
          // Whether this session's live feed is actually alive, and the reader's way back when it is
          // not. It travels as a prop rather than being read from a store inside the page for the
          // same reason everything else here does: a component that reached for the store could not
          // be mounted by a test without one.
          liveStream={liveStream}
          // Only THIS daemon's slice, and only once it has actually been read:
          // `sessions === null` is "not read yet", which must not reach the
          // reference surface as a fleet with nobody in it.
          {...(fleetSlice?.sessions === null || fleetSlice?.sessions === undefined
            ? {}
            : { daemonSessions: fleetSlice.sessions })}
          entries={entries}
          onBack={() => navigate(daemonSessionsPath(connection.daemonId))}
          onNavigate={navigate}
          onRefresh={refresh}
          onSessionChange={publishSession}
          presentation={layout === 'drawer' ? 'sheet' : 'pane'}
          pins={store.pins}
          refreshError={sessionIssue}
          session={session}
          usage={store.usage}
        />
      ) : (
        <main className="mx-auto flex h-full w-full max-w-[980px] flex-col gap-3 overflow-y-auto py-3">
          <button
            type="button"
            className="kt-btn self-start"
            onClick={() => navigate(daemonSessionsPath(scope.daemonId))}
          >
            ← Sessions
          </button>
          <section className="kt-panel p-panel" aria-labelledby="session-route-heading">
            <h1 id="session-route-heading" className="m-0 font-display text-display font-bold tracking-display">
              {scope.sessionId}
            </h1>
            <p className="mb-0 text-ui text-muted">{sessionIssue ?? 'Opening this daemon-scoped session…'}</p>
          </section>
        </main>
      )}
    </div>
  );
}

function SettingsRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const connectionSnapshot = useConnectionSnapshot();
  const { navigate } = useRouter();
  const dictation = useSttSettings(store.stt);
  const carrier = useActiveCarrier(store.carrier, connection.daemonId);
  const notifications = useNotificationControls(useNotificationControlsHost(), connection);
  const probeDaemon = useCallback(
    async (daemon: DaemonConnection) => {
      const client = await store.clients.client(daemon);
      await client.request('/v1/health', HealthViewSchema, {}, 5_000);
    },
    [store.clients],
  );
  const readWardenStatus = useCallback(
    async (daemon: DaemonConnection) => await (await store.clients.client(daemon)).wardenStatus(),
    [store.clients],
  );
  const createDaemonClient = useCallback(
    async (daemon: DaemonConnection) => await store.clients.client(daemon),
    [store.clients],
  );
  const daemonSettingsTabs = useMemo(
    () => [
      {
        id: 'resource-limits',
        label: 'Resource limits',
        description: 'Linux CPU and RAM caps for this daemon’s managed fleet.',
        // Referenced directly rather than wrapped: this surface takes only `connection`, so a
        // pass-through arrow would add a component factory nothing renders — an uncovered line that
        // exists solely to rename its own argument. Doctor below genuinely needs one; it also passes `read`.
        Surface: CgroupConfigSurface,
      },
      {
        id: 'doctor',
        label: 'Doctor',
        description: 'Programs this daemon host needs, and what each absence breaks.',
        Surface: ({ connection: activeConnection }: { readonly connection: DaemonConnection }) => (
          <DoctorSettings
            connection={activeConnection}
            read={async daemon => await (await store.clients.client(daemon)).request('/v1/doctor', DoctorReportSchema)}
          />
        ),
      },
      pricingSettingsTab(createDaemonClient),
      fleetSettingsTab(async daemon => await store.clients.client(daemon)),
      // Directly after Fleet: the accounts, then who is signed in to them.
      fleetSignInTab(async daemon => await store.clients.client(daemon)),
    ],
    [createDaemonClient, store.clients],
  );
  return (
    <SettingsPage
      daemonId={connection.daemonId}
      connections={connectionSnapshot.connections}
      controls={store.controls}
      dictation={dictation}
      probeDaemon={probeDaemon}
      readWardenStatus={readWardenStatus}
      // Through the app's client pool, so a grant read travels the same carrier — direct first, relay
      // as the automatic fallback — as every other daemon call. The surface's own default would dial
      // the daemon address directly, which is how a screen ends up reporting a limit it could not read
      // on a daemon that is only reachable through the rendezvous.
      createGrantClient={createDaemonClient}
      daemonSettingsTabs={daemonSettingsTabs}
      onSelectDaemon={daemonId => {
        store.connections.select(daemonId);
        navigate(`${daemonSettingsPath(daemonId)}#daemons`);
      }}
      onRenameDaemon={(daemonId, label) => {
        store.connections.rename(daemonId, label);
      }}
      onRemoveDaemon={daemonId => {
        const removedActiveDaemon = daemonId === connection.daemonId;
        store.connections.remove(daemonId);
        if (!removedActiveDaemon) return;
        const fallback = store.connections.getSnapshot().selectedDaemonId;
        navigate(fallback === null ? connectionPickerPath() : `${daemonSettingsPath(fallback)}#daemons`);
      }}
      onAddDaemon={() => navigate(connectionPickerPath())}
      carrier={carrier}
      // Read through `daemonCarriers`, which is the set the router will actually dial. A pairing
      // whose fingerprint this protocol cannot address has its relays stripped before a single
      // attempt, so the cached set alone would advertise a fallback that can never be tried — and
      // would hide "there is no relay to fall back on" from the one reader it is written for.
      relayAdvertised={daemonCarriers(connection).some(method => method.kind === 'relay')}
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

type WardenVerdictReadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly verdicts: WardenVerdictsView }
  | { readonly status: 'stale'; readonly verdicts: WardenVerdictsView }
  | { readonly status: 'unavailable' };

/** Read one daemon's concise report index. This intentionally lives beside the
 * route that mounts it: the state is not a reusable global cache, and a failed
 * read must remain visibly unavailable rather than quietly becoming []. */
function useWardenVerdicts(
  daemon: DaemonConnection,
  read: (daemon: DaemonConnection) => Promise<WardenVerdictsView>,
): WardenVerdictReadState {
  const [held, setHeld] = useState<{ readonly daemon: DaemonConnection; readonly state: WardenVerdictReadState }>({
    daemon,
    state: { status: 'loading' },
  });

  useEffect(() => {
    let cancelled = false;
    setHeld({ daemon, state: { status: 'loading' } });
    const poll = async (): Promise<void> => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const verdicts = await read(daemon);
        if (!cancelled) setHeld({ daemon, state: { status: 'ready', verdicts } });
      } catch {
        if (cancelled) return;
        setHeld(current => {
          if (!sameDaemonConnection(current.daemon, daemon)) return current;
          return current.state.status === 'ready' || current.state.status === 'stale'
            ? { daemon, state: { status: 'stale', verdicts: current.state.verdicts } }
            : { daemon, state: { status: 'unavailable' } };
        });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [daemon, read]);

  return sameDaemonConnection(held.daemon, daemon) ? held.state : { status: 'loading' };
}

function WardenVerdictsRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const readVerdicts = useCallback(
    async (daemon: DaemonConnection) => await (await store.clients.client(daemon)).wardenVerdicts(),
    [store.clients],
  );
  const readReport = useCallback(
    async (daemon: DaemonConnection, reportPath: string) =>
      await (await store.clients.client(daemon)).wardenReport(reportPath),
    [store.clients],
  );
  const state = useWardenVerdicts(connection, readVerdicts);
  const [report, setReport] = useState<WardenReportDialogRequest | null>(null);

  if (state.status === 'loading')
    return (
      <section className="kt-panel p-panel" role="status" aria-label="Loading Warden reports">
        <p className="m-0 text-ui text-muted">Checking recent Warden reports…</p>
      </section>
    );
  if (state.status === 'unavailable')
    return (
      <section className="kt-panel p-panel" role="alert" aria-label="Warden reports unavailable">
        <h2 className="m-0 text-title font-semibold">Recent verdicts unavailable</h2>
        <p className="mb-0 mt-1 text-ui text-muted">
          This daemon could not provide the report index. Ferretry will not present an empty history as evidence that
          the fleet is healthy.
        </p>
      </section>
    );

  return (
    <>
      {state.status === 'stale' && (
        <p
          className="m-0 rounded-control border border-warn-border bg-warn-bg px-cell-x py-2 text-cell text-warn"
          role="status"
        >
          The latest report check failed; showing the last verified index.
        </p>
      )}
      <WardenVerdicts connection={connection} verdicts={state.verdicts} onOpenReport={request => setReport(request)} />
      <WardenReportDialog request={report} read={readReport} onClose={() => setReport(null)} />
    </>
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

function ImportedHistoryRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  return (
    <ImportedHistoryPage
      connection={connection}
      readHistory={async daemon => await (await store.clients.client(daemon)).foreignHistory()}
      readConversation={async (daemon, id) => await (await store.clients.client(daemon)).foreignHistoryConversation(id)}
    />
  );
}

function ProjectsRoute({ connection }: DaemonPageProps) {
  return <ProjectsPage connection={connection} />;
}

function ProjectDetailRoute({ connection, projectId }: ProjectDetailPageProps) {
  return <ProjectDetailPage connection={connection} projectId={projectId} />;
}

const PAGE_SLOTS: PageHostSlots = {
  ConnectionPicker,
  Setup: SetupGuide,
  Sessions: SessionsRoute,
  NewSession: NewSessionRoute,
  Projects: ProjectsRoute,
  ProjectDetail: ProjectDetailRoute,
  SessionChat: SessionRoute,
  Settings: SettingsRoute,
  Warden: WardenRoute,
  Analytics: AnalyticsRoute,
  Learning: LearningRoute,
  ImportedHistory: ImportedHistoryRoute,
};

/** The mounted shell; exported so render tests can inject the router and store providers. */
export function AppShell() {
  useAppViewport();
  const store = useAppStore();
  const connectionSnapshot = useConnectionSnapshot();
  const { route, navigate } = useRouter();
  const pageRoute: PageRoute = route.kind === 'legacy-tasks-redirect' ? route.to : route;
  const connection =
    pageRoute.kind === 'connection-picker' || pageRoute.kind === 'setup'
      ? undefined
      : connectionSnapshot.connections.find(candidate => candidate.daemonId === pageRoute.daemonId);
  const [permission, setPermission] = useState<NotificationPermissionState>(notificationPermission);
  /*
   * THE SETUP JOURNEY IS DECIDED AT ENTRY, AND HELD ONLY WHILE IT LASTS.
   *
   * Two ways in. Nothing paired: the store is already hydrated on this first
   * render (`StoreProvider` holds the tree back until IndexedDB opens), so zero
   * connections is a true "nothing here" and not a not-loaded-yet flash. Or a
   * pairing code in the address — a phone's camera app opening `/pair#v1;…` —
   * which is the setup journey arriving at its third stage, whether or not this
   * browser already has daemons.
   *
   * It is HELD because pairing adds a connection synchronously: re-deciding on
   * that render would swap the guide out at the exact moment the reader earned
   * the stage that tells them it worked. It is RELEASED as soon as they leave
   * for a daemon page, so coming back to `/` later is ordinary browsing and
   * shows the picker rather than the guide they already finished.
   */
  const [setupJourney, setSetupJourney] = useState(
    () => connectionSnapshot.connections.length === 0 || arrivalFromLocation().kind !== 'none',
  );
  useEffect(() => {
    if (pageRoute.kind === 'connection-picker' || pageRoute.kind === 'setup') return;
    setSetupJourney(false);
  }, [pageRoute.kind]);
  /*
   * The screen a reader HEARS must be the screen they SEE.
   *
   * A cold `/` renders the setup guide, so the crumb, the page key and the live
   * announcement all have to come from that, not from the picker route the URL
   * still literally names. Deriving them from one effective route is what keeps
   * the two descriptions from drifting apart.
   */
  /*
   * A PAIRED BROWSER IS ASKED NOTHING WHEN IT OPENS.
   *
   * `firstRunEntry` decides between the fleet, the picker and the guide from
   * evidence alone, and the only one of the three that is a NAVIGATION is the
   * fleet — so it happens in an effect, and the render below shows the picker
   * for the single frame it takes. A blank screen while deciding would be the
   * failure mode this shortcut exists to remove.
   *
   * IT IS AN ENTRY SHORTCUT, NOT A REDIRECT ON THE ROUTE. Decided once, from
   * how this session STARTED. `/` is the only address that reaches the daemon
   * picker, which is where "set up another machine" lives — so a permanent
   * redirect off it would make a paired reader unable to add their second
   * daemon at all. Opening the app is the moment nobody should be asked
   * anything; deliberately navigating back to `/` afterwards is a reader asking
   * for that screen, and they get it.
   */
  const [shortcut] = useState<DaemonId | null>(() => {
    if (pageRoute.kind !== 'connection-picker') return null;
    const entry = firstRunEntry({
      pairedDaemonIds: connectionSnapshot.connections.map(candidate => candidate.daemonId),
      selectedDaemonId: connectionSnapshot.selectedDaemonId,
      setupJourney,
    });
    return entry.kind === 'fleet' ? entry.daemonId : null;
  });
  useEffect(() => {
    if (shortcut === null) return;
    navigate(daemonSessionsPath(shortcut));
  }, [navigate, shortcut]);
  const effectiveRoute: PageRoute = pageRoute.kind === 'connection-picker' && setupJourney ? SETUP_ROUTE : pageRoute;

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
  const [sessionSearchFocusSignal, setSessionSearchFocusSignal] = useState(0);
  const openPalette = useCallback(
    () => setPalette(current => ({ open: true, focusSignal: current.focusSignal + 1 })),
    [],
  );
  const closePalette = useCallback(() => setPalette(current => ({ ...current, open: false })), []);
  /*
   * THE SETTINGS CATALOG ANSWERS THE WHOLE SETTINGS QUESTION.
   *
   * The palette takes a query FUNCTION rather than a list, so which controls
   * match a phrase is decided once, by the surface that owns their labels,
   * descriptions, anchors and keywords. A list handed over here would have made
   * the shell the second place that decides what "push to talk" finds, and the
   * two rules would have drifted the first time a keyword was added.
   *
   * The live push-to-talk binding rides along because the catalog cannot read
   * browser-local dictation storage without owning it, and a reader searching
   * for their own shortcut should be told which one it currently is.
   */
  const dictation = useSttSettings(store.stt);
  const pushToTalk = dictationShortcutLabel(dictation.settings.shortcut);
  const paletteSettings = useCallback<PaletteSettingsSource>(
    (daemon, query) => settingsPaletteEntries(daemon, query, { dictationShortcutLabel: pushToTalk }),
    [pushToTalk],
  );
  const { touchAffected } = useInputModality();
  const currentSessionScope = useMemo(
    () =>
      connection !== undefined && pageRoute.kind === 'session'
        ? daemonSessionScope(connection, pageRoute.sessionId)
        : null,
    [connection, pageRoute],
  );

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
  const pageKey = routePageKey(effectiveRoute);
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

  /**
   * THE SHORTCUT YIELDS TO A FIELD ONLY WHERE THERE IS SOMETHING TO YIELD FOR.
   *
   * Off a session route the chord opens the global palette, and yielding to a
   * focused field is deliberate — see the test that presses it inside an input,
   * a textarea, a select and a contenteditable and requires the keystroke to
   * survive.
   *
   * ON a session route it is item #6's current-session search, and the field the
   * reader is almost always in is the composer — a `<textarea>`. That one field,
   * and the search itself, deliberately reach the palette. Other editable and
   * modal contexts keep the chord: a rename field or an open dialog owns its
   * keyboard interaction and must not be escaped through by a global listener.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'k' && event.key !== 'K') return;
      if (event.shiftKey || event.altKey || (!event.metaKey && !event.ctrlKey)) return;
      const sessionScoped = currentSessionScope !== null;
      if (isModalShortcutTarget(event.target)) return;
      if (isTextEntryTarget(event.target) && (!sessionScoped || !isSessionSearchShortcutTarget(event.target))) return;
      event.preventDefault();
      if (sessionScoped) setSessionSearchFocusSignal(current => current + 1);
      else openPalette();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [currentSessionScope, openPalette]);

  let content: ReactNode;
  if (effectiveRoute.kind === 'setup') {
    // `/setup` is reachable at any time — a paired reader setting up a second
    // machine asked for it. What never happens is ordinary browsing dropping a
    // paired reader back into the guide.
    content = (
      <div className="kt-shell overflow-y-auto">
        <SetupGuide />
      </div>
    );
  } else if (effectiveRoute.kind === 'connection-picker') {
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
      <SessionSearchProvider connection={connection} focusSignal={sessionSearchFocusSignal} scope={currentSessionScope}>
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
            {...(currentSessionScope === null ? {} : { currentSessionSearch: <SessionSearchControl shortcutTarget /> })}
          />
          {/*
            The finder's touch affordance wraps the page area rather than one
            page: a phone has no Cmd/Ctrl+K, and the top bar's own Find button is
            behind the destination sheet on that width. The region is passive and
            discovers the touched page scroller, so ordinary scrolling stays
            browser-owned and a transcript — where the same movement loads history
            — can explicitly decline it.
          */}
          <PullToPaletteRegion
            className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3"
            enabled={touchAffected}
            onOpen={openPalette}
          >
            <ChunkErrorBoundary onChunkError={raiseRecovery} onReload={applyUpdate}>
              <PageHost key={pageKey} route={pageRoute} connection={connection} slots={PAGE_SLOTS} />
            </ChunkErrorBoundary>
          </PullToPaletteRegion>
          <CommandPalette
            open={palette.open}
            focusSignal={palette.focusSignal}
            onClose={closePalette}
            daemon={connection.daemonId}
            sessions={paletteSessionEntries(sessions)}
            onNavigate={navigate}
            settings={paletteSettings}
            touchAffected={touchAffected}
            shortcutAvailable={currentSessionScope === null}
          />
        </div>
      </SessionSearchProvider>
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
        {routeAnnouncement(effectiveRoute)}
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
