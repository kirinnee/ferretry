import { DoctorReportSchema, HealthViewSchema, type QueuedMessage } from '@ferretry/protocol';
import { KanbanSquare, QrCode, Sparkles } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { composerSuggestionSwitches } from './components/composer-autocomplete.ts';
import { ImportedHistoryPage } from './components/imported-history-page.tsx';
import type { SendCancel, SendRetry, SendSubmit } from './components/ledger-message.tsx';
import { liveStreamState } from './components/live-stream-indicator.tsx';
import { NewSessionPage } from './components/new-session-page.tsx';
import {
  type SessionEventStreamControl,
  type SessionEventStreamEnvironment,
  type SessionEventStreamStatus,
  startSessionEventStream,
} from './components/session-event-stream-model.ts';
import { browserTerminalDeckDependencies } from './components/session-terminal-deck.tsx';
import {
  changesOnlyByJournal,
  type SessionWorkspaceRefreshControl,
  type SessionWorkspaceRefreshEnvironment,
  sendCanceller,
  sendRetrier,
  sendSubmitter,
  startSessionWorkspaceRefresh,
  transcriptEntriesFromLog,
} from './components/session-workspace-model.ts';
import { SessionsPage } from './components/sessions-page.tsx';
import type { SendDismiss, SendExpand } from './components/settled-send-note.tsx';
import { useAgendaSessionActions } from './features/agenda/agenda-session-actions.tsx';
import { GlobalAnalyticsPage } from './features/analytics/global-analytics-page.tsx';
import { TERMINAL_STATUSES } from './shell/status-mark.tsx';
import { AgendaInboxComposer } from './features/agenda/agenda-inbox-composer.tsx';
import { AgendaInboxPage } from './features/agenda/agenda-inbox-page.tsx';
import { BoardOriginProvider, useBoardOrigin } from './features/board/board-origin.tsx';
import { BoardPage } from './features/board/board-page.tsx';
import { LinkBehaviourProvider } from './features/browser/external-link.tsx';
import { useLocalComputer } from './features/browser/use-local-computer.ts';
import { tunnelSwitchOffer } from './features/carrier/carrier-preference-selector.tsx';
import { configFilesSettingsTab } from './features/config-files/config-files-settings.tsx';
import { ConnectionHealthNotice } from './features/connection/connection-health-notice.tsx';
import { NewDeviceNotices } from './features/device-notice/new-device-notice.tsx';
import { ComponentsSurface } from './features/fleet/components/components-tab.tsx';
import { CredentialsTab } from './features/fleet/credentials/credentials-tab.tsx';
import type { FleetClientFactory } from './features/fleet/fleet-client.ts';
import { BrowserTab } from './features/fleet/machine/browser-tab.tsx';
import { MachineSettingsSurface } from './features/fleet/machine/settings-tab.tsx';
import { ProfilesTab } from './features/fleet/profiles/profiles-tab.tsx';
import { RuntimesTab } from './features/fleet/runtimes/runtimes-tab.tsx';
import { landingAfterPairing } from './features/fleet/setup/first-run-landing.ts';
import { isMachineSetupStepId } from './features/fleet/setup/onboarding-model.ts';
import { browserSetupStorage } from './features/fleet/setup/setup-progress.ts';
import { MachineSetupScreen } from './features/fleet/setup/setup-screen.tsx';
import { machineHash } from './features/fleet/shell/machine-route.ts';
import type { MachineTabSurfaces } from './features/fleet/shell/machines-surface.tsx';
import { useHypermediaSessionActions } from './features/hypermedia/hypermedia-session-actions.tsx';
import { InstallBannerSlot } from './features/install/install-app.tsx';
import { LearningPage } from './features/learning/learning-page.tsx';
import { useLearningSessionActions } from './features/learning/learning-session-actions.tsx';
import { LEARNING_SETTINGS_TAB, LearningSettingsSurface } from './features/learning/learning-settings.tsx';
import { useMachinesPassiveLearning } from './features/learning/passive-learning.tsx';
import { browserClipboardWriter } from './features/onboarding/copy-button.tsx';
import { detectDeviceKind } from './features/onboarding/device-kind.ts';
import { firstRunEntry } from './features/onboarding/first-run-entry.ts';
import { CHECKING_HOSTED_RELAY, type HostedRelayFallback } from './features/onboarding/hosted-relay.ts';
import { detectInstallChannel } from './features/onboarding/onboarding-model.ts';
import { OnboardingPage } from './features/onboarding/onboarding-page.tsx';
import {
  OnboardingProgressStore,
  resetOnboardingProgress,
  startOnboardingPairing,
} from './features/onboarding/onboarding-progress.ts';
import { setupHandoffFromHref } from './features/onboarding/setup-handoff.ts';
import type { SetupSharePort } from './features/onboarding/setup-handoff-panel.tsx';
import { usePackSessionActions } from './features/pack/pack-session-actions.tsx';
import { PACK_SETTINGS_TAB } from './features/pack/pack-settings.tsx';
import { DeviceRefusedNotice } from './features/pairing/device-refused-notice.tsx';
import { PairingScreen } from './features/pairing/pairing-screen.tsx';
import { ProjectDetailPage } from './features/projects/project-detail.tsx';
import { LaneEditorPage } from './features/projects/lane-editor.tsx';
import { ProjectsPage } from './features/projects/projects-page.tsx';
import { restartFerrets } from './features/restart-outdated/restart-outdated-api.ts';
import { RestartOverlayProvider } from './features/restart-outdated/restart-overlay.tsx';
import { ActionToast } from './features/session-actions/action-toast.tsx';
import { sessionRowMenuRenderer } from './features/session-actions/row-actions-host.tsx';
import { switchTapper } from './features/session-info/switch-marks.tsx';
import { SessionSearchControl, SessionSearchProvider } from './features/session-search/session-search.tsx';
import { aboutSettingsTab } from './features/settings/about-machine.tsx';
import { agentClisSettingsTab } from './features/settings/agent-clis.tsx';
import { CgroupConfigSurface } from './features/settings/cgroup-settings.tsx';
import { ConnectionPreferenceSettings } from './features/settings/connection-preference-settings.tsx';
import { daemonDisplayName, distinctDaemonName } from './features/settings/daemon-settings.tsx';
import { dictationShortcutLabel } from './features/settings/dictation-shortcut.ts';
import { DoctorSettings } from './features/settings/doctor-settings.tsx';
import { useMachineUpdates } from './features/settings/machine-updates.ts';
import { NotificationFilterSettingsView } from './features/settings/notification-filter-settings.tsx';
import { MachineNotificationList, NotificationsOffBanner } from './features/settings/notification-machines.tsx';
import { NotificationSettingsView } from './features/settings/notification-settings.tsx';
import {
  PAIR_PHONE_DESCRIPTION,
  PairPhoneSheet,
  pairPhoneLabel,
  usePairPhoneAllowed,
} from './features/settings/pair-phone.tsx';
import { PasskeyNudge } from './features/settings/passkey-nudge.tsx';
import { performanceSettingsTab } from './features/settings/performance-settings.tsx';
import { pricingSettingsTab } from './features/settings/pricing-settings.tsx';
import { securityLogSettingsTab } from './features/settings/security-log-settings.tsx';
import { settingsPaletteEntries } from './features/settings/settings-catalog.ts';
import { SettingsPage } from './features/settings/settings-page.tsx';
import { ViewportOverlay } from './features/settings/viewport-details.tsx';
import { speedupsSettingsTab } from './features/speedups/speedups-surface.tsx';
import { StepUpDialog, UNLOCK_COPY } from './features/step-up/step-up-dialog.tsx';
import { useStuckMessageActions } from './features/stuck-messages/use-stuck-message-actions.tsx';
import { useAskWardenActions } from './features/warden/ask-warden.tsx';
import { WardenOverviewSurface } from './features/warden/warden-overview-surface.tsx';
import { useWhatsNewHost, WhatsNewProvider } from './features/whats-new/whats-new-host.tsx';
import { WhatsNewSheet } from './features/whats-new/whats-new-sheet.tsx';
import { useAccountPickerSlice } from './hooks/use-account-picker.ts';
import { useActiveCarrier, useDeviceRefused } from './hooks/use-active-carrier.ts';
import { useAppViewport } from './hooks/use-app-viewport.ts';
import { type BoardMachine, useBoard } from './hooks/use-board.ts';
import { useChatTasksUrl } from './hooks/use-chat-tasks-url.ts';
import { useAgendaSession, useAgendaSnapshot } from './hooks/use-agenda.ts';
import { agendaClearPort } from './lib/agenda-clear-agents.ts';
import { AgendaInboxContext, useAgendaInbox, useAgendaInboxModel, useInboxMachines } from './hooks/use-agenda-inbox.ts';
import { useAgendaReplies } from './hooks/use-agenda-replies.ts';
import { useCarrierPreferences, useTunnelService, useTunnelSwitches } from './hooks/use-carrier-preferences.ts';
import { useConfigChangeFeed } from './hooks/use-config-change-feed.ts';
import { useConnectionHealth } from './hooks/use-connection-health.ts';
import { useInputModality } from './hooks/use-input-modality.ts';
import { useInstallPrompt } from './hooks/use-install-prompt.ts';
import { useLayoutMode } from './hooks/use-layout-mode.ts';
import { useLiveClock } from './hooks/use-live-clock.ts';
import { useMachineNotifications } from './hooks/use-machine-notifications.ts';
import { useMachineOrder } from './hooks/use-machine-order.ts';
import { type ListedMachine, useMachineSources } from './hooks/use-machine-sources.ts';
import {
  browserFleetPollEnvironment,
  type MachineFleetFeedOpener,
  useMachinesPoll,
} from './hooks/use-machines-poll.ts';
import { useNeedsRuntime } from './hooks/use-needs-runtime.ts';
import { type NotificationOpenSource, useNotificationOpen } from './hooks/use-notification-open.ts';
import {
  type NotificationControlsHost,
  useNotificationControls,
  useNotificationFilterPreferences,
  useNotificationWatch,
} from './hooks/use-notifications.ts';
import { useKnownProjects, useProjects } from './hooks/use-projects.ts';
import { browserReleaseAsk, releaseContainer, useReleaseIntegrity } from './hooks/use-release-integrity.ts';
import { useSendView } from './hooks/use-send-view.ts';
import {
  canRegister,
  type ServiceWorkerUpdateEnvironment,
  useServiceWorkerUpdate,
  workerUrl,
} from './hooks/use-service-worker-update.ts';
import { useSttSettings } from './hooks/use-stt-settings.ts';
import { useTheme } from './hooks/use-theme.ts';
import { type MachineSource, machineDisplayOrder } from './lib/all-machines.ts';
import { AgendaWireProbes } from './lib/agenda-wire-react.tsx';
import { agendaTargetFromSearch } from './lib/agenda-inbox.ts';
import { NO_BOARD_FILTERS } from './lib/board-model.ts';
import { boardBadgeCount } from './lib/board-phone.ts';
import { inboxSourceFromSearch } from './lib/agenda-inbox-list.ts';
import { transcriptIsCurrent } from './lib/background-fresh.ts';
import { boardPorts } from './lib/board-ports.ts';
import { DEFAULT_CARRIER_PREFERENCE } from './lib/carrier-preference.ts';
import type { DaemonConnectionRecord } from './lib/connections.ts';
import { type DaemonConnection, type DaemonId, daemonCarriers } from './lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionKey, daemonSessionScope } from './lib/daemon-scope.ts';
import { browserFleetFeedEnvironment } from './lib/fleet-feed.ts';
import { projectKeyFor } from './lib/fleet-grouping.ts';
import { installBanner } from './lib/install-prompt.ts';
import { placeLedgerRows } from './lib/ledger-placement.ts';
import { createLiveActivityHub } from './lib/live-activity-feed.ts';
import { moveMachine } from './lib/machine-order.ts';
import type { NotificationCategory, QuietHours } from './lib/notification-filter.ts';
import type {
  NotificationPermissionState,
  NotificationRegistrationLike,
  NotificationSurface,
  PageNotificationLike,
} from './lib/notify.ts';
import { installPortraitLock } from './lib/orientation-lock.ts';
import {
  type BoardPageProps,
  type QueuePageProps,
  type DaemonPageProps,
  PageHost,
  type PageHostSlots,
  type ProjectDetailPageProps,
  type SessionChatPageProps,
} from './lib/pages/page-host.tsx';
import {
  connectionPickerPath,
  daemonAgendaPath,
  daemonQueuePath,
  daemonLearningPath,
  daemonProjectPath,
  daemonSessionsPath,
  daemonBoardForFerretPath,
  daemonSettingsPath,
  daemonWardenPath,
  type PageRoute,
  parseRoute,
  routePageKey,
  setupPath,
} from './lib/pages/routes.ts';
import { SessionChatPage } from './lib/pages/session-chat-page.tsx';
import { WardenPage } from './lib/pages/warden-page.tsx';
import { QueuePage } from './components/queue-page.tsx';
import { queueContribution } from './features/queue-view/queue-action.ts';
import { browserQrScanHost, type QrDetectorLike, type QrScanHost } from './lib/pair-scan.ts';
import { type PairingArrival, pairingArrival } from './lib/pairing.ts';
import { useRenderTiming } from './lib/performance/main-thread.ts';
import { exposePerformanceReport } from './lib/performance/report-text.ts';
import { clearForegroundPinScope, getForegroundPinScope, setForegroundPinScope } from './lib/pin-bridge.ts';
import {
  type ContainerPushEnrolment,
  containerPushEnrolment,
  moveOffSharedPush,
  type PairedPushMachine,
  type PushContainerLike,
  supportsWebPush,
} from './lib/push-enrolment.ts';
import { frameQrDetector } from './lib/qr-frame-decoder.ts';
import { readItemConversation } from './lib/item-conversation.ts';
import { RECENT_MESSAGE_COUNT, type RecentMessagesMemory, readRecentMessages } from './lib/recent-messages.ts';
import { isCarrierOutage } from './lib/relay-carrier.ts';
import { RELEASE_WORKER_RELEASE } from './lib/release-manifest.ts';
import { RouterProvider, useRouter } from './lib/router.tsx';
import { chatScrollSlot } from './lib/scroll-memory.ts';
import { type LedgerSendRecord, ledgerFeed, parseLedgerSendsResponse, readLedgerSends } from './lib/send-ledger.ts';
import { joinOutbox, joinQueue, queueActions, readSessionQueue } from './lib/send-queue.ts';
import { QueueActionsContext } from './components/queue-actions-context.tsx';
import type { CachedTranscript } from './lib/session-cache.ts';
import {
  type AppStore,
  createAppStore,
  StoreProvider,
  useAppStore,
  useConnectionSnapshot,
  useDaemonClient,
  useDaemonFetch,
  useLockedMachines,
} from './lib/store.tsx';
import type { SpeechAssets } from './lib/stt/on-device-voices.ts';
import { createSurfaceEventHub } from './lib/surface-control.ts';
import { tunnelNote } from './lib/tunnel-service.ts';
import {
  AppBar,
  AppTabBar,
  type AppTabBarProps,
  appBarDestinationForRoute,
  type Crumb,
  showsTabBar,
  UPDATE_CHIP,
  type UpdateReason,
} from './shell/app-bar.tsx';
import { AppUpdatedToast } from './shell/app-updated-toast.tsx';
import { ChunkErrorBoundary } from './shell/chunk-error-boundary.tsx';
import { CommandPalette, type PaletteSettingsSource } from './shell/command-palette.tsx';
import { InsightsFrame } from './shell/insights-frame.tsx';
import { PageScrollRegion } from './shell/page-scroll-region.tsx';
import {
  boardForFerretPaletteCommand,
  pairPhonePaletteCommand,
  whatsNewPaletteCommand,
} from './shell/palette-destinations.ts';
import { machinePaletteSessions, paletteSessionEntries } from './shell/palette-model.ts';
import { PullToPaletteRegion } from './shell/pull-to-palette-region.tsx';
import { ReleaseNoticeBanner } from './shell/release-notice.tsx';
import {
  SessionsBar,
  type SessionsBarPlace,
  type SessionsBarPresentation,
  type SessionsBarUpdate,
} from './shell/sessions-bar.tsx';
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

/** The reader's label for a paired daemon, which its push worker titles every notification with. */
/**
 * The name a machine's push worker titles its notifications with: the reader's OWN label, or else the
 * start of its verified daemon id. Never its address, which the machine chose itself in its pairing QR —
 * an unlabelled machine could otherwise pair as `https://work-mac.example` and title its alerts so.
 */
const pushLabelOf = (record: DaemonConnectionRecord | undefined, daemon: DaemonId): string =>
  record?.label?.trim() || `Machine ${String(daemon).slice(0, 12)}`;

export const pushMachineLabel = (records: readonly DaemonConnectionRecord[], daemon: DaemonId): string =>
  pushLabelOf(
    records.find(candidate => candidate.daemonId === daemon),
    daemon,
  );

/** Every paired daemon by its label, for the push reconcile. */
export const pairedPushMachines = (records: readonly DaemonConnectionRecord[]): readonly PairedPushMachine[] =>
  records.map(record => ({ daemonId: record.daemonId, label: pushLabelOf(record, record.daemonId) }));

/**
 * Web Push through ONE registration per paired daemon (`lib/push-scope.ts`): each of the signed worker
 * file, at that daemon's own scope, titled with the reader's label for it.
 */
export const browserPushEnrolment = (label: (daemon: DaemonId) => string): ContainerPushEnrolment | null => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  if (
    !supportsWebPush({
      secureContext: globalThis.isSecureContext === true,
      serviceWorker: 'serviceWorker' in navigator,
      pushManager: 'PushManager' in window,
    })
  )
    return null;
  return containerPushEnrolment({
    container: navigator.serviceWorker as unknown as PushContainerLike,
    origin: window.location.origin,
    workerUrl: workerUrl(RELEASE_WORKER_RELEASE),
    label,
    deviceName: 'Ferretry PWA',
  });
};

const NotificationControlsContext = createContext<NotificationControlsHost | null>(null);

const useNotificationControlsHost = (): NotificationControlsHost => {
  const host = useContext(NotificationControlsContext);
  if (host === null) throw new Error('notification controls require the app shell');
  return host;
};

/**
 * Every paired machine's notification state, read and switched through the one enrolment flow. The mute
 * folded into each row is this browser's local filter (`notification-filter.ts`).
 */
const usePairedMachineNotifications = (onChanged?: () => void) => {
  const store = useAppStore();
  const connectionSnapshot = useConnectionSnapshot();
  const filter = useNotificationFilterPreferences(store.notificationFilter);
  const sources = useMemo(
    () =>
      connectionSnapshot.connections.map(machine => ({
        connection: machine,
        label: distinctDaemonName(machine, connectionSnapshot.connections),
        muted: filter.machines[machine.daemonId] === false,
      })),
    [connectionSnapshot.connections, filter.machines],
  );
  const host = useNotificationControlsHost();
  const machines = useMachineNotifications(host, sources, onChanged === undefined ? {} : { onChanged });
  const toggleShown = useCallback(
    (daemonId: string, shown: boolean) => store.notificationFilter.set({ machines: { [daemonId]: shown } }),
    [store.notificationFilter],
  );
  return { ...machines, canEnrol: machines.permission === 'granted' || machines.permission === 'default', toggleShown };
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
    case 'project-lanes':
      return [
        { href: sessions, label: 'Sessions' },
        { href: `${sessions}/projects`, label: 'Projects' },
        { href: daemonProjectPath(route.daemonId, route.projectId), label: 'Project' },
        { label: 'Lanes' },
      ];
    case 'session':
      return [{ href: sessions, label: 'Sessions' }, { label: route.sessionId }];
    case 'attention':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Inbox' }];
    case 'board':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Board' }];
    case 'queue':
      return [{ href: sessions, label: 'Sessions' }, { label: 'Queue' }];
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
    case 'machine-setup':
      return [{ href: daemonSettingsPath(route.daemonId), label: 'Settings' }, { label: 'Set up a machine' }];
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
 * `getUserMedia` is ABSENT (not merely refused) outside a secure context, and a browser without it
 * gets no scan button at all rather than one that fails when pressed; the pairing screen shows its
 * paste field instead. `BarcodeDetector` is Chromium-only, so WebKit decodes frames in software.
 */
export const browserQrScan = (): QrScanHost | null => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  const native = (window as { BarcodeDetector?: new (options: { formats: string[] }) => QrDetectorLike })
    .BarcodeDetector;
  // WebKit has no BarcodeDetector. Giving it a software decoder (downloaded only when somebody taps
  // Scan) is what lets an iPhone reach getUserMedia at all — and so show its camera prompt.
  const detector: () => QrDetectorLike =
    native === undefined
      ? () =>
          frameQrDetector({
            createCanvas: () => document.createElement('canvas'),
            loadDecoder: async () => (await import('jsqr')).default,
          })
      : () => new native({ formats: ['qr_code'] });
  const host = browserQrScanHost({
    media: navigator.mediaDevices,
    detector,
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
      onPair={async (seed, deviceName) => {
        const connection = await store.pair(seed, deviceName);
        // A machine that is not set up opens its first run straight away; anything else, its sessions.
        navigate(
          await landingAfterPairing(store.connections.select(connection.daemonId), daemon =>
            store.clients.client(daemon),
          ),
        );
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
        // A machine that is not set up opens its first run instead of its sessions.
        if (selected !== null)
          void landingAfterPairing(store.connections.select(selected), daemon => store.clients.client(daemon)).then(
            navigate,
          );
      }}
      renderPairing={({ onPaired, onStatedFailure }) => (
        <PairingScreen
          embedded
          onStatedFailure={onStatedFailure}
          arrival={arrival}
          scanHost={scanHost}
          onArrivalTaken={takeArrival}
          connections={snapshot.connections}
          selectedDaemonId={selected}
          onPair={async (seed, deviceName) => {
            await store.pair(seed, deviceName);
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
  useRenderTiming(store.performance, 'fleet');
  const { navigate } = useRouter();
  const allMachines = useContext(AllMachinesContext);
  const { connections } = useConnectionSnapshot();
  const record = connections.find(candidate => candidate.daemonId === connection.daemonId);
  const readWardenStatus = useCallback(
    async (daemon: DaemonConnection) => await (await store.clients.client(daemon)).wardenStatus(),
    [store.clients],
  );
  return (
    <SessionsPage
      connection={connection}
      connectionHealth={store.connectionHealth}
      machineName={record === undefined ? daemonDisplayName(connection) : distinctDaemonName(record, connections)}
      fleet={store.fleet}
      controls={store.controls}
      projects={store.projects}
      usage={store.usage}
      accountPicker={store.accountPicker}
      wardenStatus={readWardenStatus}
      onOpenWardenReport={() => navigate(daemonWardenPath(connection.daemonId))}
      onNavigate={navigate}
      {...(allMachines === undefined
        ? {}
        : {
            machineSources: allMachines.sources,
            newSessionMachines: allMachines.machines,
            machineConnections: allMachines.connections,
          })}
    />
  );
}

/** The New session page's fragment while Continue is the open choice. */
const CONTINUE_HASH = '#continue';

/** A runtime's Launch names it as `?agent=`: a hint the Account box may honour, never a start. */
/** Where the service worker's messages arrive, or `null` in a browser with no worker. */
const notificationOpenSource = (): NotificationOpenSource | null =>
  typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? (navigator.serviceWorker as unknown as NotificationOpenSource)
    : null;

const launchHint = (search: string): { readonly initialAgent?: string } => {
  const agent = new URLSearchParams(search).get('agent');
  return agent === null || agent === '' ? {} : { initialAgent: agent };
};

function NewSessionRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const { navigate, back } = useRouter();
  // Continue is part of the address (`#continue`), replaced in place: Back to this page, or a reload, opens
  // the list the reader was scrolling rather than the empty form.
  const continuing = window.location.hash === CONTINUE_HASH;
  const chooseContinuing = useCallback(
    (next: boolean) =>
      navigate(`${window.location.pathname}${window.location.search}${next ? CONTINUE_HASH : ''}`, { replace: true }),
    [navigate],
  );
  const record = useConnectionSnapshot().connections.find(candidate => candidate.daemonId === connection.daemonId);
  // "Continue a conversation" reads and adopts through the same fleet client as Settings; one stable factory.
  const createFleetClient = useCallback<FleetClientFactory>(daemon => store.clients.client(daemon), [store.clients]);
  return (
    <NewSessionPage
      accounts={store.accountPicker}
      createFleetClient={createFleetClient}
      connection={connection}
      machineName={daemonDisplayName(record ?? connection)}
      fleet={store.fleet}
      projects={store.projects}
      startSession={async (daemon, request) => await (await store.clients.client(daemon)).start(request)}
      resumeSession={async (daemon, sessionId) => await (await store.clients.client(daemon)).resume(sessionId)}
      usage={store.usage}
      onNavigate={navigate}
      onBack={back}
      continuing={continuing}
      onContinuingChange={chooseContinuing}
      {...launchHint(window.location.search)}
    />
  );
}

/**
 * The phone's sessions drawer opener, for the one page that draws its own ☰: the session page's bar.
 * `null` wherever there is no drawer to open — every width but a phone.
 */
const SessionsDrawerContext = createContext<(() => void) | null>(null);

/**
 * Every paired machine, for the one session list across them (Settings › Behaviour › Sessions list: All
 * machines) — or `undefined`, when the list shows the machine on screen alone: the reader chose that,
 * or there is only one machine. Read once by the shell, which also keeps each machine's list fresh.
 */
interface AllMachinesList {
  readonly sources: readonly MachineSource[];
  readonly machines: readonly { readonly daemonId: DaemonId; readonly name: string }[];
  /** The same machines' pairings, in the same order: every per-machine read goes through its own. */
  readonly connections: readonly DaemonConnection[];
}

const AllMachinesContext = createContext<AllMachinesList | undefined>(undefined);

/** Nobody learns, until a machine says otherwise. */
const NO_LEARNERS: ReadonlySet<string> = new Set();

/** The sidebar's "last seen" clock: a minute is its smallest step, so a 30s tick is plenty. */
const MACHINE_CLOCK_MS = 30_000;

/** The sessions bar's reload offer, worded exactly as the app bar's chip always was. */
export const updateOffer = (reason: UpdateReason): SessionsBarUpdate => ({
  ...UPDATE_CHIP[reason],
  tone: reason === 'recovery' ? 'warn' : 'accent',
});

/** Which foot place of the sessions bar a route belongs to. */
export const sessionsBarPlace = (route: PageRoute): SessionsBarPlace | null => {
  switch (route.kind) {
    case 'projects':
    case 'project-detail':
    case 'project-lanes':
      return 'projects';
    case 'analytics':
    case 'warden':
    case 'learning':
      return 'insights';
    case 'settings':
      return 'settings';
    case 'attention':
      return 'attention';
    default:
      return null;
  }
};

/**
 * The sessions bar, wired to the app store: this machine's sessions kept fresh, its projects, every
 * paired machine for the switcher, and the reader's collapsed preference.
 */
function ShellSessionsBar({
  connection,
  route,
  presentation,
  onClose,
  onOpenPalette,
  search,
  updateReady,
  onApplyUpdate,
  onPairPhone,
}: {
  readonly connection: DaemonConnection;
  readonly route: PageRoute;
  readonly presentation: SessionsBarPresentation;
  readonly onClose: (() => void) | undefined;
  readonly onOpenPalette: () => void;
  readonly search: ReactNode;
  readonly updateReady: UpdateReason | null;
  readonly onApplyUpdate: () => void;
  /** Absent when this machine says the reader may not pair a device with it. */
  readonly onPairPhone: (() => void) | undefined;
}) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const rowMenuRenderer = useMemo(() => sessionRowMenuRenderer(navigate), [navigate]);
  const { connections } = useConnectionSnapshot();
  const allMachines = useContext(AllMachinesContext);
  const agendaInbox = useAgendaInbox();
  const now = useLiveClock({ intervalMs: MACHINE_CLOCK_MS });
  const fleet = useSyncExternalStore(
    listener => store.fleet.subscribe(listener),
    () => store.fleet.getSnapshot(),
  );
  const projects = useProjects(store.projects, connection);
  const clientFor = useDaemonClient();
  const needsRuntime = useNeedsRuntime(connection, clientFor);
  // Which ferrets are instructed to learn, for their "Learning: passive" chip — on EVERY machine the bar
  // lists, each read through its own pairing, so a learner on the second machine is marked too.
  const learnersOn = useMemo(() => allMachines?.connections ?? [connection], [allMachines, connection]);
  const daemonFetch = useDaemonFetch();
  const machineLearners = useMachinesPassiveLearning(learnersOn, daemonFetch);
  // The machine menu's update dot: each paired machine asked once, through the app's client pool.
  const updates = useMachineUpdates({
    connections,
    createClient: useDaemonClient(),
    locked: useLockedMachines(store.unlockGate),
  });
  const collapsed = useSyncExternalStore(store.controls.subscribe, () =>
    store.controls.controls(connection.daemonId),
  ).sidebarCollapsed;
  const machineOrder = useMachineOrder(store.controls);
  const { sessionsMode, density, groupNeedsYou } = useSyncExternalStore(store.controls.subscribe, () =>
    store.controls.snapshot(),
  ).device;
  const displayed = machineDisplayOrder(connections, machineOrder.saved);
  const record = connections.find(candidate => candidate.daemonId === connection.daemonId);
  // The desktop column, folded to its icon rail only when the reader folded it.
  const shape: SessionsBarPresentation = presentation === 'column' && collapsed ? 'rail' : presentation;
  const machineName = record === undefined ? daemonDisplayName(connection) : distinctDaemonName(record, connections);
  return (
    <SessionsBar
      active={sessionsBarPlace(route)}
      // The inbox counts every paired machine, whichever list the bar shows.
      agendaHref={daemonAgendaPath(connection.daemonId)}
      agendaTotal={agendaInbox?.total ?? 0}
      activeSessionId={route.kind === 'session' ? route.sessionId : null}
      daemonId={connection.daemonId}
      machineName={machineName}
      density={density}
      groupNeedsYou={groupNeedsYou}
      onDensityChange={next => store.controls.setDeviceControls({ density: next })}
      initialMode={sessionsMode}
      onModeChange={mode => store.controls.setDeviceControls({ sessionsMode: mode })}
      {...(needsRuntime
        ? { createRuntimeHref: `${daemonSettingsPath(connection.daemonId)}${machineHash(machineName, 'runtimes')}` }
        : {})}
      machines={displayed.map(candidate => ({
        daemonId: candidate.daemonId,
        name: distinctDaemonName(candidate, connections),
        updateAvailable: updates.has(candidate.daemonId),
      }))}
      {...(updateReady === null ? {} : { update: updateOffer(updateReady), onApplyUpdate })}
      onMoveMachine={(id, target, edge) =>
        machineOrder.commit(
          moveMachine(
            displayed.map(candidate => candidate.daemonId),
            id,
            target,
            edge,
          ),
        )
      }
      onAddMachine={() => navigate(connectionPickerPath())}
      {...(onPairPhone === undefined ? {} : { onPairPhone })}
      onNavigate={navigate}
      onOpenPalette={onOpenPalette}
      presentation={shape}
      renderSessionMenu={rowMenuRenderer}
      onRestartOutdated={request => restartFerrets(connection, daemonFetch, request)}
      learningPassive={machineLearners.get(connection.daemonId) ?? NO_LEARNERS}
      {...(allMachines === undefined ? {} : { machineLearners })}
      projects={projects}
      sessions={fleet.daemons.get(connection.daemonId)?.sessions ?? null}
      {...(allMachines === undefined ? {} : { machineSources: allMachines.sources, now })}
      {...(search === undefined ? {} : { search })}
      {...(onClose === undefined ? {} : { onClose })}
      {...(shape === 'column'
        ? { onCollapse: () => store.controls.setDeviceControls({ sidebarCollapsed: true }) }
        : {})}
      {...(presentation === 'column' && shape === 'rail'
        ? { onExpand: () => store.controls.setDeviceControls({ sidebarCollapsed: false }) }
        : {})}
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
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

const browserEventStreamEnvironment: SessionEventStreamEnvironment = {
  setTimeout: (callback, milliseconds) => globalThis.setTimeout(callback, milliseconds),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  random: () => Math.random(),
};

function SessionRoute({
  connection,
  scope,
  agendaOverride,
}: SessionChatPageProps & { readonly agendaOverride?: string | null }) {
  const store = useAppStore();
  // The router's fetch, recorded for the Performance report like every other daemon read.
  const daemonFetch = useDaemonFetch();
  useRenderTiming(store.performance, 'session');
  // What the chat's Tasks tab needs to open a card over the chat, the same two the Board page is given.
  const boardTasks = useMemo(
    () => ({ agenda: store.attention, ports: boardPorts(daemon => store.clients.client(daemon)) }),
    [store.attention, store.clients],
  );
  // Memoised on the router rather than rebuilt per render: the deck remounts when its dependencies
  // object changes identity, and a remount mid-session tears down a live shell. Every attach is a
  // stream session the router opens on whichever carrier reaches the daemon, so there is no measured
  // carrier to pass any more — the router walks one itself when nothing has measured it yet.
  const terminalDeck = useMemo(
    () =>
      browserTerminalDeckDependencies(
        daemonFetch,
        async (daemon, request) => await store.carrier.openStream(daemon, request),
        (daemon, listener) => store.connectionHealth.onRecovered(daemon.daemonId, listener),
      ),
    [daemonFetch, store.carrier, store.connectionHealth],
  );
  const { navigate, back, entryKey } = useRouter();
  const tasksView = useChatTasksUrl({ navigate, back }, window.location);
  const layout = useLayoutMode();
  const dictation = useSttSettings(store.stt);
  // Actions › Warden: offered only where this caller's grants open the Warden (read once per machine).
  const wardenActions = useAskWardenActions(connection);
  // The "This folder" rail reads through the app's own clients: the ONE agenda client, a fleet
  // client per machine, and the machine's display name for the MCP sign-in sheet.
  const sessionContext = useMemo(
    () => ({
      attention: store.attention,
      createFleetClient: async (daemon: DaemonConnection) => await store.clients.client(daemon),
      machineName: daemonDisplayName(connection),
    }),
    [store.attention, store.clients, connection],
  );
  const { daemonId, sessionId } = scope;
  // The session's Attention, read through the ONE daemon-scoped client the app
  // store owns — same carrier as every generated call, and invalidated with the
  // pairing rather than outliving it.
  const agendaStatus = useAgendaSession(store.attention, connection, scope);
  const agendaSnapshot = useAgendaSnapshot(store.attention, scope);
  const agendaReplies = useAgendaReplies(store.attention, connection, scope);
  const agenda = useMemo(
    () => ({ client: store.attention, snapshot: agendaSnapshot, status: agendaStatus }),
    [store.attention, agendaSnapshot, agendaStatus],
  );
  const subscribe = useCallback((listener: () => void) => store.fleet.subscribe(listener), [store.fleet]);
  const snapshot = useCallback(() => store.fleet.getSnapshot(), [store.fleet]);
  const fleet = useSyncExternalStore(subscribe, snapshot);
  const controls = useSyncExternalStore(store.controls.subscribe, () => store.controls.controls(daemonId));
  // THE mapping from the persisted device preference to the composer's rule,
  // written once. It is memoised on the two values rather than rebuilt on
  // every render because the composer rebuilds its providers from it, and a
  // fresh object each render would abort an open list on every keystroke.
  const composerSuggestions = useMemo(
    () => composerSuggestionSwitches(controls.suggestionKeys, controls.skillSuggestions),
    [controls.suggestionKeys, controls.skillSuggestions],
  );
  const fleetSlice = fleet.daemons.get(scope.daemonId);
  const session = fleetSlice?.byId.get(scope.sessionId);
  const openSessions = useContext(SessionsDrawerContext);
  const projects = useKnownProjects(store.projects, daemonId);
  // Learning's two Actions-menu entries, and the scan dialog and status line they open.
  const learningActions = useLearningSessionActions({
    connection,
    fetcher: useDaemonFetch(),
    sessions: fleetSlice?.sessions ?? null,
    projects,
    accounts: useAccountPickerSlice(store.accountPicker, connection).catalog?.accounts ?? null,
    onViewLearning: () => navigate(daemonLearningPath(daemonId)),
  });
  // Hypermedia's Actions-menu toggle, and the status line that says it takes effect at the next launch.
  const hypermediaActions = useHypermediaSessionActions({ connection, fetcher: useDaemonFetch() });
  // Pack mode's Actions-menu toggle, and its status line: also read at the next launch.
  const packActions = usePackSessionActions({ connection, fetcher: useDaemonFetch() });
  // Agenda mode's Actions-menu toggle: also read at the next launch.
  const agendaActions = useAgendaSessionActions({ connection, fetcher: useDaemonFetch() });
  /*
   * DRAWN FROM THIS DEVICE'S CACHE FIRST. Back into a chat, or a reload, used to open on an empty
   * transcript that refilled a round trip later; the last copy this device saw is drawn in the first
   * frame instead (`lib/session-cache.ts`), and `transcriptCached` says "Updating…" over it until the
   * first live read replaces it.
   */
  const [entries, setEntries] = useState<ReturnType<typeof transcriptEntriesFromLog>>(() =>
    transcriptEntriesFromLog(store.sessionCache.peekTranscript(scope)?.log ?? ''),
  );
  /** The session's send ledger — where each message the reader (or a teammate) sent actually went. */
  const [sends, setSends] = useState<readonly LedgerSendRecord[]>(() =>
    parseLedgerSendsResponse(store.sessionCache.peekTranscript(scope)?.sends ?? []),
  );
  /** The session's durable queue — the first ticks of a message, before the ledger has it (`lib/send-queue.ts`). */
  const [queue, setQueue] = useState<readonly QueuedMessage[]>([]);
  const [transcriptCached, setTranscriptCached] = useState(
    () => store.sessionCache.peekTranscript(scope) !== undefined,
  );
  /**
   * The drawn copy already holds everything the session's journal does (`lib/background-fresh.ts` kept
   * it so): switching here is instant and says nothing while the live read confirms it.
   */
  const [cacheCurrent, setCacheCurrent] = useState(() =>
    transcriptIsCurrent(store.sessionCache.peekTranscript(scope), store.fleet.session(scope)),
  );
  /** A background read of this very chat is still in flight: a tiny dot, not "Updating…". */
  const catchingUp = useSyncExternalStore(store.backgroundFresh.subscribe, () =>
    store.backgroundFresh.isCatchingUp(scope),
  );
  // Per session, not per history entry: coming back to a conversation by any route finds the reading position.
  const readingPosition = useMemo(
    () => chatScrollSlot(store.scrollMemory, daemonSessionKey(scope)),
    [scope, store.scrollMemory],
  );
  const [client, setClient] = useState<Awaited<ReturnType<typeof store.clients.client>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** The daemon can prove no transcript is this session's: Chat cannot fill and no send can be confirmed. */
  const [transcriptUnbound, setTranscriptUnbound] = useState(false);
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
  /** Where this session's journal stood when its view was read (`SessionView.journalSequence`), or 0. */
  const journalHead = useRef(0);
  journalHead.current = session?.journalSequence ?? 0;
  /**
   * The reported status AND THE OWNER THAT REPORTED IT, stored as one value because they are one
   * fact and storing them apart is what made them disagree.
   *
   * A BARE `streamStatus` WAS COMMITTED FOR THE WRONG OWNER, one render early. Deriving the chip from
   * "may a subscription exist right now" fixed the direction where the answer becomes NO, but not the
   * direction where it becomes YES again: on the render where a carrier walk succeeds after a
   * failure, the host facts already say `subscribed`, while the replacement model does not exist yet
   * — a passive effect creates it AFTER the commit. So React painted the PREVIOUS owner's `live` over
   * a session with no subscription behind it, and a stale `disconnected` painted a Reconnect button
   * whose callback had a null control. Measured, not theorised: the commit ledger was
   * `{subscribed: true, state: 'live', hasControl: false}` and only then `{'connecting', true}`.
   *
   * Pairing the status with its owner makes the stale read unrepresentable rather than unlikely: a
   * status is only ever shown to the owner that produced it, and any other owner — new, replaced, or
   * restored — reads `connecting` until its own model says otherwise.
   */
  const [reportedStream, setReportedStream] = useState<{
    readonly owner: object | null;
    readonly status: SessionEventStreamStatus;
  }>({ owner: null, status: 'connecting' });
  const streamControl = useRef<SessionEventStreamControl | null>(null);
  /**
   * The live feed's share for the session page: every event this route receives is handed on, so the
   * AGENT marker and Take over / Hand back move the moment the daemon journals a change — on the same
   * one subscription, never a second socket. A new hub per session: one session's events are never
   * another's.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session id is the hub's identity
  const surfaceEvents = useMemo(() => createSurfaceEventHub(), [daemonId, sessionId]);
  // The working turn's live readout rides the same socket (`?live=1`); one hub per session, like the above.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the session id is the hub's identity
  const liveActivity = useMemo(() => createLiveActivityHub(), [daemonId, sessionId]);
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
  /**
   * Whether the poll may slow down: the live feed is up and the agent is idle at its prompt, so every
   * change arrives as an event first. Written each render below, read by the poll on each tick.
   */
  const relaxedPoll = useRef(false);
  /**
   * HOW WELL THIS DAEMON IS REACHED, said once by the connection model rather than by this route.
   *
   * A LOST CARRIER IS NOT A SESSION ISSUE. It used to arrive here as each read's own failure, so one
   * dropped relay socket painted the whole walk's sentence — once for the transcript, once for the
   * session — over a workspace that was fine. Now an outage leaves the last good transcript, session
   * and client exactly where they are, the poll keeps running, and the first answer after it refreshes
   * at once; only an error the daemon actually returned is said here.
   */
  const connectionHealth = useConnectionHealth(store.connectionHealth, daemonId);
  /** Bumped when the daemon comes back after the CLIENT itself could not be opened, so it is opened again. */
  const [clientAttempt, setClientAttempt] = useState(0);
  useEffect(
    () =>
      store.connectionHealth.onRecovered(daemonId, () => {
        void refreshControl.current?.refresh(true);
        if (refreshControl.current === null) setClientAttempt(attempt => attempt + 1);
      }),
    [daemonId, store.connectionHealth],
  );
  /**
   * WHO a live subscription would belong to, as one identity — `null` when none may exist.
   *
   * NOT UNTIL A CARRIER HAS BEEN MEASURED, and that is a fix rather than a guard. A carrier is
   * decided by the first request that walks, so this route can render before any walk has finished —
   * and a subscription opened then takes the direct branch and opens a socket at an address a
   * relayed browser cannot reach. The model would retry that address until its budget ran out and
   * then tell the reader the daemon is offline, which makes waiting for the measurement MORE
   * necessary rather than less.
   *
   * THE IDENTITY IS THE CHOICE OBJECT, NOT ITS KIND. Keying on the kind alone would leave a stream
   * subscribed to a carrier the router has replaced whenever the replacement happens to be the same
   * kind — relay A for relay B. That is not reachable through today's router, which only ever
   * replaces a winner by way of `undefined`, but "not reachable today" is a fact about one call site
   * rather than about this route, and the object costs nothing to depend on.
   *
   * IT IS AN OBJECT SO THAT IDENTITY IS COMPARABLE. Memoised on exactly the three values a model is
   * built from, it is stable while they are and a NEW object the moment any of them changes — which
   * is what lets a render ask "is the status I am holding this owner's, or the previous one's?"
   * A boolean could not answer that, and answering it wrong is what committed a stale `Live`.
   */
  const streamOwner = useMemo(
    () => (client === null || measuredCarrier?.ok !== true ? null : { client, carrier: measuredCarrier, sessionId }),
    [client, measuredCarrier, sessionId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `clientAttempt` is a re-open trigger, read by nothing
  useEffect(() => {
    let current = true;
    let control: SessionWorkspaceRefreshControl | null = null;
    /** Whether a live read has answered under this effect: from then on the cache never draws again. */
    let live = false;
    const cacheScope = daemonSessionScope(connection, sessionId);
    const generation = store.sessionCache.generation(daemonId);
    const drawCached = (cached: CachedTranscript | null | undefined): void => {
      setEntries(cached == null ? [] : transcriptEntriesFromLog(cached.log));
      setSends(cached == null ? [] : parseLedgerSendsResponse(cached.sends));
      setQueue([]);
      setTranscriptCached(cached != null);
      setCacheCurrent(cached != null && transcriptIsCurrent(cached, store.fleet.session(cacheScope)));
    };
    store.sessionCache.markOpened(cacheScope);
    store.backgroundFresh.setOpen(cacheScope);
    setError(null);
    setTranscriptUnbound(false);
    const inMemory = store.sessionCache.peekTranscript(cacheScope);
    drawCached(inMemory);
    // Not in memory (a reload): the stored copy, unless the daemon has answered first.
    if (inMemory === undefined)
      void store.sessionCache.transcript(cacheScope).then(cached => {
        if (current && !live && cached !== null) drawCached(cached);
      });
    setClient(null);
    void store.clients
      .client(connection)
      .then(api => {
        if (!current) return;
        setClient(api);
        const agendaScope = daemonSessionScope(connection, sessionId);
        const ledger = ledgerFeed(setSends);
        control = startSessionWorkspaceRefresh({
          api: {
            // Attention shares the workspace's one visibility-aware refresh
            // owner. Its own status reports a failed board read, so a failure
            // here must not relabel a successful transcript as unreadable.
            logs: async id => {
              void store.attention.revalidate(connection, agendaScope).catch(() => undefined);
              return await api.logs(id);
            },
            get: async id => await store.fleet.fetchSession(connection, { daemonId, sessionId: id }),
            sends: async id => await readLedgerSends(api, id),
            queue: async id => await readSessionQueue(api, id),
          },
          sessionId,
          environment: browserWorkspaceRefreshEnvironment,
          onTranscript: next => {
            live = true;
            setTranscriptCached(false);
            setEntries(next);
          },
          onLog: log => store.sessionCache.saveTranscript(cacheScope, { log }, generation),
          onSends: rows => {
            store.sessionCache.saveTranscript(cacheScope, { sends: rows }, generation);
            ledger.onSends(parseLedgerSendsResponse(rows));
          },
          onSendsFailed: ledger.onSendsFailed,
          onQueue: setQueue,
          // fetchSession publishes the same proved view into the daemon-scoped
          // fleet cache; publishing it again here would force two shell renders.
          onSession: () => undefined,
          onError: setError,
          onTranscriptUnbound: setTranscriptUnbound,
          quiet: isCarrierOutage,
          relaxed: () => relaxedPoll.current,
        });
        refreshControl.current = control;
      })
      .catch(reason => {
        // An outage here is retried by the connection model, and its recovery bumps `clientAttempt`.
        if (current && !isCarrierOutage(reason)) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      current = false;
      store.backgroundFresh.setOpen(null);
      control?.stop();
      if (refreshControl.current === control) refreshControl.current = null;
    };
  }, [
    clientAttempt,
    connection,
    daemonId,
    sessionId,
    store.attention,
    store.backgroundFresh,
    store.clients,
    store.fleet,
    store.sessionCache,
  ]);

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
    if (streamOwner === null) return;
    // The gating rules live on `streamOwner` above, because they decide an IDENTITY and not just a
    // permission — see its comment for why a carrier must be measured first and why the dependency
    // is the choice object rather than its kind.
    // A FIRST subscription starts where the session's journal stood when its view was read, not at
    // the beginning: replaying a long session's whole history was hundreds of kilobytes over the relay
    // on every open, each replayed event asking for another full refresh, for nothing this route reads —
    // the transcript and the surfaces are read directly. An older daemon reports no position, which is
    // the old replay. The cursor takes the position as already accounted for, so a later resubscription
    // resumes from it rather than from a newer view's.
    if (liveCursorRef.current === 0) liveCursorRef.current = journalHead.current;
    const stream = startSessionEventStream({
      api: streamOwner.client,
      sessionId: streamOwner.sessionId,
      after: liveCursorRef.current,
      environment: browserEventStreamEnvironment,
      onRecovered: listener => store.connectionHealth.onRecovered(daemonId, listener),
      onEvent: event => {
        liveCursorRef.current = Math.max(liveCursorRef.current, event.sequence);
        setLiveCursor(current => Math.max(current, event.sequence));
        surfaceEvents.publish(event);
        refreshControl.current?.nudge();
      },
      onLive: live => liveActivity.publish(live),
      // A reply's text, a tool call, its result: none of them is a journal event, so without this each
      // reached the Chat only when the poll came round. The frame says the file moved; the read says what.
      onTranscript: () => refreshControl.current?.nudge(),
      // Stamped with the owner, so a report can never be read by a later one. The model publishes
      // nothing after `stop()`, and even if it did, a report from a replaced owner is discarded at
      // render rather than believed.
      onStatus: status => {
        // The page's pollers stand back while the feed is live, and pick their old pace up when it is not.
        surfaceEvents.setLive(status === 'live');
        setReportedStream({ owner: streamOwner, status });
      },
    });
    streamControl.current = stream;
    surfaceEvents.setLive(stream.status() === 'live');
    setReportedStream({ owner: streamOwner, status: stream.status() });
    return () => {
      surfaceEvents.setLive(false);
      stream.stop();
      if (streamControl.current === stream) streamControl.current = null;
    };
  }, [daemonId, liveActivity, store.connectionHealth, streamOwner, surfaceEvents]);

  /**
   * The transcript with the send ledger IN it: delivered sends chip the message they became, and every
   * send not yet in the conversation sits after it with a chip saying where it is.
   */
  const outboxAll = useSyncExternalStore(store.outbox.subscribe, store.outbox.snapshot);
  const outboxEntries = useMemo(
    () => outboxAll.filter(entry => entry.daemonId === daemonId && entry.sessionId === sessionId),
    [outboxAll, daemonId, sessionId],
  );
  const joinedSends = useMemo(() => joinOutbox(joinQueue(sends, queue), outboxEntries), [sends, queue, outboxEntries]);
  const sendView = useSendView(joinedSends);
  const { view: sendViewState, tick: settledTick, dismiss: dismissSends, setExpanded: expandSend } = sendView;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `settledTick` re-places the rows when one folds or retires on its own.
  const placedEntries = useMemo(
    () => placeLedgerRows(entries, joinedSends, Date.now(), sendViewState),
    [entries, joinedSends, sendViewState, settledTick],
  );
  /** A row's × — puts one undelivered send away on this device; the daemon's ledger is never told. */
  const dismissSend = useCallback<SendDismiss>(record => dismissSends([record.sendId]), [dismissSends]);
  const toggleSend = useCallback<SendExpand>((record, open) => expandSend(record.sendId, open), [expandSend]);
  /** A row's Retry, under the send's ORIGINAL id — see `sendRetrier`. */
  const retrySend = useMemo<SendRetry>(
    () => sendRetrier(client, sessionId, () => void refreshControl.current?.refresh(true)),
    [client, sessionId],
  );
  /** Asks for fresh evidence at once. Stable, so the menu entry built over it is not rebuilt for nothing. */
  const refreshSends = useCallback(() => void refreshControl.current?.refresh(true), []);
  /** A row's Cancel — takes the send back; the daemon says what that did on the agent's screen. */
  const cancelSend = useMemo<SendCancel>(
    () => sendCanceller(client, sessionId, refreshSends),
    [client, sessionId, refreshSends],
  );
  /** A row's Press Enter — for a message typed into the agent's composer and never submitted. */
  const submitSend = useMemo<SendSubmit>(
    () => sendSubmitter(client, sessionId, refreshSends),
    [client, sessionId, refreshSends],
  );
  /** Edit and Cancel for a message still in the queue; the bubble reaches them through a context, not props. */
  const queueActionsValue = useMemo(
    () => queueActions(client, sessionId, refreshSends, store.outbox),
    [client, sessionId, refreshSends, store.outbox],
  );
  // "Clear stuck messages" — Actions-menu entry that takes back every message nothing proved arrived.
  const stuckActions = useStuckMessageActions({
    client,
    sessionId,
    sends,
    refresh: refreshSends,
    view: sendViewState,
    dismiss: dismissSends,
  });
  const queueLink = useMemo(
    () => queueContribution(outboxEntries.length, () => navigate(daemonQueuePath(daemonId, sessionId))),
    [outboxEntries.length, navigate, daemonId, sessionId],
  );
  // Every feature's Actions-menu entries for this ferret: Warden, Learning, Hypermedia, Pack mode, then stuck messages.
  const sessionActions = useMemo(
    () => [
      ...wardenActions,
      ...learningActions.contributions,
      ...hypermediaActions.contributions,
      ...packActions.contributions,
      ...agendaActions.contributions,
      ...stuckActions.contributions,
      queueLink,
    ],
    [
      wardenActions,
      learningActions.contributions,
      hypermediaActions.contributions,
      packActions.contributions,
      agendaActions.contributions,
      stuckActions.contributions,
      queueLink,
    ],
  );
  /**
   * The reader's way back, and it is a REF rather than the control itself on purpose: a callback
   * that depended on the live stream object would change identity on every resubscription and
   * re-render the whole chat page with it.
   */
  const reconnectStream = useCallback(() => {
    streamControl.current?.reconnect();
  }, []);
  /**
   * WHAT THE CHIP READS — a status only its own owner may supply.
   *
   * TWO SEPARATE WAYS THIS ROUTE COULD LIE, and both are closed here. Deriving from the host facts
   * closes the direction where a subscription becomes IMPOSSIBLE: the client goes `null`, or a walk
   * finds the daemon unreachable, React runs the cleanup and the effect returns early without ever
   * publishing, and a remembered status went on saying `live` with nothing behind it.
   *
   * Comparing the OWNER closes the direction where it becomes possible again — the one a plain
   * derivation still got wrong. On the render where a carrier walk succeeds after a failure, the
   * host facts already say `subscribed`, but the replacement model does not exist yet; it is built by
   * a passive effect AFTER the commit. React therefore painted the previous owner's `live`, and a
   * previous `disconnected` painted a Reconnect button whose callback had a null control. Neither
   * survives an identity check: an owner that has not reported yet reads `connecting`, which is the
   * honest answer and also the one state that offers no control.
   */
  const subscribed = streamOwner !== null;
  const ownedStatus: SessionEventStreamStatus =
    streamOwner !== null && reportedStream.owner === streamOwner ? reportedStream.status : 'connecting';
  relaxedPoll.current = ownedStatus === 'live' && session !== undefined && changesOnlyByJournal(session.state);
  const liveStream = useMemo(
    () => ({
      status: liveStreamState(subscribed, measuredCarrier?.ok === false, ownedStatus),
      onReconnect: reconnectStream,
    }),
    [measuredCarrier, ownedStatus, reconnectStream, subscribed],
  );

  useEffect(() => {
    const foreground = { daemonId, sessionId };
    setForegroundPinScope(foreground);
    return () => clearForegroundPinScope(foreground);
  }, [daemonId, sessionId]);

  const sessionState: SessionState = session !== undefined ? 'connected' : error !== null ? 'failed' : 'opening';
  const sessionIssue = error === null ? null : `Session workspace issue: ${error}`;
  // The reader acted (a send among them): read now, and keep the poll at full rate while the turn it
  // starts is announced — a feed that died without a close must not leave the page on its relaxed poll.
  const refresh = useCallback(() => {
    refreshControl.current?.acted();
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
      data-connection={connectionHealth.kind}
    >
      {/* These live regions outlive every loading/error/content swap. */}
      <p className="sr-only" role="status" aria-live="polite" data-session-state={sessionState}>
        {SESSION_STATE_MESSAGE[sessionState]}
      </p>
      <p className="sr-only" role="alert" data-session-error="">
        {sessionIssue ?? ''}
      </p>
      {learningActions.host}
      {hypermediaActions.host}
      {packActions.host}
      {agendaActions.host}
      {session !== undefined && client !== null ? (
        <QueueActionsContext.Provider value={queueActionsValue}>
          <SessionChatPage
            accountPicker={store.accountPicker}
            board={store.board}
            boardTasks={boardTasks}
            tasksView={tasksView}
            actionContributions={sessionActions}
            infoLearning={learningActions.passiveFor(scope.sessionId)}
            switches={{
              hypermedia: hypermediaActions.onFor(session),
              pack: packActions.onFor(session),
              onToggle: switchTapper(
                { hypermedia: hypermediaActions, pack: packActions, agenda: agendaActions },
                session.config.id,
              ),
            }}
            browserLogin={store.browserLogin}
            attention={agenda}
            agendaReplies={agendaReplies}
            // A notification tap or an unread row names the item it opens at (`?attention=A3`).
            agendaTarget={
              agendaOverride !== undefined ? agendaOverride : agendaTargetFromSearch(window.location.search)
            }
            // Each navigation that names one re-targets it, so tapping the same item's notification again rings it again.
            agendaTargetKey={entryKey}
            chatWidth={controls.chatWidth}
            composerEnterKey={controls.composerEnterKey}
            composerPhoneEnterKey={controls.composerPhoneEnterKey}
            composerFetch={daemonFetch}
            composerSuggestions={composerSuggestions}
            composerVimMode={controls.composerVimMode}
            connectionState={connectionHealth}
            context={sessionContext}
            workspaceLayouts={store.workspaceLayouts}
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
            daemonSessions={fleetSlice?.sessions ?? undefined}
            entries={placedEntries}
            onRetry={retrySend}
            onCancel={cancelSend}
            onSubmit={submitSend}
            onDismiss={dismissSend}
            onExpand={toggleSend}
            onNavigate={navigate}
            {...(openSessions === null ? {} : { onOpenSessions: openSessions })}
            project={projectKeyFor(session.config.cwd, projects).name}
            onRefresh={refresh}
            onSessionChange={publishSession}
            presentation={layout === 'drawer' ? 'sheet' : 'pane'}
            pins={store.pins}
            refreshError={sessionIssue}
            transcriptUnbound={transcriptUnbound}
            updating={transcriptCached && !cacheCurrent && !catchingUp}
            catchingUp={transcriptCached && catchingUp}
            readingPosition={readingPosition}
            session={session}
            surfaceEvents={surfaceEvents}
            liveActivity={liveActivity}
            usage={store.usage}
          />
        </QueueActionsContext.Provider>
      ) : (
        <main className="mx-auto flex h-full w-full max-w-[980px] flex-col gap-3 overflow-y-auto py-3">
          <button type="button" className="kt-btn self-start" onClick={() => back(daemonSessionsPath(scope.daemonId))}>
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

/**
 * The Machines tabs (docs/design/account-model.md §4.2). ONE LINE PER TAB, each the shell's empty frame
 * until the unit that fills it replaces its own line: Runtimes and Credentials U17, Profiles and
 * Components U18, Settings U19.
 */
const MACHINE_TAB_SURFACES: MachineTabSurfaces = {
  runtimes: RuntimesTab,
  credentials: CredentialsTab,
  profiles: ProfilesTab,
  components: ComponentsSurface,
  browser: BrowserTab,
  machine: MachineSettingsSurface,
};

function SettingsRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const lockedMachines = useLockedMachines(store.unlockGate);
  const connectionSnapshot = useConnectionSnapshot();
  const { navigate } = useRouter();
  const dictation = useSttSettings(store.stt);
  const carrier = useActiveCarrier(store.carrier, connection.daemonId);
  const connectionHealth = useConnectionHealth(store.connectionHealth, connection.daemonId);
  /**
   * WHICH CARRIERS THIS DEVICE WALKS FOR EACH MACHINE (§15), offered twice from one value: beside the
   * active machine's Connection status, and for every machine under This device › Connection. Whether
   * "Tunnel only" could carry anything is the machine's own published set first, then the service.
   */
  const carrierPreferences = useCarrierPreferences(store.carrierPreferences);
  const tunnelService = useTunnelService(store.tunnelService);
  // Each machine's own word on its tunnel switch (§15): tunnels are opt-in, so a selector offers one.
  const tunnelSwitches = useTunnelSwitches(store.tunnelSwitch, connectionSnapshot.connections);
  const preferenceAvailability = useCallback(
    (daemon: DaemonConnection) => ({
      webrtc: store.webrtcAvailable,
      tunnelNote: tunnelNote(
        daemonCarriers(daemon).some(method => method.kind === 'tunnel'),
        tunnelService,
      ),
      tunnel: tunnelSwitchOffer(
        tunnelSwitches[daemon.daemonId],
        async () => await store.tunnelSwitch.set(daemon, true),
      ),
    }),
    [store.webrtcAvailable, store.tunnelSwitch, tunnelService, tunnelSwitches],
  );
  // One identity per machine, so the Connection panel's poll restarts only when the machine changes.
  const measureCarrierRtt = useCallback(
    async () => await store.webrtcRttMs(connection.daemonId),
    [store, connection.daemonId],
  );
  const carrierPreference = useMemo(
    () => ({
      value: carrierPreferences[connection.daemonId] ?? DEFAULT_CARRIER_PREFERENCE,
      onChange: (preference: Parameters<typeof store.carrierPreferences.set>[1]) =>
        store.carrierPreferences.set(connection.daemonId, preference),
      availability: preferenceAvailability(connection),
    }),
    [carrierPreferences, connection, preferenceAvailability, store.carrierPreferences],
  );
  const notifications = useNotificationControls(useNotificationControlsHost(), connection);
  const machineNotifications = usePairedMachineNotifications(notifications.refresh);
  const notificationFilter = useNotificationFilterPreferences(store.notificationFilter);
  const onNotificationCategoryChange = useCallback(
    (category: NotificationCategory, next: boolean) => {
      store.notificationFilter.set({ categories: { [category]: next } });
    },
    [store.notificationFilter],
  );
  const onNotificationQuietHoursChange = useCallback(
    (patch: Partial<QuietHours>) => {
      store.notificationFilter.set({ quietHours: patch });
    },
    [store.notificationFilter],
  );
  const probeDaemon = useCallback(
    async (daemon: DaemonConnection) => {
      const client = await store.clients.client(daemon);
      await client.request('/v1/health', HealthViewSchema, {}, 5_000);
    },
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
      // Diagnostics beside the doctor: what this machine and this app spend their time on.
      performanceSettingsTab(createDaemonClient, store.performance, store.carrierDrops),
      pricingSettingsTab(createDaemonClient),
      // Optional provider keys sit with the machine's other spend: pricing, then the keys that spend.
      speedupsSettingsTab(createDaemonClient),
      securityLogSettingsTab(createDaemonClient),
      configFilesSettingsTab(createDaemonClient),
      { ...LEARNING_SETTINGS_TAB, Surface: LearningSettingsTabSurface },
      // Sub-ferrets, who picks their model, and the routing prompt (docs/pack-mode.md).
      PACK_SETTINGS_TAB,
      // What this machine runs and getting it up to date (docs/updating.md).
      aboutSettingsTab(createDaemonClient),
      // The agent CLIs its ferrets run, whether Ferretry verified them, and updating them (docs/updating.md).
      agentClisSettingsTab(createDaemonClient),
    ],
    [createDaemonClient, store.clients, store.performance, store.carrierDrops],
  );
  // This device's copy of every machine's sessions and messages, and where each page was scrolled.
  const clearCachedData = useCallback(async (): Promise<void> => {
    await store.sessionCache.clearAll();
    store.scrollMemory.clear();
  }, [store.scrollMemory, store.sessionCache]);
  return (
    <SettingsPage
      daemonId={connection.daemonId}
      onClearCachedData={clearCachedData}
      connections={connectionSnapshot.connections}
      controls={store.controls}
      dictation={dictation}
      probeDaemon={probeDaemon}
      // Through the app's client pool, so a grant read travels the same carrier — direct first, relay
      // as the automatic fallback — as every other daemon call. The surface's own default would dial
      // the daemon address directly, which is how a screen ends up reporting a limit it could not read
      // on a daemon that is only reachable through the rendezvous.
      createGrantClient={createDaemonClient}
      daemonSettingsTabs={daemonSettingsTabs}
      // The same pool as every other daemon call, so a machine read rides the measured carrier.
      createMachineClient={createDaemonClient}
      createUpdateClient={createDaemonClient}
      lockedMachines={lockedMachines}
      machineTabs={MACHINE_TAB_SURFACES}
      onRenameDaemon={(daemonId, label) => {
        store.connections.rename(daemonId, label);
      }}
      onMachineNamed={(daemonId, name) => store.connections.learnDaemonName(daemonId, name)}
      onRemoveDaemon={daemonId => {
        const removedActiveDaemon = daemonId === connection.daemonId;
        store.connections.remove(daemonId);
        if (!removedActiveDaemon) return;
        const fallback = store.connections.getSnapshot().selectedDaemonId;
        navigate(fallback === null ? connectionPickerPath() : `${daemonSettingsPath(fallback)}#machines`);
      }}
      onAddDaemon={() => navigate(connectionPickerPath())}
      carrier={carrier}
      connectionHealth={connectionHealth}
      // Read through `daemonCarriers`, which is the set the router will actually dial. A pairing
      // whose fingerprint this protocol cannot address has its relays stripped before a single
      // attempt, so the cached set alone would advertise a fallback that can never be tried — and
      // would hide "there is no relay to fall back on" from the one reader it is written for.
      relayAdvertised={daemonCarriers(connection).some(method => method.kind === 'relay')}
      carrierPreference={carrierPreference}
      measureCarrierRtt={measureCarrierRtt}
      connectionPreferences={
        <ConnectionPreferenceSettings
          machines={connectionSnapshot.connections.map(machine => ({
            daemonId: machine.daemonId,
            label: distinctDaemonName(machine, connectionSnapshot.connections),
            preference: carrierPreferences[machine.daemonId] ?? DEFAULT_CARRIER_PREFERENCE,
            availability: preferenceAvailability(machine),
          }))}
          onChange={(daemonId, preference) => store.carrierPreferences.set(daemonId, preference)}
        />
      }
      notifications={
        <div className="flex flex-col gap-4">
          <NotificationsOffBanner
            rows={machineNotifications.rows}
            canEnrol={machineNotifications.canEnrol}
            busy={machineNotifications.busy}
            onEnable={machineNotifications.enable}
          />
          <NotificationSettingsView
            permission={notifications.permission}
            devices={notifications.devices}
            currentDeviceId={notifications.currentDeviceId}
            onRevokeDevice={notifications.revokeDevice}
          />
          <MachineNotificationList
            rows={machineNotifications.rows}
            canEnrol={machineNotifications.canEnrol}
            busy={machineNotifications.busy}
            failures={machineNotifications.failures}
            onEnable={machineNotifications.enable}
            onDisable={machineNotifications.disable}
            onTurnOnAll={machineNotifications.turnOnAll}
            onToggleShown={machineNotifications.toggleShown}
          />
          <NotificationFilterSettingsView
            preferences={notificationFilter}
            onCategoryChange={onNotificationCategoryChange}
            onQuietHoursChange={onNotificationQuietHoursChange}
          />
        </div>
      }
      onNavigate={navigate}
    />
  );
}

function WardenOverviewRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const fleet = useSyncExternalStore(
    listener => store.fleet.subscribe(listener),
    () => store.fleet.getSnapshot(),
  );
  return (
    <WardenOverviewSurface
      connection={connection}
      sessions={fleet.daemons.get(connection.daemonId)?.sessions ?? null}
      onNavigate={navigate}
    />
  );
}

const WARDEN_SLOTS = { Overview: WardenOverviewRoute } as const;

function WardenRoute({ connection }: DaemonPageProps) {
  const { navigate } = useRouter();
  return (
    <InsightsFrame current="warden" daemonId={connection.daemonId} onNavigate={navigate}>
      <WardenPage connection={connection} slots={WARDEN_SLOTS} />
    </InsightsFrame>
  );
}

/** Analytics reads every paired machine, in the order and by the names the sessions bar shows them. */
function AnalyticsRoute({ connection }: DaemonPageProps) {
  const { route, navigate } = useRouter();
  const store = useAppStore();
  const { connections } = useConnectionSnapshot();
  const savedOrder = useMachineOrder(store.controls).saved;
  const machines = useMemo(
    () =>
      machineDisplayOrder(connections, savedOrder).map(record => ({
        connection: record,
        name: distinctDaemonName(record, connections),
      })),
    [connections, savedOrder],
  );
  return (
    <InsightsFrame current="analytics" daemonId={connection.daemonId} onNavigate={navigate}>
      <GlobalAnalyticsPage
        connection={connection}
        machines={machines}
        view={route.kind === 'analytics' && route.view === 'query' ? 'query' : 'overview'}
        onNavigate={navigate}
      />
    </InsightsFrame>
  );
}

function LearningRoute({ connection }: DaemonPageProps) {
  const { navigate } = useRouter();
  const store = useAppStore();
  const fleet = useSyncExternalStore(
    listener => store.fleet.subscribe(listener),
    () => store.fleet.getSnapshot(),
  );
  const projects = useProjects(store.projects, connection);
  const accounts = useAccountPickerSlice(store.accountPicker, connection).catalog?.accounts ?? null;
  return (
    <InsightsFrame current="learning" daemonId={connection.daemonId} onNavigate={navigate}>
      <LearningPage
        connection={connection}
        sessions={fleet.daemons.get(connection.daemonId)?.sessions ?? null}
        projects={projects}
        accounts={accounts}
        onNavigate={navigate}
      />
    </InsightsFrame>
  );
}

/** Settings › Learning on one machine, its ferrets named from the fleet the app already reads. */
function LearningSettingsTabSurface({ connection }: { readonly connection: DaemonConnection }) {
  const store = useAppStore();
  const fleet = useSyncExternalStore(
    listener => store.fleet.subscribe(listener),
    () => store.fleet.getSnapshot(),
  );
  return (
    <LearningSettingsSurface
      connection={connection}
      sessions={fleet.daemons.get(connection.daemonId)?.sessions ?? null}
    />
  );
}

/**
 * The Inbox. Its cards come from EVERY paired machine (the shell's one inbox), so the
 * machine in the address only decides which machine's chrome surrounds it.
 */
function AgendaRoute({ connection }: DaemonPageProps) {
  const { navigate } = useRouter();
  const store = useAppStore();
  const inbox = useAgendaInbox();
  // Each conversation's walk to its last messages, kept while the page is open so a re-read is one page.
  const recentWalks = useRef<RecentMessagesMemory>(new Map()).current;
  const phone = useLayoutMode() === 'drawer';
  const machineNotifications = usePairedMachineNotifications();
  const daemonFetch = useDaemonFetch();
  const clientFor = useCallback((target: DaemonConnection) => store.clients.client(target), [store.clients]);
  const clearPort = useMemo(() => agendaClearPort(store.clients, daemonFetch), [store, daemonFetch]);
  return inbox === null ? null : (
    <AgendaInboxPage
      clearPort={clearPort}
      banner={
        <NotificationsOffBanner
          rows={machineNotifications.rows}
          canEnrol={machineNotifications.canEnrol}
          busy={machineNotifications.busy}
          onEnable={machineNotifications.enable}
        />
      }
      inbox={inbox}
      from={inboxSourceFromSearch(window.location.search)}
      onClearFrom={() => navigate(daemonAgendaPath(connection.daemonId))}
      onNavigate={navigate}
      phone={phone}
      // The open item's ferret's own composer: a reply goes to its chat, about the item.
      renderComposer={card => {
        const target = inbox.connectionFor(card.daemonId);
        if (target === undefined) return null;
        const controls = store.controls.controls(card.daemonId);
        return (
          <AgendaInboxComposer
            autocompleteFetcher={daemonFetch}
            clientFor={clientFor}
            compact={phone}
            connection={target}
            disabled={TERMINAL_STATUSES.has(card.view.state.status)}
            enterKeyPreference={controls.composerEnterKey}
            itemId={card.item.id}
            key={card.key}
            phoneEnterKeyPreference={controls.composerPhoneEnterKey}
            usage={store.usage}
            view={card.view}
          />
        );
      }}
      readConversation={async card => {
        const target = inbox.connectionFor(card.daemonId);
        if (target === undefined) throw new Error('That machine is no longer paired with this browser.');
        return await readItemConversation(await store.clients.client(target), card.view.config.id, card.item.id);
      }}
      readRecent={async card => {
        const target = inbox.connectionFor(card.daemonId);
        if (target === undefined) throw new Error('That machine is no longer paired with this browser.');
        const scope = daemonSessionScope(target, card.view.config.id);
        return await readRecentMessages(
          await store.clients.client(target),
          card.view.config.id,
          RECENT_MESSAGE_COUNT,
          recentWalks,
          daemonSessionKey(scope),
        );
      }}
    />
  );
}

/** Every ferret's callsign by session id, from the sessions every paired machine reports. */
function useFerretCallsigns(store: AppStore): ReadonlyMap<string, string> {
  const fleet = useSyncExternalStore(
    listener => store.fleet.subscribe(listener),
    () => store.fleet.getSnapshot(),
  );
  return useMemo(() => {
    const names = new Map<string, string>();
    for (const slice of fleet.daemons.values()) {
      for (const session of slice.sessions ?? []) {
        if (session.config.teammate !== undefined) names.set(session.config.id, session.config.teammate);
      }
    }
    return names;
  }, [fleet]);
}

/**
 * The Board across every paired machine. The query string carries the filters and the view, so a view is a
 * link; a change replaces the entry (the back button leaves the board, it does not walk every filter).
 */
function useBoardMachines(): readonly BoardMachine[] {
  const store = useAppStore();
  const { connections } = useConnectionSnapshot();
  const savedOrder = useMachineOrder(store.controls).saved;
  return useMemo(
    () =>
      machineDisplayOrder(connections, savedOrder).map(record => ({
        connection: record,
        name: distinctDaemonName(record, connections),
      })),
    [connections, savedOrder],
  );
}

/**
 * The phone's bottom bar with the Board tab's number on it. It shares the Board page's own unfiltered read
 * (the same store key), so the badge costs no request of its own; only this subtree renders when it moves.
 */
function PhoneTabBar(props: Omit<AppTabBarProps, 'boardCount'>) {
  const store = useAppStore();
  const machines = useBoardMachines();
  const { model } = useBoard(store.board, machines, NO_BOARD_FILTERS);
  return <AppTabBar {...props} boardCount={boardBadgeCount(model.counts)} />;
}

function QueueRoute({ connection, sessionId }: QueuePageProps) {
  return <QueuePage daemonId={connection.daemonId} {...(sessionId === undefined ? {} : { sessionId })} />;
}

function BoardRoute({ connection, taskId }: BoardPageProps) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const machines = useBoardMachines();
  const callsigns = useFerretCallsigns(store);
  const phone = useLayoutMode() === 'drawer';
  const origin = useBoardOrigin();
  const onSearch = useCallback(
    (search: string) => navigate(`${window.location.pathname}${search === '' ? '' : `?${search}`}`, { replace: true }),
    [navigate],
  );
  const ports = useMemo(() => boardPorts(daemon => store.clients.client(daemon)), [store.clients]);
  return (
    <BoardPage
      agenda={store.attention}
      callsigns={callsigns}
      phone={phone}
      machines={machines}
      onNavigate={navigate}
      onSearch={onSearch}
      openCard={taskId === undefined ? null : { daemonId: connection.daemonId, taskId }}
      ports={ports}
      origin={origin}
      search={window.location.search}
      store={store.board}
    />
  );
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

/** One machine's full-screen first run: no app chrome, only its own stepper. */
function MachineSetupRoute({ connection }: DaemonPageProps) {
  const store = useAppStore();
  // The Voice step's clean-up choice is THIS device's dictation setting, the same one Settings › Dictation edits.
  const dictation = useSttSettings(store.stt);
  const { connections } = useConnectionSnapshot();
  const { navigate } = useRouter();
  const record = connections.find(candidate => candidate.daemonId === connection.daemonId);
  const createClient = useCallback(
    async (daemon: DaemonConnection) => await store.clients.client(daemon),
    [store.clients],
  );
  // `/d/<id>/setup#claude` opens on that step: Settings' Import again lands on Claude Code.
  const [startAt] = useState(() => {
    const step = window.location.hash.replace(/^#/u, '');
    return isMachineSetupStepId(step) ? step : undefined;
  });
  if (record === undefined) return null;
  return (
    <MachineSetupScreen
      {...(startAt === undefined ? {} : { startAt })}
      connection={record}
      connections={connections}
      createClient={createClient}
      onNavigate={navigate}
      storage={browserSetupStorage()}
      voiceCleanup={dictation}
    />
  );
}

function ProjectsRoute({ connection }: DaemonPageProps) {
  return <ProjectsPage connection={connection} />;
}

function ProjectDetailRoute({ connection, projectId }: ProjectDetailPageProps) {
  return <ProjectDetailPage connection={connection} projectId={projectId} />;
}

function ProjectLanesRoute({ connection, projectId }: ProjectDetailPageProps) {
  const callsigns = useFerretCallsigns(useAppStore());
  return <LaneEditorPage callsigns={callsigns} connection={connection} projectId={projectId} />;
}

const PAGE_SLOTS: PageHostSlots = {
  ConnectionPicker,
  Setup: SetupGuide,
  Sessions: SessionsRoute,
  NewSession: NewSessionRoute,
  Projects: ProjectsRoute,
  ProjectDetail: ProjectDetailRoute,
  ProjectLanes: ProjectLanesRoute,
  SessionChat: SessionRoute,
  Settings: SettingsRoute,
  Warden: WardenRoute,
  Analytics: AnalyticsRoute,
  Learning: LearningRoute,
  Attention: AgendaRoute,
  Board: BoardRoute,
  Queue: QueueRoute,
  ImportedHistory: ImportedHistoryRoute,
  MachineSetup: MachineSetupRoute,
};

/**
 * A MACHINE THAT NO LONGER ACCEPTS THIS BROWSER GETS ONE SENTENCE, NOT ONE ERROR PER PANEL.
 *
 * The router learns the refusal from the first request the daemon refuses and stops dialling; this
 * swaps the page for the notice that says so and offers the repair. A re-pair replaces the pairing,
 * the router forgets the refusal with it, and the page comes back.
 */
function DeviceRefusedGate({
  connection,
  children,
}: {
  readonly connection: DaemonConnectionRecord;
  readonly children: ReactNode;
}) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const refused = useDeviceRefused(store.carrier, connection.daemonId);
  if (!refused) return children;
  return (
    <DeviceRefusedNotice
      machineName={daemonDisplayName(connection)}
      onPairAgain={() => {
        startOnboardingPairing(detectDeviceKind(navigator));
        navigate(setupPath());
      }}
    />
  );
}

/** The mounted shell; exported so render tests can inject the router and store providers. */
export function AppShell() {
  const layout = useLayoutMode();
  const install = useInstallPrompt();
  const installDue = layout === 'drawer' && install !== null && installBanner(install.snapshot) !== null;
  useAppViewport();
  const store = useAppStore();
  const connectionSnapshot = useConnectionSnapshot();
  const { route, navigate, entryKey } = useRouter();
  const pageRoute: PageRoute =
    route.kind === 'legacy-tasks-redirect' || route.kind === 'legacy-attention-redirect' ? route.to : route;
  const connection =
    pageRoute.kind === 'connection-picker' || pageRoute.kind === 'setup'
      ? undefined
      : connectionSnapshot.connections.find(candidate => candidate.daemonId === pageRoute.daemonId);
  // The machine on screen tells this browser when its configuration moves, so no screen showing it
  // needs a reload to see a change made anywhere else. See `useConfigChangeFeed`.
  useConfigChangeFeed(store, connection);
  // A notification tap routes here in the app instead of the worker reloading the window.
  useNotificationOpen(notificationOpenSource(), window.location.origin, navigate);
  /*
   * ONE SESSION LIST ACROSS EVERY MACHINE, unless the reader chose the machine on screen alone. Each
   * machine's list is read through its own pairing — its own device key — at a slower beat for the
   * machines not on screen, and not at all while the app is hidden (`useMachinesPoll`). Only the
   * session lists: transcripts, terminals and browsers stay with the one session that is open.
   */
  const layoutPhone = layout === 'drawer';
  const sessionsList = useSyncExternalStore(store.controls.subscribe, () => store.controls.snapshot()).device
    .sessionsList;
  const savedMachineOrder = useMachineOrder(store.controls).saved;
  const everyMachine = sessionsList === 'all' && connectionSnapshot.connections.length > 1 && connection !== undefined;
  /*
   * EVERY PAIRED MACHINE IS READ, whichever list the reader chose: Attention is counted across all of
   * them (the Agenda tab, the sidebar's entry, the inbox), and an ask on a machine that is not on
   * screen must still reach the badge. Each list is one cheap read on its own feed or slow beat — the
   * Sessions list setting decides what the LIST shows, not what this browser is willing to hear about.
   */
  const everyPairedMachine = useMemo<readonly ListedMachine[]>(
    () =>
      connection === undefined
        ? []
        : machineDisplayOrder(connectionSnapshot.connections, savedMachineOrder).map(record => ({
            connection: record,
            name: distinctDaemonName(record, connectionSnapshot.connections),
          })),
    [connection, connectionSnapshot.connections, savedMachineOrder],
  );
  const listedMachines = useMemo<readonly ListedMachine[]>(
    () => (everyMachine ? everyPairedMachine : []),
    [everyMachine, everyPairedMachine],
  );
  const polled = useMemo<readonly DaemonConnection[]>(
    () =>
      connection === undefined || pageRoute.kind === 'machine-setup'
        ? []
        : everyPairedMachine.length > 1
          ? everyPairedMachine.map(machine => machine.connection)
          : [connection],
    [connection, everyPairedMachine, pageRoute.kind],
  );
  // Each machine's fleet feed, with no replay: the list is read when it says something moved.
  const openFleetFeed = useCallback<MachineFleetFeedOpener>(
    async (machine, onEvent, onIdle, signal) =>
      await (await store.clients.client(machine)).fleetEvents(0, onEvent, signal, idle => onIdle(idle.idleSeconds)),
    [store.clients],
  );
  useMachinesPoll(
    store.fleet,
    polled,
    connection?.daemonId ?? null,
    layoutPhone,
    browserFleetPollEnvironment,
    openFleetFeed,
    browserFleetFeedEnvironment,
    useCallback((daemonId, event) => store.board.noteEvent(daemonId, event), [store.board]),
  );
  const lockedMachines = useLockedMachines(store.unlockGate);
  const agendaInbox = useAgendaInboxModel(store.attention, useInboxMachines(store.fleet, everyPairedMachine));
  const machineSources = useMachineSources(store, listedMachines, lockedMachines);
  const allMachines = useMemo<AllMachinesList | undefined>(
    () =>
      everyMachine
        ? {
            sources: machineSources,
            machines: listedMachines.map(machine => ({ daemonId: machine.connection.daemonId, name: machine.name })),
            connections: listedMachines.map(machine => machine.connection),
          }
        : undefined,
    [everyMachine, listedMachines, machineSources],
  );
  /*
   * A PASSKEY PROMPT COMES FROM THE MACHINE ON SCREEN: the one the route names, or — on setup and the
   * picker, which name none — the one just paired or chosen. Every other machine's background reads wait
   * for it, and the machine list shows them locked, rather than raising a prompt over this machine's page.
   */
  const onScreen =
    pageRoute.kind === 'connection-picker' || pageRoute.kind === 'setup'
      ? connectionSnapshot.selectedDaemonId
      : pageRoute.daemonId;
  useEffect(() => {
    store.stepUp.focus(onScreen);
    store.unlockGate.focus(onScreen);
  }, [onScreen, store]);
  /*
   * THE MACHINE ON SCREEN IS THE SELECTED ONE. Opening a row on another machine — from the sessions bar,
   * the finder, a notification or a link — makes that machine this browser's choice, so the next visit to
   * `/` lands on it and nothing that falls back to "the selected machine" still means the one before.
   */
  const routedDaemonId = connection?.daemonId;
  useEffect(() => {
    if (routedDaemonId !== undefined && store.connections.get(routedDaemonId) !== undefined)
      store.connections.select(routedDaemonId);
  }, [routedDaemonId, store]);
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
    // A notification tap the app was started for (`useNotificationOpen`, whose effect runs first) has
    // already moved it off the picker: that is where the reader asked to go, and it wins.
    if (parseRoute(window.location.pathname).kind !== 'connection-picker') return;
    navigate(daemonSessionsPath(shortcut), { replace: true });
  }, [navigate, shortcut]);
  const effectiveRoute: PageRoute = pageRoute.kind === 'connection-picker' && setupJourney ? SETUP_ROUTE : pageRoute;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    installPortraitLockOnce();
  }, []);

  /*
   * THE SERVICE WORKER IS THE RELEASE CHECKER (`src/worker/service-worker.ts`,
   * `docs/pwa-release-signing.md`). It is registered wherever a browser allows one, and the page
   * then only ever ASKS it things: `useReleaseIntegrity` hears whether an update was installed or
   * refused, and audits any new worker the browser starts installing.
   */
  const workerContainer = useMemo(
    () =>
      canRegister(typeof navigator === 'undefined' ? undefined : navigator, globalThis.isSecureContext)
        ? (navigator.serviceWorker as unknown as ServiceWorkerUpdateEnvironment['container'])
        : null,
    [],
  );
  const workerEnvironment = useMemo(
    () => ({
      release: RELEASE_WORKER_RELEASE,
      container: workerContainer,
      doc: document,
      win: window,
      reload: () => window.location.reload(),
      onError: () => undefined,
    }),
    [workerContainer],
  );
  const { updateReady, applyUpdate, raiseRecovery, clearRecovery, raiseUpdate } =
    useServiceWorkerUpdate(workerEnvironment);
  const releaseEnvironment = useMemo(() => {
    const container = releaseContainer({
      navigator: workerContainer === null ? undefined : navigator,
      secure: globalThis.isSecureContext,
      MessageChannel: globalThis.MessageChannel,
    });
    return {
      container,
      doc: document,
      ask: browserReleaseAsk(globalThis.MessageChannel),
      onUpdateReady: raiseUpdate,
    };
  }, [raiseUpdate, workerContainer]);
  const release = useReleaseIntegrity(releaseEnvironment);

  const notificationSurface = useMemo(() => browserNotificationSurface(navigate, setPermission), [navigate]);
  // The label is read at enrolment time, so a push worker is always titled with the reader's CURRENT
  // name for its machine; the reconcile below re-labels the ones already registered and drops the
  // workers of machines this browser no longer pairs with.
  const pushEnrolment = useMemo(
    () => browserPushEnrolment(daemon => pushMachineLabel(store.connections.list(), daemon)),
    [store.connections],
  );
  const pairedMachines = pairedPushMachines(connectionSnapshot.connections);
  const pairedKey = pairedMachines.map(machine => `${machine.daemonId}\u0000${machine.label}`).join('\u0001');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the joined ids and labels are the deliberate trigger
  useEffect(() => {
    if (pushEnrolment === null) return;
    // Then off the old shared subscription, for every paired machine at once: at app start, not when
    // somebody happens to open each machine's notification settings (docs/cross-daemon.md §4b).
    const contexts = store.connections.list().map(connection => ({
      connection,
      service: store.pushService,
      devices: store.pushDevices,
      preferences: store.notificationPreferences,
      enrolment: pushEnrolment,
    }));
    void pushEnrolment.reconcile(pairedPushMachines(store.connections.list())).then(() => moveOffSharedPush(contexts));
  }, [
    pushEnrolment,
    pairedKey,
    store.connections,
    store.notificationPreferences,
    store.pushDevices,
    store.pushService,
  ]);
  const notificationControlsHost = useMemo<NotificationControlsHost>(
    () => ({
      preferences: store.notificationPreferences,
      surface: notificationSurface,
      service: store.pushService,
      devices: store.pushDevices,
      enrolment: pushEnrolment,
    }),
    [notificationSurface, pushEnrolment, store.notificationPreferences, store.pushDevices, store.pushService],
  );
  const notificationWatchHost = useMemo(
    () => ({
      sessions: {
        subscribe: (listener: () => void) => store.fleet.subscribe(listener),
        snapshot: () => store.fleet.getSnapshot(),
      },
      preferences: store.notificationPreferences,
      filter: store.notificationFilter,
      surface: notificationSurface,
      hidden: () => document.hidden,
      foregroundSession: getForegroundPinScope,
      now: Date.now,
    }),
    [notificationSurface, store.fleet, store.notificationPreferences, store.notificationFilter],
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
  /** The phone's sessions drawer, behind the session bar's ☰ and the top bar's opener. */
  const [sessionsDrawer, setSessionsDrawer] = useState(false);
  const openSessionsDrawer = useCallback(() => setSessionsDrawer(true), []);
  const closeSessionsDrawer = useCallback(() => setSessionsDrawer(false), []);
  /*
   * "PAIR A PHONE WITH ‹THIS MACHINE›", from the machine switcher or the finder: the Add-a-device
   * surface in a sheet over whatever page is open. Offered only when this machine says the reader may
   * pair a device with it, and held per machine, so switching machines can never leave one open over
   * another machine's page.
   */
  const pairPhoneAllowed = usePairPhoneAllowed(connection);
  const [pairPhoneFor, setPairPhoneFor] = useState<string | null>(null);
  const pairPhoneDaemon = connection?.daemonId;
  const openPairPhone = useCallback(() => setPairPhoneFor(pairPhoneDaemon ?? null), [pairPhoneDaemon]);
  const closePairPhone = useCallback(() => setPairPhoneFor(null), []);
  /* "WHAT'S NEW": one host for the sheet, opened from Settings › About and from the finder. */
  const whatsNew = useWhatsNewHost();
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
  const sidebarCollapsed = useSyncExternalStore(store.controls.subscribe, () => store.controls.snapshot()).device
    .sidebarCollapsed;
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
  /**
   * WHERE THIS SESSION'S SEARCH IS MOUNTED: in the sessions bar's full column, on a session page. A rail
   * and a phone have no room for it.
   */
  const barSessionSearch = currentSessionScope !== null && layout !== 'drawer' && !sidebarCollapsed;
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

  // The last chat the reader stood in, so the Board opens on that ferret's cards.
  const [boardOrigin, setBoardOrigin] = useState<DaemonSessionScope | null>(null);
  useEffect(() => {
    if (currentSessionScope !== null) setBoardOrigin(currentSessionScope);
  }, [currentSessionScope]);

  /**
   * Cmd/Ctrl+K OPENS THE GLOBAL FINDER, ON EVERY PAGE, FROM ANY FOCUS.
   *
   * It was once split by context — the finder off a session route, the session's own file search on
   * one — and it yielded to inputs and to a terminal, so the same chord opened different things (or
   * nothing) depending on where focus happened to be. One chord, one meaning now. The listener is a
   * capture-phase window listener so the composer, a terminal's keyboard capture and a remote
   * browser's cannot eat it. The only exception is an open modal dialog, which owns its keyboard
   * interaction and must not be escaped through by a global listener.
   *
   * COST, deliberately accepted: inside a terminal Ctrl+K is no longer readline's kill-to-end-of-line;
   * the finder wins. The finder itself and the in-session file search are one click away from the
   * app bar and the sessions bar.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'k' && event.key !== 'K') return;
      if (event.shiftKey || event.altKey || (!event.metaKey && !event.ctrlKey)) return;
      if (isModalShortcutTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      openPalette();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [openPalette]);

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
  } else if (pageRoute.kind === 'machine-setup') {
    // A ONE-TIME GUIDED JOB, so it gets the whole screen: no app bar, no bottom bar, no sidebar — only the
    // setup's own named stepper, with its way out ("Finish later") inside it.
    content = (
      <div className="kt-shell flex flex-col overflow-hidden">
        <DeviceRefusedGate connection={connection}>
          <ChunkErrorBoundary
            onChunkError={raiseRecovery}
            onRecovered={clearRecovery}
            onReload={applyUpdate}
            resetKey={pageKey}
          >
            <PageHost key={pageKey} route={pageRoute} connection={connection} slots={PAGE_SLOTS} />
          </ChunkErrorBoundary>
        </DeviceRefusedGate>
      </div>
    );
  } else {
    const sessions = fleet.daemons.get(connection.daemonId)?.sessions ?? [];
    const phone = layout === 'drawer';
    // Find searches every reachable machine when the list shows them all; a machine that is down is named,
    // never allowed to empty the rest. One machine at a time, it is that machine's own fleet.
    const paletteSearch =
      allMachines === undefined
        ? { sessions: paletteSessionEntries(sessions), note: null }
        : machinePaletteSessions(allMachines.sources);
    // Cmd-K "Board for <ferret>": only on a chat, where there is a ferret to narrow the Board to.
    const chatFerret =
      pageRoute.kind === 'session'
        ? paletteSearch.sessions.find(entry => entry.view.config.id === pageRoute.sessionId)
        : undefined;
    const boardForFerret =
      pageRoute.kind !== 'session'
        ? null
        : boardForFerretPaletteCommand(chatFerret?.headline ?? pageRoute.sessionId, KanbanSquare, () =>
            navigate(
              daemonBoardForFerretPath(connection.daemonId, pageRoute.sessionId, chatFerret?.view.config.focusTask?.id),
            ),
          );
    // Every paired machine, so one that is down is counted whichever machine's page is open.
    const noticeMachines = machineDisplayOrder(connectionSnapshot.connections, savedMachineOrder).map(record => ({
      daemonId: record.daemonId,
      name: distinctDaemonName(record, connectionSnapshot.connections),
    }));
    const machineName = distinctDaemonName(connection, connectionSnapshot.connections);
    const sessionsBar = (presentation: SessionsBarPresentation, onClose?: () => void) => (
      <ShellSessionsBar
        connection={connection}
        onClose={onClose}
        onOpenPalette={openPalette}
        presentation={presentation}
        route={pageRoute}
        // On a session page the bar's box is that session's own file search; everywhere else it opens the finder.
        // Cmd/Ctrl+K is the finder on both.
        search={barSessionSearch ? <SessionSearchControl /> : undefined}
        updateReady={updateReady}
        onApplyUpdate={applyUpdate}
        onPairPhone={pairPhoneAllowed ? openPairPhone : undefined}
      />
    );
    content = (
      <SessionSearchProvider board={store.board} connection={connection} scope={currentSessionScope}>
        <BoardOriginProvider value={boardOrigin}>
          <WhatsNewProvider value={whatsNew.entry}>
            <RestartOverlayProvider>
              <SessionsDrawerContext.Provider value={phone ? openSessionsDrawer : null}>
                <div className={`kt-shell flex overflow-hidden ${phone ? 'flex-col' : 'flex-row'}`}>
                  {/* EXPANDED BY DEFAULT at every width above a phone: the column folds to its icon rail only
                when the reader folds it (remembered per device), never because the window is narrow. */}
                  {phone ? null : sessionsBar('column')}
                  <div data-shell-main="" className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {/* A phone keeps its top bar off the session page only: there the session's own bar
                  carries ☰, and every other page still needs a way to the drawer and the finder. */}
                    {phone && pageRoute.kind !== 'session' ? (
                      <AppBar
                        crumbs={pageCrumbs(pageRoute)}
                        daemon={connection.daemonId}
                        onOpenPalette={openPalette}
                        onOpenSidebar={openSessionsDrawer}
                        sessionCount={sessions.length}
                        updateReady={updateReady}
                        onApplyUpdate={applyUpdate}
                        active={appBarDestinationForRoute(pageRoute)}
                        onNavigate={navigate}
                        tabBarShown={showsTabBar(pageRoute)}
                        agendaCount={agendaInbox.total}
                        themeToggle={<ThemeToggle touch />}
                      />
                    ) : null}
                    <ConnectionHealthNotice health={store.connectionHealth} machines={noticeMachines} />
                    <NewDeviceNotices connections={connectionSnapshot.connections} clients={store.clients} />
                    {pageRoute.kind === 'settings' ? null : (
                      <PasskeyNudge
                        key={String(connection.daemonId)}
                        connection={connection}
                        onOpenSecurity={() => navigate(`${daemonSettingsPath(connection.daemonId)}#security`)}
                      />
                    )}
                    {/*
                The finder's touch affordance wraps the page area rather than one
                page: a phone has no Cmd/Ctrl+K. The region is passive and
                discovers the touched page scroller, so ordinary scrolling stays
                browser-owned and a transcript — where the same movement loads history
                — can explicitly decline it.
              */}
                    <PullToPaletteRegion
                      className={`relative min-h-0 min-w-0 flex-1 px-1 sm:px-3${phone && showsTabBar(pageRoute) ? ' overflow-clip' : ''}`}
                      enabled={touchAffected}
                      onOpen={openPalette}
                    >
                      <DeviceRefusedGate connection={connection}>
                        <ChunkErrorBoundary
                          onChunkError={raiseRecovery}
                          onRecovered={clearRecovery}
                          onReload={applyUpdate}
                          resetKey={pageKey}
                        >
                          <PageScrollRegion entryKey={entryKey} memory={store.scrollMemory}>
                            <PageHost key={pageKey} route={pageRoute} connection={connection} slots={PAGE_SLOTS} />
                          </PageScrollRegion>
                        </ChunkErrorBoundary>
                      </DeviceRefusedGate>
                    </PullToPaletteRegion>
                    {/* The phone's level one sits under the page, above the home indicator. */}
                    {phone && showsTabBar(pageRoute) ? (
                      <PhoneTabBar
                        daemon={connection.daemonId}
                        agendaCount={agendaInbox.total}
                        active={appBarDestinationForRoute(pageRoute)}
                        onNavigate={navigate}
                        onOpenPalette={openPalette}
                      />
                    ) : null}
                  </div>
                  {phone && sessionsDrawer ? sessionsBar('drawer', closeSessionsDrawer) : null}
                  <CommandPalette
                    open={palette.open}
                    focusSignal={palette.focusSignal}
                    onClose={closePalette}
                    daemon={connection.daemonId}
                    sessions={paletteSearch.sessions}
                    sessionsNote={paletteSearch.note}
                    onNavigate={navigate}
                    settings={paletteSettings}
                    touchAffected={touchAffected}
                    commands={[
                      ...(pairPhoneAllowed
                        ? [
                            pairPhonePaletteCommand(
                              pairPhoneLabel(machineName),
                              PAIR_PHONE_DESCRIPTION,
                              QrCode,
                              openPairPhone,
                            ),
                          ]
                        : []),
                      whatsNewPaletteCommand(Sparkles, whatsNew.entry.open),
                      ...(boardForFerret === null ? [] : [boardForFerret]),
                    ]}
                  />
                  {/* After the finder, so the finder hands focus back to its opener before this captures it. */}
                  <PairPhoneSheet
                    connection={connection}
                    machineName={machineName}
                    onClose={closePairPhone}
                    open={pairPhoneAllowed && pairPhoneFor === connection.daemonId}
                    presentation={phone ? 'sheet' : 'dialog'}
                  />
                  <WhatsNewSheet
                    fresh={whatsNew.fresh}
                    onClose={whatsNew.close}
                    open={whatsNew.open}
                    presentation={phone ? 'sheet' : 'dialog'}
                    releases={whatsNew.releases}
                  />
                </div>
              </SessionsDrawerContext.Provider>
            </RestartOverlayProvider>
          </WhatsNewProvider>
        </BoardOriginProvider>
      </SessionSearchProvider>
    );
  }

  const promptMachineName = (daemonId: string): string => {
    const record = connectionSnapshot.connections.find(candidate => candidate.daemonId === daemonId);
    return record === undefined ? 'This machine' : distinctDaemonName(record, connectionSnapshot.connections);
  };

  return (
    <AgendaInboxContext.Provider value={agendaInbox}>
      <AllMachinesContext.Provider value={allMachines}>
        <NotificationControlsContext.Provider value={notificationControlsHost}>
          <AgendaWireProbes machines={connectionSnapshot.connections} />
          <ThemeFollower />
          <MotionFollower />
          <ViewportOverlay />
          <AppUpdatedToast />
          {/* The install offer shares the release notice's pinned dock, so the page starts below both
          rather than under either. Phone only: a desktop browser keeps its own install control in the
          address bar, and Settings › This device carries the offer at every width. */}
          {release.notice === null && !installDue ? null : (
            <ReleaseNoticeDock>
              {release.notice === null ? null : (
                <ReleaseNoticeBanner notice={release.notice} onDismiss={release.dismiss} />
              )}
              <InstallBannerSlot phone={layout === 'drawer'} />
            </ReleaseNoticeDock>
          )}
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
          <StoreLinkBehaviour>{content}</StoreLinkBehaviour>
          {/* One passkey prompt for the whole app: any daemon request refused for want of a step-up raises
          it, and it names which machine is asking. */}
          <StepUpDialog gate={store.stepUp} machineName={promptMachineName} />
          {/* The same prompt, for a machine that asks for a passkey on opening (`unlock_required`). */}
          <StepUpDialog gate={store.unlockGate} copy={UNLOCK_COPY} machineName={promptMachineName} />
        </NotificationControlsContext.Provider>
      </AllMachinesContext.Provider>
    </AgendaInboxContext.Provider>
  );
}

/** The root variable through which the shell keeps room for the release notice (`.kt-shell`, index.css). */
const RELEASE_NOTICE_INSET = '--release-notice-h';

/**
 * The release notice, pinned above the page, AND the room for it. It used to float over the shell, so at
 * 390px it covered the first card of whatever was on screen. Its height is published on the root and the
 * shell's top padding grows by it, so the page starts below the notice rather than under it.
 */
function ReleaseNoticeDock({ children }: { readonly children: ReactNode }) {
  const dock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = dock.current;
    if (element === null) return;
    const root = document.documentElement;
    const publish = (): void => root.style.setProperty(RELEASE_NOTICE_INSET, `${element.offsetHeight}px`);
    publish();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(publish);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty(RELEASE_NOTICE_INSET);
    };
  }, []);
  return (
    <div ref={dock} className="fixed inset-x-0 top-[var(--app-top,0px)] z-50" data-release-notice-dock="">
      {children}
    </div>
  );
}

/**
 * Keeps `<html data-theme>` following a live OS light/dark switch on EVERY page. The listener lives in
 * `useTheme`, and only the theme toggle and Settings mounted it, so a `system` preference on a phone
 * layout, setup or a session page kept the old scheme until a reload. Renders nothing.
 */
function ThemeFollower() {
  useTheme();
  return null;
}

/**
 * Keeps `<html data-motion>` following Settings › Appearance › Motion on every page: `reduced` stills
 * every animation in this browser (`styles/index.css`), `system` leaves it to prefers-reduced-motion.
 */
function MotionFollower() {
  const store = useAppStore();
  const motion = useSyncExternalStore(store.controls.subscribe, () => store.controls.snapshot().device.motion);
  useEffect(() => {
    const root = document.documentElement;
    if (motion === 'reduced') root.dataset.motion = 'reduced';
    else delete root.dataset.motion;
  }, [motion]);
  return null;
}

/**
 * Binds every external link under it to Settings › Appearance › "Open links in", read from this
 * device's controls (`features/browser/external-link.tsx`).
 */
function StoreLinkBehaviour({ children }: { readonly children: ReactNode }) {
  const store = useAppStore();
  const openLinksIn = useSyncExternalStore(
    store.controls.subscribe,
    () => store.controls.snapshot().device.openLinksIn,
  );
  const computer = useLocalComputer();
  const [notice, setNotice] = useState<string | null>(null);
  const dismiss = useCallback(() => setNotice(null), []);
  return (
    <LinkBehaviourProvider
      notify={setNotice}
      openLinksIn={openLinksIn}
      {...(computer === undefined ? {} : { computer })}
    >
      {children}
      <ActionToast notice={notice} onDismiss={dismiss} />
    </LinkBehaviourProvider>
  );
}

export interface AppProps {
  /** Where the build put on-device dictation's worker and runtime; only `main.tsx` knows. */
  readonly speechAssets?: SpeechAssets;
}

/** Public client-only root. Providers live here; `main.tsx` only calls `createRoot`. */
export function App({ speechAssets }: AppProps = {}) {
  // One identity for the store's life: the provider reopens the store whenever this changes.
  const createStore = useCallback(async () => {
    const store = await createAppStore({ speechAssets: speechAssets ?? null });
    // The browser's half of the Performance report, readable from the console until Settings shows it.
    exposePerformanceReport(store.performance);
    return store;
  }, [speechAssets]);
  return (
    <RouterProvider>
      <StoreProvider createStore={createStore}>
        <AppShell />
      </StoreProvider>
    </RouterProvider>
  );
}
