/**
 * The visual harness page. NOT part of the shipped bundle — it exists so a
 * human (and `harness/screenshot.ts`) can look at the ported shell in a real
 * browser, at a phone width and a desktop width, with the real design-system
 * stylesheet applied.
 *
 * It renders the shell chrome plus every feature surface ported so far, so a
 * reviewer can compare the phone and desktop renders against the original.
 */

import type {
  AnalyticsResponse,
  AttentionSnapshot,
  BrowserStatus,
  CapabilityGrant,
  CapabilityGrants,
  CapabilityGrantView,
  CgroupConfigPatch,
  CgroupConfigView,
  DaemonCapability,
  DaemonUpdateSettingsPatch,
  DaemonUpdateStartRequest,
  DaemonUpdateView,
  DoctorReport,
  GrantRefusal,
  GrantsView,
  HarnessUpdateStartRequest,
  HarnessUpdateView,
  PairedDevicesView,
  PairingCodeMintResponse,
  PasskeysView,
  PinSnapshot,
  ProjectInfo,
  SecretList,
  SecuritySettingsView,
  SessionFsFile,
  SessionSearchTask,
  SessionView,
  TaskLive,
  TaskStatus,
  TaskSummary,
  TerminalListView,
  WardenConfigView,
  WardenStatusView,
} from '@ferretry/protocol';
import {
  DAEMON_CAPABILITIES,
  HARNESS_UPDATE_CODES,
  matchesSessionSearchQuery,
  SECRET_SCHEMA_VERSION,
  SESSION_FILE_INDEX_VERSION,
  secretReference,
  sessionSearchTaskHaystack,
  TASK_SCHEMA_VERSION,
} from '@ferretry/protocol';
import { AgendaChatHarness } from './agenda-chat.tsx';
import { FyHttpError } from '@ferretry/protocol/client';
import { type ConnectionChoice, chooseConnection } from '@ferretry/relay';
import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ZodType } from 'zod';
import {
  type AttachmentBlobLoader,
  AttachmentGalleryProvider,
  TranscriptAttachmentGallery,
} from '../src/components/attachment-gallery.tsx';
import { AttachmentUnlockPrompt } from '../src/components/attachment-unlock-prompt.tsx';
import { Composer } from '../src/components/composer.tsx';
import {
  type AccountUsageRow,
  accountPickerOptions,
  projectPickerOptions,
  type RecentProjectOption,
} from '../src/components/daemon-picker-model.ts';
import {
  AccountPickerField,
  accountFieldOptions,
  accountFieldSource,
  ProjectPickerField,
  projectFieldOptions,
  projectFieldSource,
} from '../src/components/daemon-pickers.tsx';
import { DictationControl, useDictationBundle } from '../src/components/dictation-control.tsx';
import { DictationSheet, type DictationStage } from '../src/components/dictation-sheet.tsx';
import { FileInstanceSurface } from '../src/components/file-instance-surface.tsx';
import { FilesTab } from '../src/components/files-tab.tsx';
import { LedgerMessage } from '../src/components/ledger-message.tsx';
import { Markdown } from '../src/components/markdown.tsx';
import { MigrateSheet } from '../src/components/migrate-sheet.tsx';
import { NewSessionPage } from '../src/components/new-session-page.tsx';
import { QuestionForm } from '../src/components/question-form.tsx';
import { RenameSheet } from '../src/components/rename-sheet.tsx';
import { RuntimeEffortControls, RuntimeModelControls } from '../src/components/runtime-controls.tsx';
import { PendingAttachmentStrip, PendingMessage, ThreadSkeleton } from '../src/components/session-chat-parts.tsx';
import { SessionCommandControls } from '../src/components/session-command-controls.tsx';
import { SessionDashboard } from '../src/components/session-dashboard.tsx';
import { SessionDetails } from '../src/components/session-details.tsx';
import { SessionHeader } from '../src/components/session-header.tsx';
import { SessionList } from '../src/components/session-list.tsx';
import { SessionSurfaceReferences } from '../src/components/session-surface-references.tsx';
import { SessionTaskKanban, SessionTaskList } from '../src/components/session-tasks.tsx';
import { SessionTerminalDeck, type TerminalDeckDependencies } from '../src/components/session-terminal-deck.tsx';
import { transcriptEntriesFromLog } from '../src/components/session-workspace-model.ts';
import { SessionsPage } from '../src/components/sessions-page.tsx';
import { type PaneSnapshotReader, TerminalSnapshotView } from '../src/components/terminal-snapshot.tsx';
import { ThinkingIndicator } from '../src/components/thinking-indicator.tsx';
import { Transcript } from '../src/components/transcript.tsx';
import type { AnalyticsRequest } from '../src/features/analytics/analytics-custom-query.tsx';
import { AnalyticsMetricChart } from '../src/features/analytics/analytics-metric-chart.tsx';
import {
  analyticsOverview,
  analyticsRangeDays,
  formatAxisUsd,
  formatDay,
  formatDollars,
  overviewRow,
} from '../src/features/analytics/analytics-overview.ts';
import { AnalyticsResponseView } from '../src/features/analytics/analytics-response-view.tsx';
import type { AnalyticsAggregateResponse } from '../src/features/analytics/analytics-result-table.tsx';
import { AnalyticsResultTable } from '../src/features/analytics/analytics-result-table.tsx';
import { GlobalAnalyticsPage } from '../src/features/analytics/global-analytics-page.tsx';
import {
  type SessionAnalyticsRequest,
  SessionAnalyticsSurface,
} from '../src/features/analytics/session-analytics-surface.tsx';
import { AttentionBoard } from '../src/features/attention/attention-board.tsx';
import { BrowserLoginBanner, type BrowserLoginView } from '../src/features/browser/browser-login-banner.tsx';
import { InAppBrowserSurface } from '../src/features/browser/in-app-browser.tsx';
import type { BrowserDestination } from '../src/features/browser/in-app-browser-model.ts';
import { RemoteBrowserPane, type RemoteBrowserPaneProps } from '../src/features/browser/remote-browser-pane.tsx';
import type { RemoteBrowserSocket } from '../src/features/browser/remote-browser-viewer.tsx';
import { rememberBrowserEngine } from '../src/features/browser/unified-browser-model.ts';
import {
  DEFAULT_UNIFIED_BROWSER_DEPENDENCIES,
  type UnifiedBrowserDependencies,
  UnifiedBrowserSurface,
} from '../src/features/browser/unified-browser-surface.tsx';
import { ConfigFilesSurface } from '../src/features/config-files/config-files-settings.tsx';
import { type NewDeviceNoticeClients, NewDeviceNotices } from '../src/features/device-notice/new-device-notice.tsx';
import type { FleetClientFactory } from '../src/features/fleet/fleet-client.ts';
import { MachineSettingsTab } from '../src/features/fleet/machine/settings-tab.tsx';
import { isMachineSetupStepId } from '../src/features/fleet/setup/onboarding-model.ts';
import { MachineSetupScreen } from '../src/features/fleet/setup/setup-screen.tsx';
import type { MachineTabProps, MachineTabSurfaces } from '../src/features/fleet/shell/machines-surface.tsx';
import { useHypermediaSessionActions } from '../src/features/hypermedia/hypermedia-session-actions.tsx';
import { LineageSurfaceContent } from '../src/features/lineage/lineage-surface.tsx';
import type { ClipboardWriter } from '../src/features/onboarding/copy-button.tsx';
import type { DeviceKind } from '../src/features/onboarding/device-kind.ts';
import type { HostedRelayFallback } from '../src/features/onboarding/hosted-relay.ts';
import type { OnboardingRouteId, OnboardingStepId } from '../src/features/onboarding/onboarding-model.ts';
import { OnboardingPage } from '../src/features/onboarding/onboarding-page.tsx';
import {
  ONBOARDING_PROGRESS_VERSION,
  OnboardingProgressStore,
} from '../src/features/onboarding/onboarding-progress.ts';
import type { SetupSharePort } from '../src/features/onboarding/setup-handoff-panel.tsx';
import { DeviceRefusedNotice } from '../src/features/pairing/device-refused-notice.tsx';
import { PairingScreen } from '../src/features/pairing/pairing-screen.tsx';
import { PinsBoard } from '../src/features/pins/pins-board.tsx';
import { PinsTrigger } from '../src/features/pins/pins-trigger.tsx';
import type { ProjectRegistrationStatus } from '../src/features/projects/project-registration-model.ts';
import { ProjectsHub } from '../src/features/projects/projects-hub.tsx';
import type { SecretClient } from '../src/features/secrets/secrets-api.ts';
import { SecretsCard } from '../src/features/secrets/secrets-card.tsx';
import { type SecretClientFactory, SecretsSurface } from '../src/features/secrets/secrets-surface.tsx';
import { INFO_TABS, type InfoTab } from '../src/features/session-info/info-model.ts';
import { SessionSearchControl, SessionSearchProvider } from '../src/features/session-search/session-search.tsx';
import { AboutMachineSurface } from '../src/features/settings/about-machine.tsx';
import type { PairingClient } from '../src/features/settings/add-device-api.ts';
import {
  AddDeviceCard,
  AddDeviceSurface,
  type PairingClientFactory,
} from '../src/features/settings/add-device-settings.tsx';
import { AgentClisSurface } from '../src/features/settings/agent-clis.tsx';
import { CapabilityList } from '../src/features/settings/capability-list.tsx';
import { CgroupConfigSurface } from '../src/features/settings/cgroup-settings.tsx';
import type { DaemonSettingsTabDefinition } from '../src/features/settings/daemon-settings-frame.tsx';
import { DictationSettings } from '../src/features/settings/dictation-settings.tsx';
import { DEFAULT_DICTATION_SHORTCUT } from '../src/features/settings/dictation-shortcut.ts';
import { DictationShortcutPicker } from '../src/features/settings/dictation-shortcut-picker.tsx';
import { DoctorSettings } from '../src/features/settings/doctor-settings.tsx';
import type { GrantClient } from '../src/features/settings/grants-api.ts';
import { type GrantClientFactory, GrantsCard, GrantsSurface } from '../src/features/settings/grants-settings.tsx';
import { MarkdownComposerSettings } from '../src/features/settings/markdown-composer-settings.tsx';
import { NotificationSettingsView } from '../src/features/settings/notification-settings.tsx';
import { PerformanceSettings } from '../src/features/settings/performance-settings.tsx';
import type { SecurityLogClient } from '../src/features/settings/security-api.ts';
import { SecurityLogSurface } from '../src/features/settings/security-log-settings.tsx';
import type { PasskeyClientFactory } from '../src/features/settings/security-settings.tsx';
import { settingsPaletteEntries } from '../src/features/settings/settings-catalog.ts';
import { SettingsPage } from '../src/features/settings/settings-page.tsx';
import { ViewportOverlay, viewportOverlay } from '../src/features/settings/viewport-details.tsx';
import { VoiceEngineChoice } from '../src/features/settings/voice-engine-choice.tsx';
import type { SkillsCatalog } from '../src/features/skills/skills-catalog.ts';
import { SkillsSurface } from '../src/features/skills/skills-surface.tsx';
import { StepUpDialog, UNLOCK_COPY } from '../src/features/step-up/step-up-dialog.tsx';
import { filterTaskDag, taskDag } from '../src/features/tasks/task-dag.ts';
import { TaskDagGraph } from '../src/features/tasks/task-dag-graph.tsx';
import { TaskName } from '../src/features/tasks/task-name.tsx';
import { taskStatusCounts, toggleTaskStatusFilter } from '../src/features/tasks/task-presentation.ts';
import { TaskQuickSummary, TaskRow } from '../src/features/tasks/task-row.tsx';
import { TaskStatusFilter } from '../src/features/tasks/task-status-filter.tsx';
import { askWardenContribution } from '../src/features/warden/ask-warden.tsx';
import {
  type WardenClientFactory,
  WardenConfigCard,
  WardenConfigSurface,
} from '../src/features/warden/warden-config-card.tsx';
import { WardenOverview } from '../src/features/warden/warden-overview.tsx';
import { WardenOverviewSurface } from '../src/features/warden/warden-overview-surface.tsx';
import { WardenStrip } from '../src/features/warden/warden-strip.tsx';
import { WardenVerdicts } from '../src/features/warden/warden-verdicts.tsx';
import type { ConsoleTyper } from '../src/features/workspace/console-surface.tsx';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { DETAILS_TAB_ORDER, type DetailsTab } from '../src/hooks/use-details-tab.ts';
import { useLayoutMode } from '../src/hooks/use-layout-mode.ts';
import type { LiveClockOptions } from '../src/hooks/use-live-clock.ts';
import type { ScopeNavigation } from '../src/hooks/use-project-scope.ts';
import type { RemoteBrowserScheduler, RemoteBrowserTransport } from '../src/hooks/use-remote-browser.ts';
import type { WardenStatusReader } from '../src/hooks/use-warden-status.ts';
import type { PickerAccount, PickerAccountHealth } from '../src/lib/account-picker-catalog.ts';
import { type DaemonAccountPickerSlice, DaemonAccountPickerStore } from '../src/lib/account-picker-store.ts';
import { DaemonHttpTransport, daemonApiClient } from '../src/lib/api-client.ts';
import { DaemonAttentionClient } from '../src/lib/attention-client.ts';
import type { DaemonConnectionRecord } from '../src/lib/connections.ts';
import { type ChatWidthPreference, type ControlsStorage, DaemonControlsStore } from '../src/lib/controls.ts';
import { type DaemonConnection, type DaemonId, daemonConnection } from '../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../src/lib/daemon-scope.ts';
import { DeviceKeyUnsupportedError } from '../src/lib/device-keys.ts';
import { DaemonDraftStore } from '../src/lib/drafts.ts';
import type { FleetProject, SessionGroup } from '../src/lib/fleet-grouping.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../src/lib/fleet-store.ts';
import { buildLineage } from '../src/lib/lineage.ts';
import { writeMdComposePref } from '../src/lib/md-compose.ts';
import { daemonSessionsPath } from '../src/lib/pages/routes.ts';
import { type SessionChatClient, SessionChatPage } from '../src/lib/pages/session-chat-page.tsx';
import { WardenPage } from '../src/lib/pages/warden-page.tsx';
import type { QrScanHost } from '../src/lib/pair-scan.ts';
import type { PairingArrival } from '../src/lib/pairing.ts';
import { type DaemonProjectsPort, type DaemonProjectsSlice, DaemonProjectsStore } from '../src/lib/projects-store.ts';
import { AppOutdatedError, DaemonOutdatedError } from '../src/lib/relay-carrier.ts';
import type { DaemonFetch } from '../src/lib/runtime-models.ts';
import { unlockStaysSentence } from '../src/lib/security-settings-client.ts';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';
import { SIDE_PANE_DEFAULT_WIDTH } from '../src/lib/side-pane-preferences.ts';
import type { StepUpClient } from '../src/lib/step-up-client.ts';
import { StepUpGate } from '../src/lib/step-up-gate.ts';
import { DaemonClientProvider } from '../src/lib/store.tsx';
import {
  BrowserRecognitionError,
  type BrowserRecognitionProvider,
  type BrowserRecognitionSupport,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultEventLike,
} from '../src/lib/stt/browser-recognition.ts';
import type { CaptureMonitor } from '../src/lib/stt/level-monitor.ts';
import { PARAKEET_CATALOG_MODEL } from '../src/lib/stt/model-catalog.ts';
import { PARAKEET_TOTAL_BYTES, PARAKEET_VERSION_LABEL } from '../src/lib/stt/parakeet-model.ts';
import type { ParakeetInstallSnapshot, ParakeetVoice } from '../src/lib/stt/parakeet-voice.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../src/lib/stt/stt-settings.ts';
import { DaemonUsageIndex } from '../src/lib/usage.ts';
import { type DaemonUsagePort, DaemonUsageStore } from '../src/lib/usage-store.ts';
import { activateWorkspaceTab, openWorkspaceTab, workspaceTab } from '../src/lib/workspace-layout.ts';
import { WorkspaceLayoutStore } from '../src/lib/workspace-layout-store.ts';
import { AgentSidebar } from '../src/shell/agent-sidebar.tsx';
import { AppBar, AppTabBar } from '../src/shell/app-bar.tsx';
import { BottomSheet } from '../src/shell/bottom-sheet.tsx';
import { BrandMark } from '../src/shell/brand-mark.tsx';
import { BulkStopConfirmation } from '../src/shell/bulk-stop-confirmation.tsx';
import { type ChatWidth, ChatWidthControl } from '../src/shell/chat-width-control.tsx';
import { ChunkErrorBoundary } from '../src/shell/chunk-error-boundary.tsx';
import { CommandPalette, type PaletteSettingsSource } from '../src/shell/command-palette.tsx';
import { ContextMenu } from '../src/shell/context-menu.tsx';
import { FleetNavigationRail } from '../src/shell/fleet-navigation-rail.tsx';
import { INSIGHTS_COLUMN_CLASS, InsightsFrame } from '../src/shell/insights-frame.tsx';
import { MarkerLine, MarkerSeparator } from '../src/shell/marker.tsx';
import { ModeBadge } from '../src/shell/mode-badge.tsx';
import { paletteSessionEntries } from '../src/shell/palette-model.ts';
import { ActionGroup, Badge, Button, Card, Label, PanelBody, PanelHeader, Textarea } from '../src/shell/primitives.tsx';
import { type Quota, QuotaReadout } from '../src/shell/quota-readout.tsx';
import { RcBadge } from '../src/shell/rc-badge.tsx';
import { SessionRowMenu } from '../src/shell/session-row-menu.tsx';
import { SessionsBar } from '../src/shell/sessions-bar.tsx';
import { SheetTabs } from '../src/shell/sheet-tabs.tsx';
import { SidePaneWorkspace } from '../src/shell/side-pane.tsx';
import { SidePaneResizeHandle } from '../src/shell/side-pane-resize-handle.tsx';
import { SidePaneSearch } from '../src/shell/side-pane-search.tsx';
import {
  getSidePaneTabDefinitions,
  openSidePaneBrowserTab,
  openSidePaneFileTab,
  openSidePaneTab,
  readSidePaneTabsState,
  resolveSidePaneTab,
  type SidePaneTabDefinition,
} from '../src/shell/side-pane-tab-model.ts';
import { SidePaneTabs } from '../src/shell/side-pane-tabs.tsx';
import { StatusMark } from '../src/shell/status-mark.tsx';
import { ViewTabs } from '../src/shell/view-tabs.tsx';
import { harnessCatalogAnswer } from './account-model-catalog.ts';
import {
  ANALYTICS_FIXTURE_MACHINES,
  ANALYTICS_FIXTURE_NOW,
  ANALYTICS_FIXTURE_ROWS,
  answerAnalyticsFixture,
} from './analytics-fixture.ts';
import { harnessConfigFilesClient } from './config-files-fixture.ts';
import { ContextToolsHarness, contextToolsFrame } from './context-tools.tsx';
import {
  LEARNING_PASSIVE,
  LearningHubHarness,
  LearningSettingsHarness,
  useHarnessLearningActions,
} from './learning-hub.tsx';
import { machineSetupAnswer } from './machine-setup-fixture.ts';
import { HARNESS_MACHINE_TABS } from './machine-tabs.tsx';
import { McpSignInFrameHarness, mcpSignInFrame } from './mcp-sign-in.tsx';
import { isPairFromMenuPage, PairFromMenuHarness } from './pair-from-menu.tsx';
import { harnessPerformanceClient, harnessRecorder } from './performance-fixture.ts';
import { isSessionContextMenuPage, SessionContextMenuHarness } from './session-context-menu.tsx';
import {
  WARDEN_FIXTURE_ATTENTION,
  WARDEN_FIXTURE_CONFIG,
  WARDEN_FIXTURE_CONFIG_NO_LOGIN,
  WARDEN_FIXTURE_CONFIG_UNKNOWN_LOGIN,
  WARDEN_FIXTURE_NOW,
  WARDEN_FIXTURE_STATUS,
  wardenFixtureRequest,
} from './warden-fixture.ts';
import { isWhatsNewPage, WhatsNewHarness } from './whats-new.tsx';

const daemon = daemonConnection({
  daemonId: 'harness-daemon',
  baseUrl: 'https://daemon.invalid/',
  deviceId: 'harness-token',
  daemonName: 'studio-mac',
});
const unreachableDaemon = daemonConnection({
  daemonId: 'unreachable-daemon',
  baseUrl: 'https://offline.example.test',
  deviceId: 'offline-harness-token',
  daemonName: 'travel-laptop',
});
const checkingDaemon = daemonConnection({
  daemonId: 'checking-daemon',
  baseUrl: 'https://checking.example.test',
  deviceId: 'checking-harness-token',
  daemonName: 'build-runner',
});
/**
 * The studio's pairing from before it was reset: same name, same address, an identity nothing answers
 * any more. A newer pairing replaced it, so it reads as the old pairing and offers to be removed.
 */
const resetDaemon = daemonConnection({
  daemonId: 'harness-daemon-before-reset',
  baseUrl: 'https://daemon.invalid/',
  deviceId: 'harness-old-token',
  daemonName: 'studio-mac',
});
const HARNESS_SETTINGS_CONNECTIONS = [
  { ...daemon, label: 'Studio workstation', pairedAt: 1, lastSelectedAt: 3 },
  { ...unreachableDaemon, label: 'Travel laptop', pairedAt: 1, lastSelectedAt: 2 },
  { ...checkingDaemon, pairedAt: 1, lastSelectedAt: 1 },
  { ...resetDaemon, label: 'Studio workstation', pairedAt: 0, lastSelectedAt: 0 },
] as const satisfies readonly DaemonConnectionRecord[];
/**
 * A set-up machine Clone can copy FROM, so the preview's "Runs on" review is walkable. Offered to Clone
 * only: the Daemons section keeps its three-daemon fixture.
 */
const cloneSourceDaemon = daemonConnection({
  daemonId: 'clone-source-daemon',
  baseUrl: 'https://work.example.test',
  deviceId: 'clone-source-harness-token',
});
const HARNESS_CLONE_SOURCE = { ...cloneSourceDaemon, label: 'Work laptop', pairedAt: 1, lastSelectedAt: 0 };

type SettingsDaemonScenario = 'one' | 'many';

const settingsDaemonScenario = (): SettingsDaemonScenario =>
  new URLSearchParams(window.location.search).get('settings-daemons') === 'one' ? 'one' : 'many';

const settingsConnections = (scenario: SettingsDaemonScenario): DaemonConnectionRecord[] =>
  scenario === 'one'
    ? [{ ...HARNESS_SETTINGS_CONNECTIONS[0] }]
    : HARNESS_SETTINGS_CONNECTIONS.map(item => ({ ...item }));

const harnessSettingsProbe = async (connection: DaemonConnection): Promise<void> => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  if (connection.daemonId === checkingDaemon.daemonId) await new Promise<void>(() => undefined);
};
const scope = daemonSessionScope(daemon, 'harness-session');

/** Every reference state on one screen: proved, unproved, escaped, and in code. */
const HARNESS_REFERENCE_PROSE = [
  'Ask :zelda to read @src/api.ts:120-140 before &F12 lands, then clear !A3 with /summary',
  'and watch %terminal:0a1b2c3d4e5f, while %terminal:ffffffffffff is gone.',
  '',
  'Unproved stays prose: :ganon, @missing.ts, &F99, !A9, /nope. Escaped stays literal: \\:zelda.',
  '',
  'Inline code keeps its box and its bytes: `send :zelda "@src/api.ts:120"`.',
  '',
  '```ts',
  'const owner = ":zelda"; // still a highlighted string literal',
  'const path = "@src/api.ts:120";',
  'if (a && b < c) open(path);',
  '```',
].join('\n');
const settingsControls = new DaemonControlsStore();

/**
 * A skills catalog covering both scopes and every origin chip, so the row
 * chrome, the group headings and the badge column can all be compared against
 * the original at both widths.
 */
const HARNESS_SKILLS: SkillsCatalog = {
  harness: 'claude',
  skills: [
    { name: 'kteam', description: 'Coordinate detached teammates.', scope: 'global', origin: 'claude' },
    { name: 'summary', description: 'Recap the current work, outcome first.', scope: 'global', origin: 'both' },
    {
      name: 'liftoff-ops',
      description: 'Infrastructure access for Kubernetes, metrics and logs.',
      scope: 'global',
      origin: 'codex',
    },
    {
      name: 'cli-authoring',
      description: 'Doctrine for extending the CLI package.',
      scope: 'project',
      origin: 'claude',
    },
    { name: 'floop', description: 'Review the diff until every reviewer agrees.', scope: 'project', origin: 'unknown' },
  ],
};

/**
 * A carrier a reader would actually want to see rendered: the RELAYED one.
 *
 * Direct is the boring case and the one every other harness screen already implies.
 * What is worth looking at is the fallback disclosure — the reason sentence naming
 * why direct was passed over, the hosted operator's observer list, and the warning
 * that live updates do not travel over a relay.
 */
const HARNESS_RELAYED_CARRIER = chooseConnection([
  {
    method: { kind: 'direct', daemonUrl: 'https://studio.tail1234.ts.net' },
    reachable: false,
    detail: 'Failed to fetch',
  },
  { method: { kind: 'relay', relayUrl: 'https://relay.ferretry.dev', operator: 'hosted' }, reachable: true },
]);

/**
 * The same page for a daemon that answered nothing.
 *
 * Its direct address failed and the hosted relay could not reach it either, so
 * no carrier is claimed: the panel names both attempts instead of showing the
 * healthy machine's relay path under this machine's name.
 */
const HARNESS_OFFLINE_CARRIER = chooseConnection([
  {
    method: { kind: 'direct', daemonUrl: 'https://offline.example.test' },
    reachable: false,
    detail: 'Failed to fetch',
  },
  {
    method: { kind: 'relay', relayUrl: 'https://relay.ferretry.dev', operator: 'hosted' },
    reachable: false,
    detail: 'this daemon never claimed a rendezvous',
  },
]);

/**
 * Carrier evidence belongs to ONE pairing, so it is read per daemon.
 *
 * The fixture used to hand every frame the healthy machine's relayed
 * measurement, which is exactly the confusion the carrier panel exists to
 * prevent — a reader would have seen Travel laptop reporting a path measured for
 * Studio workstation. The daemon whose probe never answers reports NO
 * measurement rather than a stale one; unmeasured is a state the card renders.
 *
 * `relayAdvertised` is true for each of them because the advertisement is a
 * service fact this browser read once, not a property of any host: the offline
 * pairing had a relay to fall back to and it still did not answer, which its
 * passed-over list says outright.
 */
const harnessSettingsCarrier = (
  daemonId: DaemonConnection['daemonId'],
): { readonly carrier: ConnectionChoice | undefined; readonly relayAdvertised: boolean } =>
  daemonId === daemon.daemonId
    ? { carrier: HARNESS_RELAYED_CARRIER, relayAdvertised: true }
    : daemonId === unreachableDaemon.daemonId
      ? { carrier: HARNESS_OFFLINE_CARRIER, relayAdvertised: true }
      : { carrier: undefined, relayAdvertised: true };

const HARNESS_STT_SETTINGS: SttSettings = {
  ...DEFAULT_STT_SETTINGS,
  dictionary: ['ferretry = ferretree', 'nitroso'],
  userContext: 'I work on ferretry and the daemon fleet. Our services: nitroso, diene, alcohol.',
};

/**
 * A stand-in analyser branch fed a fake LEVEL, so the meter in a screenshot is the real paint path
 * rather than an empty box — headless Chrome has no microphone to open. `level` is the amplitude of
 * the tone at a moment; the speaking fixture swells and drops like syllables, the silent one is zero.
 */
const levelMonitor = (level: (seconds: number) => number): CaptureMonitor => ({
  createAnalyser: () => {
    const born = performance.now();
    return {
      analyser: {
        fftSize: 512,
        smoothingTimeConstant: 0.5,
        minDecibels: -90,
        maxDecibels: -10,
        getFloatTimeDomainData: (target: Float32Array) => {
          const amplitude = level((performance.now() - born) / 1_000);
          for (let index = 0; index < target.length; index += 1) {
            target[index] = amplitude * Math.sin((index / target.length) * Math.PI * 12);
          }
        },
      },
      disconnect: () => undefined,
    };
  },
});

/** Speech-like: syllable swells over a slower phrase envelope, with the brief gaps between words. */
const harnessMonitor: CaptureMonitor = levelMonitor(seconds => {
  const phrase = Math.abs(Math.sin(seconds * 1.1));
  const syllable = Math.abs(Math.sin(seconds * 7.3)) ** 1.5;
  return 0.01 + 0.2 * phrase * syllable;
});

/** Nothing said: the mic is open and the room is quiet. */
const harnessSilentMonitor: CaptureMonitor = levelMonitor(() => 0);

/**
 * The dictation fixtures.
 *
 * Speech recognition is a BROWSER capability here: nothing polls a daemon for a
 * speech status, there is no model catalogue and no installer, so none of that is
 * answered by the harness any more. What still has to be stood in for is the
 * recognition object itself — headless Chrome has no microphone, and a screenshot
 * run must not depend on a browser vendor's speech service being reachable.
 *
 * `harnessRecognitionProvider` is that stand-in and it is deliberately
 * SYNCHRONOUS: support is handed in as data, and one scripted recognition either
 * reports words the instant it starts or fires exactly one error event. Every
 * card below therefore settles into its state during the same commit that starts
 * it, which is what makes these stable shots at both required widths — no clock,
 * no click, no awaited permission prompt.
 */
interface HarnessRecognitionScript {
  /** Words the engine reports the instant recognition starts. */
  readonly heard?: readonly string[];
  /** Fired instead of hearing anything, exactly as a real error event would be. */
  readonly failWith?: SpeechRecognitionErrorEventLike;
}

class HarnessRecognition implements SpeechRecognitionLike {
  continuous = false;
  interimResults = false;
  lang = 'en-US';
  maxAlternatives = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onresult: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onnomatch: ((event: SpeechRecognitionResultEventLike) => void) | null = null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null = null;

  readonly #script: HarnessRecognitionScript;

  constructor(script: HarnessRecognitionScript) {
    this.#script = script;
  }

  start(): void {
    this.onstart?.();
    if (this.#script.failWith !== undefined) {
      this.onerror?.(this.#script.failWith);
      return;
    }
    const heard = this.#script.heard ?? [];
    if (heard.length === 0) return;
    this.onspeechstart?.();
    this.onresult?.({
      resultIndex: 0,
      results: heard.map(text => ({ 0: { transcript: text, confidence: 0.94 }, isFinal: true, length: 1 })),
    });
  }

  /** Stop and Cancel both end the engine; the session decides what that means. */
  stop(): void {
    this.onend?.();
  }

  abort(): void {
    this.onend?.();
  }
}

const harnessRecognitionProvider = (
  support: BrowserRecognitionSupport,
  script: HarnessRecognitionScript = {},
): BrowserRecognitionProvider => ({
  support,
  create: () => {
    // The controller refuses before it ever asks an unavailable browser for a
    // recognition object; this keeps the fake honest if that order ever changes.
    if (!support.available) {
      throw new BrowserRecognitionError('recognition-unavailable', support.reason ?? 'Dictation is unavailable here.');
    }
    return new HarnessRecognition(script);
  },
  // No visibility watch and no timers: a screenshot run must not be able to
  // cancel a card by backgrounding the page, and the duration limit has nothing
  // to measure against a synchronous engine.
  watchHidden: () => () => undefined,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
});

const HARNESS_RECOGNITION_AVAILABLE: BrowserRecognitionSupport = {
  available: true,
  availability: 'available',
  implementation: 'standard',
};

/** Firefox with the preference off, or any engine without the constructor. */
const HARNESS_RECOGNITION_UNSUPPORTED: BrowserRecognitionSupport = {
  available: false,
  availability: 'unsupported',
  implementation: null,
  reason: 'This browser does not support dictation for web apps.',
};

/** WebKit exposes the prefixed interface in an installed iOS app, then refuses it. */
const HARNESS_RECOGNITION_IOS_HOME_SCREEN: BrowserRecognitionSupport = {
  available: false,
  availability: 'ios-home-screen',
  implementation: 'webkit',
  reason: 'Home Screen apps cannot use dictation on iPhone or iPad. Open Ferretry in Safari instead.',
};

/**
 * Parakeet's install in each state the Voice settings show, frozen. A static snapshot rather than the
 * real service: the gallery is about what each state LOOKS like, and nothing here may download.
 */
const harnessParakeetVoice = (snapshot: ParakeetInstallSnapshot): ParakeetVoice =>
  ({
    model: PARAKEET_CATALOG_MODEL,
    support: { available: snapshot.phase !== 'unsupported' },
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    refresh: async () => undefined,
    install: async () => undefined,
    cancel: () => undefined,
    remove: async () => undefined,
    createSession: () => {
      throw new Error('the harness never dictates through Parakeet');
    },
  }) as unknown as ParakeetVoice;

const HARNESS_PARAKEET_ABSENT = harnessParakeetVoice({
  phase: 'absent',
  totalBytes: PARAKEET_TOTAL_BYTES,
  downloadedBytes: 0,
});
const HARNESS_PARAKEET_INSTALLING = harnessParakeetVoice({
  phase: 'installing',
  totalBytes: PARAKEET_TOTAL_BYTES,
  downloadedBytes: 281_000_000,
  label: 'Encoder',
});
const HARNESS_PARAKEET_INSTALLED = harnessParakeetVoice({
  phase: 'installed',
  totalBytes: PARAKEET_TOTAL_BYTES,
  downloadedBytes: PARAKEET_TOTAL_BYTES,
  version: PARAKEET_VERSION_LABEL,
  installedAt: '2026-10-16T09:30:00.000Z',
});
/** Available and silent: the mic-button card is about the button's two layouts. */
const harnessSilentRecognition = harnessRecognitionProvider(HARNESS_RECOGNITION_AVAILABLE);

/** Available and hearing something — the read-only caption in its live state. */
const harnessHearingRecognition = harnessRecognitionProvider(HARNESS_RECOGNITION_AVAILABLE, {
  heard: ['Port the dictation panel', 'and keep the caption read-only.'],
});

const harnessUnsupportedRecognition = harnessRecognitionProvider(HARNESS_RECOGNITION_UNSUPPORTED);
const harnessIosHomeScreenRecognition = harnessRecognitionProvider(HARNESS_RECOGNITION_IOS_HOME_SCREEN);

/** The site is blocked: the browser refuses without asking the reader again. */
const harnessBlockedRecognition = harnessRecognitionProvider(HARNESS_RECOGNITION_AVAILABLE, {
  failWith: { error: 'not-allowed' },
});

/** The prompt was dismissed rather than answered — same code, different sentence. */
const harnessDismissedRecognition = harnessRecognitionProvider(HARNESS_RECOGNITION_AVAILABLE, {
  failWith: { error: 'not-allowed', message: 'The microphone prompt was dismissed without a choice.' },
});

/**
 * A frozen elapsed clock. The first read starts the recording at zero and every
 * later read reports the same 1:05, so an m:ss readout in a capture cannot drift
 * between the phone and the desktop shot.
 */
const harnessElapsedClock = (): (() => number) => {
  let started = false;
  return () => {
    if (!started) {
      started = true;
      return 0;
    }
    return 65_000;
  };
};

/**
 * One live dictation flow, opened by a mount-time gesture instead of a click.
 *
 * This is the shipped `useDictationBundle` state machine over a scripted
 * recognition object, so the panel copy, the mic button's label and the stage
 * colour are all derived the way a real session derives them. A hand-written
 * stage could drift from the component; this cannot.
 */
/**
 * Settings › Voice with Parakeet chosen: the Live words (experimental) switch starts OFF, exactly as
 * a fresh install or an upgrading device would see it, and the card is interactive.
 */
function HarnessLiveWordsSetting() {
  const [settings, setSettings] = useState<SttSettings>({ ...DEFAULT_STT_SETTINGS, engine: 'parakeet' });
  return (
    <Card aria-label="Dictation live words setting" className="min-w-0" id="harness-dictation-live-words">
      <PanelBody>
        <DictationSettings
          settings={settings}
          update={patch => setSettings(current => ({ ...current, ...patch }))}
          persisted
          recognitionSupport={HARNESS_RECOGNITION_AVAILABLE}
          voice={null}
        />
      </PanelBody>
    </Card>
  );
}

function DictationFlowHarness({
  label,
  recognition,
  settings,
}: {
  readonly label: string;
  readonly recognition: BrowserRecognitionProvider;
  readonly settings: SttSettings;
}) {
  const now = useMemo(harnessElapsedClock, []);
  const { control, sheet, stage, handle } = useDictationBundle({
    daemon,
    draft: '',
    onDraftChange: () => {},
    settings,
    recognition,
    // A stacked review page must never bind the reader's push-to-talk chord.
    shortcutHost: null,
    now,
    clockIntervalMs: 1_000,
  });
  const start = useRef(handle.start);
  start.current = handle.start;
  useEffect(() => start.current(), []);

  return (
    <div className="flex min-w-0 flex-col gap-2" data-dictation-stage={stage}>
      <Label>{label}</Label>
      {/* The panel is anchored above its composer, so each example needs its own
          positioned box at the same width. Reserve the wrapped mobile error
          strip's full height so it cannot paint over this fixture's label. */}
      <div className="relative h-[144px] min-w-0">
        <div className="absolute inset-x-0 top-[144px]">{sheet}</div>
      </div>
      <div className="flex items-center gap-2">{control}</div>
    </div>
  );
}

/**
 * The host this fixture's resource limits are computed against.
 *
 * `effective` is the pair of cgroup v2 values a daemon would actually write, so
 * a harness that echoed the same strings back after an apply would show a cap
 * nobody asked for. These are recomputed from the percentages the card sent
 * against this one fixed host, which is what makes the Apply button reviewable.
 */
const HARNESS_CGROUP_HOST = { cpus: 8, memoryBytes: 34_359_738_368 } as const;

/**
 * The two values a host manager is actually given.
 *
 * A PERCENTAGE OF THE WHOLE MACHINE for CPU — 80% of eight CPUs is `640%` — and decimal bytes for
 * memory. This fixture used to compute the unified hierarchy's raw `cpu.max` pair
 * (`"640000 100000"`), which is a second spelling of one fact and one that no `set-property` would
 * accept, so a reviewer looking at the captured panel was reading a number the daemon never writes.
 * `packages/daemon/src/lib/cgroups/limits.ts` owns the conversion and this mirrors it exactly.
 */
const harnessCgroupQuota = (cpuPercent: number, memoryPercent: number) => ({
  cpuQuota: `${Math.max(1, Math.round(cpuPercent * HARNESS_CGROUP_HOST.cpus))}%`,
  memoryMax: String(Math.max(1, Math.floor((memoryPercent / 100) * HARNESS_CGROUP_HOST.memoryBytes))),
});

const harnessCgroupView = (config: CgroupConfigView['config']): CgroupConfigView => ({
  config,
  // This fixture host is Linux with cgroup v2, so the controls it renders are
  // controls that would do something. The unsupported presentation is a real
  // state, but it belongs to a platform this fixture is not pretending to be.
  supported: true,
  // The slice a real daemon names, derived there from the product scope rather than written out.
  fleetSlice: 'ferretry-fleet.slice',
  effective: {
    cpus: HARNESS_CGROUP_HOST.cpus,
    memoryBytes: HARNESS_CGROUP_HOST.memoryBytes,
    fleet: harnessCgroupQuota(config.fleet.cpuPercent, config.fleet.memoryPercent),
    perAgent: harnessCgroupQuota(config.perAgent.cpuPercent, config.perAgent.memoryPercent),
  },
  // The captured state deliberately carries both kinds of evidence the surface must make visible:
  // a running pane whose saved limit needs a relaunch, and a host-manager refusal that means the
  // durable configuration is newer than the live scope. A happy-only fixture cannot prove either
  // warning survives the trip through the production card.
  restartRequiredSessions: ['msh-harness-running'],
  warnings: [
    'user manager unavailable — the saved limits are stored but are not in force; relaunch affected sessions once the host manager is reachable',
  ],
});

const HARNESS_CGROUP_CONFIG: CgroupConfigView['config'] = {
  enabled: true,
  fleet: { cpuPercent: 80, memoryPercent: 75 },
  perAgent: { cpuPercent: 25, memoryPercent: 25 },
};

/**
 * The in-memory cgroup daemon. State lives per client, so every capture starts
 * from the declared configuration above rather than from whatever an earlier
 * capture typed, and the patch is merged exactly as the partial protocol shape
 * arrives.
 */
const harnessCgroupClient = async (connection: DaemonConnection) => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  let config = HARNESS_CGROUP_CONFIG;
  return {
    cgroupConfig: async () => harnessCgroupView(config),
    updateCgroupConfig: async (patch: CgroupConfigPatch) => {
      config = {
        enabled: patch.enabled ?? config.enabled,
        fleet: { ...config.fleet, ...patch.fleet },
        perAgent: { ...config.perAgent, ...patch.perAgent },
      };
      return harnessCgroupView(config);
    },
  };
};

/** The Performance panel's fixture machine and this page's recorder (`performance-fixture.ts`). */
const HARNESS_PERFORMANCE_CLIENT = harnessPerformanceClient();
const HARNESS_RECORDER = harnessRecorder();

/** The Files panel's in-memory daemon (`config-files-fixture.ts`). */
const HARNESS_CONFIG_FILES_CLIENT = harnessConfigFilesClient(unreachableDaemon.daemonId);

/**
 * The panels the composition root supplies, in the order it supplies them (production also
 * supplies Model pricing, which this fixture leaves out).
 *
 * The frame then renders EIGHT — Warden, Secrets, Add a device, What devices may do, Resource
 * limits, Doctor, Carrier, Host checks. Each one
 * is the real surface behind a client that answers from memory: no leaf is faked
 * and nothing here reaches the network, which the screenshot driver enforces by
 * aborting every request that leaves the loopback origin.
 *
 * Declared once at module scope so the definitions (and therefore the `Surface`
 * component identities) are stable across renders, instead of remounting every
 * panel whenever this page's state changes.
 */
const HARNESS_DAEMON_SETTINGS_TABS: readonly DaemonSettingsTabDefinition[] = [
  {
    id: 'resource-limits',
    label: 'Resource limits',
    description: 'Linux CPU and RAM caps for this daemon’s managed fleet.',
    // Wrapped, unlike production, only to inject the in-memory client: the
    // default client would reach the daemon this fixture does not have.
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <CgroupConfigSurface connection={connection} createClient={harnessCgroupClient} />
    ),
  },
  {
    id: 'doctor',
    label: 'Doctor',
    description: 'Programs this daemon host needs, and what each absence breaks.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <DoctorSettings
        connection={connection}
        read={async target => {
          if (target.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
          return HARNESS_DOCTOR;
        }}
      />
    ),
  },
  {
    id: 'performance',
    label: 'Performance',
    description: 'Measure what this machine and this app spend their time on, and get a report safe to share.',
    // A window of a second and a half, on a fixture machine and a recorder that already holds a minute of reads.
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <PerformanceSettings
        connection={connection}
        createClient={HARNESS_PERFORMANCE_CLIENT}
        recorder={HARNESS_RECORDER}
      />
    ),
  },
  {
    id: 'security-log',
    label: 'Security log',
    description: 'Recent pairings, removals, refused attempts and other security events on this machine.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <SecurityLogSurface connection={connection} createClient={harnessSecurityClient} />
    ),
  },
  {
    id: 'files',
    label: 'Files',
    description: 'The YAML files this machine’s settings live in.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <ConfigFilesSurface
        key={connection.daemonId}
        connection={connection}
        createClient={HARNESS_CONFIG_FILES_CLIENT}
      />
    ),
  },
  {
    id: 'about',
    label: 'About & updates',
    description: 'This machine’s version, how it was installed, and updating it.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <AboutMachineSurface connection={connection} createClient={harnessAboutClient} />
    ),
  },
  {
    id: 'agent-clis',
    label: 'Agent CLIs',
    description: 'The Claude Code and Codex this machine runs, whether Ferretry verified them, and updating them.',
    Surface: ({ connection }: { readonly connection: DaemonConnection }) => (
      <AgentClisSurface connection={connection} createClient={harnessAgentClisClient} />
    ),
  },
];

/** Minutes before this page loaded, so the relative times in a capture read as a real recent history. */
const harnessMinutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * SETTINGS › MACHINE › ABOUT, answered in the page (`docs/updating.md`). `?about=manual` makes the
 * harness daemon a deb install (steps, no button); otherwise it is a Homebrew install with 4.29.0 out and
 * two ferrets mid-turn, so the "they keep running" line and Update when idle are on screen. Update starts
 * the update; Update when idle waits.
 * The app is stamped 4.29.0 against the machine's 4.28.0, so the version warning is on screen too.
 */
(globalThis as { __FY_APP_VERSION__?: string }).__FY_APP_VERSION__ = '4.29.0';
const HARNESS_ABOUT_MANUAL = new URLSearchParams(window.location.search).get('about') === 'manual';
const HARNESS_ABOUT_VIEW: DaemonUpdateView = {
  current: '4.28.0',
  ...(HARNESS_ABOUT_MANUAL
    ? {
        method: { kind: 'system-package', manager: 'apt' },
        plan: {
          kind: 'manual',
          explanation:
            'This daemon was installed by the system package manager, which needs sudo. Ferretry never asks for it.',
          steps: [
            { command: 'sudo apt-get update && sudo apt-get install --only-upgrade fy' },
            { command: 'fy daemon restart' },
          ],
        },
      }
    : {
        method: { kind: 'homebrew', cask: 'ferretry' },
        plan: {
          kind: 'self',
          steps: [{ command: 'brew upgrade --cask ferretry' }, { command: 'fy daemon restart' }],
          rollback: 'none',
        },
      }),
  check: {
    state: 'ok',
    checkedAt: harnessMinutesAgo(42),
    latest: { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' },
  },
  available: true,
  midTurn: 2,
  autoInstall: false,
  job: null,
};
/** The machine list's update dot: the harness daemon says 4.29.0 is out; every other machine says nothing. */
const HARNESS_UPDATE_CLIENT: FleetClientFactory = async connection => ({
  request: async <T,>(path: string, schema: ZodType<T>): Promise<T> => {
    if (connection.daemonId !== daemon.daemonId) throw new Error(`no ${path} on this harness machine`);
    return schema.parse(HARNESS_ABOUT_VIEW);
  },
});
const harnessAboutClient = async (connection: DaemonConnection) => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  let view = HARNESS_ABOUT_VIEW;
  return {
    daemonUpdate: async () => view,
    startDaemonUpdate: async (request: DaemonUpdateStartRequest): Promise<DaemonUpdateView> => {
      view = {
        ...view,
        job:
          request.when === 'now'
            ? { state: 'running', target: request.target, startedAt: new Date().toISOString() }
            : { state: 'waiting-for-idle', target: request.target, requestedAt: new Date().toISOString(), midTurn: 2 },
      };
      return view;
    },
    updateDaemonUpdateSettings: async (patch: DaemonUpdateSettingsPatch) => {
      view = { ...view, autoInstall: patch.autoInstall };
      return view;
    },
  };
};

/**
 * SETTINGS › MACHINE › AGENT CLIs, answered in the page (`docs/updating.md`). `?agent-clis=<state>` picks
 * which install methods the harness daemon reports, so every method can be captured:
 *
 * - `npm` (default): Claude Code from an nvm npm global (verified + newest buttons), Codex from a Homebrew cask;
 * - `nix`: Claude Code from home-manager inside nix-darwin (the flake steps), Codex from a nix profile element;
 * - `native`: Claude Code from its own installer after a finished update, Codex a standalone binary past the
 *   verified version.
 *
 * Every Update past the verified version answers `409 harness_update_unverified` unless confirmed, so the
 * second question is reachable by clicking; a confirmed one starts a running job.
 */
const HARNESS_CLIS_STATE = new URLSearchParams(window.location.search).get('agent-clis') ?? 'npm';
const HARNESS_CLI_VERIFIED_URL =
  'https://github.com/kirinnee/ferretry/blob/main/packages/fleet/tests/contract/README.md';
const HARNESS_CLAUDE_CHANGELOG = 'https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md';
const harnessCliCheck = (version: string, url: string) =>
  ({ state: 'ok', checkedAt: harnessMinutesAgo(0), latest: { version, url } }) as const;
const HARNESS_CLAUDE_LATEST = harnessCliCheck('2.1.230', HARNESS_CLAUDE_CHANGELOG);
const HARNESS_CODEX_LATEST = harnessCliCheck('0.163.0', 'https://github.com/openai/codex/releases/tag/rust-v0.163.0');
const HARNESS_CLIS_VIEWS: Readonly<Record<string, HarnessUpdateView>> = {
  npm: {
    harnesses: [
      {
        harness: 'claude',
        location: {
          state: 'located',
          path: '/home/kirin/.nvm/versions/node/v22.11.0/bin/claude',
          rule: 'inherited environment',
          declaredBy: 'PATH',
        },
        installed: { state: 'ok', version: '2.1.200' },
        method: {
          kind: 'npm-global',
          tool: 'npm',
          package: '@anthropic-ai/claude-code',
          prefix: '/home/kirin/.nvm/versions/node/v22.11.0',
          nodeManager: 'nvm',
        },
        plan: {
          kind: 'self',
          steps: [
            {
              command:
                'npm install -g --prefix /home/kirin/.nvm/versions/node/v22.11.0 @anthropic-ai/claude-code@latest',
            },
          ],
          rollback: 'automatic',
          pinsVersion: true,
        },
        check: HARNESS_CLAUDE_LATEST,
        verified: { version: '2.1.220', url: HARNESS_CLI_VERIFIED_URL },
        verification: 'older',
        available: true,
        job: null,
      },
      {
        harness: 'codex',
        location: {
          state: 'located',
          path: '/opt/homebrew/bin/codex',
          rule: 'explicit override',
          declaredBy: 'FY_CODEX_BIN',
        },
        installed: { state: 'ok', version: '0.145.0' },
        method: { kind: 'homebrew', type: 'cask', package: 'codex' },
        plan: {
          kind: 'self',
          steps: [{ command: 'brew update' }, { command: 'brew upgrade --cask codex' }],
          rollback: 'none',
          pinsVersion: false,
        },
        check: HARNESS_CODEX_LATEST,
        verified: { version: '0.145.0', url: HARNESS_CLI_VERIFIED_URL },
        verification: 'verified',
        available: true,
        job: null,
      },
    ],
  },
  nix: {
    harnesses: [
      {
        harness: 'claude',
        location: {
          state: 'located',
          path: '/etc/profiles/per-user/kirin/bin/claude',
          rule: 'extra search path',
          declaredBy: 'harness.searchPaths',
        },
        installed: { state: 'ok', version: '2.1.220' },
        method: { kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' },
        plan: {
          kind: 'manual',
          explanation:
            'Claude Code comes from your home-manager configuration, which nix-darwin applies, which pins the version in its flake. Bump the input there, then switch.',
          steps: [
            {
              command: 'nix flake update nixpkgs',
              note: 'in the flake that holds your home-manager configuration; the input that provides claude-code is usually nixpkgs, or an overlay that packages it',
            },
            {
              command: 'darwin-rebuild switch --flake .',
              note: 'home-manager is applied by this nix-darwin rebuild; there is no separate home-manager switch',
            },
          ],
        },
        check: HARNESS_CLAUDE_LATEST,
        verified: { version: '2.1.220', url: HARNESS_CLI_VERIFIED_URL },
        verification: 'verified',
        available: true,
        job: null,
      },
      {
        harness: 'codex',
        location: {
          state: 'located',
          path: '/home/kirin/.nix-profile/bin/codex',
          rule: 'inherited environment',
          declaredBy: 'PATH',
        },
        installed: { state: 'ok', version: '0.140.0' },
        method: { kind: 'nix-profile', element: 'codex' },
        plan: {
          kind: 'self',
          steps: [{ command: 'nix profile upgrade --refresh codex' }],
          rollback: 'automatic',
          pinsVersion: false,
        },
        check: HARNESS_CODEX_LATEST,
        verified: { version: '0.145.0', url: HARNESS_CLI_VERIFIED_URL },
        verification: 'older',
        available: true,
        job: null,
      },
    ],
  },
  native: {
    harnesses: [
      {
        harness: 'claude',
        location: {
          state: 'located',
          path: '/home/kirin/.local/bin/claude',
          rule: 'inherited environment',
          declaredBy: 'PATH',
        },
        installed: { state: 'ok', version: '2.1.220' },
        method: { kind: 'native-installer', directory: '/home/kirin/.local/share/claude' },
        plan: { kind: 'self', steps: [{ command: 'claude update' }], rollback: 'automatic', pinsVersion: true },
        check: HARNESS_CLAUDE_LATEST,
        verified: { version: '2.1.220', url: HARNESS_CLI_VERIFIED_URL },
        verification: 'verified',
        available: true,
        job: {
          state: 'finished',
          report: {
            from: '2.1.200',
            to: '2.1.220',
            target: '2.1.220',
            outcome: 'succeeded',
            message:
              'Updated Claude Code 2.1.200 → 2.1.220. Running ferrets keep the version they started with until they are restarted; new ones start on this one.',
            finishedAt: harnessMinutesAgo(3),
          },
        },
      },
      {
        harness: 'codex',
        location: { state: 'located', path: '/usr/local/bin/codex', rule: 'inherited environment', declaredBy: 'PATH' },
        installed: { state: 'ok', version: '0.163.0' },
        method: { kind: 'standalone', directory: '/usr/local/bin' },
        plan: {
          kind: 'manual',
          explanation:
            'Codex here is a file in /usr/local/bin that no package manager Ferretry knows owns — usually a binary from its GitHub releases. Replace it with the new release, or reinstall with npm so later updates are one click.',
          steps: [
            {
              command: 'npm install -g @openai/codex',
              note: 'or download the new release from https://github.com/openai/codex/releases/latest',
            },
          ],
        },
        check: HARNESS_CODEX_LATEST,
        verified: { version: '0.145.0', url: HARNESS_CLI_VERIFIED_URL },
        verification: 'unverified',
        available: false,
        job: null,
      },
    ],
  },
};
const harnessAgentClisClient = async (connection: DaemonConnection) => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  let view = HARNESS_CLIS_VIEWS[HARNESS_CLIS_STATE] ?? (HARNESS_CLIS_VIEWS.npm as HarnessUpdateView);
  return {
    harnessUpdate: async () => view,
    startHarnessUpdate: async (request: HarnessUpdateStartRequest): Promise<HarnessUpdateView> => {
      const entry = view.harnesses.find(harness => harness.harness === request.harness);
      const verified = entry?.verified.version ?? '0.0.0';
      if (request.confirmUnverified !== true && (request.target === undefined || request.target !== verified))
        throw new FyHttpError('not yet verified by Ferretry', 409, HARNESS_UPDATE_CODES.unverified, {
          error: 'not yet verified by Ferretry',
          code: HARNESS_UPDATE_CODES.unverified,
          ...(request.target === undefined ? {} : { target: request.target }),
          verified,
        });
      view = {
        harnesses: view.harnesses.map(harness =>
          harness.harness === request.harness
            ? {
                ...harness,
                job: {
                  state: 'running',
                  startedAt: new Date().toISOString(),
                  command: harness.plan?.steps[0]?.command ?? 'update',
                },
              }
            : harness,
        ),
      };
      return view;
    },
  };
};

/**
 * The security log the harness daemon answers with: every actor kind, a refusal, a failure, and one
 * unreadable line, so the gap warning and both badges are on screen in the same frame.
 */
const HARNESS_AUDIT_VIEW = {
  kept: [
    {
      at: harnessMinutesAgo(12),
      event: 'device.paired',
      actor: { kind: 'device', deviceId: `fy_device_id_${'Ff'.repeat(11)}`, deviceName: 'Ernest’s iPad' },
      subject: `fy_device_id_${'Ff'.repeat(11)}`,
      outcome: 'succeeded',
      detail: { carrier: 'relay' },
    },
  ],
  // One more than the page shows, so "Show older" is on screen and measured.
  keptTotal: 2,
  records: [
    {
      at: harnessMinutesAgo(4),
      event: 'pairing.refused',
      actor: { kind: 'anonymous' },
      outcome: 'refused',
    },
    {
      at: harnessMinutesAgo(13),
      event: 'pairing.code-minted',
      actor: { kind: 'host' },
      outcome: 'succeeded',
    },
    {
      at: harnessMinutesAgo(95),
      event: 'step-up.failed',
      actor: { kind: 'device', deviceId: `fy_device_id_${'Dd'.repeat(11)}`, deviceName: 'Ernest’s Pixel 8' },
      outcome: 'failed',
    },
    {
      at: harnessMinutesAgo(180),
      event: 'secrets.used',
      actor: { kind: 'warden' },
      subject: 'GITHUB_TOKEN',
      outcome: 'succeeded',
    },
    {
      at: harnessMinutesAgo(26 * 60),
      event: 'grants.changed',
      actor: { kind: 'host' },
      outcome: 'succeeded',
    },
  ],
  unreadable: 1,
} as const;

/** The security log client: the healthy daemon answers the fixture, the unreachable one fails. */
const harnessSecurityClient = async (connection: DaemonConnection): Promise<SecurityLogClient> => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  return { request: (async () => HARNESS_AUDIT_VIEW) as SecurityLogClient['request'] };
};

/**
 * The new-device notice's pool for `?device-notice`: one device paired five minutes ago that this
 * browser has not seen. Revoking it answers with the list without it, so "Remove it" is walkable.
 */
const HARNESS_NOTICE_CLIENTS: NewDeviceNoticeClients = {
  client: async connection => {
    if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
    return await HARNESS_PAIRING_CLIENT(connection);
  },
};
const HARNESS_NOTICE_DEVICE = {
  id: `fy_device_id_${'Ff'.repeat(11)}`,
  name: 'Unknown iPad',
  platform: 'browser',
  createdAt: harnessMinutesAgo(5),
  lastSeenAt: harnessMinutesAgo(5),
} as const;
/** Nothing seen yet, in memory only, so the device above is news on every load. */
const HARNESS_NOTICE_STORAGE = {
  getItem: () => '[]',
  setItem: () => undefined,
};

/**
 * The settings fixture is also mounted on a page of its own by
 * `?settings-harness=1`. That gives the screenshot driver the exact 390×844 and
 * 1440×900 responsive canvas instead of measuring a route-sized component
 * through the stacked gallery's gutters. The ordinary gallery card below uses
 * this same component, so the standalone review surface cannot drift from it.
 *
 * `settings-daemons=one` narrows the registry to the healthy current pairing.
 * The default `many` scenario deliberately carries one successful probe, one
 * refusal, and one probe that never answers; all three reachability treatments
 * can therefore be reviewed without a clock or a network request.
 */
function SettingsPageHarness({ standalone = false }: { readonly standalone?: boolean }) {
  const [connections, setConnections] = useState<DaemonConnectionRecord[]>(() =>
    settingsConnections(settingsDaemonScenario()),
  );
  const [activeDaemonId, setActiveDaemonId] = useState(daemon.daemonId);
  const [settings, setSettings] = useState<SttSettings>(HARNESS_STT_SETTINGS);
  // Measured for the daemon on screen, never carried over from the last one.
  const activeCarrier = harnessSettingsCarrier(activeDaemonId);

  // The Machine tab reads the OTHER paired machines from the app store; the harness has none, so it
  // hands them over itself. The other tabs are the harness map's.
  const machineTabs = useMemo<MachineTabSurfaces>(
    () => ({
      ...HARNESS_MACHINE_TABS,
      machine: function HarnessMachineSettings(props: MachineTabProps) {
        return (
          <MachineSettingsTab
            {...props}
            sources={[
              ...connections.filter(candidate => candidate.daemonId !== props.connection.daemonId),
              HARNESS_CLONE_SOURCE,
            ]}
          />
        );
      },
    }),
    [connections],
  );

  const page = (
    <SettingsPage
      daemonId={activeDaemonId}
      connections={connections}
      controls={settingsControls}
      dictation={{
        settings,
        update: patch => setSettings(current => ({ ...current, ...patch })),
        persisted: true,
        recognitionSupport: HARNESS_RECOGNITION_AVAILABLE,
        voice: HARNESS_PARAKEET_ABSENT,
      }}
      notifications={<NotificationSettingsView permission="granted" devices={[]} onRevokeDevice={() => {}} />}
      probeDaemon={harnessSettingsProbe}
      carrier={activeCarrier.carrier}
      relayAdvertised={activeCarrier.relayAdvertised}
      readWardenStatus={async connection => {
        if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
        return WARDEN;
      }}
      createWardenClient={HARNESS_WARDEN_CLIENT}
      createGrantClient={HARNESS_GRANT_CLIENT}
      createPairingClient={HARNESS_PAIRING_CLIENT}
      createPasskeyClient={HARNESS_PASSKEY_CLIENT}
      createSecretClient={HARNESS_SECRET_CLIENT}
      daemonSettingsTabs={HARNESS_DAEMON_SETTINGS_TABS}
      createMachineClient={HARNESS_MACHINE_CLIENT}
      createUpdateClient={HARNESS_UPDATE_CLIENT}
      machineTabs={machineTabs}
      // A stand-in router: the path picks the daemon, the hash is kept on THIS page's address, so a
      // Machines tab or switch stays inside the preview instead of loading a route the harness lacks.
      onNavigate={to => {
        const target = new URL(to, window.location.href);
        const id = decodeURIComponent(target.pathname.split('/')[2] ?? '');
        // The full-screen setup is a route of its own; the preview opens its own page for it, on the
        // step the address's hash names (Import again opens on Claude Code).
        if (target.pathname.endsWith('/setup')) {
          const step = target.hash.replace(/^#/u, '');
          window.location.assign(
            `${window.location.pathname}?machine-setup=${encodeURIComponent(id)}${step === '' ? '' : `&setup-step=${step}`}`,
          );
          return;
        }
        const next = connections.find(connection => String(connection.daemonId) === id);
        if (next) setActiveDaemonId(next.daemonId);
        window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${target.hash}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      }}
      onRenameDaemon={(daemonId, label) =>
        setConnections(current =>
          current.map(connection =>
            connection.daemonId === daemonId
              ? { ...connection, ...(label === undefined ? { label: undefined } : { label }) }
              : connection,
          ),
        )
      }
      onRemoveDaemon={daemonId => {
        const remaining = connections.filter(connection => connection.daemonId !== daemonId);
        setConnections(remaining);
        if (activeDaemonId === daemonId && remaining[0] !== undefined) setActiveDaemonId(remaining[0].daemonId);
      }}
      onAddDaemon={() => {}}
    />
  );

  return standalone ? (
    <section
      id="harness-settings-page"
      aria-label="Settings page preview"
      className="kt-shell h-dvh overflow-hidden bg-surface"
      data-settings-daemon-scenario={connections.length === 1 ? 'one' : 'many'}
    >
      {new URLSearchParams(window.location.search).has('device-notice') ? (
        // The notice as App.tsx mounts it — above the page, inside the shell — for review captures only.
        <div className="flex h-full min-h-0 flex-col gap-2 pt-2">
          <NewDeviceNotices
            connections={connections}
            clients={{
              client: async connection => {
                const client = await HARNESS_NOTICE_CLIENTS.client(connection);
                return {
                  request: (async (path: string, schema: unknown, init?: RequestInit) => {
                    const answer = (await client.request(path, schema as never, init)) as PairedDevicesView;
                    return init?.method === 'DELETE'
                      ? answer
                      : { ...answer, devices: [...answer.devices, HARNESS_NOTICE_DEVICE] };
                  }) as PairingClient['request'],
                };
              },
            }}
            storage={HARNESS_NOTICE_STORAGE}
          />
          <div className="min-h-0 flex-1">{page}</div>
        </div>
      ) : (
        page
      )}
    </section>
  ) : (
    <Card
      id="harness-settings-page"
      aria-label="Settings page preview"
      className="h-[800px] overflow-hidden sm:h-[760px]"
      data-settings-daemon-scenario={connections.length === 1 ? 'one' : 'many'}
    >
      {page}
    </Card>
  );
}

/**
 * `?app-chrome=<destination>`: the app's level-one navigation as a page — the top bar's text links and
 * Find box on a desktop, the bottom bar on a phone — around an empty page, for review captures.
 */
function AppChromeHarness({ active }: { readonly active: string }) {
  useAppViewport();
  const layout = useLayoutMode();
  const phone = layout === 'drawer';
  const destination = (['sessions', 'projects', 'analytics', 'warden', 'learning', 'settings'] as const).find(
    candidate => candidate === active,
  );
  const insights = destination === 'analytics' || destination === 'warden' || destination === 'learning';
  const page =
    destination === 'analytics' ? (
      <GlobalAnalyticsPage
        connection={daemon}
        machines={HARNESS_ANALYTICS_MACHINES}
        view={new URLSearchParams(window.location.search).get('analytics-view') === 'query' ? 'query' : 'overview'}
        onNavigate={() => {}}
        requestAnalytics={HARNESS_GLOBAL_ANALYTICS_REQUEST}
        now={() => ANALYTICS_FIXTURE_NOW}
        initialQuery={new URLSearchParams(window.location.search).get('q')}
      />
    ) : destination === 'learning' ? (
      <LearningHubHarness
        connection={daemon}
        sessions={WORKSPACE_FLEET}
        scanRunning={new URLSearchParams(window.location.search).has('scan-running')}
      />
    ) : destination === 'settings' && new URLSearchParams(window.location.search).has('learning-settings') ? (
      <main className="min-h-0 flex-1 overflow-y-auto p-panel" aria-label="Settings › Learning">
        <h1 className="m-0 mb-3 font-display text-display font-bold tracking-display">Learning</h1>
        <LearningSettingsHarness connection={daemon} sessions={WORKSPACE_FLEET} />
      </main>
    ) : destination === 'warden' ? (
      <WardenPage connection={daemon} slots={{ Overview: HarnessWardenOverview }} />
    ) : destination === 'sessions' ? (
      <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3" data-harness="sessions">
        <SessionsPage
          clock={HARNESS_FROZEN_CLOCK}
          connection={daemon}
          controls={APP_CHROME_SESSIONS_CONTROLS}
          fleet={SESSIONS_PAGE_FLEET}
          onOpenWardenReport={() => {}}
          projects={SESSIONS_PAGE_PROJECTS}
          scopeNavigation={SESSIONS_PAGE_NAVIGATION}
          usage={SESSIONS_PAGE_USAGE}
          wardenStatus={SESSIONS_PAGE_WARDEN}
        />
      </div>
    ) : active === 'warden-settings' ? (
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5" data-harness="warden-settings">
        <div className={INSIGHTS_COLUMN_CLASS}>
          <WardenConfigSurface connection={daemon} createClient={HARNESS_WARDEN_CLIENT} unavailable="message" />
        </div>
      </main>
    ) : (
      <main className="min-h-0 flex-1 p-panel text-cell text-muted">The page goes here.</main>
    );
  return (
    <div className={`kt-shell flex overflow-hidden ${phone ? 'flex-col' : 'flex-row'}`} id="harness-app-chrome">
      {phone ? null : (
        <SessionsBar
          active={insights ? 'insights' : destination === 'projects' || destination === 'settings' ? destination : null}
          activeSessionId={null}
          daemonId={daemon.daemonId}
          machineName="AMER-D22HXVF42W"
          machines={WORKSPACE_MACHINES}
          onAddMachine={() => {}}
          onCollapse={() => {}}
          onNavigate={() => {}}
          onOpenPalette={() => {}}
          learningPassive={LEARNING_PASSIVE}
          presentation={layout === 'rail' ? 'rail' : 'column'}
          projects={[]}
          sessions={WORKSPACE_FLEET}
        />
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-shell-main="">
        {phone ? (
          <AppBar
            crumbs={
              destination === 'sessions'
                ? [{ label: 'Sessions' }]
                : [{ href: daemonSessionsPath(daemon.daemonId), label: 'Sessions' }, { label: 'Settings' }]
            }
            daemon={daemon.daemonId}
            onOpenPalette={() => {}}
            onOpenSidebar={() => {}}
            sessionCount={7}
            active={destination ?? 'settings'}
            tabBarShown={phone}
          />
        ) : null}
        {insights ? (
          <InsightsFrame current={destination} daemonId={daemon.daemonId} onNavigate={() => {}}>
            {page}
          </InsightsFrame>
        ) : (
          page
        )}
        {phone ? (
          <AppTabBar daemon={daemon.daemonId} active={destination ?? 'settings'} onOpenPalette={() => {}} />
        ) : null}
      </div>
    </div>
  );
}
function StandaloneSettingsPageHarness() {
  useAppViewport();
  return <SettingsPageHarness standalone />;
}

/** Setup progress for the harness: in memory, so a capture never reads or leaves a real browser's state. */
const harnessSetupStorage = (): Pick<Storage, 'getItem' | 'setItem'> => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
};

/**
 * `?machine-setup=<daemon>`: one machine's full-screen New machine setup, as the app shows it after pairing
 * a machine that is not set up — no app chrome, only its own rail. `&setup-step=claude` opens it on a step,
 * as Settings' Import again does. Leaving it returns to the Settings preview on that machine.
 */
function StandaloneMachineSetupHarness({ daemonId }: { readonly daemonId: string }) {
  useAppViewport();
  const connections = settingsConnections('many');
  const record =
    connections.find(connection => String(connection.daemonId) === daemonId) ?? HARNESS_SETTINGS_CONNECTIONS[0];
  const storage = useMemo(harnessSetupStorage, []);
  const step = new URLSearchParams(window.location.search).get('setup-step') ?? '';
  return (
    <section
      id="harness-machine-setup"
      aria-label="Machine setup preview"
      className="kt-shell h-dvh overflow-hidden bg-bg"
    >
      <MachineSetupScreen
        connection={record}
        connections={connections}
        createClient={HARNESS_MACHINE_CLIENT}
        createPairingClient={HARNESS_PAIRING_CLIENT}
        voice={HARNESS_PARAKEET_ABSENT}
        storage={storage}
        {...(isMachineSetupStepId(step) ? { startAt: step } : {})}
        onNavigate={to => {
          const target = new URL(to, window.location.href);
          window.location.assign(`${window.location.pathname}?settings-harness=1${target.hash}`);
        }}
      />
    </section>
  );
}

/**
 * The markdown composer preference is a single reader-wide setting, so the
 * harness turns it ON for the whole page: that is the state a reviewer needs to
 * look at, and the composers with an empty draft are unaffected (a placeholder
 * is painted by the textarea, not by the overlay). Toggle it live from the
 * "Composer settings" card when serving the harness by hand.
 */
writeMdComposePref(new URLSearchParams(window.location.search).get('editor') === 'rich' ? 'rich' : 'on');

/** A draft that exercises every paint token the overlay knows. */
const MARKDOWN_DRAFT = [
  '# Port review',
  '',
  'Ping :zelda about **the metric contract** and *the caret*, then read',
  '@packages/pwa/src/lib/composer-markdown.ts:1-24 before &F12 lands.',
  '',
  '> Colour is `paint` only — see [the design record](docs/standards/index.md).',
  '',
  '- lossless tokens',
  '1. best-effort semantics',
  '',
  '```ts',
  'const tokens = tokenizeMarkdown(draft);',
  '```',
].join('\n');
const MARKDOWN_DRAFT_SCOPE = daemonSessionScope(daemon, 'harness-markdown-composer');
const markdownDrafts = new DaemonDraftStore();
markdownDrafts.save(MARKDOWN_DRAFT_SCOPE, MARKDOWN_DRAFT);

const harnessSession = {
  config: {
    id: 'harness-session',
    name: 'Transcript scrolling',
    teammate: 'fable',
    label: 'Port the session screen',
    model: 'gpt-5.6-sol',
    modelHint: 'gpt-5.6',
    agent: 'codex',
    harness: 'codex',
    mode: 'auto',
    cwd: '/work/ferretry',
    updatedAt: '1970-01-01T00:00:01.000Z',
  },
  state: {
    id: 'harness-session',
    status: 'running',
    turn: 4,
    lastActivityAt: '1970-01-01T00:00:01.000Z',
    contextPercent: 54,
    quota: { fiveHourPercent: 7, weeklyPercent: 12 },
    activity: 'Writing tests',
  },
  directory: '/work/ferretry',
} as unknown as SessionView;

const harnessChildSession = {
  ...harnessSession,
  config: { ...harnessSession.config, parent: 'harness-lead' },
} as SessionView;

openSidePaneTab(scope, 'tasks');
openSidePaneFileTab(scope, 'packages/p../src/shell/side-pane-tabs.tsx');
openSidePaneFileTab(scope, 'README.md');

/** Phone below this width, exactly as the app decides its presentation. */
const PHONE_MAX = 768;

/** One session per status class, so all three glyph shapes are on the page. */
const MARK_SESSIONS: readonly (readonly [string, SessionView])[] = [
  ['running', harnessSession],
  [
    'awaiting a human',
    { ...harnessSession, state: { ...harnessSession.state, status: 'awaiting_user' } } as SessionView,
  ],
  [
    'parked',
    {
      ...harnessSession,
      state: {
        ...harnessSession.state,
        status: 'running',
        waiting: { since: '2026-07-31T11:00:00.000Z', peerName: 'freddie', condition: 'CI to go green' },
      },
    } as SessionView,
  ],
  ['completed', { ...harnessSession, state: { ...harnessSession.state, status: 'completed' } } as SessionView],
  ['failed', { ...harnessSession, state: { ...harnessSession.state, status: 'failed' } } as SessionView],
];

/** A local family keeps the Lineage card readable at both required widths. */
const LINEAGE_SESSIONS: readonly SessionView[] = [
  {
    ...harnessSession,
    config: { ...harnessSession.config, id: 'lineage-parent', teammate: 'Fable', name: 'Plan the surface port' },
    state: { ...harnessSession.state, id: 'lineage-parent', status: 'waiting' },
  } as SessionView,
  {
    ...harnessSession,
    config: { ...harnessSession.config, id: 'harness-session', parent: 'lineage-parent' },
  } as SessionView,
  {
    ...harnessSession,
    config: {
      ...harnessSession.config,
      id: 'lineage-child',
      teammate: 'Mira',
      name: 'Render Lineage',
      parent: 'harness-session',
    },
    state: { ...harnessSession.state, id: 'lineage-child', status: 'completed' },
  } as SessionView,
];

const QUOTA_CALM = { fiveHourPercent: 31, weeklyPercent: 58 } as Quota;
const QUOTA_TIGHT = { fiveHourPercent: 92, weeklyPercent: 78, atLimit: true } as Quota;

/** Stands in for a lazy pane whose chunk was pruned by a newer deploy. */
function DeadPane(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'SessionChatPage')");
}

const task = (overrides: Partial<Omit<TaskSummary, 'live'>> & { live?: Partial<TaskLive> }): TaskSummary => ({
  v: 1,
  id: 'F12',
  kind: 'feature',
  // FIVE WORDS. `TaskTitleSchema` caps a title at five, and this fixture used
  // six — type-valid and schema-invalid, so every card rendering it was drawing
  // a task the daemon would refuse. Found by the current-session search, which
  // is the first surface here to parse these rows rather than only render them.
  title: 'Port the remaining PWA components',
  workflow: 'quick',
  phase: 'todo',
  dependsOn: [],
  status: 'todo',
  statusReason: null,
  assignee: null,
  repo: null,
  files: [],
  links: { prs: [], branch: null, commits: [], docs: [] },
  order: null,
  createdAt: '2026-07-30T09:00:00.000Z',
  createdBy: null,
  updatedAt: '2026-07-31T09:00:00.000Z',
  descriptionChars: 0,
  askChars: 40,
  askSource: 'slack',
  clarificationCount: 0,
  blocked: false,
  blockedReason: null,
  blockedSince: null,
  blockedBy: [],
  ...overrides,
  live: {
    assigneeSessionId: null,
    assigneeName: null,
    assigneeStatus: null,
    assigneeHealth: null,
    assigneeDoneMarker: false,
    assigneeLastActivityAt: null,
    staleness: null,
    ...overrides.live,
  },
});

const TASKS: readonly TaskSummary[] = [
  task({
    id: 'F12',
    phase: 'build',
    status: 'in_progress',
    assignee: 'hayden',
    files: ['packages/pwa/src/features/tasks/task-row.tsx'],
    links: { prs: ['https://github.com/kirinnee/ferretry/pull/49'], branch: null, commits: [], docs: [] },
    live: { assigneeSessionId: 'harness-session', assigneeName: 'Hayden', assigneeHealth: 'active' },
  }),
  task({
    id: 'B7',
    kind: 'bug',
    title: 'Transcript detaches on prepend',
    phase: 'build',
    status: 'blocked',
    blocked: true,
    statusReason: 'waiting on the scroller port',
    blockedReason: 'Blocked by the scroller port',
    blockedBy: ['F12'],
    askChars: 40,
    askSource: 'agent: warden',
    live: { staleness: 'quiet', assigneeHealth: 'unknown' },
  }),
  task({
    id: 'C3',
    kind: 'chore',
    title: 'Retire the legacy state path',
    phase: 'done',
    status: 'done',
    dependsOn: ['F12'],
  }),
];
const TASK_DAG = taskDag(TASKS);

const WARDEN: WardenStatusView = WARDEN_FIXTURE_STATUS;

/** A daemon that has its configuration but has never produced a report. */
const WARDEN_NOT_REPORTING: WardenStatusView = {
  ...WARDEN,
  anomalies: [],
  failover: undefined,
  lastSweepAt: undefined,
  liveWarden: undefined,
};

const WARDEN_CONFIG: WardenConfigView = WARDEN_FIXTURE_CONFIG;

/** One concrete host diagnosis keeps the Doctor tab reviewable without a daemon. */
const HARNESS_DOCTOR: DoctorReport = {
  ready: false,
  harnesses: [
    { kind: 'claude', launchable: ['claude-auto-studio'], blocked: [] },
    { kind: 'codex', launchable: [], blocked: ['codex-auto-studio: not on PATH'] },
  ],
  checks: [
    { name: 'tmux', requirement: 'required', status: 'present', summary: 'on PATH', impact: 'sessions can start' },
    {
      name: 'codex-auto-studio',
      requirement: 'required',
      status: 'missing',
      summary: 'not on PATH',
      impact: 'Codex sessions cannot start on this daemon.',
    },
  ],
  limitation: 'PATH presence is all this report proves.',
};

/**
 * The secret store as the screen meets it.
 *
 * The values are absent from this fixture because they are absent from the wire: the daemon serves
 * no route that returns one, so there is nothing for a harness to invent. What a review is looking
 * at is a name, an instant, a mask, and a configured reference that does not resolve.
 */
const SECRETS_READY: SecretList = {
  v: SECRET_SCHEMA_VERSION,
  health: 'ready',
  secrets: [
    { name: 'ANTHROPIC_API_KEY', createdAt: '2026-03-02T09:00:00.000Z', updatedAt: '2026-03-02T09:00:00.000Z' },
    { name: 'GITHUB_TOKEN', createdAt: '2026-01-11T09:00:00.000Z', updatedAt: '2026-07-28T16:20:00.000Z' },
  ],
  references: [
    { name: 'ANTHROPIC_API_KEY', origin: 'config/daemon.json → secretEnvironment.AUTH', resolved: true },
    { name: 'STRIPE_KEY', origin: 'config/daemon.json → secretEnvironment.BILLING', resolved: false },
  ],
};

/** Damaged is its own state, never an empty list. */
const SECRETS_DAMAGED: SecretList = {
  v: SECRET_SCHEMA_VERSION,
  health: 'damaged',
  diagnosis:
    'this daemon holds sealed secrets and the key that opens them is gone; restore the key file or delete the vault and set the secrets again',
  secrets: [],
  references: [{ name: 'ANTHROPIC_API_KEY', origin: 'config/daemon.json → secretEnvironment.AUTH', resolved: false }],
};

/**
 * The grant fixtures, as a PAIRED browser sees them — a browser on the machine itself included, because
 * only the CLI is the owner at the machine. A browser is always governed, so every state worth reviewing
 * is on this side of the boundary: a capability the operator switched off, a configure axis waiting on a
 * passkey confirmation, and the same machine after that confirmation.
 */
const grantEntry = (
  capability: DaemonCapability,
  granted: { use: boolean; configure: boolean },
  useRefusal: GrantRefusal,
  configureRefusal: GrantRefusal,
  origin: 'default' | 'config file' = 'default',
): CapabilityGrantView => ({
  capability,
  use: useRefusal === 'granted',
  configure: configureRefusal === 'granted',
  granted,
  mayGrant: false,
  useRefusal,
  configureRefusal,
  origin,
});

const on = { use: true, configure: true };

/** A paired phone that has not confirmed with its passkey: every dangerous demand reads `step-up-required`. */
const HARNESS_GRANTS_STEP_UP: GrantsView = {
  capabilities: [
    grantEntry('fleet', on, 'granted', 'step-up-required'),
    grantEntry('terminal', { use: false, configure: false }, 'not-granted', 'not-granted', 'config file'),
    grantEntry('browser', on, 'step-up-required', 'step-up-required'),
    grantEntry('filesystem', on, 'granted', 'step-up-required', 'config file'),
    grantEntry('warden', { use: true, configure: false }, 'granted', 'not-granted', 'config file'),
    grantEntry('pairing', on, 'step-up-required', 'step-up-required', 'config file'),
  ],
  governed: true,
  hostLocal: false,
  steppedUp: false,
};

/** The same phone after one passkey touch: what the operator allowed is open, and the view says so. */
const HARNESS_GRANTS_STEPPED_UP: GrantsView = {
  capabilities: [
    grantEntry('fleet', on, 'granted', 'granted'),
    grantEntry('terminal', { use: false, configure: false }, 'not-granted', 'not-granted', 'config file'),
    grantEntry('browser', on, 'granted', 'granted'),
    grantEntry('filesystem', on, 'granted', 'granted', 'config file'),
    grantEntry('warden', { use: true, configure: false }, 'granted', 'not-granted', 'config file'),
    grantEntry('pairing', on, 'granted', 'granted', 'config file'),
  ],
  governed: true,
  hostLocal: false,
  steppedUp: true,
};

/** A daemon that cannot read its own grant document: denied, loudly, and not shown as permissive. */
const HARNESS_GRANTS_UNDETERMINED: GrantsView = {
  capabilities: DAEMON_CAPABILITIES.map(capability => grantEntry(capability, on, 'undetermined', 'undetermined')),
  governed: true,
  hostLocal: false,
  steppedUp: false,
};

/**
 * THE PAIRING CODE IN EVERY CAPTURE IS FAKE, AND IT HAS TO BE.
 *
 * A committed PNG of a real minted code would be a real credential in the repository, readable by
 * anybody who can read the review — a QR is not obfuscation, it is a machine-readable label. So the
 * harness never mints: the code, the id and the fingerprint below are invented, the daemon address is
 * `example.test`, and the expiry is frozen so the countdown renders the same number in every capture.
 */
const HARNESS_PAIR_NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');
const HARNESS_PAIR_DAEMON_ID = `fy_daemon_${'Hh'.repeat(21)}A`;
const HARNESS_PAIR_URL = `https://ferretry.pages.dev/pair#v1;url=${encodeURIComponent('https://workstation.example.test')};code=7F3K-Q2ND;fp=${encodeURIComponent(HARNESS_PAIR_DAEMON_ID)}`;

const HARNESS_INVITE: PairingCodeMintResponse = {
  pairingId: `fy_pair_${'Pp'.repeat(11)}`,
  code: '7F3K-Q2ND',
  ttlSeconds: 120,
  expiresAt: '2026-01-01T00:01:34.000Z',
  daemonId: HARNESS_PAIR_DAEMON_ID,
  daemonName: 'workstation',
  daemonUrl: 'https://workstation.example.test',
  pairUrl: HARNESS_PAIR_URL,
  reach: 'any-device',
};

const harnessGrants = (held: Partial<Record<DaemonCapability, Partial<CapabilityGrant>>>): CapabilityGrants =>
  Object.fromEntries(
    DAEMON_CAPABILITIES.map(capability => [capability, { use: false, configure: false, ...held[capability] }]),
  ) as CapabilityGrants;

const HARNESS_DEVICE_GRANTS_DEFAULT = harnessGrants({ fleet: { use: true } });
const HARNESS_DEVICE_GRANTS_WIDENED = harnessGrants({
  fleet: { use: true, configure: true },
  terminal: { use: true },
  secrets: { use: true },
});
const HARNESS_MAY_WIDEN = harnessGrants({
  fleet: { use: true, configure: true },
  terminal: { use: true },
  pairing: { configure: true },
});

/** Two devices, one of them the browser doing the looking, so the "this device" mark is reviewable. */
const HARNESS_PAIRED_DEVICES: PairedDevicesView = {
  devices: [
    {
      id: `fy_device_id_${'Dd'.repeat(11)}`,
      name: 'Ernest’s Pixel 8',
      platform: 'browser',
      createdAt: '2025-12-20T18:22:00.000Z',
      lastSeenAt: '2025-12-31T22:04:00.000Z',
      idleExpiresAt: '2026-12-31T00:00:00.000Z',
      // The default a fresh device holds — fleet.use alone — so the browser doing the looking can be
      // seen holding the least, with every widen it may not make explained beside its switch.
      grants: HARNESS_DEVICE_GRANTS_DEFAULT,
    },
    {
      id: `fy_device_id_${'Ee'.repeat(11)}`,
      name: 'Studio iMac',
      platform: 'browser',
      createdAt: '2025-11-02T09:15:00.000Z',
      lastSeenAt: '2025-11-02T09:15:00.000Z',
      idleExpiresAt: '2026-12-31T00:00:00.000Z',
      grants: HARNESS_DEVICE_GRANTS_WIDENED,
    },
  ],
  hostLocal: false,
  thisDeviceId: `fy_device_id_${'Dd'.repeat(11)}`,
  // A remote caller holding terminal and fleet (and pairing.configure): it may widen those, and no more,
  // so the rest render their reason and the host command instead of a switch that would fail.
  mayWiden: HARNESS_MAY_WIDEN,
};

/**
 * The pairing client the settings harness mounts.
 *
 * IT NEVER MINTS A REAL CODE. Every value it answers with is the frozen fake above, so no capture and no
 * served harness session can put a working credential on screen or in a PNG. The unreachable pairing
 * throws, so the refusal panel is reviewable in the frame as well as in its own gallery card.
 */
/**
 * The passkey client the settings harness mounts. It registers nothing: the list is a frozen fixture of
 * two passkeys, so no capture can contain a credential and no served session can open a real prompt.
 */
const HARNESS_PASSKEYS: PasskeysView = {
  passkeys: [
    { id: 'Ab'.repeat(16), origin: 'https://ferretry.example.test', createdAt: '2025-12-20T18:22:00.000Z' },
    { id: 'Cd'.repeat(16), origin: 'https://ferretry.example.test', createdAt: '2025-12-28T09:05:00.000Z' },
  ],
  registration: 'confirm-existing',
  stepUpUntil: '2026-01-01T00:15:00.000Z',
};

/**
 * The security settings a remote phone sees: the machine's own document, presence switched ON so the
 * loosening sentence is on screen without a press, and a caller that may not loosen anything.
 */
const HARNESS_SECURITY: SecuritySettingsView = {
  settings: {
    stepUpWindowMinutes: 15,
    deviceKeyRotationDays: 30,
    unlockOnOpen: true,
    unlockValidityHours: 8,
    stepUpOnActions: true,
    idleExpiryDays: 30,
  },
  source: 'document',
  mayWiden: false,
  widenCommand: 'fy daemon security set <field> <value>',
};

/**
 * THE UNLOCK PROMPT, as a machine that is locked meets it. Opened only under `?unlock-prompt`, so every
 * other frame is unchanged; its line reads the hours the way the app does, from the machine's own number.
 */
const HARNESS_UNLOCK_GATE = new StepUpGate({
  ceremony: async () => {},
  describe: () => 'The passkey did not check out.',
  scope: async () => unlockStaysSentence(HARNESS_SECURITY.settings.unlockValidityHours),
});
if (window.location.search === '?unlock-prompt') void HARNESS_UNLOCK_GATE.require(daemon);

/** The secret store's client: answers the one list the panel reads, and no write. */
const HARNESS_SECRET_CLIENT: SecretClientFactory = async connection => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  return { request: (async () => SECRETS_READY) as SecretClient['request'] };
};

const HARNESS_PASSKEY_CLIENT: PasskeyClientFactory = async connection => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  return {
    request: (async (path: string, _schema: unknown, init?: RequestInit) => {
      if (path === '/v1/security' && init?.method === 'PATCH') throw new Error('the harness changes nothing');
      return path === '/v1/security' ? HARNESS_SECURITY : HARNESS_PASSKEYS;
    }) as StepUpClient['request'],
  };
};

const HARNESS_PAIRING_CLIENT: PairingClientFactory = async connection => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  let devices = HARNESS_PAIRED_DEVICES;
  return {
    request: (async (path: string, _schema: unknown, init?: RequestInit) => {
      if (path === '/v1/pair/code' && init?.method === 'POST') return HARNESS_INVITE;
      if (path.startsWith('/v1/pair/code/') && init?.method === 'DELETE')
        return { pairingId: HARNESS_INVITE.pairingId, status: 'expired', expiresAt: HARNESS_INVITE.expiresAt };
      if (path.endsWith('/grants') && init?.method === 'PATCH') {
        const id = decodeURIComponent(path.slice('/v1/pair/devices/'.length, -'/grants'.length));
        const patch = JSON.parse(String(init.body)) as Record<string, Partial<CapabilityGrant>>;
        devices = {
          ...devices,
          devices: devices.devices.map(device =>
            device.id === id
              ? {
                  ...device,
                  grants: Object.fromEntries(
                    DAEMON_CAPABILITIES.map(capability => [
                      capability,
                      { ...device.grants[capability], ...patch[capability] },
                    ]),
                  ) as CapabilityGrants,
                }
              : device,
          ),
        };
        return devices;
      }
      if (path.startsWith('/v1/pair/devices/') && init?.method === 'DELETE') {
        const id = decodeURIComponent(path.slice('/v1/pair/devices/'.length));
        devices = { ...devices, devices: devices.devices.filter(device => device.id !== id) };
        return devices;
      }
      return devices;
    }) as PairingClient['request'],
  };
};

/**
 * The grant client the settings harness mounts.
 *
 * The unreachable pairing THROWS, so the "limits unavailable" panel is reviewable: a failed read must
 * never render as five allowed rows, and that is exactly the state a screenshot has to prove.
 */
/**
 * The Machines section's reads, answered locally: `GET /v1/fleet/machine` for the switcher (the
 * unreachable pairing is offline, the first is set up, the rest are not), plus what the Settings tab's
 * flows read — the setup scan, with one tool missing, on top of the shared catalogue — so Import again,
 * Clone and Install are walkable without a daemon.
 */
const HARNESS_MACHINE_CLIENT: FleetClientFactory = async connection => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  const setUp = connection.daemonId === daemon.daemonId || connection.daemonId === cloneSourceDaemon.daemonId;
  const answer = (path: string, init?: RequestInit): unknown => {
    // New machine setup and Copy settings: Speed-ups, Warden, Learning, secret names, settings files.
    const setup = machineSetupAnswer(String(connection.daemonId), setUp, path, init);
    if (setup !== undefined) return setup;
    if (path === '/v1/fleet/export') return HARNESS_CLONE_EXPORT;
    if (path === '/v1/fleet/setup/scan') return setUp ? HARNESS_SETUP_SCAN : HARNESS_FIRST_RUN_SCAN;
    if (path !== '/v1/fleet/machine') return harnessCatalogAnswer(path, init);
    return {
      name: 'studio-mac',
      format: setUp ? 'version-2' : 'none',
      setUp,
      agentPermissions: 'auto',
      defaultRuntime: setUp ? 'claude-default' : null,
      agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false },
      tools: [{ harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' }],
      runtimeCount: setUp ? 5 : 0,
      runningSessions: 0,
      // The host's own browser: it may apply, and nothing more is asked.
      authority: { mayApply: true, applyRefusal: 'granted' },
    };
  };
  return {
    request: (async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) =>
      // A profile's Edit as YAML reads its file through the same client, as it does from a real daemon.
      path.startsWith('/v1/config/') && machineSetupAnswer(String(connection.daemonId), setUp, path, init) === undefined
        ? (await HARNESS_CONFIG_FILES_CLIENT(connection)).request(path, schema as never, init)
        : schema.parse(answer(path, init))) as Awaited<ReturnType<FleetClientFactory>>['request'],
    // Offered so removing a runtime shows its "Move them to…" picker; the gallery never confirms a move.
    migrate: async () => {
      throw new Error('the harness moves no ferret');
    },
  };
};

/**
 * What "Work laptop" exports for Clone: everything the preview has to spell out before it may copy —
 * an MCP server's command line and variables, a hook script, and a settings file with a status-line
 * command and a permission rule — next to plain instructions that run nothing.
 */
const HARNESS_CLONE_EXPORT = {
  format: 'ferretry-clone',
  version: 1,
  machine: 'work-mac',
  exportedAt: '2026-10-13T09:00:00.000Z',
  credentials: [{ id: 'claude-work', harness: 'claude', email: 'someone.with.a.long.address@example.com' }],
  components: {
    instructions: { main: { file: 'components/instructions/main.md' } },
    mcp: {
      notes: {
        command: 'npx',
        args: ['-y', '@acme/notes-mcp', '--vault', '/Users/kirin-on-a-long-machine-name/Documents/Notes'],
        env: { NOTES_TOKEN: secretReference('NOTES_TOKEN'), NODE_OPTIONS: '--max-old-space-size=4096' },
      },
    },
    hooks: { guard: { harness: 'claude', directory: 'components/hooks/guard' } },
    settings: {
      claude: {
        harness: 'claude',
        file: 'components/settings/claude.json',
        flags: ['--permission-mode', 'acceptEdits'],
      },
    },
  },
  profiles: { default: { layers: ['instructions/main', 'mcp/notes', 'hooks/guard', 'settings/claude'] } },
  runtimes: { 'claude-work': { credential: 'claude-work', profile: 'default', agent: false } },
  files: [
    { path: 'components/instructions/main.md', content: '# Work rules\n' },
    {
      path: 'components/hooks/guard/pre-tool-use.sh',
      content: '#!/bin/sh\n# Refuse a push straight to main.\ngrep -q "git push origin main" && exit 2\nexit 0\n',
    },
    {
      path: 'components/settings/claude.json',
      content: JSON.stringify(
        {
          statusLine: { type: 'command', command: '~/.claude/statusline.sh' },
          permissions: { allow: ['Bash(npm test:*)', 'Bash(git status)'] },
          theme: 'dark',
        },
        null,
        2,
      ),
    },
  ],
  notCopied: [],
};

/**
 * What the first run finds on a machine that is not set up: both tools installed, Claude Code signed in
 * with a full setup, and Codex installed but not signed in — so the Codex step offers Sign in now.
 */
const HARNESS_FIRST_RUN_SCAN = {
  machine: 'studio-mac',
  format: 'none',
  tools: [
    { harness: 'claude', label: 'Claude Code', installed: true },
    { harness: 'codex', label: 'Codex', installed: true },
  ],
  harnesses: [
    {
      harness: 'claude',
      installed: true,
      account: { state: 'signed-in', email: 'someone.with.a.long.address@example.com' },
      instructions: { name: 'CLAUDE.md', source: 'CLAUDE.md', bytes: 2150 },
      settings: { source: 'settings.json', count: 6, hooks: 1 },
      mcpServers: ['github', 'linear', 'notes'],
      skills: ['release-notes', 'pr-review', 'changelog'],
      secretKeys: ['env.GITHUB_TOKEN'],
      missingCommands: [],
      problems: [],
    },
    {
      harness: 'codex',
      installed: true,
      account: { state: 'not-signed-in' },
      instructions: { name: 'AGENTS.md', source: 'AGENTS.md', bytes: 1400 },
      mcpServers: ['github'],
      skills: [],
      secretKeys: [],
      missingCommands: [],
      problems: [],
    },
  ],
  instructionsIdentical: false,
  runtimes: [
    { harness: 'claude', name: 'claude-default', profile: 'default' },
    { harness: 'codex', name: 'codex-default', profile: 'default' },
  ],
  updates: [],
  duplicates: [],
  notes: [],
  importing: { available: true },
};

/** What Import again finds on the harness machine: a full Claude Code setup, and Codex not installed. */
const HARNESS_SETUP_SCAN = {
  machine: 'studio-mac',
  format: 'version-2',
  tools: [
    { harness: 'claude', label: 'Claude Code', installed: true },
    {
      harness: 'codex',
      label: 'Codex',
      installed: false,
      install: { kind: 'runnable', command: 'npm install -g @openai/codex' },
    },
  ],
  harnesses: [
    {
      harness: 'claude',
      installed: true,
      account: { state: 'refresh-due', email: 'someone.with.a.long.address@example.com' },
      instructions: { name: 'CLAUDE.md', source: 'CLAUDE.md', bytes: 2150 },
      settings: { source: 'settings.json', count: 6, hooks: 1 },
      mcpServers: ['github', 'linear', 'notes'],
      skills: ['release-notes', 'pr-review', 'changelog', 'db-migrate', 'incident-summary'],
      secretKeys: ['env.GITHUB_TOKEN', 'env.LINEAR_API_KEY'],
      missingCommands: ['uvx'],
      problems: [],
    },
    {
      harness: 'codex',
      installed: false,
      account: { state: 'not-signed-in' },
      mcpServers: [],
      skills: [],
      secretKeys: [],
      missingCommands: [],
      problems: [],
    },
  ],
  runtimes: [],
  updates: [{ reference: 'settings/claude', sources: ['settings.json'] }],
  duplicates: [{ harness: 'claude', existing: 'claude-default', suggested: 'claude-default-2' }],
  notes: [],
  importing: { available: true },
};

const HARNESS_GRANT_CLIENT: GrantClientFactory = async connection => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  let view = HARNESS_GRANTS_STEPPED_UP;
  return {
    request: (async (_path: string, _schema: unknown, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as Partial<Record<DaemonCapability, Partial<typeof on>>>;
        view = {
          ...view,
          capabilities: view.capabilities.map(entry => {
            const change = patch[entry.capability];
            if (change === undefined) return entry;
            const granted = {
              use: change.use ?? entry.granted.use,
              configure: change.configure ?? entry.granted.configure,
            };
            return { ...entry, granted, origin: 'config file' as const };
          }),
        };
      }
      return view;
    }) as GrantClient['request'],
  };
};

/** The settings harness owns its Warden fixture too: no visual review should
 * dial a live daemon, and the unreachable pairing stays unavailable rather
 * than borrowing the healthy daemon’s policy. */
const HARNESS_WARDEN_CLIENT: WardenClientFactory = async connection => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  return {
    wardenConfig: async () => WARDEN_CONFIG,
    wardenStatus: async () => WARDEN,
    updateWardenConfig: async () => WARDEN_CONFIG,
    request: wardenFixtureRequest,
  };
};

/** The Warden page's reads, answered from the fixture day; a sweep or investigate request answers in words. */
const HARNESS_WARDEN_OVERVIEW_CLIENT = async () => ({
  wardenStatus: async () => WARDEN_FIXTURE_STATUS,
  wardenAttention: async () => WARDEN_FIXTURE_ATTENTION,
  wardenRun: async () => ({ sweptAt: new Date(WARDEN_FIXTURE_NOW).toISOString(), anomalies: [] }),
  wardenInvestigate: async ({ sessionId }: { readonly sessionId: string }) => ({
    sessionId,
    state: 'queued' as const,
    position: 1,
    message: 'Queued: next in line for an investigation.',
  }),
  wardenLeave: async ({ sessionId }: { readonly sessionId: string }) => ({
    blessing: {
      sessionId,
      kinds: ['sus_thinking' as const],
      expiresAt: new Date(WARDEN_FIXTURE_NOW + 4 * 3_600_000).toISOString(),
      by: 'owner' as const,
    },
    message: 'Left alone for 4 h. A new kind of trouble, or a change of status, still raises a flag.',
  }),
  wardenReport: async (reportPath: string) => `# Verdict: KILL\n\nEvidence from ${reportPath}.`,
});

/** The Warden page as the app mounts it, on the fixture day. */
function HarnessWardenOverview({ connection }: { readonly connection: DaemonConnection }) {
  return (
    <WardenOverviewSurface
      connection={connection}
      sessions={WORKSPACE_FLEET}
      createClient={HARNESS_WARDEN_OVERVIEW_CLIENT}
      now={() => WARDEN_FIXTURE_NOW}
    />
  );
}

/** Settings › Warden, controlled the way Settings holds it, without a daemon. */
function HarnessWardenConfig({ view = WARDEN_CONFIG }: { readonly view?: WardenConfigView }) {
  const [draft, setDraft] = useState(view.config);
  return (
    <WardenConfigCard
      view={view}
      draft={draft}
      onChange={setDraft}
      jevKey={{ state: 'missing', keyUrl: 'https://typesafe.ai/keys' }}
      loginOptions={(view.login?.available ?? []).map(agent => ({ agent }))}
      speedupsHref="#speedups"
      onSave={() => {}}
    />
  );
}

/** Frozen so the screenshots of two runs are byte-identical. */
const HARNESS_NOW = Date.parse('2026-07-31T12:00:00.000Z');

/** A camera that never decodes: the harness needs the control enabled, not a scan. */
const HARNESS_SCAN_HOST: QrScanHost = { supported: true, scan: async () => await new Promise<string>(() => {}) };

/**
 * One store per setup screen, so each card is a different point in a journey.
 *
 * Seeded through a READ-ONLY fake storage rather than through the store's
 * `entry` option: `entry` names a route and lands on its first step, which is
 * the right behaviour for an arrival and useless for a gallery that has to show
 * the middle of one. The fake answers with a fixed document and swallows every
 * write, so a review page can neither read nor overwrite the real reader's
 * `fy-onboarding-v4` progress.
 *
 * THE JOURNEY IS SEEDED IN FULL, not just the route: which computer runs the
 * daemon and who installs it are what decide the list of steps, and a document
 * naming a route alone is refused by the parser rather than guessed at.
 */
const harnessOnboarding = (
  journey: Record<string, string>,
  current: OnboardingStepId,
  device: DeviceKind = 'desktop',
): OnboardingProgressStore =>
  new OnboardingProgressStore({
    device,
    storage: {
      getItem: () =>
        JSON.stringify({
          v: ONBOARDING_PROGRESS_VERSION,
          stage: 'walk',
          ...journey,
          current,
          furthest: current,
        }),
      setItem: () => {},
    },
    paired: true,
  });

/** The daemon subflow, walked by hand on the machine holding the page. */
const hereByHand = (route: OnboardingRouteId = 'first-time'): Record<string, string> => ({
  route,
  target: 'this',
  doer: 'self',
});

/**
 * A store parked on one of the QUESTIONS.
 *
 * Seeded rather than left empty, because an empty store resolves to the ENTRY
 * question and both of the others are one or two answers in — a gallery that
 * could only reach them by pressing buttons could not show them as still frames
 * at all.
 */
const harnessQuestion = (document: Record<string, string>, device: DeviceKind = 'desktop'): OnboardingProgressStore =>
  new OnboardingProgressStore({
    device,
    storage: {
      getItem: () => JSON.stringify({ v: ONBOARDING_PROGRESS_VERSION, ...document }),
      setItem: () => {},
    },
    paired: true,
  });

/**
 * The screens the gallery shows, named by what a reviewer is looking at.
 *
 * THE PAIRS ARE THE POINT, and each pair differs by one answer rather than by
 * decoration:
 *
 * - `doer` and `doer-mobile`: the same question, above a STATED ASSUMPTION with a
 *   way out on a computer and a STATED FACT on a phone, which is what replaced
 *   asking a phone what it is.
 * - `brief` and `brief-elsewhere`: the same prompt, with the share affordance that
 *   only exists when the agent is on a machine this clipboard cannot reach.
 * - `agent-pair` and `agent-pair-elsewhere`: "already paired in another tab" is
 *   true only when the daemon is on this machine, and that is now an answer rather
 *   than a guess from the device.
 * - `elsewhere` and `elsewhere-mobile`: ONE screen that reads the same on both,
 *   which is the whole claim of the recursion — a laptop setting up a server sees
 *   what a phone sees.
 */
type HarnessOnboardingScreen =
  | 'entry'
  | 'target'
  | 'doer'
  | 'doer-mobile'
  | 'brief'
  | 'brief-elsewhere'
  | 'agent-pair'
  | 'agent-pair-elsewhere'
  | 'install'
  | 'agents'
  | 'daemon'
  | 'local'
  | 'elsewhere'
  | 'elsewhere-mobile'
  | 'handoff'
  | 'pair'
  | 'scan'
  | 'done';

const HARNESS_ONBOARDING: Readonly<Record<HarnessOnboardingScreen, OnboardingProgressStore>> = {
  /* No document at all: the ENTRY question is what an empty store resolves to. */
  entry: new OnboardingProgressStore({ storage: undefined, device: 'desktop' }),
  /* Which computer — asked outright only when a fleet is being added to from a computer. */
  target: harnessQuestion({ stage: 'target', route: 'add-daemon' }),
  doer: harnessQuestion({ stage: 'doer', route: 'first-time', target: 'this' }),
  'doer-mobile': harnessQuestion({ stage: 'doer', route: 'first-time', target: 'other' }, 'mobile'),
  brief: harnessOnboarding({ route: 'first-time', target: 'this', doer: 'agent' }, 'brief'),
  'brief-elsewhere': harnessOnboarding({ route: 'first-time', target: 'other', doer: 'agent' }, 'brief', 'mobile'),
  'agent-pair': harnessOnboarding({ route: 'first-time', target: 'this', doer: 'agent' }, 'agent-pair'),
  'agent-pair-elsewhere': harnessOnboarding(
    { route: 'first-time', target: 'other', doer: 'agent' },
    'agent-pair',
    'mobile',
  ),
  install: harnessOnboarding(hereByHand(), 'install'),
  /* Ferretry runs Claude Code and Codex and is neither: the step that makes the daemon worth starting. */
  agents: harnessOnboarding(hereByHand(), 'agents'),
  daemon: harnessOnboarding(hereByHand(), 'daemon'),
  /* The same-machine collapse: a daemon on this box, and nothing to scan. */
  local: harnessOnboarding(hereByHand(), 'local'),
  /* The recursion, on a computer: the reader walks to the machine that will host it. */
  elsewhere: harnessOnboarding({ route: 'add-daemon', target: 'other', doer: 'self' }, 'elsewhere'),
  /* And on a phone, where the answer was forced rather than chosen. */
  'elsewhere-mobile': harnessOnboarding({ route: 'first-time', target: 'other', doer: 'self' }, 'elsewhere', 'mobile'),
  handoff: harnessOnboarding(hereByHand(), 'handoff'),
  pair: harnessOnboarding({ route: 'add-client' }, 'pair'),
  /* The scan step on the entry that arrives holding a link: no `fy pair` to run here. */
  scan: harnessOnboarding({ route: 'add-client' }, 'scan'),
  done: harnessOnboarding(hereByHand(), 'done'),
};

/**
 * The origin a hand-off link is built from.
 *
 * A `.invalid` host, because the reserved TLD cannot resolve: a QR in a review
 * screenshot must not be a scannable link to anything real.
 */
const HARNESS_SETUP_HREF = 'https://ferretry.example.invalid/setup';

/** A clipboard the review page never actually needs to reach. */
const HARNESS_CLIPBOARD: ClipboardWriter = async () => {};

/**
 * A share sheet that exists and does nothing.
 *
 * Present so the frames whose whole point is the SHARE affordance actually draw
 * it: the shipped code omits the button when the port is absent, which is the
 * ordinary desktop case and would silently review as "the gap is still open".
 */
const HARNESS_SHARE: SetupSharePort = async () => {};

/**
 * The three advertisement answers the connection chooser can render, as fixed
 * values.
 *
 * A review page must not ask the real relay directory anything, and the point of
 * these frames is that “switched off” and “could not find out” look different
 * from each other and from “advertising now”. A `.invalid` host, because the
 * reserved TLD cannot resolve and nothing here may address a real service.
 */
const HARNESS_FALLBACK = {
  available: { kind: 'available' as const, relayUrl: 'https://relay.example.invalid' },
  disabled: { kind: 'disabled' as const },
  undetermined: { kind: 'undetermined' as const, reason: 'this page could not reach the relay directory' },
} satisfies Readonly<Record<string, HostedRelayFallback>>;

/** The pre-filled arrival a phone's own camera app produces. */
const HARNESS_ARRIVAL: PairingArrival = {
  kind: 'seed',
  seed: { daemonUrl: 'https://studio.tail1234.ts.net', daemonId: 'sha256:8f2c…41ab', code: 'harness-code' },
};

/**
 * The thumbnail's picture is supplied as an INLINE image and the document card
 * as a stored attachment. That covers both gallery surfaces without a network
 * round trip: the harness aborts every off-origin request, and a `data:` URL
 * has no origin to allow.
 */
const HARNESS_ATTACHMENT_IMAGE =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="320" height="200"%3E%3Crect width="320" height="200" fill="%23111827"/%3E%3Crect x="24" y="132" width="48" height="44" fill="%2310b981"/%3E%3Crect x="88" y="96" width="48" height="80" fill="%2338bdf8"/%3E%3Crect x="152" y="60" width="48" height="116" fill="%23f59e0b"/%3E%3Crect x="216" y="40" width="48" height="136" fill="%23a78bfa"/%3E%3Ctext x="24" y="32" fill="%23f9fafb" font-family="system-ui" font-size="15"%3ECoverage by tier%3C/text%3E%3C/svg%3E';

const HARNESS_ATTACHMENT_LOADER: AttachmentBlobLoader = async () => new Blob(['%PDF-1.7'], { type: 'application/pdf' });

const HARNESS_ATTACHMENTS = [
  { kind: 'inline' as const, src: HARNESS_ATTACHMENT_IMAGE, alt: 'Coverage by tier' },
  {
    kind: 'attachment' as const,
    sessionId: 'harness-session',
    attachmentId: 'harness-doc',
    filename: 'split-proposal.pdf',
    mime: 'application/pdf',
    size: 481_233,
    textExtraction: { method: 'pdfjs' as const, characters: 18_204, truncated: true },
  },
  {
    kind: 'attachment' as const,
    sessionId: 'harness-session',
    attachmentId: 'harness-brief',
    filename: 'unit-brief.docx',
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 24_112,
    textExtractionFailure: { code: 'password_protected_document', message: 'the document is password protected' },
  },
];

/**
 * The Files tab reads its directory, git status and file bytes through the
 * global `fetch`, because `useFsProbe` is a page-level store rather than a
 * prop. The harness has no daemon and must not reach one, so the fixture is
 * installed as a narrow wrapper: anything addressed to the harness daemon's
 * `/fs` routes is answered here, and every other request still goes through the
 * real fetch (which the screenshot pass aborts if it leaves the loopback
 * origin). Harness-only — nothing in `src/` patches a global.
 */
interface HarnessFsEntry {
  readonly name: string;
  readonly type: 'dir' | 'file' | 'symlink';
  readonly size?: number;
  readonly ignored?: boolean;
  readonly denied?: boolean;
  readonly escapes?: boolean;
}

/**
 * Typed rather than `unknown` because the search FILE INDEX is derived from this
 * same tree (`HARNESS_SEARCH_FILE_INDEX`). Two hand-written fixtures would let
 * the Files tab and the search index disagree about what this session contains,
 * and a capture of a disagreement proves nothing about the product.
 */
const HARNESS_FS_LISTINGS: Readonly<Record<string, { readonly entries: readonly HarnessFsEntry[] }>> = {
  '': {
    entries: [
      { name: 'docs', type: 'dir' },
      { name: 'packages', type: 'dir' },
      { name: 'node_modules', type: 'dir', ignored: true },
      { name: 'CLAUDE.md', type: 'file', size: 4_812 },
      // Shares `port` with F12 so the search evidence is genuinely mixed: a
      // file matching both name/path competes with a task matching its title.
      { name: 'port-plan.md', type: 'file', size: 1_337 },
      { name: 'Taskfile.yaml', type: 'file', size: 9_233 },
      { name: 'coverage.csv', type: 'file', size: 612 },
      { name: 'flake.nix', type: 'file', size: 2_104 },
      { name: '.env', type: 'file', denied: true },
      { name: 'result', type: 'symlink', escapes: true },
    ],
  },
};

const HARNESS_FS_CHANGES = {
  repo: true,
  branch: 'port/pwafiles3',
  changes: [
    { path: 'CLAUDE.md', status: ' M', additions: 12, deletions: 3 },
    { path: 'Taskfile.yaml', status: '??' },
  ],
};

/** The two paths whose reload states the file-tab card exists to show. */
const HARNESS_RELOAD_PENDING = 'RELEASE.md';
const HARNESS_RELOAD_FAILING = 'DEPLOY.md';
const HARNESS_RELOAD_FAILURE =
  'the session working tree is being rewritten by a checkout, so this file cannot be read right now';

const HARNESS_PREVIEW_CSV = [
  'package,tier,lines,covered',
  'cli,unit,1842,1842',
  'daemon,unit,9137,9137',
  'daemon,int,2211,2211',
  'pwa,unit,7420,7420',
  'relay,unit,1304,1304',
].join('\n');

/**
 * A file body the way the daemon sends one: `size` is the UTF-8 byte count of
 * what it carries, because `SessionFsFileSchema` REQUIRES it.
 *
 * Measured rather than typed in, so a fixture edit cannot carry a size that
 * disagrees with its own bytes.
 */
const harnessFsFile = (path: string, content: string): SessionFsFile => ({
  path,
  size: new TextEncoder().encode(content).length,
  content,
});

/**
 * One real file body, so the file INSTANCE tab (#35) paints its own bytes
 * rather than a network failure. The harness aborts every non-loopback request,
 * so a file tab has nothing to show unless this answers for it.
 *
 * TYPED AS THE WIRE SHAPE, not `unknown`. Since #432 every file read is parsed
 * with `SessionFsFileSchema`, and three of these bodies had no `size`: each
 * failed to parse, so the two Reload cards never had a first copy to keep and
 * the full screenshot pass timed out waiting for a notice that could not be
 * drawn. `unknown` let that through the typechecker; this type does not. It
 * also has no `lang`: the wire never carried one, the view derives it from the
 * path, and the parser was silently dropping the one these fixtures set.
 */
const HARNESS_FS_FILES: Readonly<Record<string, SessionFsFile>> = {
  'CLAUDE.md': {
    path: 'CLAUDE.md',
    size: 4_812,
    content: [
      '# Workspace agent guide',
      '',
      'Use the repository\u2019s nix shell for every command.',
      'This file is a pure index \u2014 the linked documents own their subjects.',
      '',
      '## Non-negotiable invariants',
      '',
      '- **Name single-sourcing**: the PRODUCT name is the root package name;',
      '  the BINARY name is the bin key in the CLI package.',
      '- **The Homebrew cask is committed into this repo** under Casks/.',
    ].join('\n'),
  },
  'Taskfile.yaml': {
    path: 'Taskfile.yaml',
    size: 9_233,
    content: ['version: "3"', '', 'tasks:', '  test:', '    desc: Run unit, integration and SIT suites'].join('\n'),
  },
  'coverage.csv': harnessFsFile('coverage.csv', HARNESS_PREVIEW_CSV),
  [HARNESS_RELOAD_PENDING]: harnessFsFile(
    HARNESS_RELOAD_PENDING,
    ['# Release notes', '', 'The bytes on screen were loaded a moment ago.'].join('\n'),
  ),
  [HARNESS_RELOAD_FAILING]: harnessFsFile(
    HARNESS_RELOAD_FAILING,
    ['# Deploy log', '', 'The bytes on screen were loaded before the host went away.'].join('\n'),
  ),
};

/**
 * The rich preview's own bounded byte read (`?format=base64`). One CSV is
 * enough to show a real table renderer; a PDF or a raster would only prove the
 * browser can decode, which is not this surface's decision.
 */
const HARNESS_FS_PREVIEWS: Readonly<Record<string, SessionFsFile>> = {
  'coverage.csv': { path: 'coverage.csv', size: HARNESS_PREVIEW_CSV.length, base64: btoa(HARNESS_PREVIEW_CSV) },
};

/**
 * The two RELOAD states are REAL reads that misbehave, not drawn notices: each
 * of these paths answers once and then either never settles (a reload genuinely
 * in flight) or fails the way a browser fails.
 *
 * The `served` flag lives ON THE FIXTURE, and it is re-armed by page entry: this
 * module is evaluated once per document, so every capture that navigates starts
 * from `served: false`. A shared counter keyed by path made "read exactly once"
 * a property of the whole page instead of a property of one fixture — a second
 * body reading the same path would silently consume the good answer and leave
 * the card loading forever, which the screenshot pass could only experience as a
 * hang. EACH DRIVEN PATH BELONGS TO EXACTLY ONE BODY; the pass's explicit
 * timeouts (`screenshot.ts`) turn a violation of that into a named failure in
 * seconds rather than a wait.
 */
interface DrivenRead {
  readonly onRepeat: 'never-settles' | 'fails';
  served: boolean;
}

const HARNESS_DRIVEN_READS: Readonly<Record<string, DrivenRead>> = {
  [HARNESS_RELOAD_PENDING]: { onRepeat: 'never-settles', served: false },
  [HARNESS_RELOAD_FAILING]: { onRepeat: 'fails', served: false },
};

/**
 * The reads the harness daemon answers beyond the file tabs' `/fs` routes.
 *
 * Most surfaces take a client factory this fixture injects (Warden, resource
 * limits). The secret store cannot: `SecretsSurface` falls back to
 * `daemonApiClient` because no secret-client seam is forwarded through
 * `SettingsPage` — the GAP `docs/secrets.md` declares. Unanswered, its capture
 * showed "Reading this daemon's secret store…": the harness's own aborted
 * request, reviewed as if the product had produced it.
 */
/**
 * The task board the current-session search reads — ONE list of FULL tasks.
 *
 * The prose (description, original ask, clarifications) never reaches a client:
 * `/tasks` answers SUMMARIES, and the daemon decides matching. So this fixture
 * holds the whole task and PROJECTS the summary from it, exactly as the daemon
 * does, and answers `?q=` with the protocol's own haystack and matcher rather
 * than a second rule invented here.
 *
 * C3 is the load-bearing row. Its summary contains no `port` anywhere — not its
 * title, not its number — and only its original ask says `ported`. If a reader
 * ever went back to matching locally against summaries, C3 disappears from the
 * `port` capture, so the results assertion fails instead of passing for the
 * wrong reason. F12's title matches `port` outright, which is why C3 rather
 * than F12 is the proof that server-side prose matching is what answered.
 *
 * Built from the existing `TASKS` so the rows a screenshot shows are the same
 * rows every other task card in this harness shows.
 */
const HARNESS_SEARCH_PROSE: Readonly<
  Record<string, { readonly ask: string; readonly clarifications: readonly string[] }>
> = {
  F12: {
    ask: 'Finish porting the PWA feature components so the workspace stops falling back.',
    clarifications: ['Include the side-pane surfaces, not just the transcript.'],
  },
  B7: {
    ask: 'The transcript jumps to the bottom whenever older messages are prepended.',
    clarifications: ['Only reproducible with the composer focused.'],
  },
  C3: {
    ask: 'Retire the legacy state path once the last reader is ported onto the new home.',
    clarifications: ['Leave the migration command in place for one more release.'],
  },
};

/** The searchable task, plus the summary the wire is allowed to carry. */
type HarnessSearchTask = SessionSearchTask & { readonly summary: TaskSummary };

const HARNESS_SEARCH_TASKS: readonly HarnessSearchTask[] = TASKS.map(summary => {
  const prose = HARNESS_SEARCH_PROSE[summary.id] ?? { ask: summary.title, clarifications: [] };
  return {
    summary,
    id: summary.id,
    title: summary.title,
    description: `${summary.title}. Tracked on the tree board and searchable by its number, ${summary.id}.`,
    ask: { text: prose.ask },
    clarifications: prose.clarifications.map(text => ({ text })),
  };
});

/**
 * `GET /v1/sessions/:id/tasks[?q=]`, shaped as `SessionTaskListResponseSchema`.
 *
 * The whole-response schema is what carries `parseErrors` and `updatedAt`, and a
 * fixture that answered a bare `{ tasks: [...] }` would fail to parse the moment
 * the reader adopts it — silently, as an unavailable half rather than as a test
 * failure. A blank or absent `q` is the board itself; a present one is filtered
 * with `matchesSessionSearchQuery`, so `no-match` is a genuine empty answer.
 */
const harnessTaskListResponse = (sessionId: string, query: string | null): unknown => {
  const matched =
    query === null
      ? HARNESS_SEARCH_TASKS
      : HARNESS_SEARCH_TASKS.filter(task => matchesSessionSearchQuery(sessionSearchTaskHaystack(task), query));
  return {
    v: TASK_SCHEMA_VERSION,
    sessionId,
    tasks: matched.map(task => ({ ...task.summary, sessionId })),
    parseErrors: 0,
    updatedAt: new Date(HARNESS_NOW).toISOString(),
  };
};

/**
 * `GET /v1/sessions/:id/fs/index`, derived from `HARNESS_FS_LISTINGS`.
 *
 * Directories are not indexed files, and the three non-file entries map exactly
 * onto the three skip reasons that do NOT make a walk partial: `.env` is
 * `denied`, `node_modules` is `excluded`, and the `result` symlink is
 * `unsupported`. `SessionFileIndexResponseSchema` refuses a `complete` document
 * that also reports `unreadable`/`truncated` work, so those three are the only
 * skips a complete index here may carry.
 */
const HARNESS_FILE_INDEX_ROOT = '/home/pilot/work/ferretry';

const harnessIndexPath = (directory: string, name: string): string =>
  directory === '' ? name : `${directory}/${name}`;

const HARNESS_FILE_INDEX_FILES = Object.entries(HARNESS_FS_LISTINGS).flatMap(([directory, listing]) =>
  listing.entries
    .filter(entry => entry.type === 'file' && entry.denied !== true)
    .map(entry => ({ path: harnessIndexPath(directory, entry.name), name: entry.name })),
);

const harnessSkipCount = (matches: (entry: HarnessFsEntry) => boolean): number =>
  Object.values(HARNESS_FS_LISTINGS).reduce((total, listing) => total + listing.entries.filter(matches).length, 0);

const HARNESS_FILE_INDEX_SKIPPED = [
  { reason: 'denied', count: harnessSkipCount(entry => entry.denied === true) },
  { reason: 'excluded', count: harnessSkipCount(entry => entry.ignored === true) },
  { reason: 'unsupported', count: harnessSkipCount(entry => entry.type === 'symlink') },
].filter(skip => skip.count > 0);

/**
 * The session whose index stopped early.
 *
 * Its OWN session id rather than a flag on the healthy one, for two reasons: the
 * `results` card must keep a complete index to be able to say "no match" without
 * qualification, and the compiled `#session-workspace` request ledger is filtered
 * by `harness-session`, so a second scope cannot contaminate its counts.
 */
const HARNESS_PARTIAL_SESSION_ID = 'harness-partial-session';

/** How many indexed files the truncated walk never reached. */
const HARNESS_PARTIAL_INDEX_KEPT = 2;

const harnessFileIndexResponse = (sessionId: string): unknown => {
  const partial = sessionId === HARNESS_PARTIAL_SESSION_ID;
  const files = partial ? HARNESS_FILE_INDEX_FILES.slice(0, HARNESS_PARTIAL_INDEX_KEPT) : HARNESS_FILE_INDEX_FILES;
  const truncated = HARNESS_FILE_INDEX_FILES.length - files.length;
  return {
    v: SESSION_FILE_INDEX_VERSION,
    sessionId,
    root: HARNESS_FILE_INDEX_ROOT,
    files,
    coverage: partial ? 'partial' : 'complete',
    skipped: partial
      ? [...HARNESS_FILE_INDEX_SKIPPED, { reason: 'truncated', count: truncated }]
      : HARNESS_FILE_INDEX_SKIPPED,
  };
};

/** The sessions whose task board this fixture answers for. Deliberately NOT
 *  every session: `harness-workspace` is a scope of its own, and answering its
 *  board here would change surfaces this unit is not measuring. */
const HARNESS_SEARCH_SESSION_IDS: readonly string[] = ['harness-session', HARNESS_PARTIAL_SESSION_ID];

const HARNESS_DAEMON_READS: Readonly<Record<string, unknown>> = {
  '/v1/secrets': SECRETS_READY,
  // The session workspace's "This folder" rail: one open signal and one answered, and its skills.
  '/v1/sessions/harness-workspace/attention': {
    v: 1,
    sessionId: 'harness-workspace',
    items: [
      {
        id: 'A3',
        source: 'question',
        sourceRef: null,
        subject: 'Use the seeded test account?',
        why: 'The login page needs a user to sign in with.',
        waitingSince: '2026-07-31T11:58:00.000Z',
        howToResolve: 'Pick one.',
        ask: { kind: 'multiple-choice', options: [{ label: 'Yes' }, { label: 'No' }] },
        raisedBy: 'agent',
        raisedBySession: 'harness-workspace',
        raisedByName: 'Hadi',
      },
    ],
    resolved: [],
    count: 1,
    parseErrors: 0,
    updatedAt: '2026-07-31T12:00:00.000Z',
  },
  '/v1/sessions/harness-workspace/skills': {
    harness: 'claude',
    skills: [
      { name: 'summary', description: 'Summarise this session for the human.', scope: 'global', origin: 'claude' },
      { name: 'babysit-pr', description: 'Drive a PR to green.', scope: 'global', origin: 'both' },
      { name: 'floop', description: 'Review, fix, repeat until satisfied.', scope: 'project', origin: 'both' },
    ],
  },
};

/**
 * THE SESSION WORKSPACE'S AGENT TOOLS, kept in the page. Hadi drives the `dev` terminal and the `app`
 * page (markers good until 2099, so a capture never races their lapse); `docs` is an incognito page and
 * the third page was opened by the person and has no name. Take over / Hand back change the held set
 * here, so the controls are walkable; `?held` starts with the `app` page taken over.
 */
const HARNESS_WORKSPACE_SESSION = 'harness-workspace';
const HARNESS_DRIVING_UNTIL = '2099-01-01T00:00:00.000Z';
const HARNESS_WORKSPACE_PAGES: {
  id: string;
  name?: string;
  url: string;
  title: string;
  incognito?: true;
  ownerSessionId: string;
  ownerName: string;
}[] = [
  {
    id: 'C0FFEE0001',
    name: 'app',
    url: 'http://localhost:5173/login',
    title: 'Sign in — Ferretry',
    ownerSessionId: HARNESS_WORKSPACE_SESSION,
    ownerName: 'Hadi',
  },
  {
    id: 'C0FFEE0002',
    name: 'docs',
    url: 'https://docs.example.test/getting-started',
    title: 'Getting started — Docs',
    incognito: true,
    ownerSessionId: HARNESS_WORKSPACE_SESSION,
    ownerName: 'Hadi',
  },
  {
    id: 'C0FFEE0003',
    url: 'https://github.com/kirinnee/ferretry/pull/500',
    title: 'feat(daemon): drive terminals and browser pages by name',
    ownerSessionId: HARNESS_WORKSPACE_SESSION,
    ownerName: 'Hadi',
  },
];
const harnessWorkspaceSurfaces = (kind: 'terminal' | 'browser'): readonly { id: string; name?: string }[] =>
  kind === 'terminal'
    ? [{ id: 'a1b2c3d4e5f6', name: 'dev' }]
    : HARNESS_WORKSPACE_PAGES.map(page => ({ id: page.id, ...(page.name === undefined ? {} : { name: page.name }) }));
let harnessPageCount = HARNESS_WORKSPACE_PAGES.length;
const harnessHeld = new Set<string>(window.location.search.includes('held') ? ['browser:C0FFEE0001'] : []);
let harnessViewedPage = 'C0FFEE0001';
/**
 * `?agent-tabs=opened` has Hadi open the terminal and the pages (their tabs appear without a click);
 * `?agent-tabs=asked` has it then hand the terminal over ("your turn here").
 */
const harnessAgentTabs = ((value: string | null) => (value === 'opened' || value === 'asked' ? value : null))(
  new URLSearchParams(window.location.search).get('agent-tabs'),
);
const OPENED_AT = '2026-10-16T09:00:00.000Z';
const ASKED_AT = '2026-10-16T09:02:00.000Z';
const HARNESS_ASK_MESSAGE = 'Type the sudo password, then press Enter';
const harnessAgentRecord = (kind: 'terminal' | 'browser', surface: { id: string; name?: string }, at: string) => ({
  surface: kind,
  id: surface.id,
  ...(surface.name === undefined ? {} : { name: surface.name }),
  agentSessionId: HARNESS_WORKSPACE_SESSION,
  agentName: 'Hadi',
  at,
});
const harnessControlView = (kind: 'terminal' | 'browser') => {
  const driven = harnessWorkspaceSurfaces(kind)[0];
  return {
    sessionId: HARNESS_WORKSPACE_SESSION,
    driving:
      driven === undefined || harnessHeld.has(`${kind}:${driven.id}`)
        ? []
        : [
            {
              surface: kind,
              id: driven.id,
              ...(driven.name === undefined ? {} : { name: driven.name }),
              agentSessionId: HARNESS_WORKSPACE_SESSION,
              agentName: 'Hadi',
              since: '2026-10-16T09:00:00.000Z',
              until: HARNESS_DRIVING_UNTIL,
            },
          ],
    takeovers: harnessWorkspaceSurfaces(kind)
      .filter(surface => harnessHeld.has(`${kind}:${surface.id}`))
      .map(surface => ({
        surface: kind,
        id: surface.id,
        ...(surface.name === undefined ? {} : { name: surface.name }),
        by: { by: 'human', deviceId: 'harness-device' },
        since: '2026-10-16T09:01:00.000Z',
      })),
    handed: [],
    opened:
      harnessAgentTabs === null
        ? []
        : harnessWorkspaceSurfaces(kind).map(surface => harnessAgentRecord(kind, surface, OPENED_AT)),
    asked:
      harnessAgentTabs !== 'asked' || kind !== 'terminal'
        ? []
        : harnessWorkspaceSurfaces(kind)
            .slice(0, 1)
            .filter(surface => !harnessHeld.has(`${kind}:${surface.id}`))
            .map(surface => ({ ...harnessAgentRecord(kind, surface, ASKED_AT), message: HARNESS_ASK_MESSAGE })),
  };
};
const harnessWorkspaceBrowser = () => {
  const active = HARNESS_WORKSPACE_PAGES.find(page => page.id === harnessViewedPage) ?? HARNESS_WORKSPACE_PAGES[0];
  return {
    sessionId: HARNESS_WORKSPACE_SESSION,
    state: 'running',
    pages: HARNESS_WORKSPACE_PAGES,
    activePageId: active?.id,
    url: active?.url,
    title: active?.title,
    canGoBack: false,
    canGoForward: false,
    pageState: 'ready',
    viewport: { width: 1280, height: 800 },
    viewers: 1,
    persistentProfile: true,
    profileKind: 'shared',
    idleTimeoutSeconds: 900,
    capacity: { running: 3, maximum: 60 },
  };
};
/** A person's toolbar action on the workspace's browser, answered as the daemon would. */
const harnessWorkspaceAct = (action: { action: string; pageId?: string }) => {
  if (action.action === 'activate-page' && action.pageId !== undefined) harnessViewedPage = action.pageId;
  if (action.action === 'close-page') {
    const at = HARNESS_WORKSPACE_PAGES.findIndex(page => page.id === action.pageId);
    if (at >= 0) HARNESS_WORKSPACE_PAGES.splice(at, 1);
  }
  if (action.action === 'new-page') {
    harnessPageCount += 1;
    harnessViewedPage = `C0FFEE${String(harnessPageCount).padStart(4, '0')}`;
    HARNESS_WORKSPACE_PAGES.push({
      id: harnessViewedPage,
      url: 'https://example.test/',
      title: 'New page',
      ownerSessionId: HARNESS_WORKSPACE_SESSION,
      ownerName: 'Hadi',
    });
  }
  return { status: harnessWorkspaceBrowser() };
};
/**
 * The workspace's real engine over the same page state as its page strip, so a capture shows ONE
 * browser: the pages the strip lists are the pages the engine shows.
 */
const HARNESS_WORKSPACE_BROWSER_TRANSPORT: RemoteBrowserTransport = {
  readStatus: async () => harnessWorkspaceBrowser() as BrowserStatus,
  runAction: async (_daemon, _scope, action) => harnessWorkspaceAct(action) as never,
};

/** The workspace's control and browser routes, answered from the state above; null for any other. */
const harnessWorkspaceTools = (method: string, rest: string, body: string): Response | null => {
  const control = /^surfaces\/(terminals|browser)\/control$/.exec(rest);
  if (control !== null) {
    const kind = control[1] === 'terminals' ? 'terminal' : 'browser';
    if (method === 'POST') {
      const request = JSON.parse(body) as { action: string; key: string };
      const target = harnessWorkspaceSurfaces(kind).find(
        surface => surface.id === request.key || surface.name === request.key,
      );
      if (target !== undefined && request.action === 'takeover') harnessHeld.add(`${kind}:${target.id}`);
      if (target !== undefined && request.action === 'handback') harnessHeld.delete(`${kind}:${target.id}`);
    }
    return harnessJson(harnessControlView(kind));
  }
  if (rest !== 'browser') return null;
  if (method === 'POST') {
    const action = JSON.parse(body) as { action: string; pageId?: string };
    return harnessJson(harnessWorkspaceAct(action));
  }
  return harnessJson(harnessWorkspaceBrowser());
};

/** Which pairing a request is addressed to, taken from the fixtures themselves. */
const HARNESS_DAEMON_HOSTS = {
  answering: new URL(daemon.baseUrl).hostname,
  offline: new URL(unreachableDaemon.baseUrl).hostname,
  checking: new URL(checkingDaemon.baseUrl).hostname,
} as const;

const harnessJson = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/**
 * Every read this fixture answers, in order, as `METHOD /path?query`.
 *
 * WHY A GLOBAL AND NOT `page.on('request')`. An answered route never leaves the
 * page: `harnessJson()` returns synchronously and the network layer is never
 * touched, so the driver's request events see NOTHING. A request ledger has to
 * be kept where the requests actually are, which is here. Same shape as
 * `window.__harnessKeyboard`, and read back the same way.
 *
 * Only the ANSWERING host is recorded. The offline and checking daemons are
 * states rather than data, and their reads are not what a count of "how many
 * times did this surface dial the daemon" is asking about.
 */
const harnessRequests: string[] = [];
(window as unknown as { __harnessRequests: readonly string[] }).__harnessRequests = harnessRequests;

/** `/v1/sessions/:id/<rest>` split into its session and its route, or null. */
const harnessSessionRoute = (pathname: string): { readonly sessionId: string; readonly rest: string } | null => {
  const match = /^\/v1\/sessions\/([^/]+)\/(.+)$/.exec(pathname);
  const sessionId = match?.[1];
  const rest = match?.[2];
  if (sessionId === undefined || rest === undefined) return null;
  return { sessionId: decodeURIComponent(sessionId), rest };
};

/** A running Claude turn's pane, ending on the spinner line the activity line reads. */
const HARNESS_LIVE_PANE = [
  '● Read(packages/daemon/src/lib/fleet-login/service.ts)',
  '  ⎿  Read 512 lines',
  '',
  '✽ Pontificating… (42s · ↓ 3.1k tokens · esc to interrupt)',
  '',
  '> ',
].join('\n');

/**
 * INFO AND ACTIONS, ANSWERED IN THE PAGE. The workspace session works in a managed worktree with
 * uncommitted changes; the Warden nudged it once; its analytics are priced; its project `.mcp.json`
 * declares `playwright`, and an Add MCP server preview answers with the diff the daemon would make.
 */
const HARNESS_MCP_PROJECT_FILE = '/work/ferretry/.mcp.json';
const harnessInfoAnswer = (method: string, url: URL, body: string): unknown => {
  const path = url.pathname;
  if (method === 'GET' && path === '/v1/worktrees')
    return {
      worktrees: [
        {
          path: '/work/ferretry',
          branch: 'feat/session-workspace',
          repositoryRoot: '/work/ferretry',
          commonDirectory: '/work/ferretry/.git',
          relativeCwd: '',
          createdAt: '2026-07-31T09:00:00.000Z',
          initialHead: 'a'.repeat(40),
          branchPreexisted: false,
          ownerActive: true,
          sharedWith: [],
          live: {
            branch: 'feat/session-workspace',
            detached: false,
            undetermined: [],
            status: {
              staged: false,
              unstaged: true,
              untracked: false,
              ignored: false,
              conflicted: false,
              dirtySubmodule: false,
              truncated: false,
            },
          },
        },
      ],
    };
  if (method === 'GET' && path === '/v1/warden/verdicts')
    return [
      {
        at: '2026-07-31T11:40:00.000Z',
        targetSession: HARNESS_WORKSPACE_SESSION,
        teammate: 'hadi',
        anomalyKind: 'unattended_question',
        verdict: 'nudged',
        reason: 'It asked which account to use and nobody had answered for 20 minutes.',
        reportPath: 'warden/reports/harness-workspace-1.md',
      },
    ];
  if (method === 'GET' && path === '/v1/analytics') {
    const measure = (value: number | null) => ({ value, known: value === null ? 0 : 12, total: 12 });
    return {
      ...ANALYTICS,
      query: 'sum {id="harness-workspace"}',
      results: [
        {
          labels: {},
          sessions: 1,
          rates: { stall: 0, failure: 0, completion: 100 },
          tokens: measure(1_482_300),
          inputTokens: measure(1_204_100),
          outputTokens: measure(96_200),
          cachedInputTokens: measure(182_000),
          cacheWriteInputTokens: measure(24_000),
          cacheWrite5mInputTokens: measure(24_000),
          cacheWrite1hInputTokens: measure(0),
          reasoningTokens: measure(0),
          equivalentApiCostUsdMicros: measure(4_210_000),
          turns: measure(12),
          durationMs: measure(2_640_000),
          timeToFirstOutputMs: measure(2_100),
          contextEndPercent: measure(61),
        },
      ],
    };
  }
  if (method === 'GET' && path === '/v1/fleet/components') return harnessCatalogAnswer(path);
  if (method === 'GET' && path === '/v1/fleet/mcp-auth') return { connections: [] };
  const route = harnessSessionRoute(path);
  if (route?.sessionId !== HARNESS_WORKSPACE_SESSION) return null;
  if (method === 'GET' && route.rest === 'mcp')
    return {
      project: {
        path: HARNESS_MCP_PROJECT_FILE,
        etag: 'b'.repeat(64),
        servers: [{ name: 'playwright', transport: 'command' }],
      },
    };
  const request = JSON.parse(body) as { name?: string };
  const name = request.name ?? 'server';
  if (method === 'POST' && route.rest === 'mcp/project/preview')
    return {
      scope: 'project',
      path: HARNESS_MCP_PROJECT_FILE,
      etag: 'b'.repeat(64),
      replaces: false,
      diff: [
        { kind: 'context', text: '{' },
        { kind: 'context', text: '  "mcpServers": {' },
        { kind: 'context', text: '    "playwright": {' },
        { kind: 'context', text: '…' },
        { kind: 'remove', text: '    }' },
        { kind: 'add', text: '    },' },
        { kind: 'add', text: `    "${name}": {` },
        { kind: 'add', text: '      "command": "npx",' },
        { kind: 'add', text: '      "args": ["-y", "@sentry/mcp-server"],' },
        { kind: 'add', text: `      "env": { "SENTRY_TOKEN": "${'$'}{SENTRY_TOKEN}" }` },
        { kind: 'add', text: '    }' },
        { kind: 'context', text: '  }' },
        { kind: 'context', text: '}' },
      ],
    };
  if (method === 'POST' && route.rest === 'mcp/login/preview')
    return { scope: 'login', runtime: 'claude-default', profile: 'Default', replaces: false, ferrets: 3 };
  if (method === 'POST' && route.rest === 'mcp/project')
    return { scope: 'project', name, path: HARNESS_MCP_PROJECT_FILE, etag: 'c'.repeat(64) };
  if (method === 'POST' && route.rest === 'mcp/login')
    return { scope: 'login', name, runtime: 'claude-default', profile: 'Default' };
  return null;
};
/**
 * A BRAND-NEW SESSION nobody has asked anything yet: launched, on turn zero, its harness sitting at
 * its prompt. `#session-new` renders it; `?harness=codex` swaps the runtime. The pane each harness
 * paints at an idle prompt carries no status line, which is what makes the page read it as ready.
 */
const NEW_SESSION_HARNESS: 'claude' | 'codex' =
  new URLSearchParams(window.location.search).get('harness') === 'codex' ? 'codex' : 'claude';
const NEW_SESSION_ID = 'harness-new-session';
/** `?turn=working|your-turn|needs-input`: the daemon's turn fact for the page; absent is a brand-new session. */
const NEW_SESSION_TURN = ((value: string | null) =>
  value === 'working' || value === 'your-turn' || value === 'needs-input' ? value : undefined)(
  new URLSearchParams(window.location.search).get('turn'),
);
const HARNESS_IDLE_PANES: Readonly<Record<'claude' | 'codex', string>> = {
  claude: [
    ' ✻ Welcome to Claude Code!',
    '',
    '   cwd: /Users/kirin/.config/home-manager',
    '',
    '╭──────────────────────────────────────────────────────────────╮',
    '│ > ',
    '╰──────────────────────────────────────────────────────────────╯',
    '  ? for shortcuts',
  ].join('\n'),
  codex: [
    '>_ OpenAI Codex',
    '',
    '  directory: ~/.config/home-manager',
    '',
    '› Ask Codex to do anything',
    '',
    '  100% context left · ? for shortcuts',
  ].join('\n'),
};

/**
 * The runtime-model catalog each harness's account advertises for the new session, so the composer's model
 * and reasoning pickers open onto real choices — descriptions included — rather than a catalog failure.
 */
const NEW_SESSION_RUNTIME_MODELS: Readonly<Record<'claude' | 'codex', unknown>> = {
  claude: {
    harness: 'claude',
    source: 'wrapper-inventory',
    choices: [
      {
        value: 'claude-opus-5[1m]',
        label: 'Opus 5 (1M context)',
        description: 'The deepest model, with the long context window.',
        isDefault: true,
        reasoningEfforts: [],
      },
      {
        value: 'claude-opus-5',
        label: 'Opus 5',
        description: 'The deepest model this account advertises.',
        reasoningEfforts: [],
      },
      {
        value: 'claude-sonnet-5',
        label: 'Sonnet 5',
        description: 'Fast and capable for everyday work.',
        reasoningEfforts: [],
      },
      { value: 'claude-haiku-5', label: 'Haiku 5', reasoningEfforts: [] },
    ],
  },
  codex: {
    harness: 'codex',
    source: 'codex-app-server',
    choices: [
      {
        value: 'gpt-5.6-codex',
        label: 'GPT-5.6 Codex',
        description: 'Tuned for long agentic coding runs.',
        isDefault: true,
        defaultReasoningEffort: 'medium',
        reasoningEfforts: [
          { value: 'low', description: 'Fast responses with lighter reasoning.' },
          { value: 'medium', description: 'Balances speed and reasoning depth.' },
          { value: 'high', description: 'Greater reasoning depth for complex problems.' },
          { value: 'xhigh', description: 'Extra high reasoning depth for the hardest problems.' },
        ],
      },
      {
        value: 'gpt-5.6',
        label: 'GPT-5.6',
        description: 'The general model.',
        defaultReasoningEffort: 'medium',
        reasoningEfforts: [{ value: 'medium' }, { value: 'high' }],
      },
    ],
  },
};

const harnessFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input), window.location.href);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  // A pairing that does not answer keeps not answering: the offline daemon fails
  // the way a browser fails, and the checking daemon never settles — the same
  // read its reachability probe performs. Neither borrows the healthy host's data.
  if (url.hostname === HARNESS_DAEMON_HOSTS.offline) throw new TypeError('Failed to fetch');
  if (url.hostname === HARNESS_DAEMON_HOSTS.checking) return await new Promise<Response>(() => undefined);
  if (url.hostname !== HARNESS_DAEMON_HOSTS.answering) return await harnessFetch(input, init);
  harnessRequests.push(`${method} ${url.pathname}${url.search}`);
  const sessionRoute = harnessSessionRoute(url.pathname);
  // The live pane the activity line reads: Claude's own spinner line, as a running turn paints it.
  if (sessionRoute?.sessionId === HARNESS_WORKSPACE_SESSION) {
    const answered = harnessWorkspaceTools(method, sessionRoute.rest, String(init?.body ?? '{}'));
    if (answered !== null) return answered;
  }
  if (method === 'GET' && sessionRoute?.rest === 'snapshot')
    return new Response(
      sessionRoute.sessionId === NEW_SESSION_ID && NEW_SESSION_TURN !== 'working'
        ? HARNESS_IDLE_PANES[NEW_SESSION_HARNESS]
        : NEW_SESSION_HARNESS === 'codex' && sessionRoute.sessionId === NEW_SESSION_ID
          ? '• Working (1m 12s • Esc to interrupt)\n\n› '
          : HARNESS_LIVE_PANE,
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  if (method === 'GET' && sessionRoute?.sessionId === NEW_SESSION_ID && sessionRoute.rest === 'runtime-models')
    return harnessJson(NEW_SESSION_RUNTIME_MODELS[NEW_SESSION_HARNESS]);
  // The workspace's own pickers (`?pickers`), in Info › Runtime and the composer: a Claude account's catalog.
  if (
    method === 'GET' &&
    sessionRoute?.sessionId === HARNESS_WORKSPACE_SESSION &&
    sessionRoute.rest === 'runtime-models'
  )
    return harnessJson(NEW_SESSION_RUNTIME_MODELS.claude);
  // `?restart-unknown-proc`: Restart CLI paused because a program the inventory cannot classify is
  // running. Cancel leaves it be; "Restart anyway" resends with `forceInflight` and gets the session.
  if (
    method === 'POST' &&
    sessionRoute?.rest === 'migrate' &&
    new URLSearchParams(window.location.search).has('restart-unknown-proc')
  ) {
    const asked = JSON.parse(String(init?.body ?? '{}')) as { forceInflight?: boolean };
    if (asked.forceInflight === true)
      return harnessJson({
        ...WORKSPACE_SESSION,
        config: { ...HARNESS_WIRE_CONFIG, ...WORKSPACE_SESSION.config, teammate: 'hadi' },
      });
    return new Response(
      JSON.stringify({
        error:
          'refused: A program Ferretry doesn’t recognise is running — fy-helper --watch ./src\nin-flight inventory — status running, turn 13, worst: UNKNOWN',
        code: 'migration_refused',
        inflight: {
          status: 'running',
          turn: 13,
          blockedBy: 'unknown',
          restartsWithCli: 2,
          items: [
            {
              kind: 'process',
              verdict: 'unknown',
              title: 'A program Ferretry doesn’t recognise is running',
              detail: 'fy-helper --watch ./src --poll 250 --log /tmp/fy-helper-26965.log',
              age: '24h',
              blocks: true,
            },
          ],
        },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }
  // `?restart-downgrade`: Restart CLI paused because the relaunch would give the conversation a smaller
  // context window. Cancel leaves it be; "Restart with the smaller window" resends with the consent.
  if (
    method === 'POST' &&
    sessionRoute?.rest === 'migrate' &&
    new URLSearchParams(window.location.search).has('restart-downgrade')
  ) {
    const asked = JSON.parse(String(init?.body ?? '{}')) as { allowContextDowngrade?: boolean };
    if (asked.allowContextDowngrade === true)
      return harnessJson({
        ...WORKSPACE_SESSION,
        config: { ...HARNESS_WIRE_CONFIG, ...WORKSPACE_SESSION.config, teammate: 'hadi' },
      });
    return new Response(
      JSON.stringify({
        error:
          'claude-default serves claude-opus-5-5 with a 200000-token window and this session is running in 1000000, so part of this conversation would be cut off.',
        code: 'context_downgrade_refused',
        downgrade: { model: 'claude-opus-5-5', targetWindow: 200_000, currentWindow: 1_000_000 },
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  }
  // `?restart-ps-fails`: Restart CLI refused because the host's ps would not list the process table.
  if (
    method === 'POST' &&
    sessionRoute?.rest === 'migrate' &&
    new URLSearchParams(window.location.search).has('restart-ps-fails')
  )
    return new Response(
      JSON.stringify({
        error:
          'refused: the process table could not be read: ps exited 1: ps: etimes: keyword not found\nin-flight inventory — status running, turn 2, worst: UNKNOWN\n  blind [UNKNOWN] the process table could not be read: ps exited 1: ps: etimes: keyword not found',
        code: 'migration_refused',
      }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    );
  // An attachment upload answers with the daemon's own view of the file it now holds.
  if (method === 'POST' && sessionRoute?.rest === 'attachments') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { filename?: string; mime?: string; base64?: string };
    return harnessJson({
      id: `att_${'0'.repeat(60)}${harnessRequests.length.toString(16).padStart(4, '0')}`,
      filename: body.filename ?? 'file',
      mime: body.mime ?? 'application/octet-stream',
      size: atob(body.base64 ?? '').length,
      sha256: 'a'.repeat(64),
      createdAt: '2026-10-16T00:00:00.000Z',
    });
  }
  // `/fs/index` BEFORE the broad `/fs` branch, and this ladder is order-sensitive
  // for exactly the reason `mounts/session-filesystem.ts` registers `fs/index`
  // before `fs`: `/fs/index` INCLUDES `/fs`, matches none of the inner cases, and
  // would otherwise be answered with the root directory listing — a body that
  // fails `SessionFileIndexResponseSchema` and paints every card `unavailable`.
  if (method === 'GET' && sessionRoute !== null && sessionRoute.rest === 'fs/index')
    return harnessJson(harnessFileIndexResponse(sessionRoute.sessionId));
  // The board and the query are ONE route. A `q` present is filtered by the
  // daemon-owned matcher; absent, the whole board is the answer. There is
  // deliberately no `/tasks/:id` route: the reader that used to dial one per row
  // is the design this change deletes, so a fixture for it would let the old
  // fan-out come back green.
  if (method === 'GET' && sessionRoute?.rest === 'tasks' && HARNESS_SEARCH_SESSION_IDS.includes(sessionRoute.sessionId))
    return harnessJson(harnessTaskListResponse(sessionRoute.sessionId, url.searchParams.get('q')));
  if (url.pathname.includes('/fs')) {
    const path = url.searchParams.get('path') ?? '';
    if (url.pathname.endsWith('/fs/changes')) return harnessJson(HARNESS_FS_CHANGES);
    if (!url.pathname.endsWith('/fs/file'))
      return harnessJson({ root: '/work/ferretry', path, ...(HARNESS_FS_LISTINGS[path] ?? { entries: [] }) });
    if (url.searchParams.get('format') === 'base64') return harnessJson(HARNESS_FS_PREVIEWS[path] ?? { path });
    const driven = HARNESS_DRIVEN_READS[path];
    if (driven !== undefined) {
      if (driven.served) {
        // A REFUSAL WITH REASONS, not a bare "failed to fetch": the notice has
        // to be reviewed carrying the kind of sentence a daemon actually sends,
        // which is what makes the compact/expanded pair worth looking at.
        if (driven.onRepeat === 'fails')
          return new Response(JSON.stringify({ error: HARNESS_RELOAD_FAILURE }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        return await new Promise<Response>(() => undefined);
      }
      driven.served = true;
    }
    return harnessJson(HARNESS_FS_FILES[path] ?? { path });
  }
  // Reads only, and only routes named above. A write has no answer here on
  // purpose: this page keeps no store, so inventing a receipt for one would show
  // a saved secret that nothing holds. Anything else still leaves, where the
  // driver's abort of non-loopback traffic remains the real guarantee.
  // Info and Actions on the workspace session: its worktree, the Warden's verdicts, its analytics and
  // the session MCP routes (Info › Folder › MCP and Actions › Add MCP server), all in the page.
  const infoAnswer = harnessInfoAnswer(method, url, String(init?.body ?? '{}'));
  if (infoAnswer !== null) return harnessJson(infoAnswer);
  const read = method === 'GET' ? HARNESS_DAEMON_READS[url.pathname] : undefined;
  if (read !== undefined) return harnessJson(read);
  return await harnessFetch(input, init);
}) as typeof fetch;

/** Two link states worth looking at: an ordinary remote page and one that
 *  names the reader's own phone rather than the agent's machine. */
const HARNESS_REMOTE_LINK: BrowserDestination = {
  href: 'https://docs.example.test/getting-started',
  hostname: 'docs.example.test',
  scope: 'cross-origin',
};
const HARNESS_LOOPBACK_LINK: BrowserDestination = {
  href: 'http://localhost:5173/',
  hostname: 'localhost',
  scope: 'device-loopback',
};

/** What the Console has been typed in this page, echoed onto the harness pane as a shell would. */
let harnessConsoleLine = '';
/** The Console's typing, kept in the page: Enter ends the line, Backspace takes a character back. */
const HARNESS_CONSOLE_TYPER: ConsoleTyper = async (_daemon, _scope, data) => {
  for (const character of data) {
    if (character === '\r') harnessConsoleLine = '';
    else if (character === '\x7f') harnessConsoleLine = harnessConsoleLine.slice(0, -1);
    else if (character >= ' ') harnessConsoleLine += character;
  }
};
/** A tmux pane the harness owns outright: the terminal tab never polls a daemon here. */
const HARNESS_PANE_SNAPSHOT: PaneSnapshotReader = async () =>
  `${[
    '$ direnv exec . task test',
    '🧪 Running unit tests with coverage...',
    'bun test v1.3.13 (bf2e2cec)',
    '',
    ' packages/pwa/tests/unit/terminal-snapshot.test.tsx:',
    ' ✓ terminal snapshot view > polls the paired daemon, prints the pane [4.00ms]',
    ' ✓ terminal snapshot view > keeps the last good pane when the daemon goes quiet [3.00ms]',
    // Enough output to overflow the Console at both viewports, so it has a tail to follow and a
    // reader can scroll away from it.
    ...Array.from(
      { length: 36 },
      (_, index) =>
        ` ✓ transcript follow > case ${String(index + 1).padStart(2, '0')} keeps the reader where they chose [1.00ms]`,
    ),
    '',
    ' 7 pass',
    ' 0 fail',
    '✅ Coverage artifact matches the complete unit production ledger',
  ].join('\n')}\n$ ${harnessConsoleLine}`;

/** Two terminals the harness owns outright, so the addressing card renders its
 *  rows — reference, viewer count, ownership — with no daemon in reach. */
/**
 * A deck with a scripted shell behind it.
 *
 * The card is about how the deck READS — the tab strip, the ownership-coloured
 * co-control line, the toolbar, the ledger — so it must never depend on a daemon
 * being reachable, and it must never open a socket from a screenshot run. The
 * emulator is a stub for the same reason: xterm paints into a canvas, which a
 * screenshot diff cannot compare meaningfully anyway.
 */
const HARNESS_TERMINAL_DECK: TerminalDeckDependencies = {
  list: async () => HARNESS_TERMINAL_LISTING,
  create: async () => HARNESS_TERMINAL_LISTING.terminals[0] as never,
  rename: async () => HARNESS_TERMINAL_LISTING.terminals[0] as never,
  close: async () => ({ closed: true }),
  attach: async () => ({ write() {}, control() {}, close() {} }),
  loadXterm: () => new Promise(() => {}),
  watchTheme: () => () => {},
  confirmClose: () => false,
  confirmLink: () => false,
  writeClipboard: async () => undefined,
};

const HARNESS_TERMINAL_LISTING: TerminalListView = {
  sessionId: 'harness-session',
  terminals: [
    {
      id: 'a1b2c3d4e5f6',
      sessionId: 'harness-session',
      title: 'build',
      state: 'running',
      cols: 100,
      rows: 30,
      viewers: 1,
      openedBy: { by: 'agent', sessionId: 'mse7wwti-2a75bd9c' },
      createdAt: '2026-08-04T09:00:00.000Z',
      lastActivityAt: '2026-08-04T09:41:00.000Z',
    },
    {
      id: '0f0e0d0c0b0a',
      sessionId: 'harness-session',
      title: 'watch tests',
      state: 'running',
      cols: 100,
      rows: 30,
      viewers: 0,
      openedBy: { by: 'human', deviceId: 'harness-device' },
      createdAt: '2026-08-04T09:05:00.000Z',
      lastActivityAt: '2026-08-04T09:39:00.000Z',
      idleDeadline: '2026-08-04T10:39:00.000Z',
    },
  ],
  limits: { perSession: 6, global: 24, runningGlobal: 2, idleTimeoutSeconds: 3600, scrollbackLines: 5_000 },
};

const dashboardSession = (
  id: string,
  teammate: string,
  taskName: string,
  cwd: string,
  state: Partial<SessionView['state']> = {},
  config: Partial<SessionView['config']> = {},
): SessionView =>
  ({
    ...harnessSession,
    config: {
      ...harnessSession.config,
      id,
      teammate,
      name: taskName,
      cwd,
      label: 'pwalist',
      agent: 'codex',
      harness: 'codex',
      model: 'gpt-5.6-sol',
      modelHint: 'gpt-5.6',
      ...config,
    },
    state: {
      ...harnessSession.state,
      id,
      lastActivityAt: '2026-07-31T11:58:00.000Z',
      contextPercent: 54,
      activity: 'Porting the responsive dashboard',
      ...state,
    },
  }) as SessionView;

const DASHBOARD_SESSIONS: readonly SessionView[] = [
  dashboardSession('ms9zelda-a1', 'zelda', 'Assemble the sessions dashboard', '/work/ferretry'),
  dashboardSession(
    'ms9fable-b2',
    'fable',
    'Review the visual contract',
    '/work/ferretry',
    { status: 'awaiting_user', contextPercent: 88, needsHuman: 'Choose the release window' },
    { remoteControl: true },
  ),
  dashboardSession('ms9tyrese-c3', 'tyrese', 'Audit migration safety', '/work/ferretry', {
    status: 'failed',
    activity: undefined,
    contextPercent: 31,
  }),
  dashboardSession('ms9karime-d4', 'karime', 'Map the PWA primitives', '/work/home-manager', {
    status: 'completed',
    activity: undefined,
    contextPercent: 42,
  }),
  dashboardSession('ms9alex-e5', 'alexavier', 'Build dashboard rows', '/work/home-manager', {
    status: 'running',
    activity: 'Waiting on the test gate',
    waiting: { since: '2026-07-31T11:50:00.000Z', condition: 'the test gate' },
    contextPercent: 73,
  }),
  dashboardSession('ms9lina-f6', 'lina', 'Verify daemon isolation', '/work/home-manager', {
    contextPercent: 96,
  }),
  // An interactive session started without a name: the daemon titles it "interactive", which the list drops.
  dashboardSession(
    'ms9ronaldo-h8',
    'ronaldo',
    'interactive',
    '/work/ferretry',
    { activity: undefined },
    { mode: 'interactive' },
  ),
  dashboardSession(
    'ms9mira-g7',
    'mira',
    'Trace protocol compatibility',
    '/work/protocol',
    { status: 'completed', activity: undefined, contextPercent: 18 },
    { agent: 'codex-retired' },
  ),
];

/**
 * The roster the dashboard, header and list name each session's account from. Every harness session
 * runs on the `codex` wrapper, which this fleet calls "Studio Codex"; the last dashboard row runs on
 * a wrapper the roster no longer holds, so the id fallback is on screen too.
 */
const HARNESS_SESSION_ACCOUNTS: readonly PickerAccount[] = [
  {
    id: '44444444-4444-4444-8444-444444444444',
    kind: 'codex',
    agent: true,
    wrapper: 'codex',
    credentialId: 'studio-codex',
    displayName: 'Studio Codex',
    defaultModel: 'gpt-5.6-sol',
    models: [{ id: 'gpt-5.6-sol', available: true }],
    available: true,
    unavailableReason: null,
  },
];

const DASHBOARD_GROUPS: readonly SessionGroup[] = [
  { name: 'ferretry', path: '/work/ferretry', rows: DASHBOARD_SESSIONS.slice(0, 3) },
  { name: 'home-manager', path: '/work/home-manager', rows: DASHBOARD_SESSIONS.slice(3, 6) },
  { name: 'protocol', path: '/work/protocol', rows: DASHBOARD_SESSIONS.slice(6) },
];

const DASHBOARD_COMPACT_GROUPS: readonly SessionGroup[] = [
  { name: 'ferretry', path: '/work/ferretry', rows: DASHBOARD_SESSIONS.slice(0, 3) },
  { name: 'home-manager', path: '/work/home-manager', rows: DASHBOARD_SESSIONS.slice(3, 6) },
  { name: 'protocol', path: '/work/protocol', rows: DASHBOARD_SESSIONS.slice(6) },
];

const DASHBOARD_USAGE = new DaemonUsageIndex();
DASHBOARD_USAGE.apply(daemon.daemonId, {
  at: '2026-07-31T11:59:00.000Z',
  stale: false,
  accounts: [
    {
      agent: 'codex',
      usageBased: true,
      provider: 'openai',
      availability: 'available',
      unavailable: false,
      fiveHourPercent: 37,
      weeklyPercent: 61,
      atLimit: false,
      authOk: true,
    },
  ],
});

/** One daemon's fleet, as the palette ranks and renders it. */
const PALETTE_SESSIONS = paletteSessionEntries([
  harnessSession,
  {
    ...harnessSession,
    config: {
      ...harnessSession.config,
      id: 'ms9hi4ts-b22751c4',
      teammate: 'jessica',
      name: '[Jessica] Port the command palette',
    },
  },
  {
    ...harnessSession,
    config: {
      ...harnessSession.config,
      id: 'kq21ffds-90ab12cd',
      teammate: 'ms-98',
      name: 'Wire the daemon picker',
      cwd: '/work/kteam',
    },
    state: { ...harnessSession.state, status: 'completed' },
  },
] as SessionView[]);

/**
 * A lead with a live child and grandchild — the smallest fleet that shows every
 * bulk-stop warning: an included caller, a current-session ancestor, and
 * descendants that an orphan stop would leave running.
 */
const stopLead = harnessSession;

const stopChild = {
  ...harnessSession,
  config: {
    ...harnessSession.config,
    id: 'ms9hi4ts-b22751c4',
    teammate: 'jessica',
    name: 'Port the command palette',
    parent: 'harness-session',
  },
} as SessionView;

const stopGrandchild = {
  ...harnessSession,
  config: {
    ...harnessSession.config,
    id: 'kq21ffds-90ab12cd',
    teammate: 'ms-98',
    name: 'Wire the daemon picker',
    parent: 'ms9hi4ts-b22751c4',
  },
} as SessionView;

const STOP_FLEET: SessionView[] = [stopLead, stopChild, stopGrandchild];

/** The same fleet as the sidebar draws it: one folder, lineage-nested. */
const SIDEBAR_FLEET = {
  groups: [{ name: 'ferretry', path: '/work/ferretry', rows: STOP_FLEET }],
  lineage: buildLineage(STOP_FLEET),
  byId: new Map(STOP_FLEET.map(view => [view.config.id, view])),
  counts: { all: 3, auto: 2, interactive: 1 },
  shown: 3,
  total: 7,
  scope: '/work/ferretry',
};

const SIDEBAR_FILTERS = { query: '', mode: 'all', rcOnly: false, includeFinished: false } as const;

const RUNTIME_VIEW = {
  ...harnessSession,
  config: { ...harnessSession.config, harness: 'claude' },
  state: { ...harnessSession.state, promptReady: true, observedModel: 'claude-opus-5' },
} as SessionView;

/** The harness never reaches a daemon; a runtime command resolves and stops there. */
const HARNESS_RUNTIME_API = { runtime: async () => undefined };

const HARNESS_CLAUDE_CATALOG = {
  load: async () => ({
    harness: 'claude' as const,
    source: 'wrapper-inventory' as const,
    choices: [
      {
        value: 'claude-opus-5',
        label: 'Opus 5',
        description: 'The deepest model this account advertises.',
        isDefault: true as const,
        reasoningEfforts: [],
      },
      { value: 'claude-sonnet-5', label: 'claude-sonnet-5', reasoningEfforts: [] },
    ],
  }),
};

const PENDING_ATTACHMENTS = [
  {
    localId: 'p-1',
    file: { name: 'screenshot.png', type: 'image/png', size: 483_000 } as File,
    status: 'ready' as const,
  },
  {
    localId: 'p-2',
    file: { name: 'design-brief.pdf', type: 'application/pdf', size: 1_204_000 } as File,
    status: 'uploading' as const,
  },
  {
    localId: 'p-3',
    file: { name: 'archive.zip', type: 'application/zip', size: 92_000_000 } as File,
    status: 'failed' as const,
    error: 'This file is larger than the daemon accepts.',
  },
];

const PALETTE_COMMANDS = [
  {
    id: 'browser-login',
    label: 'Open browser login window',
    description: 'Sign in to shared Chrome through the private browser-login window',
    searchTerms: 'browser login sign in shared chrome',
    run: () => {},
  },
];

/**
 * The REAL Settings catalog answers the harness palette, exactly as it answers
 * the app's. A hand-written settings list here would put a capture of rows the
 * product does not have beside the ones it does.
 */
const PALETTE_SETTINGS: PaletteSettingsSource = (daemon, query) => settingsPaletteEntries(daemon, query);

/**
 * A ferret's agenda in its chat: the line above the composer, pressed open into its drawer.
 * `harness/screenshot.ts --attention-only` presses the line and captures it, which proves the journey
 * rather than just the render.
 */
function AgendaHarness() {
  return (
    <Card className="overflow-hidden" data-harness="agenda" style={{ height: 520 }}>
      <AgendaChatHarness board={ATTENTION} now={HARNESS_NOW} />
    </Card>
  );
}

/** Attention fixture puts all four response shapes beside their distinct action
 * controls. The permission background stays deliberately long so the phone
 * disclosure is exercised without hiding the required action. */
const ATTENTION: AttentionSnapshot = {
  v: 1,
  sessionId: 'harness-session',
  count: 4,
  parseErrors: 0,
  updatedAt: '2026-07-31T12:00:00.000Z',
  items: [
    {
      id: 'A3',
      source: 'agent-raised',
      sourceRef: null,
      sourceSeq: 1,
      subject: 'Approve this browser pairing request',
      why: 'The device needs permission before it can read this daemon’s session ledger.',
      context:
        'This paired browser holds no daemon identity in its bundle. Approval is deliberately runtime-scoped, and the detail stays behind a disclosure on a phone so the action remains visible. A daemon switch clears this ledger before the next scoped request lands, so one daemon can never briefly show another daemon’s attention.',
      waitingSince: '2026-07-31T11:30:00.000Z',
      howToResolve: 'Approve to grant this browser access to the paired daemon.',
      ask: { kind: 'permission' },
      raisedBy: 'agent',
      raisedBySession: 'harness-session',
      raisedByName: 'Zoe',
    },
    {
      id: 'A4',
      source: 'agent-raised',
      sourceRef: null,
      sourceSeq: 2,
      subject: 'Choose the next migration step',
      why: 'The agent needs one bounded direction before it can continue.',
      context: 'Each option has a different trade-off; choose exactly one.',
      waitingSince: '2026-07-31T11:35:00.000Z',
      howToResolve: 'Choose one of the offered options.',
      ask: {
        kind: 'multiple-choice',
        options: [
          { label: 'Port the data model', description: 'Make the durable response contract first.' },
          { label: 'Polish the UI', description: 'Defer the model work.' },
        ],
      },
      raisedBy: 'agent',
      raisedBySession: 'harness-session',
      raisedByName: 'Zoe',
    },
    {
      id: 'A5',
      source: 'agent-raised',
      sourceRef: null,
      sourceSeq: 3,
      subject: 'Review the generated migration note',
      why: 'The agent has produced a proposed answer that needs human review.',
      waitingSince: '2026-07-31T11:40:00.000Z',
      howToResolve: 'Accept the answer or explain what needs clarifying.',
      ask: { kind: 'answer-review' },
      raisedBy: 'agent',
      raisedBySession: 'harness-session',
      raisedByName: 'Zoe',
    },
    {
      id: 'A6',
      source: 'agent-raised',
      sourceRef: null,
      sourceSeq: 4,
      subject: 'Describe the preferred release timing',
      why: 'No fixed option can capture the needed scheduling context.',
      waitingSince: '2026-07-31T11:45:00.000Z',
      howToResolve: 'Write the response in your own words.',
      ask: { kind: 'open-question' },
      raisedBy: 'agent',
      raisedBySession: 'harness-session',
      raisedByName: 'Zoe',
    },
  ],
  resolved: [
    {
      id: 'A2',
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Withdraw the obsolete staging approval',
      why: 'A newer release plan replaced the staging path before the human answered.',
      waitingSince: '2026-07-31T11:15:00.000Z',
      howToResolve: 'Dismiss the superseded request.',
      ask: { kind: 'permission' },
      raisedBy: 'agent',
      raisedBySession: 'harness-session',
      raisedByName: 'Zoe',
      resolvedAt: '2026-07-31T11:27:00.000Z',
      resolvedBy: 'agent',
      resolvedBySession: 'harness-session',
      // The recorded ledger carries no display name for most agent work, so the audit
      // badge has to read the way it will in production: named by its session.
      resolvedByName: null,
      resolutionNote: 'The agent retracted its own stale request after the release plan changed.',
      disposition: 'dismissed',
    },
    {
      id: 'A1',
      source: 'task',
      sourceRef: 'F12',
      subject: 'Remove the superseded release gate',
      why: 'The old task gate no longer applies to the release.',
      waitingSince: '2026-07-31T11:05:00.000Z',
      howToResolve: 'Dismiss the gate after confirming the replacement task.',
      raisedBy: 'daemon',
      raisedBySession: null,
      raisedByName: null,
      resolvedAt: '2026-07-31T11:25:00.000Z',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: 'The human confirmed the replacement task and dismissed this daemon-raised item.',
      disposition: 'dismissed',
    },
  ],
};

/** Notes and a transcript pin exercise provenance, edit affordances, and the
 * exact-message action without ever connecting the visual harness to a daemon. */
const PINS: PinSnapshot = {
  v: 1,
  sessionId: 'harness-session',
  updatedAt: '2026-07-31T12:00:00.000Z',
  pins: [
    {
      id: '00000000-0000-4000-8000-000000000021',
      at: 2,
      kind: 'note',
      text: 'Check the snapshot release before asking the lead to merge.',
      by: 'agent',
      createdBy: 'harness-agent',
      createdByName: 'Zoe',
    },
    {
      id: '00000000-0000-4000-8000-000000000022',
      at: 1,
      kind: 'message',
      blockId: 'harness-message',
      blockKind: 'assistant',
      preview: 'The visual harness now captures this feature at both breakpoints.',
      by: 'human',
      createdBy: null,
      createdByName: null,
    },
  ],
};

const BROWSER_LOGIN: BrowserLoginView = {
  state: 'open',
  profilePrimed: false,
  expiresAt: '2026-07-31T12:02:00.000Z',
  connection: {
    host: '127.0.0.1',
    port: 5951,
    password: 'temporary-password',
    sshTunnel: 'ssh -N -L 5951:127.0.0.1:5951 reader@example.test',
  },
};

/** Three real pages, one of them untitled and one last touched by the agent:
 * the tab strip's fallback label and its agent marker are both on screen. */
const REMOTE_BROWSER: BrowserStatus = {
  sessionId: 'harness-session',
  state: 'running',
  pages: [
    { id: 'harness-page', url: 'https://example.test', title: 'Example' },
    { id: 'docs-page', url: 'https://docs.example.test/getting-started', title: 'Getting started — Docs' },
    { id: 'blank-page', url: 'https://api.example.test/v1/health', title: '' },
  ],
  activePageId: 'harness-page',
  url: 'https://example.test',
  title: 'Example',
  canGoBack: true,
  canGoForward: false,
  pageState: 'ready',
  viewport: { width: 640, height: 480 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 900,
  agentPage: { pageId: 'docs-page', kind: 'agent', action: 'read', at: '2026-07-31T11:00:00.000Z' },
  lastActor: { kind: 'human', at: '2026-07-31T11:02:00.000Z', action: 'click' },
  capacity: { running: 1, maximum: 3 },
};

/** A deterministic daemon seam: the visual harness must never reach a live daemon. */
const HARNESS_BROWSER_TRANSPORT: RemoteBrowserTransport = {
  readStatus: async () => REMOTE_BROWSER,
  runAction: async () => ({ status: REMOTE_BROWSER }),
};

/** Keep the fixture stable after its one initial read instead of arming a real poll. */
const HARNESS_BROWSER_SCHEDULE: RemoteBrowserScheduler = () => () => undefined;

/** A daemon response fixture: the unpriced row is deliberate and must stay
 * visible rather than being treated as a zero-cost result. */
const ANALYTICS = {
  kind: 'aggregate',
  aggregation: 'sum',
  query: 'sum by (model)',
  parsed: { aggregation: 'sum', groupBy: ['model'], matchers: [] },
  scope: { allSessions: true, indexed: 5, matched: 1 },
  index: {
    schemaVersion: 6,
    sessions: 5,
    tokenSessions: 5,
    transcriptSources: 5,
    indexedTranscriptSources: 5,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  },
  results: [
    {
      labels: { model: 'gpt-5.6-sol' },
      sessions: 4,
      tokens: { value: 1_204_320, known: 4, total: 4 },
      inputTokens: { value: 902_100, known: 4, total: 4 },
      outputTokens: { value: 302_220, known: 4, total: 4 },
      cachedInputTokens: { value: 122_000, known: 4, total: 4 },
      cacheWriteInputTokens: { value: 20_000, known: 4, total: 4 },
      equivalentApiCostUsdMicros: { value: 3_450_000, known: 4, total: 4 },
    },
    {
      labels: { model: 'unpriced' },
      sessions: 1,
      tokens: { value: 80_120, known: 1, total: 1 },
      inputTokens: { value: 67_000, known: 1, total: 1 },
      outputTokens: { value: 13_120, known: 1, total: 1 },
      cachedInputTokens: { value: 0, known: 1, total: 1 },
      cacheWriteInputTokens: { value: 0, known: 1, total: 1 },
      equivalentApiCostUsdMicros: { value: null, known: 0, total: 1 },
    },
  ],
} as unknown as AnalyticsAggregateResponse;

/** Raw-query fixture: its unknown price must remain visible in the responsive renderer. */
const ANALYTICS_RAW: AnalyticsResponse = {
  kind: 'raw',
  query: '{status=running}',
  parsed: { groupBy: [], matchers: [] },
  scope: { allSessions: true, indexed: 2, matched: 1 },
  index: {
    schemaVersion: 6,
    sessions: 2,
    tokenSessions: 1,
    transcriptSources: 2,
    indexedTranscriptSources: 2,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  },
  limit: 200,
  truncated: true,
  results: [
    {
      id: 'harness-running-session',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      contextWindow: null,
      harness: 'codex',
      mode: 'auto',
      status: 'running',
      label: 'Port analytics response',
      cwd: '/work/ferretry',
      parent: null,
      day: '2026-07-31',
      week: '2026-W31',
      createdAt: '2026-07-31T11:00:00.000Z',
      pricingModel: null,
      equivalentApiCostUsdMicros: null,
      tokens: 12_400,
      inputTokens: 9_100,
      outputTokens: 3_300,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      cacheWrite5mInputTokens: 0,
      cacheWrite1hInputTokens: 0,
      reasoningTokens: null,
      turns: 4,
      durationMs: null,
      activeDurationMs: null,
      machine: null,
      timeToFirstOutputMs: null,
      contextEndPercent: 22,
      stalled: false,
      failed: false,
      migrated: false,
      completed: false,
    },
  ],
};

/** Stable injected requests prevent parent harness renders from restarting either analytics surface. */
const HARNESS_GLOBAL_ANALYTICS_REQUEST: AnalyticsRequest = async (connection, query) =>
  answerAnalyticsFixture(query ?? 'sum by (day)', connection.daemonId);
const HARNESS_SESSION_ANALYTICS_REQUEST: SessionAnalyticsRequest = async (connection, _scope, query) =>
  answerAnalyticsFixture(query ?? 'sum by (model)', connection.daemonId);
/** The second machine the analytics fixture answers for. */
const analyticsOtherDaemon = daemonConnection({
  daemonId: ANALYTICS_FIXTURE_MACHINES[1].daemonId,
  baseUrl: 'https://kirin-box.invalid/',
  deviceId: 'harness-other-token',
  daemonName: ANALYTICS_FIXTURE_MACHINES[1].name,
});
/** Both machines, as the app hands them to Analytics. */
const HARNESS_ANALYTICS_MACHINES = [
  { connection: daemon, name: ANALYTICS_FIXTURE_MACHINES[0].name },
  { connection: analyticsOtherDaemon, name: ANALYTICS_FIXTURE_MACHINES[1].name },
];
/** The metric chart on its own: cost per day over the same fleet the Analytics page reads. */
const HARNESS_ANALYTICS_POINTS = analyticsOverview(
  analyticsRangeDays(14, ANALYTICS_FIXTURE_NOW),
  ANALYTICS_FIXTURE_ROWS.map(row => overviewRow(row, { daemonId: 'harness-daemon', name: row.machine ?? '' })),
).days.map(bucket => ({
  key: bucket.key,
  label: formatDay(bucket.key),
  values: [bucket.totals.costMicros / 1_000_000],
  flagged: bucket.totals.unpriced > 0,
  empty: bucket.totals.sessions === 0,
}));

class HarnessBrowserSocket implements RemoteBrowserSocket {
  readyState = 0;
  binaryType: BinaryType = 'blob';
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  constructor() {
    window.setTimeout(() => {
      this.readyState = 1;
      this.emit('open', new Event('open'));
      const id = new TextEncoder().encode('harness-page');
      const frame = new Uint8Array(7 + id.length + 1);
      frame.set([0x46, 0x59, 0x42, 0x46, 1, 0, id.length]);
      frame.set(id, 7);
      frame[frame.length - 1] = 0;
      this.emit('message', new MessageEvent('message', { data: frame.buffer }));
    }, 0);
  }

  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** The harness screenshots the display; input has nowhere to go. */
  send(): void {}

  close(): void {
    this.readyState = 3;
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const harnessFrame =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"%3E%3Crect width="640" height="480" fill="%23111827"/%3E%3Crect x="32" y="32" width="576" height="54" rx="8" fill="%231f2937"/%3E%3Ccircle cx="58" cy="59" r="8" fill="%23ef4444"/%3E%3Ccircle cx="82" cy="59" r="8" fill="%23f59e0b"/%3E%3Ccircle cx="106" cy="59" r="8" fill="%2310b981"/%3E%3Crect x="140" y="46" width="390" height="26" rx="5" fill="%23374151"/%3E%3Ctext x="158" y="64" fill="%23d1d5db" font-family="system-ui" font-size="14"%3Ehttps://example.test%3C/text%3E%3Ctext x="320" y="250" text-anchor="middle" fill="%23f9fafb" font-family="system-ui" font-size="30"%3ERemote browser%3C/text%3E%3Ctext x="320" y="286" text-anchor="middle" fill="%239ca3af" font-family="system-ui" font-size="16"%3ELive daemon-scoped frame%3C/text%3E%3C/svg%3E';
const HARNESS_BROWSER_SOCKET_FACTORY = () => new HarnessBrowserSocket();
const HARNESS_BROWSER_CREATE_OBJECT_URL = () => harnessFrame;
const HARNESS_BROWSER_REVOKE_OBJECT_URL = () => undefined;

/**
 * The real remote pane, pre-bound to the harness's offline daemon seams. The
 * unified surface takes its remote engine as a dependency, so the harness hands
 * it the SAME stubbed transport, poll and socket the standalone pane card uses —
 * one fixture, two cards, and no card that could reach a live daemon.
 */
const HarnessRemotePane = (props: RemoteBrowserPaneProps) => (
  <RemoteBrowserPane
    {...props}
    transport={HARNESS_BROWSER_TRANSPORT}
    schedule={HARNESS_BROWSER_SCHEDULE}
    socketFactory={HARNESS_BROWSER_SOCKET_FACTORY}
    createObjectUrl={HARNESS_BROWSER_CREATE_OBJECT_URL}
    revokeObjectUrl={HARNESS_BROWSER_REVOKE_OBJECT_URL}
  />
);

const HARNESS_UNIFIED_BROWSER_DEPENDENCIES: UnifiedBrowserDependencies = {
  ...DEFAULT_UNIFIED_BROWSER_DEPENDENCIES,
  RemotePane: HarnessRemotePane,
};

/** The session workspace's engine: the same offline seams, over the workspace's own pages. */
const HARNESS_WORKSPACE_BROWSER_DEPENDENCIES: UnifiedBrowserDependencies = {
  ...DEFAULT_UNIFIED_BROWSER_DEPENDENCIES,
  RemotePane: (props: RemoteBrowserPaneProps) => (
    <RemoteBrowserPane
      {...props}
      transport={HARNESS_WORKSPACE_BROWSER_TRANSPORT}
      schedule={HARNESS_BROWSER_SCHEDULE}
      socketFactory={HARNESS_BROWSER_SOCKET_FACTORY}
      createObjectUrl={HARNESS_BROWSER_CREATE_OBJECT_URL}
      revokeObjectUrl={HARNESS_BROWSER_REVOKE_OBJECT_URL}
    />
  ),
};

/**
 * One scope per unified-browser card. The remembered engine is module state keyed
 * by `(daemonId, sessionId)`, so two cards sharing a scope would fight over which
 * engine is selected; two scopes make each card's engine a fixture of its own.
 */
const UNIFIED_PREVIEW_SCOPE = daemonSessionScope(daemon, 'harness-unified-preview');
const UNIFIED_REMOTE_SCOPE = daemonSessionScope(daemon, 'harness-unified-remote');
const FULL_VIEWPORT_BROWSER_SCOPE = daemonSessionScope(daemon, 'harness-browser-full-viewport');
/** Seeded, not clicked: the real-engine card renders that engine on first paint. */
rememberBrowserEngine(UNIFIED_REMOTE_SCOPE, 'remote');
rememberBrowserEngine(FULL_VIEWPORT_BROWSER_SCOPE, 'remote');

/** Deterministic device controls: never a real device's stored view state. */
const memoryControlsStorage = (): ControlsStorage => {
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

/**
 * The connected Sessions page, composed exactly as production composes it: real
 * `DaemonFleetStore` / `DaemonControlsStore` / `DaemonProjectsStore` /
 * `DaemonUsageStore` over stub PORTS. The ports are the only fiction, so this
 * card proves the composition — hydration, grouping, filtering, density, scope —
 * and not just the presentation the other dashboard cards already cover.
 */
const SESSIONS_PAGE_CONTROLS = new DaemonControlsStore(memoryControlsStorage());
// Finished sessions are shown so this card carries the same rows as the
// presentation cards above it; a reviewer is comparing them side by side.
SESSIONS_PAGE_CONTROLS.setDeviceControls({ dashboardView: 'table', density: 'full', includeFinished: true });
/** The app-chrome Sessions frame: a phone's own defaults (cards), `?density=full|compact|minimal` to pick one. */
const APP_CHROME_SESSIONS_CONTROLS = new DaemonControlsStore(memoryControlsStorage());
{
  const density = new URLSearchParams(window.location.search).get('density');
  if (density === 'full' || density === 'compact' || density === 'minimal')
    APP_CHROME_SESSIONS_CONTROLS.setDeviceControls({ density });
}

/**
 * `?long-names=1`: the sessions a phone must not scroll sideways for — a task title with one unbroken word, a
 * deep folder, a path with no breaks, a long model, callsign and activity, and a long unbroken label — so the
 * Sessions page's geometry gate (`sessions-page-geometry.ts`) measures the worst text, not the polite kind.
 */
const LONG_NAME_SESSIONS: readonly SessionView[] = [
  dashboardSession(
    'ms9long-a1',
    'bartholomew-the-third-of-the-long-callsigns',
    'Rewrite_the_quarterly_reconciliation_job_so_that_it_never_double_counts_a_settled_invoice_again',
    '/work/ferretry/packages/pwa/src/components/very-long-folder-name-without-any-break-at-all/and-another-one',
    {
      status: 'awaiting_user',
      needsHuman: 'Choose_the_release_window_for_the_unbroken_deployment_of_the_whole_monorepo_today',
      activity: 'Waiting_on_the_extremely_long_running_integration_test_gate_for_the_pwa_package',
    },
    {
      label: 'a-very-long-unbroken-task-label-that-keeps-going-and-going-and-going-past-any-phone-width',
      model: 'claude-opus-5-5-with-an-unreasonably-long-model-identifier-1m-context',
    },
  ),
  dashboardSession(
    'ms9long-b2',
    'ottilie',
    'Fix the stuck sign-in on the checkout page when the saved card has expired and the user is on a slow network',
    '/work/home-manager/modules/some/deeply/nested/module/directory/structure/that/never/ends/here',
    { status: 'running' },
    { label: 'Fix the stuck sign-in on the checkout page when the saved card has expired' },
  ),
];

const SESSIONS_PAGE_FLEET = new DaemonFleetStore({
  list: async () =>
    new URLSearchParams(window.location.search).has('long-names')
      ? [...LONG_NAME_SESSIONS, ...DASHBOARD_SESSIONS]
      : DASHBOARD_SESSIONS,
  get: async () => {
    throw new Error('the harness never reads a single session');
  },
} satisfies DaemonFleetPort);

const SESSIONS_PAGE_PROJECTS = new DaemonProjectsStore({
  projects: async () => DASHBOARD_GROUPS.map(group => ({ name: group.name, path: group.path })),
} satisfies DaemonProjectsPort);

/**
 * `isHidden` is pinned true: the first read after `watch()` is unconditional, so
 * the quota columns still fill in, and no 60s poll is armed behind a screenshot.
 */
const SESSIONS_PAGE_USAGE = new DaemonUsageStore(
  {
    usage: async () => ({
      at: '2026-07-31T11:59:00.000Z',
      stale: false,
      accounts: [
        {
          agent: 'codex',
          usageBased: true,
          provider: 'openai',
          availability: 'available',
          unavailable: false,
          fiveHourPercent: 37,
          weeklyPercent: 61,
          atLimit: false,
          authOk: true,
        },
      ],
    }),
  } satisfies DaemonUsagePort,
  { isHidden: () => true },
);

const SESSIONS_PAGE_WARDEN: WardenStatusReader = async () => WARDEN;

/**
 * The scope machine's window, as a port. A harness card must not write the real
 * address bar: the page's own `#menu`/`#palette` fragments are how the
 * screenshot script drives it.
 */
const harnessScopeNavigation = (): ScopeNavigation => {
  let current = new URL(daemonSessionsPath(daemon.daemonId), 'https://harness.invalid');
  let state: unknown = null;
  const pops = new Set<() => void>();
  return {
    snapshot: () => ({ pathname: current.pathname, search: current.search, state }),
    push: (next, url) => {
      current = new URL(url, 'https://harness.invalid');
      state = next;
    },
    replace: (next, url) => {
      current = new URL(url, 'https://harness.invalid');
      state = next;
    },
    announce: () => {
      for (const listener of pops) listener();
    },
    listen: listener => {
      pops.add(listener);
      return () => {
        pops.delete(listener);
      };
    },
  };
};

const SESSIONS_PAGE_NAVIGATION = harnessScopeNavigation();

/** Frozen: a screenshot must not drift with the wall clock between viewports. */
const HARNESS_FROZEN_CLOCK: LiveClockOptions = { now: () => HARNESS_NOW, hold: true };

/** The four dashboard states worth one screenshot, in the order they degrade. */
const DASHBOARD_STATE_CARDS = [
  { title: 'Loading', sessions: null, groups: [], error: null, scopeRecovered: false },
  { title: 'Authoritative empty fleet', sessions: [], groups: [], error: null, scopeRecovered: false },
  // One row each: the banner is the subject, and a longer list would only be
  // cut off by the fixed cell height these four states share.
  {
    title: 'Fleet error',
    sessions: DASHBOARD_SESSIONS,
    groups: [{ name: 'ferretry', path: '/work/ferretry', rows: DASHBOARD_SESSIONS.slice(0, 1) }],
    error: 'The daemon could not list sessions: connection refused.',
    scopeRecovered: false,
  },
  {
    title: 'Scope recovery',
    sessions: DASHBOARD_SESSIONS,
    groups: [{ name: 'ferretry', path: '/work/ferretry', rows: DASHBOARD_SESSIONS.slice(0, 1) }],
    error: null,
    scopeRecovered: true,
  },
] as const satisfies ReadonlyArray<{
  readonly title: string;
  readonly sessions: readonly SessionView[] | null;
  readonly groups: readonly SessionGroup[];
  readonly error: string | null;
  readonly scopeRecovered: boolean;
}>;

// ─── the account and project pickers ─────────────────────────────────────────

/**
 * THE PICKER ROSTER, and why it is not `HARNESS_FLEET_ACCOUNTS`.
 *
 * That fixture is already the subject of the fleet roster card and three fleet
 * fragment captures, so widening it to carry quota and health would silently
 * change images that have already been reviewed. This one exists to make ONE
 * screenshot answer every question a reader asks of an account row, so each
 * entry carries a different combination of the three independent facts:
 *
 *   studio    available · quota well inside both windows · checked healthy
 *   atelier   available · AT LIMIT                       · checked down (timeout)
 *   loge      available · signed out (`authOk: false`)    · checked unknown
 *   terra     available · no quota row at all             · never checked
 *   archive   UNAVAILABLE with the manifest's reason      · no quota · never checked
 *
 * The last two are the ones worth staring at: "no quota row" has to render
 * `quota —` rather than 0 %, and "never checked" has to read differently from a
 * check that ran and could not tell.
 */
/** Named rather than indexed, so the health map below joins on an id a reader can see. */
const PICKER_ID = {
  studio: 'aaaaaaaa-1111-4111-8111-111111111111',
  atelier: 'aaaaaaaa-2222-4222-8222-222222222222',
  loge: 'aaaaaaaa-3333-4333-8333-333333333333',
  terra: 'aaaaaaaa-4444-4444-8444-444444444444',
  archive: 'aaaaaaaa-5555-4555-8555-555555555555',
} as const;

const HARNESS_PICKER_ACCOUNTS = [
  {
    id: PICKER_ID.studio,
    kind: 'claude',
    agent: true,
    wrapper: 'claude-auto-studio',
    credentialId: 'studio',
    displayName: 'Studio Claude',
    defaultModel: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: PICKER_ID.atelier,
    kind: 'claude',
    agent: true,
    wrapper: 'claude-auto-atelier',
    credentialId: 'atelier',
    displayName: 'Atelier Claude',
    defaultModel: 'claude-sonnet-5',
    models: [{ id: 'claude-sonnet-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: PICKER_ID.loge,
    kind: 'claude',
    agent: false,
    wrapper: 'claude-auto-loge',
    credentialId: 'loge',
    displayName: 'Loge Claude',
    defaultModel: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: PICKER_ID.terra,
    kind: 'codex',
    agent: true,
    wrapper: 'codex-auto-terra',
    credentialId: 'terra',
    displayName: 'Terra Codex',
    defaultModel: 'gpt-5.6-terra',
    models: [{ id: 'gpt-5.6-terra', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: PICKER_ID.archive,
    kind: 'codex',
    agent: true,
    wrapper: 'codex-auto-archive',
    credentialId: 'archive',
    displayName: 'Archive Codex',
    defaultModel: null,
    models: [],
    available: false,
    unavailableReason: 'the fleet publishes codex-auto-archive but this host has no such executable on its PATH',
  },
] satisfies readonly PickerAccount[];

/** The cached quota feed's rows, joined onto accounts by WRAPPER. Two are deliberately absent. */
const HARNESS_PICKER_USAGE: readonly AccountUsageRow[] = [
  { agent: 'claude-auto-studio', fiveHourPercent: 37, weeklyPercent: 61, atLimit: false, authOk: true },
  { agent: 'claude-auto-atelier', fiveHourPercent: 100, weeklyPercent: 88, atLimit: true, authOk: true },
  { agent: 'claude-auto-loge', authOk: false },
];

/** The stored verdicts the daemon published. Two accounts are deliberately absent from it. */
const HARNESS_PICKER_HEALTH: ReadonlyMap<string, PickerAccountHealth> = new Map([
  [
    'studio',
    {
      credentialId: 'studio',
      word: 'ready' as const,
      label: 'Ready',
      reason: 'provider_accepted' as const,
      explanation: 'The provider accepted this login.',
      lastCheckedAt: new Date(HARNESS_NOW - 120_000).toISOString(),
      lastCheckInconclusive: false,
    },
  ],
  [
    'atelier',
    {
      credentialId: 'atelier',
      word: 'needs_sign_in' as const,
      label: 'Needs sign-in',
      reason: 'provider_rejected' as const,
      explanation: 'The provider rejected this login. Sign in again to use it.',
      lastCheckedAt: new Date(HARNESS_NOW - 4_000).toISOString(),
      lastCheckInconclusive: false,
    },
  ],
  [
    // A 403: READY, with the quota unmeasurable. Under review here precisely because it is the
    // reading a reviewer is most likely to expect to look like a failure and must not.
    'loge',
    {
      credentialId: 'loge',
      word: 'ready' as const,
      label: 'Ready',
      reason: 'usage_scope_unavailable' as const,
      explanation: 'Accepted, but this login cannot read usage, so quota is not measurable.',
      lastCheckedAt: new Date(HARNESS_NOW - 3_000).toISOString(),
      lastCheckInconclusive: false,
    },
  ],
]);

/** A settled roster slice. No store and no network: the ADAPTER is under review. */
const pickerSlice = (overrides: Partial<DaemonAccountPickerSlice> = {}): DaemonAccountPickerSlice => ({
  generation: 1,
  catalog: { accounts: HARNESS_PICKER_ACCOUNTS },
  status: 'ready',
  error: null,
  health: null,
  healthStatus: 'idle',
  healthError: null,
  ...overrides,
});

const pickerAccountSource = (slice: DaemonAccountPickerSlice) =>
  accountFieldSource(
    slice,
    accountFieldOptions(
      accountPickerOptions(slice.catalog?.accounts ?? null, HARNESS_PICKER_USAGE, slice.health),
      HARNESS_NOW,
    ),
  );

/**
 * The fleet a first run creates: the terminal account published FIRST, then the
 * one that can run sessions. The New session form must offer only the second, and
 * fill it in.
 */
const HARNESS_FIRST_RUN_ACCOUNTS = [
  {
    id: 'bbbbbbbb-1111-4111-8111-111111111111',
    kind: 'claude',
    agent: false,
    wrapper: 'claude-default',
    credentialId: 'claude-default',
    displayName: 'Claude (default)',
    defaultModel: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: 'bbbbbbbb-2222-4222-8222-222222222222',
    kind: 'claude',
    agent: true,
    wrapper: 'claude-auto-default',
    credentialId: 'claude-default',
    displayName: 'Claude (default, auto)',
    defaultModel: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  ...HARNESS_PICKER_ACCOUNTS,
] satisfies readonly PickerAccount[];

/** A roster store over a fixed answer: the harness reaches no daemon. */
const harnessRosterStore = (accounts: readonly PickerAccount[]): DaemonAccountPickerStore =>
  new DaemonAccountPickerStore({
    catalog: async () => ({ accounts }),
    health: async () => ({ health: new Map(), error: null }),
    checkHealth: async () => ({ health: new Map(), error: null }),
  });

const HARNESS_FIRST_RUN_ROSTER = harnessRosterStore(HARNESS_FIRST_RUN_ACCOUNTS);

/** A host whose only account is the terminal one: nothing here can run a session. */
const HARNESS_TERMINAL_ONLY_ROSTER = harnessRosterStore(HARNESS_FIRST_RUN_ACCOUNTS.slice(0, 1));

/** A machine that has exactly one runtime that can run a session. */
const HARNESS_ONE_RUNTIME_ROSTER = harnessRosterStore(HARNESS_FIRST_RUN_ACCOUNTS.slice(1, 2));

/**
 * A busy machine: Claude and Codex runtimes with long names, a catalog login, an unavailable runtime,
 * stored health and cached quota on some and nothing on others — so the buttons wrap at 390px and each
 * evidence line is reviewed against a row with none.
 */
const HARNESS_MANY_RUNTIMES = [
  ...HARNESS_PICKER_ACCOUNTS.filter(account => account.agent),
  {
    id: 'cccccccc-1111-4111-8111-111111111111',
    kind: 'claude',
    agent: true,
    wrapper: 'claude-auto-glm',
    credentialId: 'glm',
    displayName: 'GLM via Z.ai',
    defaultModel: 'glm-5.3',
    models: [{ id: 'glm-5.3', available: true, label: 'GLM-5.3', tier: 'best', efforts: [] }],
    modelCatalog: { id: 'zai', label: 'GLM / Z.ai', customIds: false },
    available: true,
    unavailableReason: null,
  },
  {
    id: 'cccccccc-2222-4222-8222-222222222222',
    kind: 'claude',
    agent: true,
    wrapper: 'claude-auto-warehouse-night-shift',
    credentialId: 'warehouse',
    displayName: 'Warehouse night shift',
    defaultModel: 'claude-sonnet-5',
    models: [{ id: 'claude-sonnet-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: 'cccccccc-3333-4333-8333-333333333333',
    kind: 'codex',
    agent: true,
    wrapper: 'codex-auto-review',
    credentialId: 'review',
    displayName: 'Review Codex',
    defaultModel: 'gpt-5.6-sol',
    models: [{ id: 'gpt-5.6-sol', available: true }],
    available: true,
    unavailableReason: null,
  },
] satisfies readonly PickerAccount[];

const HARNESS_MANY_RUNTIMES_ROSTER = new DaemonAccountPickerStore({
  catalog: async () => ({ accounts: HARNESS_MANY_RUNTIMES }),
  health: async () => ({ health: HARNESS_PICKER_HEALTH, error: null }),
  checkHealth: async () => ({ health: HARNESS_PICKER_HEALTH, error: null }),
});

const HARNESS_MANY_RUNTIMES_USAGE = new DaemonUsageStore(
  {
    usage: async () => ({
      at: '2026-07-31T11:59:00.000Z',
      stale: false,
      accounts: HARNESS_PICKER_USAGE.map(row => ({
        ...row,
        usageBased: true,
        provider: 'anthropic',
        availability: 'available' as const,
        unavailable: false,
      })),
    }),
  } satisfies DaemonUsagePort,
  { isHidden: () => true },
);

/** Two registered folders, and folders a session has used that no registry names. */
const HARNESS_PICKER_REGISTRY: readonly FleetProject[] = [
  { name: 'ferretry', path: '/home/pilot/work/ferretry', id: 'p-1', source: 'clone' },
  { name: 'home-manager', path: '/home/pilot/.config/home-manager', id: 'p-2', source: 'existing-folder' },
];

const harnessPickerSession = (id: string, cwd: string, at: string): SessionView =>
  ({
    config: { ...harnessSession.config, id, cwd, updatedAt: at },
    state: { ...harnessSession.state, id, lastActivityAt: at },
    directory: cwd,
  }) as SessionView;

/**
 * Where the "recent" half comes from. The worktree beneath `ferretry` is in here
 * on purpose: the projection folds it into the registered root rather than
 * offering two ways to reach the same place.
 */
const HARNESS_PICKER_SESSIONS: readonly SessionView[] = [
  harnessPickerSession('picker-a', '/home/pilot/scratch/spike', '2026-07-31T11:40:00.000Z'),
  harnessPickerSession('picker-b', '/home/pilot/work/ferretry/wt-pickers', '2026-07-31T11:20:00.000Z'),
  harnessPickerSession('picker-c', '/home/pilot/work/nitroso', '2026-07-31T10:05:00.000Z'),
];

/**
 * The folders the New session cards offer, from the same registry and sessions
 * as the picker cards. The app hands the form both stores, so a capture without
 * them showed a bare path box that a phone reader never actually sees.
 */
const HARNESS_NEW_SESSION_PROJECTS = new DaemonProjectsStore({
  projects: async () => HARNESS_PICKER_REGISTRY,
} satisfies DaemonProjectsPort);

const HARNESS_NEW_SESSION_FLEET = new DaemonFleetStore({
  list: async () => HARNESS_PICKER_SESSIONS,
  get: async () => {
    throw new Error('the harness never reads a single session');
  },
} satisfies DaemonFleetPort);

const HARNESS_PICKER_PROJECT_SOURCE = projectFieldSource(
  { projects: HARNESS_PICKER_REGISTRY, status: 'ready', error: null },
  {
    sessions: HARNESS_PICKER_SESSIONS,
    byId: new Map(HARNESS_PICKER_SESSIONS.map(view => [view.config.id, view])),
    status: 'ready',
    error: null,
  },
  projectFieldOptions(projectPickerOptions(HARNESS_PICKER_REGISTRY, HARNESS_PICKER_SESSIONS)),
);

/**
 * The value owner both pickers need.
 *
 * A picker's whole contract is that the TYPED STRING is the answer, so a harness
 * that passed a constant `value` would be reviewing a control nobody can use.
 * This holds the state exactly as a write surface does, which is also what lets
 * the screenshot driver type into it and watch the list narrow.
 */
function HarnessPickerHost({
  initial = '',
  render,
}: {
  readonly initial?: string;
  readonly render: (value: string, onValueChange: (next: string) => void) => ReactNode;
}) {
  const [value, setValue] = useState(initial);
  return <>{render(value, setValue)}</>;
}

/** One labelled field, in the shape both write surfaces wrap their inputs in. */
function HarnessPickerLabel({
  hint,
  id,
  label,
  children,
}: {
  readonly hint: string;
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <span className="flex flex-wrap items-baseline gap-2">
        <label className="text-ui font-semibold text-fg" htmlFor={id}>
          {label}
        </label>
        <span className="text-meta text-faint" id={`${id}-help`}>
          {hint}
        </span>
      </span>
      {children}
    </div>
  );
}

/**
 * The account field, as a write surface mounts it — the SHIPPED presentational
 * component over the SHIPPED projections, with a slice literal standing in for
 * the store. Nothing here poses a popover or fakes a row.
 */
function HarnessAccountPicker({
  checked = false,
  id,
  slice = pickerSlice(),
}: {
  readonly checked?: boolean;
  readonly id: string;
  readonly slice?: DaemonAccountPickerSlice;
}) {
  const resolved = checked ? pickerSlice({ health: HARNESS_PICKER_HEALTH, healthStatus: 'ready' }) : slice;
  return (
    <HarnessPickerLabel hint="the wrapper that will run this session" id={id} label="Account">
      <HarnessPickerHost
        render={(value, onValueChange) => (
          <AccountPickerField
            describedBy={`${id}-help`}
            healthCheck={{
              status: resolved.healthStatus,
              error: resolved.healthError,
              checked: resolved.health?.size ?? 0,
              onCheck: () => undefined,
            }}
            id={id}
            label="Account"
            onValueChange={onValueChange}
            placeholder="claude-default"
            source={pickerAccountSource(resolved)}
            value={value}
          />
        )}
      />
    </HarnessPickerLabel>
  );
}

function HarnessProjectPicker() {
  return (
    <HarnessPickerLabel hint="working directory for the session" id="harness-picker-cwd" label="Project">
      <HarnessPickerHost
        render={(value, onValueChange) => (
          <ProjectPickerField
            describedBy="harness-picker-cwd-help"
            id="harness-picker-cwd"
            label="Project"
            onValueChange={onValueChange}
            placeholder="/absolute/path/to/project"
            source={HARNESS_PICKER_PROJECT_SOURCE}
            value={value}
          />
        )}
      />
    </HarnessPickerLabel>
  );
}

// ---------------------------------------------------------------------------
// Projects hub
// ---------------------------------------------------------------------------

/**
 * ONE GIT PROJECT AND ONE NON-GIT PROJECT, because the provenance rail's whole
 * job is telling them apart: a cloned checkout carries a common directory and a
 * folder somebody created does not, and a review that only ever sees the first
 * cannot notice that the second reads as an empty space.
 */
const HARNESS_PROJECT_REGISTRY: readonly FleetProject[] = [
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    name: 'ferretry',
    path: '/home/pilot/work/ferretry',
    source: 'clone',
    createdAt: '2026-07-14T09:12:00.000Z',
    git: { commonDirectory: '/home/pilot/work/ferretry/.git' },
  },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    name: 'operator-notes',
    path: '/home/pilot/notes/operator',
    source: 'new-folder',
    createdAt: '2026-08-02T16:40:00.000Z',
  },
];

/** Two unregistered folders sessions have used, newest first. */
const HARNESS_PROJECT_DISCOVERIES: readonly RecentProjectOption[] = [
  {
    kind: 'recent',
    key: '/home/pilot/scratch/spike',
    name: 'spike',
    path: '/home/pilot/scratch/spike',
    lastActivity: '2026-08-06T09:40:00.000Z',
    searchText: '/home/pilot/scratch/spike recent',
  },
  {
    kind: 'recent',
    key: '/home/pilot/work/nitroso',
    name: 'nitroso',
    path: '/home/pilot/work/nitroso',
    lastActivity: '2026-08-04T18:05:00.000Z',
    searchText: '/home/pilot/work/nitroso recent',
  },
];

const HARNESS_PROJECT_NOW = Date.parse('2026-08-06T12:00:00.000Z');

/** Which hub state a standalone page is showing. */
type HarnessProjectsFrame = 'hub' | 'empty' | 'loading' | 'error' | 'refused' | 'registered' | 'already-registered';

const harnessProjectsSlice = (frame: HarnessProjectsFrame): DaemonProjectsSlice => {
  if (frame === 'loading') return { projects: null, status: 'loading', error: null };
  if (frame === 'empty') return { projects: [], status: 'ready', error: null };
  // A failed refresh keeps the folders it already had. Capturing the failure
  // WITH a good list is the point: a blanked list reads as "nothing registered".
  if (frame === 'error')
    return {
      projects: HARNESS_PROJECT_REGISTRY,
      status: 'error',
      error: 'the daemon closed the connection before answering',
    };
  return { projects: HARNESS_PROJECT_REGISTRY, status: 'ready', error: null };
};

const HARNESS_REGISTERED_RECORD: ProjectInfo = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
  name: 'spike',
  path: '/home/pilot/scratch/spike',
  source: 'confirmed-discovery',
  createdAt: '2026-08-06T11:58:00.000Z',
};

const harnessProjectsStatus = (frame: HarnessProjectsFrame): ProjectRegistrationStatus | null => {
  if (frame === 'refused')
    return {
      phase: 'refused',
      request: { kind: 'new-folder', path: '/home/pilot/work/deep/nested', initializeGit: true },
      message: 'ENOENT: no such file or directory, mkdir ’/home/pilot/work/deep/nested’',
    };
  if (frame === 'registered')
    return {
      phase: 'registered',
      request: { kind: 'confirmed-discovery', path: '/home/pilot/scratch/spike' },
      project: HARNESS_REGISTERED_RECORD,
      alreadyRegistered: false,
    };
  if (frame === 'already-registered')
    return {
      phase: 'registered',
      request: { kind: 'existing-folder', path: '/home/pilot/scratch/spike' },
      project: HARNESS_REGISTERED_RECORD,
      alreadyRegistered: true,
    };
  return null;
};

/**
 * The hub on a page of its own.
 *
 * `ProjectsHub` is the shipped presentational half, so this frame renders exactly
 * what production renders and every state below is a state the component can
 * really be in. The form's own states are reached by DRIVING it — the disclosure,
 * the mode radios, the git checkbox — for the same reason the picker frames do:
 * a posed form proves nothing about the one a reader has to operate.
 */
function ProjectsFrameHarness({ frame }: { readonly frame: HarnessProjectsFrame }) {
  useAppViewport();
  return (
    <main
      aria-label={`Projects ${frame}`}
      className="min-h-dvh bg-bg"
      id={`harness-projects-${frame}-page`}
      data-harness-projects={frame}
    >
      <div className="mx-auto w-full max-w-[1100px]">
        <ProjectsHub
          slice={harnessProjectsSlice(frame)}
          discoveries={frame === 'empty' ? [] : HARNESS_PROJECT_DISCOVERIES}
          sessionsError={null}
          status={harnessProjectsStatus(frame)}
          onRegister={async () => true}
          onDismiss={() => undefined}
          now={HARNESS_PROJECT_NOW}
        />
      </div>
    </main>
  );
}

/** Which picker a standalone page is showing. */
type HarnessPickerFrame = 'account' | 'account-checked' | 'account-failed' | 'project';

/**
 * ONE PICKER, ON A PAGE OF ITS OWN, and this is not a convenience.
 *
 * The popover is `absolute` inside its field and paints outside the field's own
 * box. In the stacked gallery that box lives inside a scroller, so an element
 * capture clips the list away and a full-page stitch repaints the sticky bar
 * over it — the same trap the fleet frames documented. A page with no scrolling
 * ancestor and no sticky chrome is the only place a viewport capture of an OPEN
 * list is the truth, and it is also the only place the 44px and
 * inside-the-viewport assertions mean anything.
 */
function PickerFrameHarness({ frame }: { readonly frame: HarnessPickerFrame }) {
  useAppViewport();
  return (
    <main
      aria-label={`Picker ${frame}`}
      className="min-h-dvh bg-bg p-panel"
      id={`harness-picker-${frame}-page`}
      data-harness-picker={frame}
    >
      <div className="mx-auto grid w-full max-w-[720px] gap-panel">
        <header className="grid gap-xs">
          <p className="m-0 text-meta font-semibold uppercase tracking-label text-faint">Daemon pickers</p>
          <h1 className="m-0 text-title font-semibold text-fg">{frame === 'project' ? 'Project' : 'Account'}</h1>
        </header>
        {frame === 'project' ? (
          <HarnessProjectPicker />
        ) : frame === 'account-failed' ? (
          <HarnessAccountPicker
            id={`harness-picker-${frame}-agent`}
            slice={pickerSlice({
              catalog: null,
              status: 'error',
              error: 'this daemon refused the account roster: fleet_manifest_invalid',
            })}
          />
        ) : (
          <HarnessAccountPicker checked={frame === 'account-checked'} id={`harness-picker-${frame}-agent`} />
        )}
      </div>
    </main>
  );
}

function Shell() {
  const [version, bump] = useState(0);
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sttSettings, setSttSettings] = useState<SttSettings>(HARNESS_STT_SETTINGS);
  const [statuses, setStatuses] = useState<ReadonlySet<TaskStatus> | null>(null);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('identity');
  const [paneWidth, setPaneWidth] = useState(SIDE_PANE_DEFAULT_WIDTH);
  const [paneQuery, setPaneQuery] = useState('');
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const state = readSidePaneTabsState(scope);
  const phone = viewport.width <= PHONE_MAX;
  const menuOpen = window.location.hash === '#menu';
  const paletteOpen = window.location.hash === '#palette';
  const rowMenuOpen = window.location.hash === '#row-menu';
  const stopOpen = window.location.hash === '#stop';
  const fleetDrawerOpen = window.location.hash === '#fleet-drawer';
  const stopResultsOpen = window.location.hash === '#stop-results';
  const migrateOpen = window.location.hash === '#migrate';
  const renameOpen = window.location.hash === '#rename';
  const [chatWidth, setChatWidth] = useState<ChatWidth>('balanced');

  // The headless browser sizes its window after the first paint, so a viewport
  // read once at mount would report the wrong width in the screenshot.
  useEffect(() => {
    const sync = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  const tabs = state.open
    .map(id => resolveSidePaneTab(scope, id))
    .filter((def): def is SidePaneTabDefinition => def !== undefined);

  const rerender = () => bump(version + 1);

  // Keep feature surfaces append-only. PWA units add one entry instead of
  // competing to edit the gallery's JSX body during integration.
  const HARNESS_CARDS: ReadonlyArray<{ label: string; render: () => ReactNode }> = [
    {
      label: 'New session',
      render: () => (
        <section aria-label="New session" id="harness-new-session">
          <NewSessionPage
            connection={daemon}
            onNavigate={() => {}}
            startSession={async () => ({ config: { id: 'harness-created-session' } })}
          />
        </section>
      ),
    },
    {
      label: 'Session dashboard full table',
      render: () => (
        <section
          aria-label="Session dashboard full table"
          className="h-[720px] min-h-0 overflow-hidden rounded-panel border border-border bg-surface px-panel"
        >
          <SessionDashboard
            connection={daemon}
            dashboardView="table"
            density="full"
            error={null}
            groups={DASHBOARD_GROUPS}
            narrow={phone}
            now={HARNESS_NOW}
            onEnterScope={() => {}}
            onExitScope={() => {}}
            onOpenWardenReport={() => {}}
            onSetView={() => {}}
            scope={null}
            scopeName=""
            scopeRecovered={false}
            sessions={DASHBOARD_SESSIONS}
            usage={DASHBOARD_USAGE}
            accounts={HARNESS_SESSION_ACCOUNTS}
            wardenStatus={null}
            wardenVerdicts={[]}
          />
        </section>
      ),
    },
    {
      label: 'Session dashboard full cards',
      render: () => (
        <section
          aria-label="Session dashboard full cards"
          className="h-[720px] min-h-0 overflow-hidden rounded-panel border border-border bg-surface px-panel"
        >
          <SessionDashboard
            connection={daemon}
            dashboardView="cards"
            density="full"
            error={null}
            groups={DASHBOARD_GROUPS}
            narrow={phone}
            now={HARNESS_NOW}
            onEnterScope={() => {}}
            onExitScope={() => {}}
            onOpenWardenReport={() => {}}
            onSetView={() => {}}
            scope={null}
            scopeName=""
            scopeRecovered={false}
            sessions={DASHBOARD_SESSIONS}
            usage={DASHBOARD_USAGE}
            accounts={HARNESS_SESSION_ACCOUNTS}
            wardenStatus={null}
            wardenVerdicts={[]}
          />
        </section>
      ),
    },
    {
      label: 'Session dashboard compact panel',
      render: () => (
        <section
          aria-label="Session dashboard compact panel"
          className="h-[720px] min-h-0 overflow-hidden rounded-panel border border-border bg-surface px-panel"
        >
          <SessionDashboard
            connection={daemon}
            dashboardView="cards"
            density="compact"
            error={null}
            groups={DASHBOARD_COMPACT_GROUPS}
            narrow={phone}
            now={HARNESS_NOW}
            onEnterScope={() => {}}
            onExitScope={() => {}}
            onOpenWardenReport={() => {}}
            onSetView={() => {}}
            scope={null}
            scopeName=""
            scopeRecovered={false}
            sessions={DASHBOARD_SESSIONS}
            usage={DASHBOARD_USAGE}
            wardenStatus={null}
            wardenVerdicts={[]}
          />
        </section>
      ),
    },
    {
      label: 'Session dashboard scoped',
      render: () => (
        <section
          aria-label="Session dashboard scoped"
          className="h-[720px] min-h-0 overflow-hidden rounded-panel border border-border bg-surface px-panel"
        >
          <SessionDashboard
            connection={daemon}
            dashboardView={null}
            density="full"
            error={null}
            groups={DASHBOARD_GROUPS.slice(0, 1)}
            narrow={phone}
            now={HARNESS_NOW}
            onEnterScope={() => {}}
            onExitScope={() => {}}
            onOpenWardenReport={() => {}}
            onSetView={() => {}}
            scope="/work/ferretry"
            scopeName="ferretry"
            scopeRecovered={false}
            sessions={DASHBOARD_SESSIONS}
            usage={DASHBOARD_USAGE}
            wardenStatus={null}
            wardenVerdicts={[]}
          />
        </section>
      ),
    },
    {
      label: 'Setup — what do you have',
      render: () => (
        <section aria-label="Setup entry question" id="harness-onboarding-entry">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.entry}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Setup — the prompt for an agent',
      render: () => (
        <section aria-label="Setup agent brief step" id="harness-onboarding-brief">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.brief}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      /*
       * The same prompt when the agent is on ANOTHER machine, which is the frame
       * that proves the gap is closed: a clipboard does not cross devices, so this
       * one carries the share sheet and the address of the page over there.
       */
      label: 'Setup — the prompt, for an agent elsewhere (phone)',
      render: () => (
        <section aria-label="Setup agent brief step for another machine" id="harness-onboarding-brief-elsewhere">
          <OnboardingPage
            progress={HARNESS_ONBOARDING['brief-elsewhere']}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="brew"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            share={HARNESS_SHARE}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Setup — pair with what the agent printed',
      render: () => (
        <section aria-label="Setup agent pairing step" id="harness-onboarding-agent-pair">
          <OnboardingPage
            progress={HARNESS_ONBOARDING['agent-pair']}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => (
              <PairingScreen
                embedded
                connections={[]}
                selectedDaemonId={null}
                scanHost={HARNESS_SCAN_HOST}
                onPair={async () => {}}
                onRemove={() => {}}
                onSelect={() => {}}
              />
            )}
          />
        </section>
      ),
    },
    {
      label: 'Setup — pair with what an agent elsewhere printed (phone)',
      render: () => (
        <section aria-label="Setup agent pairing step for another machine" id="harness-onboarding-agent-pair-elsewhere">
          <OnboardingPage
            progress={HARNESS_ONBOARDING['agent-pair-elsewhere']}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => (
              <PairingScreen
                embedded
                connections={[]}
                selectedDaemonId={null}
                scanHost={HARNESS_SCAN_HOST}
                onPair={async () => {}}
                onRemove={() => {}}
                onSelect={() => {}}
              />
            )}
          />
        </section>
      ),
    },
    {
      label: 'Setup — which computer runs it',
      render: () => (
        <section aria-label="Setup target question" id="harness-onboarding-target">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.target}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      /* The assumption, stated, with the escape from it beside the answers. */
      label: 'Setup — who installs it',
      render: () => (
        <section aria-label="Setup doer question" id="harness-onboarding-doer">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.doer}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Setup — install',
      render: () => (
        <section aria-label="Setup install step" id="harness-onboarding-install">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.install}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      /*
       * The step that makes the daemon worth starting: Ferretry RUNS Claude Code
       * and Codex and is neither of them, so a reader who skips this finishes with
       * a paired app that cannot open one session.
       */
      label: 'Setup — install an agent harness',
      render: () => (
        <section aria-label="Setup agents step" id="harness-onboarding-agents">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.agents}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="brew"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Setup — start the daemon',
      render: () => (
        <section aria-label="Setup daemon step" id="harness-onboarding-daemon">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.daemon}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="brew"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      /* The same question on a phone, above the FACT that replaced asking. */
      label: 'Setup — who installs it (phone)',
      render: () => (
        <section aria-label="Setup doer question on a phone" id="harness-onboarding-doer-mobile">
          <OnboardingPage
            progress={HARNESS_ONBOARDING['doer-mobile']}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="brew"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Setup — same machine, nothing to scan',
      render: () => (
        <section aria-label="Setup local pairing step" id="harness-onboarding-local">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.local}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => (
              <PairingScreen
                embedded
                connections={[]}
                selectedDaemonId={null}
                scanHost={HARNESS_SCAN_HOST}
                onPair={async () => {}}
                onRemove={() => {}}
                onSelect={() => {}}
              />
            )}
          />
        </section>
      ),
    },
    {
      /*
       * THE RECURSION, ON BOTH KINDS OF DEVICE. The pair is the evidence for the
       * claim that this is ONE screen: a phone that can never host a daemon and a
       * computer standing up a second machine are told the same thing, in the same
       * words, because in both cases the machine that matters is somewhere else.
       */
      label: 'Setup — open it on that computer (phone)',
      render: () => (
        <section aria-label="Setup elsewhere step on a phone" id="harness-onboarding-elsewhere-mobile">
          <OnboardingPage
            progress={HARNESS_ONBOARDING['elsewhere-mobile']}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="brew"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Setup — open it on that computer',
      render: () => (
        <section aria-label="Setup elsewhere step" id="harness-onboarding-elsewhere">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.elsewhere}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Setup — add your phone',
      render: () => (
        <section aria-label="Setup hand-off step" id="harness-onboarding-handoff">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.handoff}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Setup — arrived with a link',
      render: () => (
        <section aria-label="Setup scan step" id="harness-onboarding-scan">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.scan}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="curl"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => (
              <PairingScreen
                embedded
                connections={[]}
                selectedDaemonId={null}
                scanHost={HARNESS_SCAN_HOST}
                onPair={async () => {}}
                onRemove={() => {}}
                onSelect={() => {}}
              />
            )}
          />
        </section>
      ),
    },
    {
      label: 'Setup — run fy pair',
      render: () => (
        <section aria-label="Setup pair step" id="harness-onboarding-pair">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.pair}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="curl"
            fallback={HARNESS_FALLBACK.available}
            fleetReady={false}
            onOpenFleet={() => {}}
            renderPairing={() => (
              <PairingScreen
                embedded
                connections={[]}
                selectedDaemonId={null}
                scanHost={HARNESS_SCAN_HOST}
                onPair={async () => {}}
                onRemove={() => {}}
                onSelect={() => {}}
              />
            )}
          />
        </section>
      ),
    },
    {
      label: 'Setup — done',
      render: () => (
        <section aria-label="Setup done step" id="harness-onboarding-done">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.done}
            write={HARNESS_CLIPBOARD}
            href={HARNESS_SETUP_HREF}
            channel="apt"
            fallback={HARNESS_FALLBACK.available}
            fleetReady
            onOpenFleet={() => {}}
            renderPairing={() => null}
          />
        </section>
      ),
    },
    {
      label: 'Daemon pairing',
      render: () => (
        <Card aria-label="Daemon pairing" className="min-w-0 overflow-hidden">
          <PairingScreen
            connections={[]}
            selectedDaemonId={null}
            scanHost={HARNESS_SCAN_HOST}
            onPair={async () => {}}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        </Card>
      ),
    },
    {
      label: 'Pairing confirmation',
      render: () => (
        <Card aria-label="Pairing confirmation" className="min-w-0 overflow-hidden">
          <PairingScreen
            connections={[]}
            selectedDaemonId={null}
            arrival={HARNESS_ARRIVAL}
            scanHost={HARNESS_SCAN_HOST}
            onPair={async () => await new Promise(() => {})}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        </Card>
      ),
    },
    /*
     * The two failures whose sentence IS the remedy. Each card's exchange rejects at once, so a capture
     * presses "Pair this device" and photographs what a reader is told: the machine is older (and how
     * to update it), or this browser cannot make the key Ferretry pairs with. The code is the fixed
     * fake `HARNESS_ARRIVAL` carries, never a real one.
     */
    {
      label: 'Pairing failed — machine is older',
      render: () => (
        <Card aria-label="Pairing failed — machine is older" className="min-w-0 overflow-hidden">
          <PairingScreen
            connections={[]}
            selectedDaemonId={null}
            arrival={HARNESS_ARRIVAL}
            scanHost={HARNESS_SCAN_HOST}
            onPair={async () => {
              throw new DaemonOutdatedError();
            }}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        </Card>
      ),
    },
    {
      label: 'Pairing failed — app is older',
      render: () => (
        <Card aria-label="Pairing failed — app is older" className="min-w-0 overflow-hidden">
          <PairingScreen
            connections={[]}
            selectedDaemonId={null}
            arrival={HARNESS_ARRIVAL}
            scanHost={HARNESS_SCAN_HOST}
            onPair={async () => {
              throw new AppOutdatedError();
            }}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        </Card>
      ),
    },
    /*
     * What replaces a machine's pages once it no longer accepts this browser (a revoke, or an idle
     * expiry): one sentence and the one action that repairs it, on either carrier.
     */
    {
      label: 'Machine no longer accepts this browser',
      render: () => (
        <Card aria-label="Machine no longer accepts this browser" className="min-w-0 overflow-hidden">
          <DeviceRefusedNotice machineName="studio.example" onPairAgain={() => {}} />
        </Card>
      ),
    },
    {
      label: 'Pairing failed — browser cannot make the key',
      render: () => (
        <Card aria-label="Pairing failed — browser cannot make the key" className="min-w-0 overflow-hidden">
          <PairingScreen
            connections={[]}
            selectedDaemonId={null}
            arrival={HARNESS_ARRIVAL}
            scanHost={HARNESS_SCAN_HOST}
            onPair={async () => {
              throw new DeviceKeyUnsupportedError();
            }}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        </Card>
      ),
    },
    {
      label: 'Paired daemon list',
      render: () => (
        <Card aria-label="Paired daemon list" className="min-w-0 overflow-hidden">
          <PairingScreen
            connections={[
              { ...daemon, label: 'Harness daemon', pairedAt: HARNESS_NOW - 3_600_000, lastSelectedAt: HARNESS_NOW },
              {
                daemonId: 'archive-daemon' as typeof daemon.daemonId,
                baseUrl: 'https://archive.invalid',
                deviceId: 'harness-archive-token',
                carriers: [{ kind: 'direct', daemonUrl: 'https://archive.invalid' }],
                label: 'Archive daemon',
                pairedAt: HARNESS_NOW - 7_200_000,
                lastSelectedAt: HARNESS_NOW - 1_800_000,
              },
            ]}
            selectedDaemonId={daemon.daemonId}
            scanHost={HARNESS_SCAN_HOST}
            onPair={async () => {}}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        </Card>
      ),
    },
    {
      label: 'Warden page',
      render: () => (
        <div data-harness="warden-overview">
          <WardenOverview
            connection={daemon}
            now={WARDEN_FIXTURE_NOW}
            status={{ status: 'ready', view: WARDEN_FIXTURE_STATUS }}
            attention={{ status: 'ready', view: WARDEN_FIXTURE_ATTENTION }}
            sessions={WORKSPACE_FLEET}
            settingsHref="#warden"
            onSweep={() => {}}
            onInvestigate={() => {}}
            onLeave={() => {}}
            onOpenReport={() => {}}
          />
        </div>
      ),
    },
    {
      label: 'Warden verdicts',
      render: () => (
        <WardenVerdicts
          connection={daemon}
          now={HARNESS_NOW}
          onOpenReport={() => {}}
          verdicts={[
            {
              at: '2026-07-31T11:58:00.000Z',
              targetSession: 'sess-1',
              teammate: 'ms-98',
              verdict: 'nudged',
              reason: 'Asked the session to report its current blocker',
              reportPath: 'warden/2026-07-31T11-58.md',
              spawn: {
                agent: 'claude-auto-loge',
                model: 'claude-sonnet-4-5',
                modelSource: 'harness',
                harness: 'claude',
                failedOver: true,
                configuredFirst: 'claude-auto-opus',
                skipped: { 'claude-auto-opus': 'at quota' },
              },
            },
          ]}
        />
      ),
    },
    {
      label: 'Reference standard',
      render: () => (
        // One card for the whole standard: every proved kind, an unproved token,
        // an escaped token, and the same references inside an inline span and a
        // highlighted fence — which is the pair a reviewer has to see side by
        // side to judge whether code styling really survived the decoration.
        <section aria-label="Reference standard harness" id="harness-references">
          <Markdown
            // Answers BOTH lookup forms, exactly as the live fleet resolver
            // does: prose links are re-proved by session id at render, so a
            // name-only fixture would paint every agent reference as prose.
            agentReferenceResolver={({ name, sessionId }) =>
              name === 'zelda' || sessionId === 'harness-session'
                ? { daemonId: daemon.daemonId, sessionId: 'harness-session', name: 'zelda' }
                : null
            }
            attentionReferenceResolver={id => id === 'A3'}
            onAttentionOpen={() => {}}
            onCodeReferenceOpen={() => {}}
            onNavigate={() => {}}
            onSkillOpen={() => {}}
            onSurfaceOpen={() => {}}
            onTaskOpen={() => {}}
            resolveFilePaths={async candidates =>
              new Map(candidates.filter(path => path === 'src/api.ts').map(path => [path, path]))
            }
            skillReferenceResolver={name => name === 'summary'}
            taskReferenceResolver={id => id === 'F12'}
            surfaceReferenceResolver={lookup =>
              lookup.key === '0a1b2c3d4e5f'
                ? {
                    state: 'open',
                    daemonId: daemon.daemonId,
                    sessionId: scope.sessionId,
                    surface: lookup.surface,
                    key: lookup.key,
                  }
                : { state: 'closed' }
            }
            text={HARNESS_REFERENCE_PROSE}
          />
        </section>
      ),
    },
    {
      label: 'Composer markdown highlighting',
      render: () => (
        // The real composer is one row tall until the reader drags it; the
        // harness stands it up so every paint token is visible at once.
        <section
          aria-label="Composer markdown highlighting harness"
          className="[&_textarea]:min-h-[15rem]"
          id="harness-composer-markdown"
        >
          <Composer
            api={{ send: async () => ({}) as never }}
            daemon={daemon}
            draftStore={markdownDrafts}
            sessionId={MARKDOWN_DRAFT_SCOPE.sessionId}
          />
        </section>
      ),
    },
    {
      label: 'Session command controls',
      render: () => (
        <SessionCommandControls
          api={{ compact: async () => {} }}
          canControl
          daemon={daemon}
          open
          promptReady
          sessionId="harness-session"
          status="awaiting_user"
        />
      ),
    },
    {
      label: 'Session screen',
      // `grid-cols-1` below `xl`, NOT the implicit `auto` column. An `auto` track grows to its items'
      // min-content, and a `truncate` label's min-content is its WHOLE text: with the Ubuntu runner's
      // fonts the panel came out 391.5px inside a 370px track, pushed the 390px page 11px sideways, and
      // the full gallery refused the tool-group capture because isolating it changed its width.
      // `minmax(0, 1fr)` lets the truncation do its job, as the real session page's layout does.
      render: () => (
        <section
          aria-label="Session screen harness"
          className="grid grid-cols-1 gap-panel xl:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.4fr)_minmax(15rem,0.7fr)]"
          id="harness-session-screen"
        >
          <SessionList
            accounts={HARNESS_SESSION_ACCOUNTS}
            daemonId={daemon.daemonId}
            onOpenSession={() => {}}
            sessions={[harnessSession]}
          />
          <div className="flex min-h-[320px] flex-col rounded-panel border border-border bg-surface">
            <SessionHeader
              accounts={HARNESS_SESSION_ACCOUNTS}
              daemonId={daemon.daemonId}
              onBack={() => {}}
              onOpenDetails={() => {}}
              onOpenFleet={() => {}}
              session={harnessSession}
            />
            <Transcript
              busy
              daemonId={daemon.daemonId}
              entries={[
                {
                  id: 'human',
                  kind: 'user',
                  text: 'Please port the session screen.',
                  label: 'You',
                  send: {
                    sendId: 'send-port',
                    acceptedAt: '2026-07-31T09:30:00.000Z',
                    message: 'Please port the session screen.',
                    attachmentIds: [],
                    fate: 'delivered',
                  },
                },
                { id: 'assistant', kind: 'assistant', text: 'I am adding rendered component tests.', label: 'Codex' },
                {
                  id: 'tools',
                  kind: 'tool',
                  text: 'ran 4 tools',
                  tools: [
                    {
                      key: 'tool-read',
                      use: { name: 'Read', input: { file_path: '/work/packages/pwa/src/components/transcript.tsx' } },
                      result: { text: 'export function Transcript(…)' },
                    },
                    {
                      key: 'tool-edit-1',
                      use: { name: 'Edit', input: { file_path: 'transcript-row.tsx', new_string: 'ToolGroup' } },
                      result: { text: 'applied' },
                    },
                    {
                      key: 'tool-edit-2',
                      use: { name: 'Edit', input: { file_path: 'tool-group.tsx', new_string: 'summarizeToolRun' } },
                      result: { text: 'applied' },
                    },
                    {
                      key: 'tool-bash',
                      use: { name: 'Bash', input: { command: 'bun test --config=bunfig.unit.toml' } },
                      result: { text: 'error: 1 test failed', isError: true },
                    },
                  ],
                },
                { id: 'notice', kind: 'notice', text: 'Drafts remain scoped to this paired daemon.' },
                {
                  id: 'ledger-row',
                  kind: 'ledger',
                  text: 'a durable send attempt',
                  placement: 'after-loaded',
                  ledger: {
                    sendId: 'send-in-transcript',
                    acceptedAt: '2026-07-31T09:58:00.000Z',
                    message: 'Remember to attach both screenshots.',
                    attachmentIds: [],
                    fate: 'unaccounted',
                    unaccountedReason: 'timeout',
                  },
                },
                {
                  id: 'tools-live',
                  kind: 'tool',
                  text: 'running a tool',
                  tools: [
                    {
                      key: 'tool-live-read',
                      use: { name: 'Read', input: { file_path: 'scripts/ci/test.sh' } },
                      result: { text: 'coverage ledger' },
                    },
                    {
                      key: 'tool-live-grep',
                      use: { name: 'Grep', input: { pattern: 'components' } },
                      result: { text: '1 match' },
                    },
                    {
                      key: 'tool-live',
                      use: { name: 'Bash', input: { command: 'bun test --coverage' } },
                      ts: new Date(Date.now() - 34_000).toISOString(),
                    },
                  ],
                },
              ]}
              onRetry={async () => true}
              sessionId="harness-session"
            />
            <section aria-label="Send ledger rows" className="flex flex-col gap-2">
              <LedgerMessage
                record={{
                  sendId: 'send-sending',
                  acceptedAt: '2026-07-31T10:00:10.000Z',
                  message: 'Also update the changelog.',
                  attachmentIds: [],
                  fate: 'accepted',
                  path: 'direct',
                }}
              />
              <LedgerMessage
                record={{
                  sendId: 'send-queued',
                  acceptedAt: '2026-07-31T10:00:00.000Z',
                  message: 'Please run the full gate before pushing.',
                  attachmentIds: [],
                  fate: 'queued',
                  path: 'native-inline',
                }}
              />
              <LedgerMessage
                onRetry={async () => true}
                record={{
                  sendId: 'send-timed-out',
                  acceptedAt: '2026-07-31T09:50:00.000Z',
                  message: 'Rebase onto main when you are done.',
                  attachmentIds: [],
                  fate: 'timed_out',
                  unaccountedReason: 'not_delivered',
                  attempt: 2,
                  retryable: true,
                }}
              />
              <LedgerMessage
                placement="before-loaded"
                onRetry={async () => true}
                record={{
                  sendId: 'send-unconfirmed',
                  acceptedAt: '2026-07-31T09:41:00.000Z',
                  message: '[peer message from teammate freddie]\nPARKED until 30m\n\nis CI green on your branch?',
                  attachmentIds: [],
                  fate: 'unaccounted',
                  unaccountedReason: 'transcript_unreadable',
                }}
              />
              <LedgerMessage
                record={{
                  sendId: 'send-delivered',
                  acceptedAt: '2026-07-31T09:12:00.000Z',
                  message: 'The tool group is in.',
                  attachmentIds: [],
                  fate: 'delivered',
                }}
              />
            </section>
            <Composer
              api={{ send: async () => ({}) as never }}
              daemon={daemon}
              quota={harnessSession.state.quota}
              sessionId="harness-session"
            />
            <QuestionForm
              api={{ answer: async () => ({}) }}
              daemon={daemon}
              question={{
                toolUseId: 'harness-question',
                questions: [
                  {
                    header: 'Port review',
                    question: 'Which verification should run before the PR is opened?',
                    options: [
                      { label: 'The complete gate', description: 'Run the exact CI reproduction.' },
                      { label: 'A focused test only', description: 'Fast but incomplete.' },
                    ],
                  },
                  {
                    header: 'Follow-up',
                    question: 'Should the screenshot comparison be included?',
                    options: [{ label: 'Yes', description: 'Check both desktop and phone layouts.' }],
                  },
                ],
              }}
              sessionId="harness-session"
            />
          </div>
          <SessionDetails daemonId={daemon.daemonId} session={harnessSession} />
        </section>
      ),
    },
    {
      label: 'Task name',
      render: () => (
        <Card aria-label="Task name" className="min-w-0">
          <PanelHeader>
            <Label>Task name</Label>
          </PanelHeader>
          <PanelBody>
            <TaskName name="[Hayden] Port the remaining PWA feature components" />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Lineage',
      render: () => (
        <section aria-label="Lineage preview" className="min-h-[360px]" id="harness-lineage">
          <Card className="h-full overflow-hidden">
            <LineageSurfaceContent daemonId={daemon.daemonId} sessionId="harness-session" sessions={LINEAGE_SESSIONS} />
          </Card>
        </section>
      ),
    },
    {
      label: 'Session task board',
      render: () => (
        <section aria-label="Task board preview" id="harness-task-board">
          <SessionTaskKanban
            compact={phone}
            daemonId={daemon.daemonId}
            onAddToChat={() => {}}
            onMarkDone={() => {}}
            onOpen={() => {}}
            tasks={[
              { ...TASKS[0]!, phase: 'live', status: 'live' },
              {
                ...TASKS[1]!,
                blocked: true,
                blockedReason: 'Waiting on the review queue',
                phase: 'build',
                status: 'blocked',
              },
              { ...TASKS[2]!, phase: 'done', status: 'done' },
            ]}
          />
        </section>
      ),
    },
    {
      // #43: the same rows in the LIST view, with the reference action a reader
      // uses to point an agent at exactly one task, and the sentence that says
      // where it went.
      label: 'Task list reference actions',
      render: () => (
        <section aria-label="Task list reference actions" className="flex flex-col gap-2" id="harness-task-list-refs">
          <SessionTaskList
            daemonId={daemon.daemonId}
            onAddToChat={() => {}}
            onMarkDone={() => {}}
            onOpen={() => {}}
            tasks={[
              { ...TASKS[0]!, phase: 'live', status: 'live' },
              { ...TASKS[1]!, phase: 'build', status: 'in_progress' },
            ]}
          />
          <p className="m-0 rounded-control bg-surface-2 px-2 py-1.5 text-ui text-muted" role="status">
            Added &amp;F12 to this session&apos;s message.
          </p>
        </section>
      ),
    },
    {
      label: 'Side pane tabs',
      render: () => (
        <Card data-harness="side-pane-tabs" className="flex min-h-0 flex-col overflow-hidden">
          <SidePaneTabs
            paneId="harness-pane"
            presentation={phone ? 'sheet' : 'pane'}
            tabs={tabs}
            all={getSidePaneTabDefinitions()}
            current={state.active ?? tabs[0]?.id ?? ''}
            onSelect={id => {
              openSidePaneTab(scope, id);
              rerender();
            }}
            onAdd={id => {
              openSidePaneTab(scope, id);
              rerender();
            }}
            onRemove={() => rerender()}
          />
          <PanelBody className="min-h-[180px] text-ui text-muted">
            The active surface body renders here. Feature surfaces are a sibling unit.
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Warden strip',
      render: () => (
        <Card>
          <PanelHeader className="flex items-center justify-between">
            <Label>Warden — fleet checks</Label>
          </PanelHeader>
          <PanelBody>
            <div data-harness="warden-strip">
              <WardenStrip status={WARDEN_NOT_REPORTING} now={HARNESS_NOW} />
            </div>
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Pins trigger',
      render: () => (
        <Card aria-label="Pins trigger" className="overflow-visible">
          <PanelHeader>
            <Label>Pins</Label>
          </PanelHeader>
          <PanelBody>
            <PinsTrigger id="harness-pins" count={3} expanded={false} onClick={() => {}} />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Skills',
      render: () => (
        <Card aria-label="Skills catalog" className="h-[520px] min-w-0 overflow-hidden" id="harness-skills">
          <SkillsSurface scope={scope} onInsert={() => {}} loadCatalog={async () => HARNESS_SKILLS} />
        </Card>
      ),
    },
    {
      label: 'Browser login',
      render: () => (
        <Card className="overflow-hidden">
          <PanelHeader>
            <Label>Browser login</Label>
          </PanelHeader>
          <BrowserLoginBanner
            status={BROWSER_LOGIN}
            now={HARNESS_NOW}
            onClose={async () => ({ state: 'closed', profilePrimed: false })}
          />
        </Card>
      ),
    },
    {
      label: 'Remote browser',
      render: () => (
        <Card aria-label="Remote browser" className="min-w-0 overflow-hidden" data-harness="remote-browser">
          <RemoteBrowserPane
            daemon={daemon}
            scope={scope}
            transport={HARNESS_BROWSER_TRANSPORT}
            schedule={HARNESS_BROWSER_SCHEDULE}
            socketFactory={HARNESS_BROWSER_SOCKET_FACTORY}
            createObjectUrl={HARNESS_BROWSER_CREATE_OBJECT_URL}
            revokeObjectUrl={HARNESS_BROWSER_REVOKE_OBJECT_URL}
          />
        </Card>
      ),
    },
    {
      label: 'Analytics cost ledger',
      render: () => (
        <Card aria-label="Analytics cost ledger" className="min-w-0 overflow-hidden">
          <PanelHeader>
            <Label>Analytics — cost ledger</Label>
          </PanelHeader>
          <PanelBody className="min-w-0">
            <AnalyticsResultTable response={ANALYTICS} caption="Harness analytics cost ledger" />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Analytics raw query result',
      render: () => (
        <Card aria-label="Analytics raw query result" className="min-w-0 overflow-hidden">
          <PanelHeader>
            <Label>Analytics — raw query result</Label>
          </PanelHeader>
          <PanelBody className="min-w-0">
            <AnalyticsResponseView response={ANALYTICS_RAW} />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Global analytics',
      render: () => (
        <GlobalAnalyticsPage
          connection={daemon}
          machines={HARNESS_ANALYTICS_MACHINES}
          onNavigate={() => {}}
          requestAnalytics={HARNESS_GLOBAL_ANALYTICS_REQUEST}
          now={() => ANALYTICS_FIXTURE_NOW}
          initialQuery={null}
        />
      ),
    },
    {
      label: 'Session analytics',
      render: () => (
        <Card aria-label="Session analytics" className="min-w-0 overflow-hidden">
          <SessionAnalyticsSurface
            connection={daemon}
            scope={scope}
            requestAnalytics={HARNESS_SESSION_ANALYTICS_REQUEST}
            requestFleetAnalytics={HARNESS_GLOBAL_ANALYTICS_REQUEST}
          />
        </Card>
      ),
    },
    {
      label: 'Warden configuration',
      render: () => <HarnessWardenConfig />,
    },
    {
      label: 'Warden configuration — unknown login',
      render: () => <HarnessWardenConfig view={WARDEN_FIXTURE_CONFIG_UNKNOWN_LOGIN} />,
    },
    {
      label: 'Warden configuration — no login set',
      render: () => <HarnessWardenConfig view={WARDEN_FIXTURE_CONFIG_NO_LOGIN} />,
    },
    {
      label: 'Analytics cost chart',
      render: () => (
        <Card aria-label="Analytics cost chart" className="min-w-0 overflow-hidden">
          <PanelHeader>
            <Label>Analytics — cost per day</Label>
          </PanelHeader>
          <PanelBody className="min-w-0">
            <AnalyticsMetricChart
              title="Equivalent API cost per day"
              series={[{ key: 'cost', label: 'Equivalent API cost', tone: 'accent' }]}
              points={HARNESS_ANALYTICS_POINTS}
              format={formatDollars}
              formatAxis={formatAxisUsd}
              flagNote="has unpriced sessions"
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Markdown composer settings',
      render: () => (
        <Card aria-label="Markdown composer settings">
          <PanelHeader>
            <Label>Composer settings</Label>
          </PanelHeader>
          <PanelBody>
            <MarkdownComposerSettings vimEnabled={false} onChangeVim={() => undefined} />
          </PanelBody>
        </Card>
      ),
    },
    ...(
      [
        ['Voice settings — not installed', 'harness-voice-absent', HARNESS_PARAKEET_ABSENT, 'parakeet'],
        ['Voice settings — installing', 'harness-voice-installing', HARNESS_PARAKEET_INSTALLING, 'parakeet'],
        ['Voice settings — installed', 'harness-voice-installed', HARNESS_PARAKEET_INSTALLED, 'parakeet'],
        ['Voice settings — browser voice', 'harness-voice-browser', HARNESS_PARAKEET_INSTALLED, 'browser'],
      ] as const
    ).map(([label, id, voice, engine]) => ({
      label,
      render: () => (
        <Card aria-label={label} className="min-w-0" id={id}>
          <PanelHeader>
            <Label>Voice</Label>
          </PanelHeader>
          <PanelBody>
            <VoiceEngineChoice
              value={engine}
              onChange={() => undefined}
              voice={voice}
              browserSupport={HARNESS_RECOGNITION_AVAILABLE}
            />
          </PanelBody>
        </Card>
      ),
    })),
    {
      label: 'Dictation shortcut settings',
      render: () => (
        <Card aria-label="Dictation shortcut settings">
          <PanelHeader>
            <Label>Dictation</Label>
          </PanelHeader>
          <PanelBody>
            <DictationShortcutPicker binding={DEFAULT_DICTATION_SHORTCUT} onChange={() => {}} />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Dictation panel',
      render: () => (
        <Card aria-label="Dictation panel" className="min-w-0" id="harness-dictation-panel">
          <PanelBody className="flex flex-col gap-4">
            {(
              [
                ['starting', undefined],
                ['recording', undefined],
                ['transcribing', undefined],
                ['empty', undefined],
                ['error', 'permission-denied'],
              ] as ReadonlyArray<readonly [DictationStage, string | undefined]>
            ).map(([stage, errorCode]) => (
              // The panel is absolutely positioned above its composer, so each
              // example needs its own positioned box at the same width.
              <div key={stage} className="relative h-[120px] min-w-0">
                <div className="absolute inset-x-0 top-[120px]">
                  <DictationSheet
                    open
                    stage={stage}
                    elapsedMs={65_000}
                    inputMonitor={harnessMonitor}
                    {...(errorCode ? { errorCode, errorMessage: 'Microphone access was blocked for this site.' } : {})}
                    onDismiss={() => {}}
                    onStop={() => {}}
                    onInsert={() => {}}
                    onDiscard={() => {}}
                    onCancel={() => {}}
                    onRetry={() => {}}
                  />
                </div>
              </div>
            ))}
          </PanelBody>
        </Card>
      ),
    },
    {
      // Parakeet's near-live words: committed words, the greyed interim tail, and the pause notice.
      label: 'Dictation near-live words',
      render: () => (
        <Card aria-label="Dictation near-live words" className="min-w-0" id="harness-dictation-near-live">
          <PanelBody className="flex flex-col gap-4">
            {(
              [
                ['recording', 'He hoped there would be stew for dinner, turnips and', 'carrots and bruised', false],
                ['recording', 'Stuff it into you, his belly', 'counselled him', true],
                ['transcribing', 'After early nightfall the yellow lamps would light up', '', false],
              ] as ReadonlyArray<readonly [DictationStage, string, string, boolean]>
            ).map(([stage, committed, interim, paused]) => (
              <div key={`${stage}-${committed}`} className="relative h-[120px] min-w-0">
                <div className="absolute inset-x-0 top-[120px]">
                  <DictationSheet
                    open
                    stage={stage}
                    engine="parakeet"
                    elapsedMs={14_000}
                    liveText={[committed, interim].filter(Boolean).join(' ')}
                    liveInterim={interim}
                    livePaused={paused}
                    onDismiss={() => {}}
                    onStop={() => {}}
                    onInsert={() => {}}
                    onDiscard={() => {}}
                    onCancel={() => {}}
                    onRetry={() => {}}
                  />
                </div>
              </div>
            ))}
          </PanelBody>
        </Card>
      ),
    },
    {
      // "We are capturing what you say": the same panel for both engines, speaking and then silent.
      label: 'Dictation input meter',
      render: () => (
        <Card aria-label="Dictation input meter" className="min-w-0" id="harness-dictation-meter">
          <PanelBody className="flex flex-col gap-4">
            {(
              [
                ['Parakeet, speaking', 'parakeet', harnessMonitor],
                ['Browser voice, speaking', 'browser', harnessMonitor],
                ['Parakeet, silent', 'parakeet', harnessSilentMonitor],
              ] as ReadonlyArray<readonly [string, 'parakeet' | 'browser', CaptureMonitor]>
            ).map(([name, engine, monitor]) => (
              <div key={name} className="flex min-w-0 flex-col gap-1">
                <Label>{name}</Label>
                <div className="relative h-[160px] min-w-0">
                  <div className="absolute inset-x-0 top-[160px]">
                    <DictationSheet
                      open
                      stage="recording"
                      engine={engine}
                      elapsedMs={9_000}
                      inputMonitor={monitor}
                      onDismiss={() => {}}
                      onStop={() => {}}
                      onInsert={() => {}}
                      onDiscard={() => {}}
                      onCancel={() => {}}
                      onRetry={() => {}}
                    />
                  </div>
                </div>
              </div>
            ))}
          </PanelBody>
        </Card>
      ),
    },
    {
      // The Settings switch for near-live words: OFF by default, labelled experimental.
      label: 'Dictation live words setting',
      render: () => <HarnessLiveWordsSetting />,
    },
    {
      label: 'Dictation mic button',
      render: () => (
        <Card aria-label="Dictation mic button" className="min-w-0" id="harness-dictation-mic">
          <PanelBody className="flex flex-wrap items-center gap-4">
            {(['compact', 'full'] as const).map(layout => (
              <div key={layout} className="relative flex items-center gap-2">
                <Label>{layout}</Label>
                <DictationControl
                  daemon={daemon}
                  draft=""
                  onDraftChange={() => {}}
                  settings={sttSettings}
                  recognition={harnessSilentRecognition}
                  layout={layout}
                />
              </div>
            ))}
          </PanelBody>
        </Card>
      ),
    },
    {
      // The live counterpart to the static panel card above: a real session,
      // recording, with the browser's own interim words in the caption.
      label: 'Dictation live recognition',
      render: () => (
        <Card aria-label="Dictation live recognition" className="min-w-0" id="harness-dictation-live">
          <PanelBody>
            <DictationFlowHarness
              label="Recording, browser caption"
              recognition={harnessHearingRecognition}
              settings={sttSettings}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      /**
       * Recognition this browser cannot do at all. Both rows are refusals read
       * from support DATA rather than from a failed attempt, and both keep the
       * mic control visible on purpose: hiding it would make feature detection
       * look like a broken click path.
       */
      label: 'Dictation unavailable',
      render: () => (
        <Card aria-label="Dictation unavailable" className="min-w-0" id="harness-dictation-unavailable">
          <PanelBody className="flex flex-col gap-4">
            <DictationFlowHarness
              label="No speech recognition in this browser"
              recognition={harnessUnsupportedRecognition}
              settings={sttSettings}
            />
            <DictationFlowHarness
              label="Installed iPhone or iPad Home Screen app"
              recognition={harnessIosHomeScreenRecognition}
              settings={sttSettings}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      /**
       * The microphone was asked for and refused. Recognition itself is
       * available, so this is a different dead end from the card above: the hint
       * points at the browser's site permission, not at the browser's engine.
       */
      label: 'Dictation permission denied',
      render: () => (
        <Card aria-label="Dictation permission denied" className="min-w-0" id="harness-dictation-permission-denied">
          <PanelBody className="flex flex-col gap-4">
            <DictationFlowHarness
              label="Microphone blocked for this site"
              recognition={harnessBlockedRecognition}
              settings={sttSettings}
            />
            <DictationFlowHarness
              label="Permission prompt dismissed"
              recognition={harnessDismissedRecognition}
              settings={sttSettings}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Dictation settings',
      render: () => (
        <Card aria-label="Dictation settings" className="min-w-0" id="harness-dictation-settings">
          <PanelBody>
            <DictationSettings
              settings={sttSettings}
              update={patch => setSttSettings(current => ({ ...current, ...patch }))}
              persisted
              recognitionSupport={HARNESS_RECOGNITION_AVAILABLE}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Notification settings',
      render: () => (
        <Card aria-label="Notification settings">
          <PanelHeader>
            <Label>Notifications</Label>
          </PanelHeader>
          <PanelBody>
            <NotificationSettingsView permission="granted" devices={[]} onRevokeDevice={() => {}} />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Settings page preview',
      render: () => <SettingsPageHarness />,
    },
    {
      label: 'Attention ledger',
      render: () => (
        <Card className="min-h-[360px] overflow-hidden">
          <AttentionBoard
            connection={daemon}
            snapshot={ATTENTION}
            loading={false}
            error={null}
            now={HARNESS_NOW}
            onAction={() => {}}
          />
        </Card>
      ),
    },
    {
      label: 'Agenda',
      render: () => <AgendaHarness />,
    },
    {
      label: 'Pins ledger',
      render: () => (
        <Card className="min-h-[400px] overflow-hidden">
          <PinsBoard
            snapshot={PINS}
            status="ready"
            onAddNote={() => {}}
            onEditNote={() => {}}
            onRemove={() => {}}
            onOpenMessage={() => {}}
          />
        </Card>
      ),
    },
    {
      label: 'Tasks',
      render: () => (
        <Card className="overflow-hidden">
          <PanelHeader>
            <Label>Tasks</Label>
          </PanelHeader>
          {/* Outside the header on purpose: `.kt-panel__header` is declared after
            `@tailwind utilities`, so its own flex rules beat any utility a
            caller adds and the filter would be centred. */}
          <div className="px-panel pb-panel">
            <TaskStatusFilter
              counts={taskStatusCounts(TASKS)}
              selected={statuses}
              onSelect={status => setStatuses(toggleTaskStatusFilter(statuses, status))}
              onShowAll={() => setStatuses(null)}
            />
          </div>
          <div className="flex flex-col divide-y divide-border-soft">
            {TASKS.filter(entry => statuses === null || statuses.has(entry.status)).map(entry => (
              <TaskRow daemonId={daemon.daemonId} key={entry.id} onOpen={() => {}} task={entry} />
            ))}
          </div>
          <PanelBody>
            <TaskQuickSummary task={TASKS[1] as TaskSummary} />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Task dependency graph',
      render: () => (
        <Card aria-label="Task dependency graph" className="min-w-0 overflow-hidden">
          <PanelHeader>
            <Label>Task dependency graph</Label>
          </PanelHeader>
          <PanelBody className="min-w-0">
            <TaskDagGraph
              daemonId={daemon.daemonId}
              dag={filterTaskDag(TASK_DAG, statuses)}
              onOpen={() => {}}
              onNavigate={() => {}}
              onShowAll={() => setStatuses(null)}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Primitives',
      render: () => (
        <Card>
          <PanelHeader className="flex items-center justify-between">
            <Label>Primitives</Label>
            <ActionGroup>
              <Button size="sm">Outline</Button>
              <Button size="sm" variant="primary">
                Primary
              </Button>
              <Button size="sm" variant="ghost">
                Ghost
              </Button>
              <Button size="sm" variant="danger">
                Danger
              </Button>
            </ActionGroup>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-sm">
            <ActionGroup>
              <Badge tone="ok">ok</Badge>
              <Badge tone="warn">warn</Badge>
              <Badge tone="err">err</Badge>
              <Badge tone="pend">pend</Badge>
              <Badge tone="accent">accent</Badge>
            </ActionGroup>
            <ViewTabs
              tabs={[
                { id: 'chat', label: 'Chat' },
                { id: 'terminal', label: 'Terminal' },
              ]}
              current={view}
              onChange={setView}
            />
            <Textarea rows={2} defaultValue="A composer draft." />
            <div>
              <Button onClick={() => setSheetOpen(true)}>Open the bottom sheet</Button>
            </div>
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Session marks',
      render: () => (
        <Card id="harness-marks">
          <PanelHeader>
            <Label>Session marks</Label>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-sm">
            {/* The brand mark, in the two contexts that render it differently.
                Untinted, `currentColor` resolves to `--fg` and the accent hub is
                a visibly different kind of thing from the cells; inside the
                accent-tinted lockup the pairing header uses, the two colours
                coincide and only the round silhouette carries that. Both are
                correct, and seeing them side by side is the only way to check
                the second one still reads. */}
            <ActionGroup>
              <BrandMark size={20} />
              <BrandMark size={32} />
              <span className="flex items-center gap-2 text-accent">
                <BrandMark size={20} />
                <span className="text-meta font-semibold uppercase tracking-label">Ferretry</span>
              </span>
            </ActionGroup>
            <div className="flex flex-col gap-1">
              {MARK_SESSIONS.map(([name, view]) => (
                <span className="flex items-center gap-sm text-cell text-muted" key={name}>
                  <StatusMark view={view} />
                  {name}
                </span>
              ))}
            </div>
            <ActionGroup>
              <ModeBadge mode="auto" />
              <ModeBadge mode="interactive" />
              <ModeBadge mode="auto" size="sm" />
              <RcBadge remoteControl url="https://claude.ai/s/harness" />
              <RcBadge remoteControl />
            </ActionGroup>
            <ActionGroup>
              <QuotaReadout quota={QUOTA_CALM} now={HARNESS_NOW} />
              <QuotaReadout quota={QUOTA_TIGHT} now={HARNESS_NOW} />
              <QuotaReadout quota={null} showUnknown now={HARNESS_NOW} />
            </ActionGroup>
            <MarkerSeparator>Turn 4</MarkerSeparator>
            <MarkerLine>Ran the unit suite — 4066 passed</MarkerLine>
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Conversation width',
      render: () => (
        <Card id="harness-chat-width">
          <PanelHeader>
            <Label>Conversation width</Label>
          </PanelHeader>
          <PanelBody>
            <ChatWidthControl value={chatWidth} onChange={setChatWidth} />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Missing pane chunk',
      render: () => (
        <Card className="overflow-hidden" id="harness-dead-pane">
          <PanelHeader>
            <Label>A pane whose chunk is gone</Label>
          </PanelHeader>
          <div className="h-40">
            <ChunkErrorBoundary onChunkError={() => {}} onReload={() => {}} onReport={() => {}}>
              <DeadPane />
            </ChunkErrorBoundary>
          </div>
        </Card>
      ),
    },
    {
      label: 'Learning review',
      render: () => (
        <Card aria-label="Learning proposals" className="min-w-0 p-3">
          <LearningHubHarness connection={daemon} sessions={WORKSPACE_FLEET} scanRunning={false} />
        </Card>
      ),
    },
    {
      label: 'Fleet sidebar',
      render: () => (
        <Card className="min-w-0 overflow-hidden" id="harness-fleet-sidebar">
          <PanelHeader>
            <Label>Fleet sidebar</Label>
          </PanelHeader>
          <div className="flex h-[420px] min-h-0">
            <AgentSidebar
              activeId={SIDEBAR_FLEET.groups[0]?.rows[1]?.config.id}
              attentionCountFor={id => (id === SIDEBAR_FLEET.groups[0]?.rows[0]?.config.id ? 3 : 0)}
              canMutate
              collapsed={false}
              daemonId={daemon.daemonId}
              drawerOpen={fleetDrawerOpen}
              filters={SIDEBAR_FILTERS}
              fleet={SIDEBAR_FLEET}
              onCloseDrawer={() => {}}
              onCollapsedChange={() => {}}
              onFilterChange={() => {}}
              onFocusFolder={() => {}}
            />
            <div className="min-w-0 flex-1 p-panel text-meta text-muted">
              The transcript sits here. The column beside it is the sidebar under test.
            </div>
          </div>
        </Card>
      ),
    },
    {
      label: 'In-app link preview',
      render: () => (
        <Card aria-label="In-app link preview" className="min-w-0 overflow-hidden" id="harness-in-app-browser">
          <div className="flex h-[24rem] flex-col">
            {/* The frame stays empty on purpose: the harness aborts every
                off-origin request, which is exactly the refusal the surface
                already warns about, so this IS the honest steady state. */}
            <InAppBrowserSurface
              destination={HARNESS_REMOTE_LINK}
              presentation="pane"
              titleId="harness-in-app-browser-title"
              onClose={() => {}}
            />
          </div>
          <div className="flex h-[18rem] flex-col border-t border-border">
            <InAppBrowserSurface
              destination={HARNESS_LOOPBACK_LINK}
              presentation="pane"
              titleId="harness-in-app-browser-loopback-title"
              onClose={() => {}}
            />
          </div>
        </Card>
      ),
    },
    {
      label: 'File tab body',
      render: () => (
        // Four bodies, one section: the ordinary read with its worded Reload,
        // the rich preview that reload path feeds, and the two states a reload
        // can leave behind. The screenshot pass presses Reload on the last two
        // — they are real reads that misbehave, not a drawn notice.
        //
        // The preview body is TALLER on purpose. Row 62 requires the raw / open /
        // download fallbacks to survive, so a slot that cuts the actions row off
        // the bottom edge is evidence for the opposite of what it claims; 24rem
        // is what fits the bar, a five-row table and that row at 390px.
        <Card aria-label="File tab body" className="min-w-0 overflow-hidden" id="harness-file-instance">
          {(
            [
              ['file-instance-surface', 'CLAUDE.md', 'h-[15rem]'],
              ['file-instance-preview', 'coverage.csv', 'h-[24rem]'],
              ['file-instance-reloading', HARNESS_RELOAD_PENDING, 'h-[15rem]'],
              ['file-instance-reload-failed', HARNESS_RELOAD_FAILING, 'h-[15rem]'],
            ] as const
          ).map(([slot, path, height], index) => (
            <div className={`flex ${height} flex-col`} data-harness={slot} key={slot}>
              <FileInstanceSurface
                daemon={daemon}
                scope={scope}
                instance={{
                  id: `file:${path}`,
                  kind: 'file',
                  key: path,
                  label: path,
                  title: path,
                  order: index + 1,
                  revision: 1,
                }}
              />
            </div>
          ))}
        </Card>
      ),
    },
    {
      label: 'Files browser',
      render: () => (
        <Card aria-label="Files browser" className="min-w-0 overflow-hidden" id="harness-files">
          <div className="flex h-[26rem] flex-col">
            <FilesTab daemon={daemon} scope={scope} cwd="/work/ferretry" />
          </div>
        </Card>
      ),
    },
    {
      label: 'Transcript attachments',
      render: () => (
        <Card aria-label="Transcript attachments" className="min-w-0 overflow-hidden" id="harness-attachments">
          <PanelHeader>
            <Label>Attachments</Label>
          </PanelHeader>
          <PanelBody className="min-w-0">
            <AttachmentGalleryProvider load={HARNESS_ATTACHMENT_LOADER}>
              <TranscriptAttachmentGallery daemon={daemon} images={HARNESS_ATTACHMENTS} />
            </AttachmentGalleryProvider>
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Terminal snapshot',
      render: () => (
        <Card aria-label="Terminal snapshot" className="min-w-0 overflow-hidden" id="harness-terminal-snapshot">
          <div className="flex h-64 flex-col">
            <TerminalSnapshotView
              daemon={daemon}
              scope={scope}
              tmuxSession="ms9u6kfu-16918932"
              now={() => HARNESS_NOW}
              readSnapshot={HARNESS_PANE_SNAPSHOT}
            />
          </div>
        </Card>
      ),
    },
    {
      label: 'Co-controlled terminal',
      render: () => (
        <Card aria-label="Co-controlled terminal" className="min-w-0" id="harness-terminal-deck">
          <PanelBody className="flex h-[22rem] min-w-0 flex-col p-0">
            <SessionTerminalDeck
              connection={daemon}
              cwd="/home/harness/workspace/ferretry"
              dependencies={HARNESS_TERMINAL_DECK}
              scope={scope}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Addressable terminals',
      render: () => (
        <Card aria-label="Addressable terminals" className="min-w-0" id="harness-surface-references">
          <PanelBody className="flex flex-col gap-sm">
            {/* The listing is the harness's own: this card is about how a
                reference, its viewer count and its ownership READ, so it must
                never depend on a daemon being reachable. */}
            <SessionSurfaceReferences
              connection={daemon}
              listTerminals={async () => HARNESS_TERMINAL_LISTING}
              scope={scope}
              write={async () => undefined}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Runtime controls',
      render: () => (
        <Card className="min-w-0" id="harness-runtime-controls">
          <PanelHeader>
            <Label>Runtime controls</Label>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-sm">
            <RuntimeModelControls
              api={HARNESS_RUNTIME_API}
              canControl
              catalogs={HARNESS_CLAUDE_CATALOG}
              daemon={daemon}
              onClose={() => {}}
              open
              view={RUNTIME_VIEW}
            />
            <RuntimeEffortControls
              api={HARNESS_RUNTIME_API}
              canControl
              catalogs={HARNESS_CLAUDE_CATALOG}
              daemon={daemon}
              onClose={() => {}}
              view={RUNTIME_VIEW}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Pending sends',
      render: () => (
        <Card className="min-w-0" id="harness-pending-sends">
          <PanelHeader>
            <Label>Pending sends</Label>
          </PanelHeader>
          <PanelBody className="flex flex-col gap-sm">
            <PendingAttachmentStrip
              entries={PENDING_ATTACHMENTS}
              onForget={() => {}}
              onRemove={() => {}}
              onRetry={() => {}}
              onUnlock={() => {}}
            />
            <PendingMessage attachments={[]} status="sending" text="Ship the sidebar port." />
            <PendingMessage attachments={[]} status="delivered" text="Ship the sidebar port." />
            <PendingMessage attachments={[]} onDismiss={() => {}} onRetry={() => {}} status="error" text="Ship it." />
            <div className="h-40">
              <ThreadSkeleton />
            </div>
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Thinking indicator',
      render: () => (
        <Card className="min-w-0" id="harness-thinking-indicator">
          <PanelHeader>
            <Label>Thinking indicator</Label>
          </PanelHeader>
          <PanelBody>
            <ThinkingIndicator activity="Writing the migration tests (34s · 2.1k tokens)" since={Date.now() - 34_000} />
          </PanelBody>
        </Card>
      ),
    },
    {
      // The PWALIST2 money shot: the page, its stores and their ports — not a
      // hand-built props object. Everything on screen was hydrated, grouped,
      // filtered and scoped by the same code production runs.
      label: 'Sessions page connected',
      render: () => (
        <section
          aria-label="Sessions page connected"
          className="h-[720px] min-h-0 overflow-hidden rounded-panel border border-border bg-surface px-panel"
        >
          <SessionsPage
            clock={HARNESS_FROZEN_CLOCK}
            connection={daemon}
            controls={SESSIONS_PAGE_CONTROLS}
            fleet={SESSIONS_PAGE_FLEET}
            narrow={phone}
            onOpenWardenReport={() => {}}
            projects={SESSIONS_PAGE_PROJECTS}
            scopeNavigation={SESSIONS_PAGE_NAVIGATION}
            usage={SESSIONS_PAGE_USAGE}
            wardenStatus={SESSIONS_PAGE_WARDEN}
          />
        </section>
      ),
    },
    {
      // Minimal density: names and tasks only. No other card renders it, so its
      // row chrome has never been looked at next to the compact one.
      label: 'Session dashboard minimal panel',
      render: () => (
        <section
          aria-label="Session dashboard minimal panel"
          className="h-[720px] min-h-0 overflow-hidden rounded-panel border border-border bg-surface px-panel"
        >
          <SessionDashboard
            connection={daemon}
            dashboardView="cards"
            density="minimal"
            error={null}
            groups={DASHBOARD_COMPACT_GROUPS}
            narrow={phone}
            now={HARNESS_NOW}
            onEnterScope={() => {}}
            onExitScope={() => {}}
            onOpenWardenReport={() => {}}
            onSetView={() => {}}
            scope={null}
            scopeName=""
            scopeRecovered={false}
            sessions={DASHBOARD_SESSIONS}
            usage={null}
            wardenStatus={null}
            wardenVerdicts={[]}
          />
        </section>
      ),
    },
    {
      // The lean TABLE. `narrow={false}` is deliberate and is why this card
      // exists: a phone would otherwise be given cards, and the three-column
      // table has never been seen at 390px, where its columns are tightest.
      label: 'Session dashboard lean table',
      render: () => (
        <section
          aria-label="Session dashboard lean table"
          className="h-[720px] min-h-0 overflow-hidden rounded-panel border border-border bg-surface px-panel"
        >
          <SessionDashboard
            connection={daemon}
            dashboardView="table"
            density="compact"
            error={null}
            groups={DASHBOARD_COMPACT_GROUPS}
            narrow={false}
            now={HARNESS_NOW}
            onEnterScope={() => {}}
            onExitScope={() => {}}
            onOpenWardenReport={() => {}}
            onSetView={() => {}}
            scope={null}
            scopeName=""
            scopeRecovered={false}
            sessions={DASHBOARD_SESSIONS}
            usage={null}
            wardenStatus={null}
            wardenVerdicts={[]}
          />
        </section>
      ),
    },
    {
      // Four states, one screenshot: loading is not empty, an empty fleet is not
      // an error, and the scope-recovery notice has to read as a fact rather than
      // a failure. They are stacked so the distinction is visible at a glance.
      label: 'Session dashboard states',
      render: () => (
        <section aria-label="Session dashboard states" className="grid gap-3">
          {DASHBOARD_STATE_CARDS.map(state => (
            <div
              className="h-[220px] min-h-0 overflow-hidden rounded-panel border border-border bg-surface px-panel"
              key={state.title}
            >
              <SessionDashboard
                connection={daemon}
                dashboardView="cards"
                density="compact"
                error={state.error}
                groups={state.groups}
                narrow={phone}
                now={HARNESS_NOW}
                onEnterScope={() => {}}
                onExitScope={() => {}}
                onOpenWardenReport={() => {}}
                onSetView={() => {}}
                scope={null}
                scopeName=""
                scopeRecovered={state.scopeRecovered}
                sessions={state.sessions}
                usage={null}
                wardenStatus={null}
                wardenVerdicts={[]}
              />
            </div>
          ))}
        </section>
      ),
    },
    {
      // The unified surface on its preview engine, with nothing opened yet: one
      // engine-agnostic toolbar, the empty "Where to?" state and the login
      // affordance. Fully offline — the preview engine has no destination, so
      // there is no frame and no request.
      label: 'Unified browser preview',
      render: () => (
        <section
          aria-label="Unified browser preview"
          className="flex h-[560px] min-h-0 flex-col overflow-hidden rounded-panel border border-border bg-surface"
          data-harness="unified-browser-preview"
        >
          <UnifiedBrowserSurface
            daemon={daemon}
            dependencies={HARNESS_UNIFIED_BROWSER_DEPENDENCIES}
            onClose={() => {}}
            onOpenLoginWindow={async () => ({ state: 'opening', profilePrimed: false })}
            presentation="pane"
            scope={UNIFIED_PREVIEW_SCOPE}
            titleId="harness-unified-browser-preview-title"
          />
        </section>
      ),
    },
    {
      // The same toolbar over the REAL engine, which is the standalone remote
      // pane with its own address row switched off. The engine is remembered for
      // this scope, so the surface paints Chrome's own tab strip and lifecycle
      // controls under one shared bar. Fully offline: the pane is bound to the
      // harness transport, poll and socket fixtures.
      label: 'Unified browser real engine',
      render: () => (
        <section
          aria-label="Unified browser real engine"
          className="flex h-[720px] min-h-0 flex-col overflow-hidden rounded-panel border border-border bg-surface"
          data-harness="unified-browser-real"
        >
          <UnifiedBrowserSurface
            daemon={daemon}
            dependencies={HARNESS_UNIFIED_BROWSER_DEPENDENCIES}
            onClose={() => {}}
            presentation="pane"
            scope={UNIFIED_REMOTE_SCOPE}
            titleId="harness-unified-browser-real-title"
          />
        </section>
      ),
    },
    {
      // The secret store as a person actually meets it: one secret that exists, one configured
      // reference this daemon cannot resolve, and the masked value that is the ONLY thing there is.
      // The card carries the honest sentence on screen — "agents cannot see these" would be false.
      label: 'Secrets',
      render: () => (
        <div data-harness="secrets-card">
          <SecretsCard list={SECRETS_READY} onPut={() => {}} onRemove={() => {}} />
        </div>
      ),
    },
    {
      // Damaged is NOT empty. A store that cannot be opened says so and warns against writing over
      // entries that are still on disk — the failure this migration has now shipped three times.
      label: 'Secrets — damaged store',
      render: () => (
        <div data-harness="secrets-damaged">
          <SecretsCard list={SECRETS_DAMAGED} onPut={() => {}} onRemove={() => {}} />
        </div>
      ),
    },
    {
      // A read this browser could not make is a stated refusal, never "no secrets".
      label: 'Secrets — unreadable',
      render: () => (
        <div data-harness="secrets-unreachable">
          <SecretsSurface
            connection={daemon}
            createClient={async () => {
              throw new Error('this daemon did not answer');
            }}
          />
        </div>
      ),
    },
    {
      // A paired phone that has not confirmed with its passkey: `terminal` switched off entirely,
      // `warden` readable but not configurable, and every dangerous demand waiting on the passkey.
      // Each disabled control carries its own reason, and the one button that asks is beside them.
      label: 'Capability limits — passkey needed',
      render: () => (
        <div data-harness="grants-step-up-needed">
          <GrantsCard connection={daemon} view={HARNESS_GRANTS_STEP_UP} onChange={() => {}} onStepUp={() => {}} />
        </div>
      ),
    },
    {
      // The same phone after one passkey touch: the panel says so and offers nothing more to press.
      label: 'Capability limits — passkey confirmed',
      render: () => (
        <div data-harness="grants-step-up-held">
          <GrantsCard connection={daemon} view={HARNESS_GRANTS_STEPPED_UP} onChange={() => {}} onStepUp={() => {}} />
        </div>
      ),
    },
    {
      // A daemon that cannot read its own grant document. Denied loudly, and NOT rendered as
      // permissive: damaged state is not empty state, and unknown is never permitted.
      label: 'Capability limits — daemon cannot say',
      render: () => (
        <div data-harness="grants-undetermined">
          <GrantsCard connection={daemon} view={HARNESS_GRANTS_UNDETERMINED} onChange={() => {}} />
        </div>
      ),
    },
    {
      // A read this browser could not make is a stated refusal, never five allowed rows.
      label: 'Capability limits — unreadable',
      render: () => (
        <div data-harness="grants-unreachable">
          <GrantsSurface
            connection={daemon}
            createClient={async () => {
              throw new Error('this daemon did not answer');
            }}
          />
        </div>
      ),
    },
    {
      // The panel before anybody presses anything: who may reach this machine, each with its own revoke
      // and the sentence saying what that revoke will do. The device this browser IS carries its mark.
      label: 'Add a device — devices on this machine',
      render: () => (
        <div data-harness="pair-devices">
          <AddDeviceCard
            connection={daemon}
            view={HARNESS_PAIRED_DEVICES}
            invite={null}
            nowMs={HARNESS_PAIR_NOW_MS}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
            onChangeDeviceGrants={() => {}}
          />
        </div>
      ),
    },
    {
      // THE FRAME THAT MATTERS. The harness daemon's address is loopback, and a browser on the machine
      // is governed like any paired device — so this must read "Governed", never a claim that the limits
      // do not apply. There is no direct-local frame: that posture does not exist.
      label: 'Capability list — governed',
      render: () => (
        <div data-harness="capability-list-governed">
          <CapabilityList connection={daemon} capabilities={HARNESS_GRANTS_STEP_UP.capabilities} governed />
        </div>
      ),
    },
    {
      // A live code: the QR, the code in words, the same link selectable for somebody who has to retype
      // it, the countdown, and Revoke now beside Done. The code is FAKE — see `HARNESS_INVITE`.
      label: 'Add a device — code on screen',
      render: () => (
        <div data-harness="pair-invite">
          <AddDeviceCard
            connection={daemon}
            view={HARNESS_PAIRED_DEVICES}
            invite={HARNESS_INVITE}
            nowMs={HARNESS_PAIR_NOW_MS}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
            onChangeDeviceGrants={() => {}}
          />
        </div>
      ),
    },
    {
      /**
       * No answer from the daemon. It says so rather than assuming the friendly reading: absence of
       * evidence is not evidence of loopback.
       *
       * THE FRAME PASSES NO `governed`, because that is how a daemon that said nothing looks: the posture
       * is the daemon's own answer and is never inferred from the capabilities, so the empty list is
       * only there to keep the frame short.
       */
      label: 'Capability list — cannot tell',
      render: () => (
        <div data-harness="capability-list-unknown">
          <CapabilityList connection={daemon} capabilities={[]} />
        </div>
      ),
    },
    {
      // The same code after its two minutes. It stops being shown as a credential at all — no QR, no
      // link — and says what to do instead, because a stale QR that still looks live is the thing a
      // person aims a phone at while wondering what they did wrong.
      label: 'Add a device — code expired',
      render: () => (
        <div data-harness="pair-expired">
          <AddDeviceCard
            connection={daemon}
            view={HARNESS_PAIRED_DEVICES}
            invite={HARNESS_INVITE}
            nowMs={Date.parse('2026-01-01T00:03:00.000Z')}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
            onChangeDeviceGrants={() => {}}
          />
        </div>
      ),
    },
    {
      // Nothing but the machine itself can reach this daemon. Said as a fact with the way forward, never
      // as a bare empty list — an empty list reads as "something was removed".
      label: 'Add a device — nothing paired yet',
      render: () => (
        <div data-harness="pair-empty">
          <AddDeviceCard
            connection={daemon}
            view={{ devices: [], hostLocal: false, mayWiden: HARNESS_MAY_WIDEN }}
            invite={null}
            nowMs={HARNESS_PAIR_NOW_MS}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
            onChangeDeviceGrants={() => {}}
          />
        </div>
      ),
    },
    {
      // The refused case, which is the one worth reviewing hardest: a caller away from the host whose
      // operator switched pairing off. The daemon's own sentence is rendered whole — it names the
      // command that changes the answer — plus the one thing the daemon cannot know.
      label: 'Add a device — the operator said no',
      render: () => (
        <div data-harness="pair-refused">
          <AddDeviceSurface
            connection={daemon}
            createClient={async () => ({
              request: async () => {
                throw Object.assign(
                  new Error(
                    'the operator of this machine has not granted the UI the use of device pairing. Grant it on the host with `fy daemon config set pairing --use`.',
                  ),
                  { code: 'grant_not_granted' },
                );
              },
            })}
          />
        </div>
      ),
    },
    {
      // The two fields AT REST, which is the state a form actually opens in and
      // the one the standalone pages below cannot show — they exist to capture an
      // OPEN list, and an open list hides the field it belongs to.
      label: 'Daemon pickers at rest',
      render: () => (
        <section aria-label="Daemon pickers at rest" className="grid gap-panel" id="harness-pickers">
          <HarnessAccountPicker checked={true} id="harness-picker-rest-agent" />
          <HarnessProjectPicker />
        </section>
      ),
    },
    {
      // A roster this browser could not read, beside a field that still works.
      // The failure is the whole point: an unreadable roster must never be drawn
      // as a host with no accounts, and the way out has to stay visible.
      label: 'Account picker — unreadable roster',
      render: () => (
        <section aria-label="Account picker unreadable roster" id="harness-picker-failed">
          <HarnessAccountPicker
            id="harness-picker-failed-agent"
            slice={pickerSlice({
              catalog: null,
              status: 'error',
              error: 'this daemon refused the account roster: fleet_manifest_invalid',
            })}
          />
        </section>
      ),
    },
    {
      // The first-run fleet: the terminal account is published first and must not
      // be offered; the account that can run sessions is filled in.
      label: 'New session — accounts that can run a session',
      render: () => (
        <section aria-label="New session account picker" id="harness-new-session-accounts">
          <NewSessionPage
            accounts={HARNESS_FIRST_RUN_ROSTER}
            connection={daemon}
            fleet={HARNESS_NEW_SESSION_FLEET}
            onNavigate={() => {}}
            projects={HARNESS_NEW_SESSION_PROJECTS}
            startSession={async () => ({ config: { id: 'harness-created-session' } })}
          />
        </section>
      ),
    },
    {
      label: 'New session — one runtime',
      render: () => (
        <section aria-label="New session with one runtime" id="harness-new-session-one-runtime">
          <NewSessionPage
            accounts={HARNESS_ONE_RUNTIME_ROSTER}
            connection={daemon}
            fleet={HARNESS_NEW_SESSION_FLEET}
            onNavigate={() => {}}
            projects={HARNESS_NEW_SESSION_PROJECTS}
            startSession={async () => ({ config: { id: 'harness-created-session' } })}
          />
        </section>
      ),
    },
    {
      label: 'New session — many runtimes',
      render: () => (
        <section aria-label="New session with many runtimes" id="harness-new-session-many-runtimes">
          <NewSessionPage
            accounts={HARNESS_MANY_RUNTIMES_ROSTER}
            connection={daemon}
            fleet={HARNESS_NEW_SESSION_FLEET}
            onNavigate={() => {}}
            projects={HARNESS_NEW_SESSION_PROJECTS}
            startSession={async () => ({ config: { id: 'harness-created-session' } })}
            usage={HARNESS_MANY_RUNTIMES_USAGE}
          />
        </section>
      ),
    },
    {
      // Only the terminal account: one sentence and a way to add one, not an empty list.
      label: 'New session — no account can run a session',
      render: () => (
        <section aria-label="New session with no runnable account" id="harness-new-session-no-accounts">
          <NewSessionPage
            accounts={HARNESS_TERMINAL_ONLY_ROSTER}
            connection={daemon}
            fleet={HARNESS_NEW_SESSION_FLEET}
            onNavigate={() => {}}
            projects={HARNESS_NEW_SESSION_PROJECTS}
            startSession={async () => ({ config: { id: 'harness-created-session' } })}
          />
        </section>
      ),
    },
  ];

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar
        crumbs={[{ href: '/d/harness-daemon', label: 'Sessions' }, { label: 'Transcript scrolling' }]}
        daemon={daemon.daemonId}
        onOpenPalette={() => {}}
        onOpenSidebar={() => {}}
        sessionCount={7}
        connectionStatus="reconnecting"
        // The rebuilt phone bar gives transient state its own row, so this no
        // longer has to disappear at 390px to protect navigation or item #6's
        // centred search seam.
        updateReady="update"
        active="warden"
        themeToggle={<Button size="sm">Theme</Button>}
      />
      <section aria-label="Fleet navigation rail preview" className="border-b border-border-soft bg-surface">
        <FleetNavigationRail
          daemon={daemon.daemonId}
          sessionCount={7}
          mode="auto"
          modeCounts={{ all: 7, auto: 5, interactive: 2 }}
          rcOnly={false}
          includeFinished={false}
          onExpand={() => {}}
          onSetMode={() => {}}
          onSetRcOnly={() => {}}
          onSetIncludeFinished={() => {}}
        />
      </section>

      <div className="flex min-h-0 flex-col gap-panel p-panel">
        {/* The desktop workspace: conversation on the left, the pane on the right
          and the separator between them. The handle measures its own parent and
          grandparent, so this nesting is the nesting the app uses. On a phone
          the pane is a full-width surface stacked underneath — no second
          column, and so no separator to drag. */}
        <div className={`relative flex min-h-[160px] gap-2 ${phone ? 'flex-col' : 'flex-row'}`}>
          <Card className="min-w-0 flex-1 p-panel text-ui text-muted">The conversation column.</Card>
          <div className="relative min-w-0 shrink-0" style={phone ? undefined : { width: `${paneWidth}px` }}>
            {!phone && <SidePaneResizeHandle width={paneWidth} onPreview={setPaneWidth} onCommit={setPaneWidth} />}
            <Card className="flex h-full flex-col gap-sm p-panel">
              <SidePaneSearch
                value={paneQuery}
                onChange={setPaneQuery}
                ariaLabel="Filter the side pane"
                placeholder="Search this pane"
              />
              <SheetTabs
                sheetId="harness-sheet-tabs"
                tabs={DETAILS_TAB_ORDER.map(key => ({ key, label: `${key[0]?.toUpperCase()}${key.slice(1)}` }))}
                current={detailsTab}
                order={DETAILS_TAB_ORDER}
                onChange={setDetailsTab}
              />
              <div className="text-ui text-muted">The {detailsTab} section renders here.</div>
            </Card>
          </div>
        </div>

        <header className="flex items-center gap-sm">
          <Label>Ferretry shell harness</Label>
          <Badge tone="ok">{phone ? 'phone' : 'desktop'}</Badge>
          <span className="text-2xs text-muted">
            {viewport.width}×{viewport.height}
          </span>
        </header>

        {HARNESS_CARDS.map(card => (
          <Fragment key={card.label}>{card.render()}</Fragment>
        ))}

        {/* Only under `#menu`, and it gets its own screenshot pass: the menu's
            dismiss surface is `fixed inset-0`, and a fixed layer breaks
            Chrome's scroll-and-stitch full-page capture of everything below
            the fold. */}
        <ContextMenu
          open={menuOpen}
          anchor={{ x: phone ? 40 : 420, y: 240 }}
          ariaLabel="Session actions"
          items={[
            { key: 'resume', label: 'Resume', onSelect: () => {} },
            { key: 'rename', label: 'Rename', detail: '2 selected', onSelect: () => {} },
            { key: 'migrate', label: 'Migrate', disabled: true, onSelect: () => {} },
            { key: 'stop', label: 'Stop', danger: true, onSelect: () => {} },
          ]}
          onClose={() => {}}
          touch={phone}
        />

        {/* Only under `#palette`, for the same reason as the menu: the palette
            is a fixed overlay and a full-page stitch cannot capture it. */}
        <CommandPalette
          open={paletteOpen}
          focusSignal={0}
          onClose={() => {}}
          daemon={daemon.daemonId}
          sessions={PALETTE_SESSIONS}
          onNavigate={() => {}}
          commands={PALETTE_COMMANDS}
          settings={PALETTE_SETTINGS}
          touchAffected={phone}
        />

        {/* Only under `#row-menu`: the REAL sidebar row menu, so the screenshot
            shows the entries the port actually builds rather than hand-written
            stand-ins — the four explicit stop scopes and their target counts. */}
        <SessionRowMenu
          state={rowMenuOpen ? { view: stopLead, x: phone ? 40 : 420, y: 240 } : null}
          sessions={STOP_FLEET}
          canMutate
          onClose={() => {}}
          onRun={() => {}}
          onBulkStop={() => {}}
          touch={phone}
        />

        {/* Only under `#stop` / `#stop-results`: another fixed overlay, and the
            two states are different screens — the confirmation lists what will
            die, the report lists what did. */}
        <BulkStopConfirmation
          request={
            stopOpen
              ? {
                  token: 1,
                  selectedId: 'harness-session',
                  scope: 'cascade',
                  targets: STOP_FLEET,
                }
              : stopResultsOpen
                ? {
                    token: 2,
                    selectedId: 'harness-session',
                    scope: 'cascade',
                    targets: STOP_FLEET,
                    outcomes: [
                      { id: stopLead.config.id, name: 'Fable', ok: true },
                      { id: stopChild.config.id, name: 'Jessica', ok: true },
                      { id: stopGrandchild.config.id, name: 'MS-98', ok: false, detail: 'already exited' },
                    ],
                    newTargets: [stopGrandchild],
                  }
                : null
          }
          activeId="ms9hi4ts-b22751c4"
          sessions={STOP_FLEET}
          onClose={() => {}}
          onConfirm={() => {}}
          onConfirmNew={() => {}}
        />

        <BottomSheet
          id="harness-sheet"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          ariaLabel="Harness sheet"
          closeLabel="Close the sheet"
        >
          <div className="p-panel text-ui">The shared modal shell, swipe handle and all.</div>
        </BottomSheet>
        <RenameSheet
          connection={daemon}
          createClient={async () => ({ rename: async () => harnessChildSession })}
          onClose={() => {}}
          open={renameOpen}
          view={harnessChildSession}
        />
        <MigrateSheet
          canMutate
          connection={daemon}
          onClose={() => {}}
          onMigrated={() => {}}
          open={migrateOpen}
          scope={scope}
          view={harnessSession}
        />
        <AttachmentUnlockPrompt
          filename="design-brief.pdf"
          onCancel={() => {}}
          onUnlock={async () => {}}
          open={window.location.search === '?attachment-unlock'}
        />
        <StepUpDialog gate={HARNESS_UNLOCK_GATE} copy={UNLOCK_COPY} machineName={() => 'Studio workstation'} />
      </div>
    </div>
  );
}

/**
 * One setup stage, alone on the page, in the production shell.
 *
 * Two reasons this is a root of its own rather than another gallery card.
 *
 * It mounts the PRODUCTION viewport producer (`useAppViewport`), which writes
 * `--app-h` and `data-keyboard` on `<html>` — correct for a page that IS the
 * app, wrong to install for every other capture in the gallery. That is what
 * lets the keyboard shot exercise the shipped geometry path from
 * `window.visualViewport` instead of a shrunken browser window: the page
 * declares `interactive-widget=resizes-content`, so the question is precisely
 * what happens when the VISUAL viewport shrinks under a portrait phone.
 *
 * And a stage taller than the phone cannot be captured honestly inside the
 * stacked gallery: Chrome clips the element shot to the fixed scroller, which
 * silently drops the top of the Install stage — brand, heading and all.
 */
function OnboardingStageHarness({ screen }: { readonly screen: HarnessOnboardingScreen }) {
  useAppViewport();
  return (
    <div className="kt-shell overflow-y-auto" id={`harness-onboarding-${screen}-page`}>
      <OnboardingPage
        progress={HARNESS_ONBOARDING[screen]}
        write={HARNESS_CLIPBOARD}
        href={HARNESS_SETUP_HREF}
        channel="curl"
        fallback={HARNESS_FALLBACK.available}
        fleetReady={screen === 'done'}
        onOpenFleet={() => {}}
        renderPairing={() => (
          <PairingScreen
            embedded
            connections={[]}
            selectedDaemonId={null}
            scanHost={HARNESS_SCAN_HOST}
            onPair={async () => {}}
            onRemove={() => {}}
            onSelect={() => {}}
          />
        )}
      />
    </div>
  );
}

// ---- the assembled session workspace ---------------------------------------
//
// A scope of its own, deliberately NOT the gallery's `scope`. The gallery opens
// tasks and two file tabs on that scope at module load (see the `openSidePaneTab`
// calls above), and inheriting them would make this page open with a pane
// already up — on a phone that means a focus-trapped sheet over the very
// transcript and composer this fixture exists to show. Starting empty is also
// what production does: nothing auto-opens the pane, the reader does.
const WORKSPACE_SCOPE = daemonSessionScope(daemon, 'harness-workspace');

/**
 * A draft in the composer, seeded through the same browser storage the shipped
 * composer reads.
 *
 * `Composer` inside `SessionChatPage` uses its own module-level
 * `DaemonDraftStore`, which is not injectable from the page's props — but every
 * instance reads `localStorage` on each `load()`, so writing the key here is the
 * honest way to paint a real draft rather than an empty box. An empty composer
 * would hide the markdown paint layer, the send button's enabled state and the
 * textarea's grown height, which are three of the things this capture is for.
 */
const WORKSPACE_DRAFT = 'Capture it at 390px and 1440px before you call it done';
new DaemonDraftStore().save(WORKSPACE_SCOPE, WORKSPACE_DRAFT, HARNESS_NOW);

const WORKSPACE_SESSION = {
  config: {
    id: 'harness-workspace',
    name: 'Assemble the session workspace',
    teammate: 'mylie',
    label: 'Assemble the session workspace',
    model: 'claude-opus-5',
    modelHint: 'opus-5',
    agent: 'claude-default',
    harness: 'claude',
    mode: 'auto',
    cwd: '/work/ferretry',
    createdAt: '2026-07-31T09:00:00.000Z',
    updatedAt: '2026-07-31T10:00:00.000Z',
  },
  state: {
    id: 'harness-workspace',
    status: 'running',
    turn: 12,
    startedAt: '2026-07-31T09:00:05.000Z',
    lastActivityAt: '2026-07-31T10:00:00.000Z',
    observedModel: 'claude-opus-5-20260915',
    observedReasoningEffort: 'high',
    contextPercent: 61,
    activity: 'Editing session-chat-page.tsx',
  },
  directory: '/work/ferretry',
} as unknown as SessionView;

/**
 * Enough conversation to overflow both viewports.
 *
 * The transcript follows its tail on mount, so a fixture that fits on screen
 * would capture a scroller that has never scrolled — and the one thing a
 * transcript capture has to prove is that the tail is pinned above the composer
 * rather than behind it. Every row kind the port renders appears: prose, a
 * clean tool run and one with a failure in it, slash commands (with output,
 * with long output that opens, and with stderr), hidden bookkeeping notices, a
 * durable ledger row, and a tool still running.
 */
const WORKSPACE_ENTRIES: readonly TranscriptEntry[] = [
  {
    id: 'workspace-user-0',
    kind: 'user',
    text: 'Run the dev server and check @CLAUDE.md before you touch the login page.',
    label: 'You',
  },
  {
    id: 'workspace-assistant-0',
    kind: 'assistant',
    text: 'Started `bun dev` in %terminal:dev, opened %browser:app at /login and read @CLAUDE.md — tap any of them to open it beside the chat.',
    label: 'hadi',
  },
  {
    id: 'workspace-command-model',
    kind: 'command',
    text: '/model opus[1m]',
    command: { name: '/model', args: 'opus[1m]', output: 'Set model to Opus 5.5 (1M context)', tone: 'ok' },
  },
  {
    id: 'workspace-command-context',
    kind: 'command',
    text: '/context',
    command: {
      name: '/context',
      output:
        'Context usage · 612k / 1M tokens (61%)\n  System prompt   3.1k\n  Tools          18.4k\n  Messages      590.6k',
      tone: 'ok',
    },
  },
  {
    id: 'workspace-command-doctor',
    kind: 'command',
    text: '/doctor',
    command: { name: '/doctor', output: 'settings.json: unexpected token at line 12', tone: 'err' },
  },
  {
    id: 'workspace-user-1',
    kind: 'user',
    text: 'Assemble the session workspace: header, transcript, composer and the side pane, on one page.',
    label: 'You',
  },
  {
    id: 'workspace-tools-0',
    kind: 'tool',
    text: 'ran 4 tools',
    tools: [
      {
        key: 'workspace-tool-0-bash',
        use: { name: 'Bash', input: { command: 'git status --short', description: 'Show working tree status' } },
        result: { text: ' M packages/pwa/src/lib/pages/session-chat-page.tsx' },
      },
      {
        key: 'workspace-tool-0-edit-a',
        use: {
          name: 'Edit',
          input: {
            file_path: 'session-chat-page.tsx',
            old_string: 'onSent={onRefresh}',
            new_string: 'onSent={onSent}',
          },
        },
        result: { text: 'applied' },
      },
      {
        key: 'workspace-tool-0-edit-b',
        use: { name: 'Edit', input: { file_path: 'transcript.tsx', new_string: 'pinSignal' } },
        result: { text: 'applied' },
      },
      {
        key: 'workspace-tool-0-read',
        use: { name: 'Read', input: { file_path: '/work/ferretry/packages/pwa/src/components/transcript.tsx' } },
        result: { text: 'export function Transcript(…)' },
      },
    ],
  },
  {
    id: 'workspace-assistant-1',
    kind: 'assistant',
    text: 'Composing it in `src/lib/pages/session-chat-page.tsx`. The page owns no store — it takes one daemon connection, one session view and one client bound to that same pairing, so a retained pane can never send to a daemon it no longer belongs to.',
    label: 'mylie',
  },
  {
    id: 'workspace-tools-1',
    kind: 'tool',
    text: 'ran 4 tools',
    tools: [
      {
        key: 'workspace-tool-read',
        use: { name: 'Read', input: { file_path: '/work/ferretry/packages/pwa/src/shell/side-pane.tsx' } },
        result: { text: 'export function SidePaneWorkspace(…)' },
      },
      {
        key: 'workspace-tool-edit-1',
        use: { name: 'Edit', input: { file_path: 'side-pane.tsx', new_string: 'shouldIncludeTab' } },
        result: { text: 'applied' },
      },
      {
        key: 'workspace-tool-write',
        // Keep a representative content body in the visual fixture. The parser
        // now also tolerates an incomplete Write record without blanking the
        // workspace; that damaged-input branch is covered by its unit test.
        use: {
          name: 'Write',
          input: {
            file_path: 'src/lib/pages/session-chat-page.tsx',
            content:
              'export function SessionChatPage({ connection, session, entries, client }: SessionChatPageProps) {',
          },
        },
        result: { text: 'wrote 375 lines' },
      },
      {
        key: 'workspace-tool-bash',
        use: { name: 'Bash', input: { command: 'bun test --config=bunfig.unit.toml side-pane' } },
        result: { text: 'error: expected the browser tab to be filtered out', isError: true },
      },
    ],
  },
  {
    id: 'workspace-assistant-2',
    kind: 'assistant',
    text: 'That failure was mine: the host filter has to reject a *stale open* as well as hide the catalogue entry, or a session that opened the browser tab before this build comes back to a pane the host cannot render. Fixed and re-run.',
    label: 'mylie',
  },
  {
    id: 'workspace-reasoning',
    kind: 'notice',
    label: 'Reasoning · 01:28:07',
    text: 'The host filter has to reject a stale open as well as hide the catalogue entry.',
  },
  {
    id: 'workspace-usage',
    kind: 'notice',
    label: 'Usage · 01:28:09',
    text: 'in=2 out=300',
  },
  {
    id: 'workspace-notice',
    kind: 'notice',
    text: 'Browser automation stays unavailable: this daemon has no browser worker installed.',
  },
  {
    id: 'workspace-ledger',
    kind: 'ledger',
    text: 'a durable send attempt',
    placement: 'after-loaded',
    ledger: {
      sendId: 'workspace-send-unconfirmed',
      acceptedAt: '2026-07-31T09:59:10.000Z',
      message: 'Keep the composer inside the chat column so both measures narrow together.',
      attachmentIds: [],
      fate: 'unaccounted',
      unaccountedReason: 'timeout',
    },
  },
  {
    id: 'workspace-user-2',
    kind: 'user',
    text: 'Capture it at 390x844 and 1440x900 before you call it done.',
    label: 'You',
  },
  {
    id: 'workspace-tools-live',
    kind: 'tool',
    text: 'running a tool',
    tools: [
      {
        key: 'workspace-tool-live',
        use: { name: 'Bash', input: { command: 'bun harness/screenshot.ts' } },
        // `Date.now()`, NOT the frozen `HARNESS_NOW`. A running tool's elapsed
        // label is computed against the wall clock inside ToolGroup, with no
        // injectable now at this level, so a fixed 2026-07-31 stamp renders as
        // however long ago that happens to be — the first capture said
        // "5111m 36s". Every other row here is deliberately frozen; this one
        // has to move with the clock to read as a tool that is running.
        ts: new Date(Date.now() - 41_000).toISOString(),
      },
    ],
  },
];

/**
 * `?wide` appends what made a phone's chat column grow past the screen (the mobile audit's L1): a fenced
 * block of long lines, a table, a long unbroken URL and a tool result of long lines. Each must scroll or
 * wrap inside its own box; none may widen the column, the composer or the page.
 */
const WIDE_ENTRIES: readonly TranscriptEntry[] = [
  {
    id: 'workspace-wide-assistant',
    kind: 'assistant',
    label: 'hadi',
    text: [
      '| File | Line | Problem | Severity |',
      '| --- | --- | --- | --- |',
      '| `packages/pwa/src/hooks/use-app-viewport.ts` | 88 | reads `visualViewport` without a null guard | high |',
      '| `packages/pwa/src/components/composer.tsx` | 412 | `position: sticky` inside a scroller with `overflow: hidden` | high |',
      '',
      '```ts',
      "export function useAppViewport(target: VisualViewport | null = window.visualViewport, write = (height: number) => document.documentElement.style.setProperty('--app-height', String(height) + 'px')): void {",
      '  useLayoutEffect(() => { if (target === null) return; target.addEventListener("resize", () => write(Math.round(target.height))); }, [target]);',
      '}',
      '```',
      '',
      'A long unbroken token like https://example.invalid/a/really/long/path/that/never/breaks/because/it/has/no/spaces/at/all/and/keeps/going/forever.tsx must wrap.',
    ].join('\n'),
  },
  {
    id: 'workspace-wide-tools',
    kind: 'tool',
    text: 'ran 1 tool',
    tools: [
      {
        key: 'workspace-wide-bash',
        use: {
          name: 'Bash',
          input: { command: 'rg -n "visualViewport" packages/pwa/src --glob "*.ts" --glob "*.tsx" --max-columns 400' },
        },
        result: {
          text: Array.from(
            { length: 6 },
            (_, line) =>
              `packages/pwa/src/hooks/use-app-viewport.ts:${88 + line}:  const height = window.visualViewport?.height ?? window.innerHeight; // a line far wider than any phone`,
          ).join('\n'),
        },
      },
    ],
  },
];
/**
 * `?peer=receiver` and `?peer=sender`: agent-to-agent messaging as each side's transcript shows it.
 *
 * Built from the daemon's rendered LOG rather than from hand-made entries, so the capture proves the
 * parse: the receiver's peer messages arrive wrapped in Claude's `<pasted_content>` block exactly as
 * the owner's report showed them, and must come out as messages FROM Jaylynn and Kamila. The sender
 * addressed its peer by NAME (`fy send jaylynn …`), which is the other half of the fix, and its last
 * row is the notice Ferretry types into a session whose message did not arrive.
 */
const PEER_RECEIVER_LOG = [
  '[09:58:01] user/message: Run the dev server and check @CLAUDE.md before you touch the login page.',
  '[09:58:12] assistant/message: Started `bun dev` in %terminal:dev and read @CLAUDE.md.',
  '[10:01:02] user/message: <pasted_content id="1fd4">',
  '    [peer message from teammate jaylynn (session harness-jaylynn) — not from the human lead]',
  '    No reply is required; jaylynn has carried on. Reply with `fy send jaylynn "…"` if useful.',
  '    ',
  "    Hey! How's your day going? I just landed the **flake bump** — the rebuild is green.",
  '    </pasted_content id="1fd4">',
  "[10:01:20] assistant/message: Going well, thanks :jaylynn — I'm on the login page now.",
  '[10:03:40] user/message: <pasted_content id="aa01">',
  '    [peer message from teammate kamila (session harness-kamila) — not from the human lead]',
  '    kamila is PARKED waiting for your reply and cannot continue until it arrives. Answer with: fy send kamila "<your reply>"',
  '    ',
  '    Is CI green on your branch? I need it before I rebase:',
  '    ',
  '    - `fix/pwa-session-layout`',
  '    - `feat/learning`',
  '    </pasted_content id="aa01">',
  '[10:04:02] user/message: <pasted_content id="bb02">',
  '    A long note I pasted myself:',
  '    keep the composer inside the chat column.',
  '    </pasted_content id="bb02">',
].join('\n');
const PEER_SENDER_LOG = [
  '[10:00:31] user/message: :jaylynn ask her about her day',
  '[10:00:40] assistant/message: Sending it to :jaylynn by name.',
  `[10:00:41] assistant/tool-call: Bash(${JSON.stringify({ command: 'fy send jaylynn "Hey! How\'s your day going?"' })})`,
  '[10:00:43] tool/tool-result: delivered',
  '[10:00:44] assistant/message: Sent — :jaylynn has it.',
  '[10:09:12] user/message: [ferretry] Your message to kamila (send 7f3a) did not reach it: it could not be confirmed (timeout) — it may still have landed. Decide whether to send it again with `fy send kamila …`.',
].join('\n');
const PEER_VIEW = new URLSearchParams(window.location.search).get('peer');
const SESSION_ENTRIES: readonly TranscriptEntry[] =
  PEER_VIEW === 'receiver'
    ? transcriptEntriesFromLog(PEER_RECEIVER_LOG, HARNESS_NOW)
    : PEER_VIEW === 'sender'
      ? transcriptEntriesFromLog(PEER_SENDER_LOG, HARNESS_NOW)
      : new URLSearchParams(window.location.search).has('wide')
        ? [...WORKSPACE_ENTRIES, ...WIDE_ENTRIES]
        : WORKSPACE_ENTRIES;

/**
 * The whole daemon surface this page can reach, answered locally.
 *
 * Nothing here touches the network: the screenshot driver aborts every
 * off-origin request anyway, so a client that tried would paint error states
 * over the layout under review. The terminal snapshot reader below supplies
 * paired-device evidence without calling the loopback-only attach route.
 *
 * Typed against `SessionChatClient` rather than cast into it, deliberately. A
 * stub that casts stops being evidence the moment the contract moves.
 */
const WORKSPACE_CLIENT: SessionChatClient = {
  answer: async () => WORKSPACE_SESSION,
  interrupt: async () => WORKSPACE_SESSION,
  resume: async () => WORKSPACE_SESSION,
  // `?slow-send`: the send never settles, so a capture can hold the moment of sending.
  send: async () =>
    new URLSearchParams(window.location.search).has('slow-send')
      ? await new Promise<never>(() => undefined)
      : ({ ...WORKSPACE_SESSION, disposition: 'queued' } as never),
  stop: async () => WORKSPACE_SESSION,
};

/**
 * The assembled workspace, alone on the page, in the production shell.
 *
 * A root of its own for the same two reasons the setup stages get one. It
 * mounts the PRODUCTION viewport producer, so `--app-h` and the safe-area
 * padding on `.kt-shell` are the shipped ones rather than the gallery's
 * document flow. And the workspace is a `h-full` layout with its own single
 * scroller: inside the stacked gallery it would be clipped by the gallery's
 * scroller and every claim about where the composer sits would be a claim about
 * the harness instead of about the app.
 *
 * The shell markup mirrors `src/App.tsx` exactly — `.kt-shell` column, the app
 * bar, then the `px-1 sm:px-3` route gutter — so the capture shows the real
 * chrome budget at 390 and at 1440, including the app bar that the PWA (unlike
 * kteam) still renders on a phone's session route.
 *
 * `presentation` is derived the way production derives it, from the layout
 * regime, so 390 gets the sheet and 1440 gets the non-modal pane without the
 * driver having to say which.
 */
/** The other agents on this harness machine, as the sessions bar lists them beside the workspace. */
const workspacePeer = (
  id: string,
  teammate: string,
  name: string,
  cwd: string,
  status: SessionView['state']['status'],
  extra: Partial<SessionView['state']> = {},
): SessionView =>
  ({
    ...WORKSPACE_SESSION,
    config: { ...WORKSPACE_SESSION.config, id, teammate, name, label: name, cwd },
    state: {
      ...WORKSPACE_SESSION.state,
      id,
      status,
      lastActivityAt: new Date(Date.now() - 600_000).toISOString(),
      ...extra,
    },
  }) as SessionView;

const WORKSPACE_FLEET: readonly SessionView[] = [
  { ...WORKSPACE_SESSION, config: { ...WORKSPACE_SESSION.config, teammate: 'hadi' } } as SessionView,
  workspacePeer('harness-marin', 'marin', 'Flaky test fix', '/work/ferretry', 'completed'),
  workspacePeer('harness-jaylynn', 'jaylynn', 'Main agent', '/work/home-manager', 'running'),
  workspacePeer('harness-maryah', 'maryah', 'Diene work', '/work/home-manager', 'awaiting_user', {
    needsHuman: 'Two old sign-ins are holding port 1455',
  }),
  workspacePeer('harness-kamila', 'kamila', 'Nitroso project', '/work/nitroso', 'waiting'),
];

const WORKSPACE_MACHINES = [
  { daemonId: daemon.daemonId, name: 'AMER-D22HXVF42W' },
  { daemonId: 'harness-other-daemon' as DaemonId, name: 'kirin-box' },
];

/** The workspace session's own shells, listed under ITS id so the deck accepts the listing. */
const WORKSPACE_TERMINAL_LISTING: TerminalListView = {
  ...HARNESS_TERMINAL_LISTING,
  sessionId: 'harness-workspace',
  terminals: HARNESS_TERMINAL_LISTING.terminals.map(terminal => ({
    ...terminal,
    sessionId: 'harness-workspace',
    // The agent's dev server is a NAMED terminal — `%terminal:dev` — the way the agent tools open one.
    ...(terminal.id === 'a1b2c3d4e5f6' ? { name: 'dev' } : {}),
  })),
};
const WORKSPACE_TERMINAL_OUTPUT = [
  '$ bun dev',
  '',
  '  VITE v6.2  ready in 412 ms',
  '',
  '  \u279c  Local:   http://localhost:5173/',
  '  \u279c  press h + enter to show help',
  'GET /login 200 18ms',
  '',
].join('\r\n');
/**
 * The real deck and the real emulator, over a scripted stream: each shell opens and paints a dev
 * server's output, so a capture shows a terminal tab as a reader sees one. No socket is opened.
 */
const WORKSPACE_TERMINAL_DECK: TerminalDeckDependencies = {
  ...HARNESS_TERMINAL_DECK,
  list: async () => WORKSPACE_TERMINAL_LISTING,
  loadXterm: async () => {
    const [xterm, fit] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
    return { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
  },
  attach: async (_daemon, _scope, _id, handlers) => {
    setTimeout(() => {
      handlers.onOpen();
      handlers.onBytes(new TextEncoder().encode(WORKSPACE_TERMINAL_OUTPUT));
    }, 0);
    return { write() {}, control() {}, close() {} };
  },
};
/**
 * The page's layout, kept in memory: `?split` opens the workspace pane with a terminal, the browser
 * and a file beside the chat — the arrangement the split-workspace captures are of.
 */
const WORKSPACE_LAYOUTS = (() => {
  const store = new WorkspaceLayoutStore({ getItem: () => null, setItem: () => undefined });
  if (window.location.search.includes('split'))
    store.update(WORKSPACE_SCOPE, layout =>
      activateWorkspaceTab(
        [
          workspaceTab('terminal', 'a1b2c3d4e5f6', { label: 'dev' }),
          workspaceTab('browser', 'app', { label: 'app' }),
          workspaceTab('file', 'CLAUDE.md'),
          workspaceTab('terminal', '0f0e0d0c0b0a', { label: 'shell' }),
        ].reduce((next, tab) => openWorkspaceTab(next, tab), layout),
        'terminal:a1b2c3d4e5f6',
      ),
    );
  return store;
})();
const WORKSPACE_ATTENTION = new DaemonAttentionClient();
/** `?chat-width=readable|balanced|full` picks the conversation measure, as Settings › Appearance does. */
const WORKSPACE_CHAT_WIDTH: ChatWidthPreference = (() => {
  const asked = new URLSearchParams(window.location.search).get('chat-width');
  return asked === 'balanced' || asked === 'full' ? asked : 'readable';
})();

/** `?info` opens Info on Overview, `?info=usage` on that tab — the frames Info's screenshots need. */
const WORKSPACE_INFO: InfoTab | undefined = (() => {
  const asked = new URLSearchParams(window.location.search).get('info');
  if (asked === null) return undefined;
  return (INFO_TABS as readonly string[]).includes(asked) ? (asked as InfoTab) : 'overview';
})();
/**
 * The account usage the composer reads, from the same passive feed the app polls: the session
 * document carries none. `isHidden` pinned true, so one read and no 60s poll behind a screenshot.
 */
const harnessUsage = (accounts: readonly { readonly agent: string; readonly five: number; readonly week: number }[]) =>
  new DaemonUsageStore(
    {
      usage: async () => ({
        at: '2026-10-16T06:00:00.000Z',
        stale: false,
        accounts: accounts.map(account => ({
          agent: account.agent,
          availability: 'available',
          fiveHourPercent: account.five,
          weeklyPercent: account.week,
          atLimit: false,
          authOk: true,
        })),
      }),
    } satisfies DaemonUsagePort,
    { isHidden: () => true },
  );
const WORKSPACE_USAGE = harnessUsage([{ agent: 'claude-default', five: 23, week: 41 }]);

/**
 * Actions › Warden for the workspace: the real contribution over the Warden fixture's status, so the form shows
 * the fixture's investigator and its $0.30 average against the $2 cap. Investigate answers "queued" and stops there.
 */
const WORKSPACE_ACTIONS = [
  askWardenContribution({
    status: async () => WARDEN_FIXTURE_STATUS,
    investigate: async request => ({ sessionId: request.sessionId, state: 'queued', position: 1, message: 'Queued.' }),
  }),
];
/** `?pickers` gives the workspace the runtime route, so the model and effort pickers draw (composer and Info › Runtime). */
const WORKSPACE_PICKERS = new URLSearchParams(window.location.search).has('pickers');
/** `?turn=working|your-turn`: the daemon's turn fact for the workspace; absent keeps the legacy live session. */
const WORKSPACE_TURN = ((value: string | null) => (value === 'working' || value === 'your-turn' ? value : undefined))(
  new URLSearchParams(window.location.search).get('turn'),
);
const WORKSPACE_PAGE_CLIENT: SessionChatClient = WORKSPACE_PICKERS
  ? { ...WORKSPACE_CLIENT, runtime: async () => WORKSPACE_SESSION }
  : WORKSPACE_CLIENT;

/** The SessionConfig fields a wire answer carries that the workspace fixture does not. */
const HARNESS_WIRE_CONFIG = {
  incarnation: 'harness-1',
  runtimeGeneration: 1,
  boardAccess: 'none',
  remoteControl: false,
  harnessFlags: [],
  turn: 4,
  intervalSeconds: 30,
  timeoutSeconds: 0,
  nudgeAfterSeconds: 0,
  killAfterSeconds: 0,
  directSendMaxChars: 0,
  resumeMenuChoice: 'full',
  maxSnapshots: 5,
  retry: { transientAttempts: 0, stalledAttempts: 0, waitForQuotaReset: false, allowAccountFailover: false },
} as const;

function SessionWorkspaceHarness() {
  useAppViewport();
  const layout = useLayoutMode();
  const presentation = layout === 'drawer' ? 'sheet' : 'pane';
  const [session, setSession] = useState({
    ...WORKSPACE_SESSION,
    config: { ...WORKSPACE_SESSION.config, teammate: 'hadi' },
    ...(WORKSPACE_TURN === undefined
      ? {}
      : {
          state: {
            ...WORKSPACE_SESSION.state,
            turnState: WORKSPACE_TURN,
            promptReady: WORKSPACE_TURN !== 'working',
            ...(WORKSPACE_TURN === 'working' ? {} : { activity: undefined }),
          },
        }),
  } as SessionView);
  const [drawer, setDrawer] = useState(window.location.search.includes('drawer'));
  const learningActions = useHarnessLearningActions(daemon, WORKSPACE_FLEET);
  // The Hypermedia toggle, answered in memory: the switch, and the note saying it waits for the next launch.
  const hypermediaFetch = useCallback<DaemonFetch>(
    async (_input, init) => {
      const enabled = (JSON.parse(String(init?.body)) as { enabled: boolean }).enabled;
      const view = { ...session, config: { ...session.config, hypermedia: enabled } };
      setSession(view);
      return Response.json({
        // The wire's own fields the workspace fixture leaves out, so the answer parses as a SessionView.
        view: { ...view, config: { ...HARNESS_WIRE_CONFIG, ...view.config } },
        restartRequired: true,
        note: `Hypermedia is ${enabled ? 'on' : 'off'}. This ferret is running, so it takes effect when the ferret restarts.`,
      });
    },
    [session],
  );
  const hypermediaActions = useHypermediaSessionActions({ connection: daemon, fetcher: hypermediaFetch });
  const bar = (shape: 'column' | 'rail' | 'drawer') => (
    <SessionsBar
      active={null}
      activeSessionId={session.config.id}
      daemonId={daemon.daemonId}
      machineName="AMER-D22HXVF42W"
      machines={WORKSPACE_MACHINES}
      onAddMachine={() => {}}
      onClose={() => setDrawer(false)}
      onCollapse={() => {}}
      onNavigate={() => {}}
      onOpenPalette={() => {}}
      learningPassive={LEARNING_PASSIVE}
      presentation={shape}
      projects={[]}
      {...(shape === 'drawer' ? {} : { search: <SessionSearchControl shortcutTarget /> })}
      sessions={WORKSPACE_FLEET}
    />
  );
  return (
    <div
      className={`kt-shell flex overflow-hidden ${layout === 'drawer' ? 'flex-col' : 'flex-row'}`}
      id="harness-session-workspace-page"
    >
      {hypermediaActions.host}
      {layout === 'drawer' ? null : bar('column')}
      <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3" data-shell-main="">
        <SessionChatPage
          chatWidth={WORKSPACE_CHAT_WIDTH}
          client={WORKSPACE_PAGE_CLIENT}
          actionContributions={[
            ...WORKSPACE_ACTIONS,
            ...learningActions.contributions,
            ...hypermediaActions.contributions,
          ]}
          infoLearning={learningActions.passiveFor(session.config.id)}
          connection={daemon}
          daemonSessions={WORKSPACE_FLEET}
          dictationSettings={DEFAULT_STT_SETTINGS}
          entries={SESSION_ENTRIES}
          {...(PEER_VIEW === null ? {} : { onNavigate: () => undefined })}
          onSessionChange={setSession}
          {...(layout === 'drawer' ? { onOpenSessions: () => setDrawer(true) } : {})}
          presentation={presentation}
          project="ferretry"
          readSnapshot={HARNESS_PANE_SNAPSHOT}
          typeIntoConsole={HARNESS_CONSOLE_TYPER}
          session={session}
          usage={WORKSPACE_USAGE}
          deck={WORKSPACE_TERMINAL_DECK}
          browser={HARNESS_WORKSPACE_BROWSER_DEPENDENCIES}
          workspaceLayouts={WORKSPACE_LAYOUTS}
          {...(WORKSPACE_INFO === undefined ? {} : { initialInfo: WORKSPACE_INFO })}
          context={{
            attention: WORKSPACE_ATTENTION,
            createFleetClient: harnessDaemonClient,
            machineName: 'AMER-D22HXVF42W',
          }}
        />
      </div>
      {layout === 'drawer' && drawer ? bar('drawer') : null}
      {learningActions.host}
    </div>
  );
}

const NEW_SESSION: SessionView = {
  config: {
    id: NEW_SESSION_ID,
    name: 'Gabriela',
    teammate: 'gabriela',
    agent: NEW_SESSION_HARNESS === 'claude' ? 'claude-auto-gabriela' : 'codex-auto-gabriela',
    harness: NEW_SESSION_HARNESS,
    model: NEW_SESSION_HARNESS === 'claude' ? 'claude-opus-5[1m]' : 'gpt-5.6-codex',
    modelHint: NEW_SESSION_HARNESS === 'claude' ? 'claude-opus-5[1m]' : 'gpt-5.6-codex',
    launchReasoningEffort: NEW_SESSION_HARNESS === 'claude' ? 'high' : 'medium',
    harnessFlags: [],
    mode: 'interactive',
    cwd: '/Users/kirin/.config/home-manager',
    createdAt: '2026-10-16T06:00:00.000Z',
    updatedAt: '2026-10-16T06:00:00.000Z',
  },
  state: {
    id: NEW_SESSION_ID,
    status: 'running',
    turn: NEW_SESSION_TURN === undefined ? 0 : 3,
    startedAt: '2026-10-16T06:00:00.000Z',
    ...(NEW_SESSION_TURN === undefined ? {} : { turnState: NEW_SESSION_TURN, turnStateAt: '2026-10-16T06:05:00.000Z' }),
  },
  directory: '/Users/kirin/.config/home-manager',
} as unknown as SessionView;
/** A short conversation for the turn frames: one ask, one answer. */
const NEW_SESSION_ENTRIES: readonly TranscriptEntry[] = [
  { id: 'ns-user', kind: 'user', label: 'You', text: 'Bump the flake inputs and rebuild.' },
  {
    id: 'ns-agent',
    kind: 'assistant',
    label: 'Gabriela',
    text: 'Updated `flake.lock` (nixpkgs, home-manager). Running `hms` now to check the rebuild.',
  },
];
const NEW_SESSION_USAGE = harnessUsage([
  { agent: 'claude-auto-gabriela', five: 18, week: 42 },
  { agent: 'codex-auto-gabriela', five: 7, week: 23 },
]);
const NEW_SESSION_CLIENT: SessionChatClient = {
  answer: async () => NEW_SESSION,
  interrupt: async () => NEW_SESSION,
  resume: async () => NEW_SESSION,
  send: async () => ({ ...NEW_SESSION, disposition: 'queued' }) as never,
  stop: async () => NEW_SESSION,
  runtime: async () => NEW_SESSION,
};

/** The owner's report, rendered: a session started a moment ago, before anything has been sent. */
function NewSessionHarness() {
  useAppViewport();
  const layout = useLayoutMode();
  const presentation = layout === 'drawer' ? 'sheet' : 'pane';
  const [session, setSession] = useState(NEW_SESSION);
  return (
    <div
      className={`kt-shell flex overflow-hidden ${layout === 'drawer' ? 'flex-col' : 'flex-row'}`}
      id="harness-new-session-page"
    >
      <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3">
        <SessionChatPage
          chatWidth="readable"
          client={NEW_SESSION_CLIENT}
          connection={daemon}
          dictationSettings={DEFAULT_STT_SETTINGS}
          entries={NEW_SESSION_TURN === undefined ? [] : NEW_SESSION_ENTRIES}
          onSessionChange={setSession}
          presentation={presentation}
          project="home-manager"
          readSnapshot={HARNESS_PANE_SNAPSHOT}
          session={session}
          usage={NEW_SESSION_USAGE}
        />
      </div>
    </div>
  );
}

/**
 * A full route, not a gallery card: the browser must be able to cover the app
 * viewport, so this harness gives the real remote viewer the same standalone
 * screen the production workspace receives. It deliberately opens a browser
 * instance from the side-pane model rather than constructing a second layout.
 */
function BrowserFullViewportHarness() {
  useAppViewport();
  const presentation = useLayoutMode() === 'drawer' ? 'sheet' : 'pane';
  useEffect(() => {
    openSidePaneBrowserTab(FULL_VIEWPORT_BROWSER_SCOPE, null, { forceNew: true });
  }, []);
  return (
    <div className="kt-shell flex flex-col overflow-hidden" id="harness-browser-full-viewport-page">
      <SidePaneWorkspace
        active
        presentation={presentation}
        scope={FULL_VIEWPORT_BROWSER_SCOPE}
        renderSurface={({ isActive, onClose, presentation: surfacePresentation, tab, titleId }) =>
          tab.instance?.kind === 'browser' ? (
            <UnifiedBrowserSurface
              daemon={daemon}
              dependencies={HARNESS_UNIFIED_BROWSER_DEPENDENCIES}
              isActive={isActive}
              onClose={onClose}
              presentation={surfacePresentation}
              scope={FULL_VIEWPORT_BROWSER_SCOPE}
              titleId={titleId}
            />
          ) : (
            <p className="m-3 text-ui text-muted">This harness opens only the real browser instance.</p>
          )
        }
      >
        <main className="flex min-h-0 flex-1 items-center justify-center bg-surface-2 p-panel text-ui text-muted">
          Session conversation remains behind the browser until it expands.
        </main>
      </SidePaneWorkspace>
    </div>
  );
}

/** Hash fragments that replace the whole gallery with one setup screen. */
const ONBOARDING_FRAGMENTS: Readonly<Record<string, HarnessOnboardingScreen>> = {
  '#onboarding-install': 'install',
  '#onboarding-keyboard': 'scan',
};

/**
 * The current-session search, in each state it can honestly be in (#6).
 *
 * ITS OWN PAGE, for the same reason the pickers have one: the result popup is
 * absolutely positioned, and the gallery's scroller clips it. Each card carries
 * its own provider, and the STATE IS THE DAEMON — the healthy fixture indexes
 * and answers, `checkingDaemon` never settles so the control is genuinely
 * mid-index, and `unreachableDaemon` fails the way a browser fails. None of the
 * three is posed: the copy in the capture is the copy the product renders when
 * a real daemon behaves that way.
 *
 * The driver types into these boxes rather than being handed a pre-filled query,
 * so what a capture proves is the real change → present → rank → render path.
 */
function SessionSearchStateCard({
  title,
  note,
  connection,
  searchScope,
}: {
  readonly title: string;
  readonly note: string;
  readonly connection: DaemonConnection;
  readonly searchScope: DaemonSessionScope;
}) {
  return (
    <section className="flex flex-col gap-sm" data-search-card={title}>
      <div>
        <h3 className="m-0 text-ui font-semibold text-fg">{title}</h3>
        <p className="m-0 text-2xs text-muted">{note}</p>
      </div>
      {/* Room for the popup to hang into: it is `absolute`, so the card has to
          reserve the space or the next card is drawn over the evidence. */}
      <div className="pb-[19rem]">
        <SessionSearchProvider connection={connection} focusSignal={0} scope={searchScope}>
          <div className="max-w-[34rem]">
            <SessionSearchControl />
          </div>
        </SessionSearchProvider>
      </div>
    </section>
  );
}

function SessionSearchHarness() {
  return (
    <div className="kt-shell overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-lg px-3 py-4">
        <SessionSearchStateCard
          connection={daemon}
          note="Files and tasks, ranked together. A file matching its name and its path outranks a task matching only its title."
          searchScope={scope}
          title="results"
        />
        <SessionSearchStateCard
          connection={daemon}
          note="A query nothing matches. Said as a no-match answer, which is not the same sentence as a failure."
          searchScope={scope}
          title="no-match"
        />
        <SessionSearchStateCard
          connection={checkingDaemon}
          note="Still building the index. The trailing slot drops the shortcut hint to say so."
          searchScope={daemonSessionScope(checkingDaemon, 'harness-session')}
          title="indexing"
        />
        <SessionSearchStateCard
          connection={unreachableDaemon}
          note="A half that could not be read is named, and never rendered as an empty result."
          searchScope={daemonSessionScope(unreachableDaemon, 'harness-session')}
          title="unavailable"
        />
        {/* Ready but INCOMPLETE, which is neither of the two states above: the
            walk stopped early, so the rows it did index are real answers and a
            name it never reached is not an absence. Its own session id keeps the
            healthy card's index complete. */}
        <SessionSearchStateCard
          connection={daemon}
          note="The index stopped early. Rows still answer, and the part that was never walked is said out loud rather than counted as nothing."
          searchScope={daemonSessionScope(daemon, HARNESS_PARTIAL_SESSION_ID)}
          title="partial-coverage"
        />
      </div>
    </div>
  );
}

/**
 * One picker per page, because the popover is absolutely positioned and the
 * gallery's scroller clips it. Its own map rather than a branch bolted onto the
 * fleet one: two units appending to the same object is the conflict this file
 * keeps trying to teach.
 */
const PICKER_FRAGMENTS: Readonly<Record<string, HarnessPickerFrame>> = {
  '#picker-account': 'account',
  '#picker-account-checked': 'account-checked',
  '#picker-account-failed': 'account-failed',
  '#picker-project': 'project',
};

/**
 * One Projects hub state per page. Its own map for the same reason the picker
 * frames have one: two units appending to a shared object is the conflict this
 * file keeps teaching.
 */
const PROJECTS_FRAGMENTS: Readonly<Record<string, HarnessProjectsFrame>> = {
  '#projects-hub': 'hub',
  '#projects-empty': 'empty',
  '#projects-loading': 'loading',
  '#projects-error': 'error',
  '#projects-refused': 'refused',
  '#projects-registered': 'registered',
  '#projects-already-registered': 'already-registered',
};

/** A typed client over the page's own (patched) network, which is where this harness answers. */
const harnessDaemonClient = async (target: DaemonConnection) =>
  await daemonApiClient(target, {
    transport: new DaemonHttpTransport(target, async (input, init) => await globalThis.fetch(input, init)),
  });

const host = document.getElementById('root');
if (host) {
  const screen = ONBOARDING_FRAGMENTS[window.location.hash];
  const pickerFrame = PICKER_FRAGMENTS[window.location.hash];
  const projectsFrame = PROJECTS_FRAGMENTS[window.location.hash];
  const settingsHarness = new URLSearchParams(window.location.search).has('settings-harness');
  const machineSetupHarness = new URLSearchParams(window.location.search).get('machine-setup');
  const appChromeHarness = new URLSearchParams(window.location.search).get('app-chrome');
  const mcpFrame = mcpSignInFrame(window.location.search);
  const contextTools = contextToolsFrame(window.location.search);
  const pairFromMenu = isPairFromMenuPage(window.location.search);
  const whatsNewPage = isWhatsNewPage(window.location.search);
  const sessionContextMenu = isSessionContextMenuPage(window.location.search);
  // `?viewport-overlay`: Settings › This device › About this device's readout pinned over any frame, as the
  // owner sees it on a phone after "Show over the app".
  if (new URLSearchParams(window.location.search).has('viewport-overlay')) viewportOverlay.set(true);
  createRoot(host).render(
    // The harness answers its daemon inside the page, on the plain network, so every surface is handed
    // a client over it; the app itself only ever has the store's session-routed pool.
    <DaemonClientProvider client={harnessDaemonClient}>
      <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
        {mcpFrame !== undefined ? (
          <McpSignInFrameHarness frame={mcpFrame} />
        ) : contextTools !== undefined ? (
          <ContextToolsHarness frame={contextTools} />
        ) : sessionContextMenu ? (
          <SessionContextMenuHarness />
        ) : whatsNewPage ? (
          <WhatsNewHarness />
        ) : pairFromMenu ? (
          <PairFromMenuHarness />
        ) : appChromeHarness !== null ? (
          <AppChromeHarness active={appChromeHarness} />
        ) : machineSetupHarness !== null ? (
          <StandaloneMachineSetupHarness daemonId={machineSetupHarness} />
        ) : settingsHarness ? (
          <StandaloneSettingsPageHarness />
        ) : window.location.hash === '#session-workspace' ? (
          <SessionWorkspaceHarness />
        ) : window.location.hash === '#session-new' ? (
          <NewSessionHarness />
        ) : window.location.hash === '#session-search' ? (
          <SessionSearchHarness />
        ) : window.location.hash === '#browser-full-viewport' ? (
          <BrowserFullViewportHarness />
        ) : pickerFrame !== undefined ? (
          <PickerFrameHarness frame={pickerFrame} />
        ) : projectsFrame !== undefined ? (
          <ProjectsFrameHarness frame={projectsFrame} />
        ) : screen === undefined ? (
          <Shell />
        ) : (
          <OnboardingStageHarness screen={screen} />
        )}
        <ViewportOverlay />
      </SessionSearchProvider>
    </DaemonClientProvider>,
  );
}
