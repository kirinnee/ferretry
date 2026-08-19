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
  CapabilityGrantView,
  CgroupConfigPatch,
  CgroupConfigView,
  DaemonCapability,
  DoctorReport,
  GrantRefusal,
  GrantsView,
  LearningStatus,
  PairedDevicesView,
  PairingCodeMintResponse,
  PinSnapshot,
  ProjectInfo,
  ProposalView,
  SecretList,
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
  matchesSessionSearchQuery,
  SECRET_SCHEMA_VERSION,
  SESSION_FILE_INDEX_VERSION,
  sessionSearchTaskHaystack,
  TASK_SCHEMA_VERSION,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { type ConnectionChoice, chooseConnection } from '@ferretry/relay';
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
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
import type { CaptureMonitor } from '../src/components/input-waveform.tsx';
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
import { SessionsPage } from '../src/components/sessions-page.tsx';
import { type PaneSnapshotReader, TerminalSnapshotView } from '../src/components/terminal-snapshot.tsx';
import { ThinkingIndicator } from '../src/components/thinking-indicator.tsx';
import { Transcript } from '../src/components/transcript.tsx';
import { AnalyticsResponseView } from '../src/features/analytics/analytics-response-view.tsx';
import type { AnalyticsAggregateResponse } from '../src/features/analytics/analytics-result-table.tsx';
import { AnalyticsResultTable } from '../src/features/analytics/analytics-result-table.tsx';
import { AnalyticsTimeSeries } from '../src/features/analytics/analytics-time-series.tsx';
import { type AnalyticsRequest, GlobalAnalyticsPage } from '../src/features/analytics/global-analytics-page.tsx';
import {
  type SessionAnalyticsRequest,
  SessionAnalyticsSurface,
} from '../src/features/analytics/session-analytics-surface.tsx';
import { AttentionActionModal, AttentionActionTrigger } from '../src/features/attention/attention-action-modal.tsx';
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
import type {
  FleetApplyOutcome,
  FleetManifestAccountView,
  FleetProposalView,
} from '../src/features/fleet/fleet-api.ts';
import {
  FleetAccountForm,
  type FleetInstructionsControl,
  FleetLayerForm,
} from '../src/features/fleet/fleet-change-forms.tsx';
import {
  emptyAccountDraft,
  type FleetAccountDraft,
  type FleetHarnessDetection,
  type FleetLayerDraft,
} from '../src/features/fleet/fleet-change-model.ts';
import { FleetApplyReport, FleetChangeReview, FleetLiveRoster } from '../src/features/fleet/fleet-change-review.tsx';
import { FleetConfigurationSurface, fleetSettingsTab } from '../src/features/fleet/fleet-configuration-surface.tsx';
import type { FleetReadState } from '../src/features/fleet/fleet-model.ts';
import { FleetSurface } from '../src/features/fleet/fleet-surface.tsx';
import { type RemoteLoginStep, RemoteLoginSurface } from '../src/features/fleet/remote-login-surface.tsx';
import { LearningHeader } from '../src/features/learning/learning-header.tsx';
import { LearningReview } from '../src/features/learning/learning-page.tsx';
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
import { PairingScreen } from '../src/features/pairing/pairing-screen.tsx';
import { PinsBoard } from '../src/features/pins/pins-board.tsx';
import { PinsTrigger } from '../src/features/pins/pins-trigger.tsx';
import type { ProjectRegistrationStatus } from '../src/features/projects/project-registration-model.ts';
import { ProjectsHub } from '../src/features/projects/projects-hub.tsx';
import { SecretsCard } from '../src/features/secrets/secrets-card.tsx';
import { SecretsSurface } from '../src/features/secrets/secrets-surface.tsx';
import { SessionSearchControl, SessionSearchProvider } from '../src/features/session-search/session-search.tsx';
import type { PairingClient } from '../src/features/settings/add-device-api.ts';
import {
  AddDeviceCard,
  AddDeviceSurface,
  type PairingClientFactory,
} from '../src/features/settings/add-device-settings.tsx';
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
import { settingsPaletteEntries } from '../src/features/settings/settings-catalog.ts';
import { SettingsPage } from '../src/features/settings/settings-page.tsx';
import type { SkillsCatalog } from '../src/features/skills/skills-catalog.ts';
import { SkillsSurface } from '../src/features/skills/skills-surface.tsx';
import { filterTaskDag, taskDag } from '../src/features/tasks/task-dag.ts';
import { TaskDagGraph } from '../src/features/tasks/task-dag-graph.tsx';
import { TaskName } from '../src/features/tasks/task-name.tsx';
import { taskStatusCounts, toggleTaskStatusFilter } from '../src/features/tasks/task-presentation.ts';
import { TaskQuickSummary, TaskRow } from '../src/features/tasks/task-row.tsx';
import { TaskStatusFilter } from '../src/features/tasks/task-status-filter.tsx';
import { WardenAttention } from '../src/features/warden/warden-attention.tsx';
import { type WardenClientFactory, WardenConfigCard } from '../src/features/warden/warden-config-card.tsx';
import { WardenStrip } from '../src/features/warden/warden-strip.tsx';
import { WardenVerdicts } from '../src/features/warden/warden-verdicts.tsx';
import { useAppViewport } from '../src/hooks/use-app-viewport.ts';
import { DETAILS_TAB_ORDER, type DetailsTab } from '../src/hooks/use-details-tab.ts';
import { useLayoutMode } from '../src/hooks/use-layout-mode.ts';
import type { LiveClockOptions } from '../src/hooks/use-live-clock.ts';
import type { ScopeNavigation } from '../src/hooks/use-project-scope.ts';
import type { RemoteBrowserScheduler, RemoteBrowserTransport } from '../src/hooks/use-remote-browser.ts';
import type { WardenStatusReader } from '../src/hooks/use-warden-status.ts';
import type { PickerAccount, PickerAccountHealth } from '../src/lib/account-picker-catalog.ts';
import type { DaemonAccountPickerSlice } from '../src/lib/account-picker-store.ts';
import type { DaemonConnectionRecord } from '../src/lib/connections.ts';
import { type ControlsStorage, DaemonControlsStore } from '../src/lib/controls.ts';
import { type DaemonConnection, daemonConnection } from '../src/lib/daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../src/lib/daemon-scope.ts';
import { DaemonDraftStore } from '../src/lib/drafts.ts';
import type { FleetProject, SessionGroup } from '../src/lib/fleet-grouping.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../src/lib/fleet-store.ts';
import { buildLineage } from '../src/lib/lineage.ts';
import { writeMdComposePref } from '../src/lib/md-compose.ts';
import { daemonSessionsPath } from '../src/lib/pages/routes.ts';
import { type SessionChatClient, SessionChatPage } from '../src/lib/pages/session-chat-page.tsx';
import type { QrScanHost } from '../src/lib/pair-scan.ts';
import type { PairingArrival } from '../src/lib/pairing.ts';
import { type DaemonProjectsPort, type DaemonProjectsSlice, DaemonProjectsStore } from '../src/lib/projects-store.ts';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';
import { SIDE_PANE_DEFAULT_WIDTH } from '../src/lib/side-pane-preferences.ts';
import {
  BrowserRecognitionError,
  type BrowserRecognitionProvider,
  type BrowserRecognitionSupport,
  type SpeechRecognitionErrorEventLike,
  type SpeechRecognitionLike,
  type SpeechRecognitionResultEventLike,
} from '../src/lib/stt/browser-recognition.ts';
import { DEFAULT_STT_SETTINGS, type SttSettings } from '../src/lib/stt/stt-settings.ts';
import { DaemonUsageIndex } from '../src/lib/usage.ts';
import { type DaemonUsagePort, DaemonUsageStore } from '../src/lib/usage-store.ts';
import { AgentSidebar } from '../src/shell/agent-sidebar.tsx';
import { AppBar } from '../src/shell/app-bar.tsx';
import { BottomSheet } from '../src/shell/bottom-sheet.tsx';
import { BrandMark } from '../src/shell/brand-mark.tsx';
import { BulkStopConfirmation } from '../src/shell/bulk-stop-confirmation.tsx';
import { type ChatWidth, ChatWidthControl } from '../src/shell/chat-width-control.tsx';
import { ChunkErrorBoundary } from '../src/shell/chunk-error-boundary.tsx';
import { CommandPalette, type PaletteSettingsSource } from '../src/shell/command-palette.tsx';
import { ContextMenu } from '../src/shell/context-menu.tsx';
import { FleetNavigationRail } from '../src/shell/fleet-navigation-rail.tsx';
import { MarkerLine, MarkerSeparator } from '../src/shell/marker.tsx';
import { ModeBadge } from '../src/shell/mode-badge.tsx';
import { paletteSessionEntries } from '../src/shell/palette-model.ts';
import { ActionGroup, Badge, Button, Card, Label, PanelBody, PanelHeader, Textarea } from '../src/shell/primitives.tsx';
import { type Quota, QuotaReadout } from '../src/shell/quota-readout.tsx';
import { RcBadge } from '../src/shell/rc-badge.tsx';
import { SessionRowMenu } from '../src/shell/session-row-menu.tsx';
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

const daemon = daemonConnection({
  daemonId: 'harness-daemon',
  baseUrl: 'https://daemon.invalid/',
  deviceToken: 'harness-token',
});
const unreachableDaemon = daemonConnection({
  daemonId: 'unreachable-daemon',
  baseUrl: 'https://offline.example.test',
  deviceToken: 'offline-harness-token',
});
const checkingDaemon = daemonConnection({
  daemonId: 'checking-daemon',
  baseUrl: 'https://checking.example.test',
  deviceToken: 'checking-harness-token',
});
const HARNESS_SETTINGS_CONNECTIONS = [
  { ...daemon, label: 'Studio workstation', pairedAt: 1, lastSelectedAt: 3 },
  { ...unreachableDaemon, label: 'Travel laptop', pairedAt: 1, lastSelectedAt: 2 },
  { ...checkingDaemon, pairedAt: 1, lastSelectedAt: 1 },
] as const satisfies readonly DaemonConnectionRecord[];

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

/** Positive fixture evidence: this is not a claim that either account is signed in. */
const HARNESS_FLEET: FleetReadState = {
  kind: 'available',
  harnesses: [
    { kind: 'claude', launchable: ['claude-auto-studio'], blocked: [] },
    {
      kind: 'codex',
      launchable: ['codex-auto-studio'],
      blocked: ['the fleet publishes codex-auto-archive but this host has no such executable on its PATH'],
    },
  ],
  accounts: [
    {
      id: 'studio-claude-auto',
      wrapper: 'claude-auto-studio',
      harness: 'claude',
      label: 'Studio Claude',
      available: true,
    },
    {
      id: 'studio-codex-auto',
      wrapper: 'codex-auto-studio',
      harness: 'codex',
      label: 'Studio Codex',
      available: true,
    },
    {
      id: 'archive-codex-auto',
      wrapper: 'codex-auto-archive',
      harness: 'codex',
      label: 'Archive Codex',
      available: false,
      unavailableReason: 'The archive account is disabled while its provider is unavailable.',
    },
  ],
};

/**
 * The fleet CONFIGURATION fixtures: one published host, one staged change against it, one honest
 * failure. Written out longhand and cast at the boundary, because these frames exist to be looked at
 * and a fixture derived from the same schema the surface parses with proves nothing about either.
 */
const HARNESS_FLEET_ACCOUNTS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'claude',
    mode: 'auto',
    wrapper: 'claude-studio',
    home: '/home/pilot/.ferretry/fleet/homes/claude-studio',
    displayName: 'Studio Claude',
    defaultModel: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    kind: 'claude',
    mode: 'interactive',
    wrapper: 'claude-auto-atelier',
    home: '/home/pilot/.ferretry/fleet/homes/claude-auto-atelier',
    displayName: 'Atelier Claude',
    defaultModel: 'claude-sonnet-5',
    models: [{ id: 'claude-sonnet-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    kind: 'codex',
    mode: 'auto',
    wrapper: 'codex-archive',
    home: '/home/pilot/.ferretry/fleet/homes/codex-archive',
    displayName: 'Archive Codex',
    defaultModel: null,
    models: [],
    available: false,
    unavailableReason: 'the fleet publishes codex-archive but this host has no such executable on its PATH',
  },
] satisfies readonly FleetManifestAccountView[];

/**
 * The create form as a person actually meets it: prefilled from a host that HAS Claude Code, with the
 * provenance visible on every field detection filled in.
 *
 * The gallery is the touch-target and both-theme evidence for this screen, so the fixture has to be the
 * prefilled state rather than a blank form — an empty draft would review a screen nobody sees.
 */
const HARNESS_FLEET_DRAFT: FleetAccountDraft = {
  ...emptyAccountDraft('claude'),
  name: 'atelier',
  displayName: 'Atelier Claude',
  modelsText: 'claude-opus-5\nclaude-sonnet-5',
  defaultModel: 'claude-opus-5',
  layer: {
    ...emptyAccountDraft('claude').layer,
    instructions: {
      path: 'instructions/claude-atelier.md',
      text: '# Atelier\n\nBe exact. Prefer the smallest change that is provably correct.\n',
    },
  },
  prefilled: {
    models: 'Detected — read from /home/pilot/.claude/settings.json.',
    defaultModel: 'Detected — read from /home/pilot/.claude/settings.json.',
    instructionsPath: 'Derived — from the wrapper name above. Choose another document, or edit the path.',
    instructionsText:
      'Imported — /home/pilot/.claude/CLAUDE.md (86 bytes). Edit it here; nothing is written until you review and authorize the change.',
  },
};

const HARNESS_FLEET_DETECTION: FleetHarnessDetection = {
  harness: 'claude',
  detail: 'Detected claude at /usr/local/bin/claude.',
  noneInstalled: false,
};

const HARNESS_FLEET_INSTRUCTIONS: FleetInstructionsControl = {
  choices: [
    {
      value: 'new-imported',
      label: 'New — instructions/claude-atelier.md, imported',
      detail:
        'Imported — /home/pilot/.claude/CLAUDE.md (86 bytes). Edit it here; nothing is written until you review and authorize the change.',
    },
    {
      value: 'new-blank',
      label: 'New — instructions/claude-atelier.md, empty',
      detail: 'A new, empty document written at that path.',
    },
    {
      value: 'asset:instructions/house-rules.md',
      label: 'instructions/house-rules.md',
      detail:
        'Already in this fleet’s asset tree. This account will read it, and an edit here rewrites the one document every account using it reads.',
    },
  ],
  value: 'new-imported',
  onChoose: () => {},
  loading: false,
};

const HARNESS_FLEET_LAYER: FleetLayerDraft = {
  instructions: {
    path: 'instructions/studio.md',
    text: '# Studio\n\nBe exact. Prefer the smallest change that is provably correct.\n',
  },
  skillsDirectory: 'skills/studio',
  skills: [
    { id: 'skills/studio/review.md', path: 'skills/studio/review.md', text: '# Review\n\nRead the diff twice.\n' },
  ],
  settingsText: '{\n  "model": "claude-opus-5",\n  "permissions": { "allow": ["Bash(git status)"] }\n}',
  env: [{ id: 'FY_LANE', name: 'FY_LANE', value: 'studio' }],
  // Fields this editor does not offer, carried through the change exactly as declared.
  preserved: { flags: ['--dangerously-skip-permissions'], mcp: 'mcp/studio.json' },
};

const HARNESS_FLEET_PROPOSAL = {
  id: 'fy_fprop_7Hq2Kd9vBnR4Tm6Ws8XzQb',
  revision: '9f1c4ab77e2d',
  mutation: {
    kind: 'create-account',
    harness: 'claude',
    name: 'atelier',
    variant: 'default',
    models: ['claude-opus-5'],
    defaultModel: 'claude-opus-5',
  },
  summary: 'add claude-atelier',
  expiresAt: '2026-08-05T08:41:00.000Z',
  state: 'pending',
  assetEdits: [
    { path: 'instructions/atelier.md', bytes: 482 },
    { path: 'skills/atelier/review.md', bytes: 1_204 },
  ],
  preview: {
    kind: 'apply',
    documents: [
      { path: '/home/pilot/.ferretry/fleet/config.yaml', bytes: 3_918 },
      { path: '/home/pilot/.ferretry/fleet/assets/instructions/atelier.md', bytes: 482 },
    ],
    plan: {
      manifestPath: '/home/pilot/.ferretry/fleet/manifest.json',
      manifest: {
        version: 1,
        generatedAt: '2026-08-05T08:26:00.000Z',
        accounts: [
          ...HARNESS_FLEET_ACCOUNTS,
          {
            id: '44444444-4444-4444-8444-444444444444',
            kind: 'claude',
            mode: 'auto',
            wrapper: 'claude-atelier',
            home: '/home/pilot/.ferretry/fleet/homes/claude-atelier',
            displayName: 'Atelier Claude',
            defaultModel: 'claude-opus-5',
            models: [{ id: 'claude-opus-5', available: true }],
            available: true,
            unavailableReason: null,
          },
        ],
      },
      operations: [
        { kind: 'directory', path: '/home/pilot/.ferretry/fleet/homes/claude-atelier', mode: 448 },
        { kind: 'file', path: '/home/pilot/.ferretry/fleet/bin/claude-atelier', mode: 493 },
        {
          kind: 'copy',
          source: '/home/pilot/.ferretry/fleet/assets/instructions/atelier.md',
          path: '/home/pilot/.ferretry/fleet/homes/claude-atelier/CLAUDE.md',
          mode: 420,
        },
        {
          kind: 'symlink',
          source: '/home/pilot/.ferretry/fleet/shared/claude/history',
          path: '/home/pilot/.ferretry/fleet/homes/claude-atelier/history',
        },
        {
          kind: 'settings',
          path: '/home/pilot/.ferretry/fleet/homes/claude-atelier/settings.json',
          format: 'json',
          layerCount: 3,
          preserveExisting: true,
          mode: 384,
        },
        {
          kind: 'codex-sqlite-ownership',
          path: '/home/pilot/.ferretry/fleet/homes/codex-archive/config.toml',
          markerPath: '/home/pilot/.ferretry/fleet/homes/codex-archive/.fy-sqlite-owner',
          sqliteHome: '/home/pilot/.ferretry/fleet/shared/codex/sqlite',
          enabled: true,
        },
        {
          kind: 'prune',
          path: '/home/pilot/.ferretry/fleet/bin',
          marker: 'ferretry-managed',
          keep: ['claude-studio', 'claude-auto-atelier', 'codex-archive', 'claude-atelier'],
        },
      ],
      sharedHistory: [
        {
          kind: 'claude',
          pool: '/home/pilot/.ferretry/fleet/shared/claude/history',
          migrated: 214,
          conflicts: 2,
          links: 4,
        },
      ],
    },
  },
} satisfies FleetProposalView;

const HARNESS_FLEET_FAILURE = {
  outcome: 'rollback-incomplete',
  failedOperation: 'settings /home/pilot/.ferretry/fleet/homes/claude-atelier/settings.json',
  reason: 'no space left on device',
  unrestored: [
    {
      path: '/home/pilot/.ferretry/fleet/homes/claude-atelier/settings.json',
      reason: 'the moved-aside original could not be renamed back',
      backup: '/home/pilot/.ferretry/fleet/homes/claude-atelier/settings.json.fy-backup',
    },
  ],
  displaced: [
    {
      path: '/home/pilot/.ferretry/fleet/homes/claude-atelier/CLAUDE.md',
      movedTo: '/home/pilot/.ferretry/fleet/homes/claude-atelier/CLAUDE.md.fy-displaced',
    },
  ],
  lockResidue: '/home/pilot/.ferretry/fleet/apply.lock',
} satisfies FleetApplyOutcome;

const HARNESS_REMOTE_LOGIN_URL = 'https://accounts.example.test/authorize?state=harness-state';

/**
 * A safe, local-only journey for visual review. The callbacks are obvious
 * fixtures, never provider credentials, and the component still clears them
 * before either terminal state is painted.
 */
function RemoteLoginHarness() {
  const start = async (): Promise<RemoteLoginStep> => ({
    kind: 'awaiting-callback',
    authorizationUrl: HARNESS_REMOTE_LOGIN_URL,
  });
  const submit = async (redirectUrl: string): Promise<RemoteLoginStep> =>
    redirectUrl.includes('rejected')
      ? { kind: 'rejected', reason: 'This callback does not match the sign-in started on Studio workstation.' }
      : { kind: 'complete', copiedToSiblings: 2 };

  return (
    <div data-harness="remote-login">
      <RemoteLoginSurface
        daemonId={daemon.daemonId}
        identity={{
          identity: 'claude:studio',
          provider: 'claude',
          accountLabel: 'Studio Claude',
          memberCount: 3,
        }}
        initialStep={{ kind: 'ready' }}
        onStart={start}
        onSubmitRedirect={submit}
        copy={async () => {}}
      />
    </div>
  );
}

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
 * A stand-in analyser branch. It paints a real waveform from a synthetic tone,
 * so the meter in a screenshot is the actual paint path rather than an empty
 * box — headless Chrome has no microphone to open.
 */
const harnessMonitor: CaptureMonitor = {
  createAnalyser: () => ({
    analyser: {
      fftSize: 512,
      smoothingTimeConstant: 0.5,
      minDecibels: -90,
      maxDecibels: -10,
      getFloatTimeDomainData: (target: Float32Array) => {
        for (let index = 0; index < target.length; index += 1) {
          target[index] = 0.34 * Math.sin((index / target.length) * Math.PI * 12);
        }
      },
    },
    disconnect: () => undefined,
  }),
};

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

/**
 * The three panels the composition root supplies, in the order it supplies them.
 *
 * The fixture renders the production EIGHT — Warden, Secrets, Environment,
 * Resource limits, Doctor, Fleet, Carrier, Host checks — because a fixture with
 * fewer cannot show what eight of them do to the frame that lists them. Each one
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
  // The real definition the composition root mounts, given the same stub daemon
  // the fleet cockpit frames use: one published fleet, staging allowed, applying
  // only with approval.
  fleetSettingsTab(async connection => {
    if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
    return fleetCockpitClient(HARNESS_FLEET_COCKPIT_ANSWERS);
  }),
];

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
      }}
      notifications={
        <NotificationSettingsView
          permission="granted"
          enabled
          preferences={{
            events: { attention: true, question: true, failed: true, completed: false },
            interactiveOnly: false,
          }}
          delivery="active"
          devices={[]}
          onEnabled={() => {}}
          onPreferences={() => {}}
          onRevokeDevice={() => {}}
        />
      }
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
      daemonSettingsTabs={HARNESS_DAEMON_SETTINGS_TABS}
      onSelectDaemon={setActiveDaemonId}
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
      {page}
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

function StandaloneSettingsPageHarness() {
  useAppViewport();
  return <SettingsPageHarness standalone />;
}

/**
 * The markdown composer preference is a single reader-wide setting, so the
 * harness turns it ON for the whole page: that is the state a reviewer needs to
 * look at, and the composers with an empty draft are unaffected (a placeholder
 * is painted by the textarea, not by the overlay). Toggle it live from the
 * "Composer settings" card when serving the harness by hand.
 */
writeMdComposePref('on');

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

/** Fixed reading instant, so ledger badges and timestamps are stable shots. */
const LEDGER_AS_OF = Date.parse('2026-07-31T10:00:30.000Z');

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

const WARDEN: WardenStatusView = {
  config: {
    enabled: true,
    accounts: [{ agent: 'claude-auto-loge' }],
    failover: { policy: 'fallback', failureThreshold: 3, cooldownMinutes: 30 },
    providerOutage: { minDistinctSessions: 2, persistenceSweeps: 2, tailLines: 40 },
    intervalMinutes: 5,
    unattendedMinutes: 20,
    minSpawnGapMinutes: 10,
    susThinkingSeconds: 600,
    susSubprocessSeconds: 900,
    maxAssignedWardens: 2,
    assignedCooldownMinutes: 15,
    blessMinutes: 30,
  },
  lastSweepAt: '2026-07-31T11:57:00.000Z',
  anomalies: [
    { kind: 'sus_thinking', sessionId: 'sess-1', status: 'thinking', detail: 'thinking for 14m', teammate: 'ms-98' },
  ],
  fingerprint: 'harness',
  liveWarden: 'sess-9',
  failover: {
    policy: 'fallback',
    failureThreshold: 3,
    cooldownMinutes: 30,
    accounts: [
      { agent: 'claude-auto-loge', eligible: true },
      { agent: 'codex-auto-terra', eligible: false, reason: 'at limit' },
    ],
    lastSelection: {
      agent: 'claude-auto-loge',
      policy: 'fallback',
      at: '2026-07-31T11:00:00.000Z',
      reason: 'first eligible',
    },
  },
};

/** A daemon that has its configuration but has never produced a report. */
const WARDEN_NOT_REPORTING: WardenStatusView = {
  ...WARDEN,
  anomalies: [],
  failover: undefined,
  lastSweepAt: undefined,
  liveWarden: undefined,
};

const WARDEN_CONFIG: WardenConfigView = {
  config: WARDEN.config,
  accounts: WARDEN.config.accounts,
  warnings: ['Account order takes effect on the next sweep.'],
};

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
 * The grant fixtures, as a PAIRED REMOTE browser sees them.
 *
 * A loopback caller reads five allowed rows and has nothing to review, so the interesting states are
 * all on this side of the boundary: a capability the operator switched off, a `configure` axis behind
 * the operator password, and a machine with no password at all — where every configure reason comes
 * back `ungated` and the disclosure is the whole point of the screen.
 */
const grantEntry = (
  capability: DaemonCapability,
  granted: { use: boolean; configure: boolean },
  useRefusal: GrantRefusal,
  configureRefusal: GrantRefusal,
  origin: 'default' | 'config file' = 'default',
  /** Whether this fixture's caller may turn the capability ON. False models a remote browser, which
   *  is the interesting case: widening is a local act and no password buys it. */
  mayGrant = false,
): CapabilityGrantView => ({
  capability,
  use: useRefusal === 'granted' || useRefusal === 'ungated',
  configure: configureRefusal === 'granted' || configureRefusal === 'ungated',
  granted,
  mayGrant,
  useRefusal,
  configureRefusal,
  origin,
});

const on = { use: true, configure: true };

/** Frozen, so an unlock countdown renders the same number in every capture. */
const HARNESS_GRANT_NOW_MS = Date.parse('2026-01-01T00:00:00.000Z');

/** A cautious operator: a password is set, so every configure axis is behind an unlock. */
const HARNESS_GRANTS_LOCKED: GrantsView = {
  capabilities: [
    grantEntry('fleet', on, 'granted', 'locked'),
    grantEntry('terminal', { use: false, configure: false }, 'not-granted', 'not-granted', 'config file'),
    grantEntry('browser', on, 'granted', 'locked'),
    grantEntry('filesystem', on, 'granted', 'locked', 'config file'),
    grantEntry('warden', { use: true, configure: false }, 'granted', 'not-granted', 'config file'),
    grantEntry('pairing', on, 'granted', 'locked', 'config file'),
  ],
  governed: true,
  hostLocal: false,
  passwordSet: true,
  unlocked: false,
  attemptsRemaining: 5,
};

/** The permissive default: nothing is standing behind the configure controls, and the screen says so. */
const HARNESS_GRANTS_UNGATED: GrantsView = {
  // `mayGrant: true` — this fixture is the caller standing AT the machine, the only one that may widen.
  // It is what makes the "direct local" capability-list frame a real loopback view rather than a remote
  // view wearing a local badge, and `governed: false` is the same fact on the view itself.
  capabilities: DAEMON_CAPABILITIES.map(capability =>
    grantEntry(capability, on, 'granted', 'ungated', 'default', true),
  ),
  governed: false,
  hostLocal: true,
  passwordSet: false,
  unlocked: false,
};

/** Five wrong passwords: the daemon has stopped checking, so no prompt is offered at all. */
const HARNESS_GRANTS_RATE_LIMITED: GrantsView = {
  capabilities: DAEMON_CAPABILITIES.map(capability => grantEntry(capability, on, 'granted', 'rate-limited')),
  governed: true,
  hostLocal: false,
  passwordSet: true,
  unlocked: false,
  attemptsRemaining: 0,
  lockedUntil: '2026-01-01T00:15:00.000Z',
};

/** A daemon that cannot read its own grant document: denied, loudly, and not shown as permissive. */
const HARNESS_GRANTS_UNDETERMINED: GrantsView = {
  capabilities: DAEMON_CAPABILITIES.map(capability => grantEntry(capability, on, 'undetermined', 'undetermined')),
  governed: true,
  hostLocal: false,
  passwordSet: true,
  unlocked: false,
};

/**
 * A BROWSER ON THE MACHINE THAT HAS NOT UNLOCKED YET — governed and local at once.
 *
 * The connection the two fields were split for. `mayGrant` stays true because locality decides widening
 * and this caller is at the machine; the configure axes read `locked` because it has not proved the
 * password. A fixture that moved the two together could not express this state at all, which is exactly
 * why it earns a capture of its own.
 */
const HARNESS_GRANTS_LOCAL_LOCKED: GrantsView = {
  capabilities: DAEMON_CAPABILITIES.map(capability => grantEntry(capability, on, 'granted', 'locked', 'default', true)),
  governed: true,
  hostLocal: true,
  passwordSet: true,
  unlocked: false,
  attemptsRemaining: 5,
};

/** The same browser after one unlock: ungoverned, and the password control is live. */
const HARNESS_GRANTS_LOCAL_UNLOCKED: GrantsView = {
  capabilities: DAEMON_CAPABILITIES.map(capability =>
    grantEntry(capability, on, 'granted', 'granted', 'default', true),
  ),
  governed: false,
  hostLocal: true,
  passwordSet: true,
  unlocked: true,
  unlockExpiresAt: '2026-01-01T00:05:00.000Z',
  attemptsRemaining: 5,
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

/** Two devices, one of them the browser doing the looking, so the "this device" mark is reviewable. */
const HARNESS_PAIRED_DEVICES: PairedDevicesView = {
  devices: [
    {
      id: `fy_device_id_${'Dd'.repeat(11)}`,
      name: 'Ernest’s Pixel 8',
      platform: 'browser',
      createdAt: '2025-12-20T18:22:00.000Z',
      lastSeenAt: '2025-12-31T22:04:00.000Z',
    },
    {
      id: `fy_device_id_${'Ee'.repeat(11)}`,
      name: 'Studio iMac',
      platform: 'browser',
      createdAt: '2025-11-02T09:15:00.000Z',
      lastSeenAt: '2025-11-02T09:15:00.000Z',
    },
  ],
  hostLocal: true,
  thisDeviceId: `fy_device_id_${'Dd'.repeat(11)}`,
};

/**
 * The pairing client the settings harness mounts.
 *
 * IT NEVER MINTS A REAL CODE. Every value it answers with is the frozen fake above, so no capture and no
 * served harness session can put a working credential on screen or in a PNG. The unreachable pairing
 * throws, so the refusal panel is reviewable in the frame as well as in its own gallery card.
 */
const HARNESS_PAIRING_CLIENT: PairingClientFactory = async connection => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  let devices = HARNESS_PAIRED_DEVICES;
  return {
    request: (async (path: string, _schema: unknown, init?: RequestInit) => {
      if (path === '/v1/pair/code' && init?.method === 'POST') return HARNESS_INVITE;
      if (path.startsWith('/v1/pair/code/') && init?.method === 'DELETE')
        return { pairingId: HARNESS_INVITE.pairingId, status: 'expired', expiresAt: HARNESS_INVITE.expiresAt };
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
const HARNESS_GRANT_CLIENT: GrantClientFactory = async connection => {
  if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
  let view = HARNESS_GRANTS_LOCKED;
  return {
    request: (async (path: string, _schema: unknown, init?: RequestInit) => {
      if (path.endsWith('/unlock')) {
        const password = String(JSON.parse(String(init?.body)).password);
        // One password works, so the unlock path and the wrong-password path are both reviewable by
        // hand when this harness is served rather than screenshotted.
        if (password !== 'ferretry-operator')
          throw new FyHttpError(
            'that is not this machine’s operator password; 4 attempts remaining before this daemon stops checking',
            401,
            'grant_wrong_password',
          );
        view = { ...view, unlocked: true, capabilities: HARNESS_GRANTS_UNGATED.capabilities, passwordSet: true };
        return { token: 'fy_unlock_harnessharnessharness1', expiresAt: '2026-01-01T00:05:00.000Z', ttlSeconds: 300 };
      }
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
  };
};

const LEARNING_STATUS: LearningStatus = {
  enabled: true,
  intervalMinutes: 10,
  lastRunAt: '2026-07-31T11:58:00.000Z',
  pending: { total: 2, strong: 1, weak: 1 },
  totals: { observations: 8, proposals: 2, tombstones: 0 },
  running: false,
};

const LEARNING_PROPOSALS: readonly ProposalView[] = [
  {
    id: 'paired-daemon',
    category: 'global',
    state: 'pending',
    title: 'Pair before opening daemon data',
    ruleText: 'Use the selected daemon connection for every request and cache key.',
    target: { kind: 'global-agent-guidance', path: 'AGENTS.md', anchor: 'PWA' },
    observationIds: ['observe-1'],
    occurrences: 5,
    crossRepoCount: 2,
    firstSeen: '2026-07-30T12:00:00.000Z',
    lastSeen: '2026-07-31T11:58:00.000Z',
    identity: 'paired-daemon',
    history: [{ at: '2026-07-31T11:58:00.000Z', event: 'created', by: 'miner' }],
    evidence: [
      {
        observationId: 'observe-1',
        sessionId: 'harness-session',
        repo: 'ferretry',
        at: '2026-07-31T11:58:00.000Z',
        quote: 'This data belongs to daemon A.',
        source: 'human',
        kind: 'correction',
      },
    ],
  },
  {
    id: 'visual-review',
    category: 'global',
    state: 'pending',
    title: 'Open both viewport screenshots',
    ruleText: 'Compare mobile and desktop captures before claiming UI fidelity.',
    target: { kind: 'global-agent-guidance', path: 'AGENTS.md' },
    observationIds: ['observe-2'],
    occurrences: 1,
    crossRepoCount: 1,
    firstSeen: '2026-07-31T11:00:00.000Z',
    lastSeen: '2026-07-31T11:00:00.000Z',
    identity: 'visual-review',
    history: [{ at: '2026-07-31T11:00:00.000Z', event: 'created', by: 'miner' }],
    evidence: [
      {
        observationId: 'observe-2',
        sessionId: 'harness-session',
        repo: 'ferretry',
        at: '2026-07-31T11:00:00.000Z',
        quote: 'Open the images.',
        source: 'human',
        kind: 'correction',
      },
    ],
  },
];

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
  | 'connect'
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
  connect: harnessOnboarding(hereByHand(), 'connect'),
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
 * One real file body, so the file INSTANCE tab (#35) paints its own bytes
 * rather than a network failure. The harness aborts every non-loopback request,
 * so a file tab has nothing to show unless this answers for it.
 */
const HARNESS_FS_FILES: Readonly<Record<string, unknown>> = {
  'CLAUDE.md': {
    path: 'CLAUDE.md',
    lang: 'markdown',
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
    lang: 'yaml',
    content: ['version: "3"', '', 'tasks:', '  test:', '    desc: Run unit, integration and SIT suites'].join('\n'),
  },
  'coverage.csv': { path: 'coverage.csv', lang: 'csv', content: HARNESS_PREVIEW_CSV },
  [HARNESS_RELOAD_PENDING]: {
    path: HARNESS_RELOAD_PENDING,
    lang: 'markdown',
    content: ['# Release notes', '', 'The bytes on screen were loaded a moment ago.'].join('\n'),
  },
  [HARNESS_RELOAD_FAILING]: {
    path: HARNESS_RELOAD_FAILING,
    lang: 'markdown',
    content: ['# Deploy log', '', 'The bytes on screen were loaded before the host went away.'].join('\n'),
  },
};

/**
 * The rich preview's own bounded byte read (`?format=base64`). One CSV is
 * enough to show a real table renderer; a PDF or a raster would only prove the
 * browser can decode, which is not this surface's decision.
 */
const HARNESS_FS_PREVIEWS: Readonly<Record<string, unknown>> = {
  'coverage.csv': { path: 'coverage.csv', base64: btoa(HARNESS_PREVIEW_CSV) },
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
 * The fleet profile environment the harness daemon publishes.
 *
 * The comparison defaults to this daemon against itself — what the surface does
 * at rest — so the difference list is legitimately empty rather than a
 * disagreement invented between two hosts this fixture cannot both answer for.
 */
const HARNESS_FLEET_ENVIRONMENT = {
  profiles: {
    default: {
      FERRETRY_FLEET: 'studio',
      FY_HOME: '/home/pilot/.ferretry',
      PATH: '/nix/var/nix/profiles/default/bin:/usr/bin:/bin',
      TZ: 'Asia/Singapore',
    },
    auto: {
      FERRETRY_FLEET: 'studio',
      FY_HOME: '/home/pilot/.ferretry',
      FY_UNATTENDED: '1',
      PATH: '/nix/var/nix/profiles/default/bin:/usr/bin:/bin',
      TZ: 'Asia/Singapore',
    },
  },
};

/**
 * The reads the harness daemon answers beyond the file tabs' `/fs` routes.
 *
 * Most surfaces take a client factory this fixture injects (Warden, resource
 * limits, Fleet). These two cannot: `SecretsSurface` falls back to
 * `daemonApiClient` because no secret-client seam is forwarded through
 * `SettingsPage` — the GAP `docs/secrets.md` declares — and
 * `FleetEnvironmentSettings` calls `fetch` itself. Unanswered, their captures
 * showed "Reading this daemon's secret store…" and "Failed to fetch": the
 * harness's own aborted request, reviewed as if the product had produced it.
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
  '/v1/fleet/environment': HARNESS_FLEET_ENVIRONMENT,
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
    if (!url.pathname.endsWith('/fs/file')) return harnessJson(HARNESS_FS_LISTINGS[path] ?? { entries: [] });
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

/** A tmux pane the harness owns outright: the terminal tab never polls a daemon here. */
const HARNESS_PANE_SNAPSHOT: PaneSnapshotReader = async () =>
  [
    '$ direnv exec . task test',
    '🧪 Running unit tests with coverage...',
    'bun test v1.3.13 (bf2e2cec)',
    '',
    ' packages/pwa/tests/unit/terminal-snapshot.test.tsx:',
    ' ✓ terminal snapshot view > polls the paired daemon, prints the pane [4.00ms]',
    ' ✓ terminal snapshot view > keeps the last good pane when the daemon goes quiet [3.00ms]',
    '',
    ' 7 pass',
    ' 0 fail',
    '✅ Coverage artifact matches the complete unit production ledger',
    '$ ',
  ].join('\n');

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
  dashboardSession('ms9mira-g7', 'mira', 'Trace protocol compatibility', '/work/protocol', {
    status: 'completed',
    activity: undefined,
    contextPercent: 18,
  }),
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

/** Attention fixture puts all four response shapes beside their distinct action
 * controls. The permission background stays deliberately long so the phone
 * disclosure is exercised without hiding the required action. */
/**
 * The focused action modal, reachable exactly as it is in the shipped session
 * workspace: a counted trigger that opens a `BottomSheet` over the page.
 *
 * It starts CLOSED on purpose. The sheet is a fixed overlay, so an open one
 * would sit on top of every other gallery capture in the same run;
 * `harness/screenshot.ts --attention-only` presses the trigger and takes the
 * whole viewport, which is the frame that actually shows the feature.
 */
function AttentionActionHarness() {
  const [open, setOpen] = useState(false);
  // The shipped page derives this from its layout mode. Reading the viewport
  // once is the harness's equivalent, and it keeps the desktop capture from
  // claiming "on this phone" at 1440px.
  const phone = useMemo(() => globalThis.innerWidth < 768, []);
  const client = useMemo(
    () => ({
      respond: async () => undefined,
      resolve: async () => undefined,
      dismiss: async () => undefined,
    }),
    [],
  );
  return (
    <Card className="overflow-hidden" data-harness="attention-modal">
      <PanelBody>
        <AttentionActionTrigger
          id="harness-attention-trigger"
          controls="harness-attention-sheet"
          count={ATTENTION.count}
          expanded={open}
          onOpen={() => setOpen(true)}
        />
      </PanelBody>
      <AttentionActionModal
        client={client}
        connection={daemon}
        id="harness-attention-sheet"
        onClose={() => setOpen(false)}
        open={open}
        scope={scope}
        snapshot={ATTENTION}
        status="ready"
        swipeEnabled={phone}
        targetId={null}
      />
    </Card>
  );
}

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
      timeToFirstOutputMs: null,
      contextEndPercent: 22,
      stalled: false,
      failed: false,
      migrated: false,
      completed: false,
    },
  ],
};

/** Temporal fixture intentionally has a missing day and an unknown cost so the
 * screenshot makes the chart's honest-gap treatment reviewable. */
const ANALYTICS_TIME = {
  kind: 'aggregate',
  aggregation: 'sum',
  query: 'sum by (day)',
  parsed: { aggregation: 'sum', groupBy: ['day'], matchers: [] },
  scope: { allSessions: true, indexed: 3, matched: 3 },
  index: {
    schemaVersion: 6,
    sessions: 3,
    tokenSessions: 3,
    transcriptSources: 3,
    indexedTranscriptSources: 3,
    pendingTranscriptSources: 0,
    sourceErrors: 0,
    refreshing: false,
  },
  results: [
    {
      labels: { day: '2026-07-29' },
      sessions: 2,
      tokens: { value: 904_320, known: 2, total: 2 },
      inputTokens: { value: 700_100, known: 2, total: 2 },
      outputTokens: { value: 204_220, known: 2, total: 2 },
      cachedInputTokens: { value: 100_000, known: 2, total: 2 },
      cacheWriteInputTokens: { value: 10_000, known: 2, total: 2 },
      equivalentApiCostUsdMicros: { value: 2_450_000, known: 2, total: 2 },
    },
    {
      labels: { day: '2026-07-31' },
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

/** Stable injected requests prevent parent harness renders from restarting either analytics surface. */
const HARNESS_GLOBAL_ANALYTICS_REQUEST: AnalyticsRequest = async (_connection, query) => ({
  ...ANALYTICS_TIME,
  query: query ?? ANALYTICS_TIME.query,
});
const HARNESS_SESSION_ANALYTICS_REQUEST: SessionAnalyticsRequest = async (_connection, _scope, query) => ({
  ...ANALYTICS,
  query: query ?? ANALYTICS.query,
});

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

const SESSIONS_PAGE_FLEET = new DaemonFleetStore({
  list: async () => DASHBOARD_SESSIONS,
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
    mode: 'auto',
    wrapper: 'claude-auto-studio',
    home: '/home/pilot/.ferretry/fleet/homes/claude-auto-studio',
    displayName: 'Studio Claude',
    defaultModel: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: PICKER_ID.atelier,
    kind: 'claude',
    mode: 'auto',
    wrapper: 'claude-auto-atelier',
    home: '/home/pilot/.ferretry/fleet/homes/claude-auto-atelier',
    displayName: 'Atelier Claude',
    defaultModel: 'claude-sonnet-5',
    models: [{ id: 'claude-sonnet-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: PICKER_ID.loge,
    kind: 'claude',
    mode: 'interactive',
    wrapper: 'claude-auto-loge',
    home: '/home/pilot/.ferretry/fleet/homes/claude-auto-loge',
    displayName: 'Loge Claude',
    defaultModel: 'claude-opus-5',
    models: [{ id: 'claude-opus-5', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: PICKER_ID.terra,
    kind: 'codex',
    mode: 'auto',
    wrapper: 'codex-auto-terra',
    home: '/home/pilot/.ferretry/fleet/homes/codex-auto-terra',
    displayName: 'Terra Codex',
    defaultModel: 'gpt-5.6-terra',
    models: [{ id: 'gpt-5.6-terra', available: true }],
    available: true,
    unavailableReason: null,
  },
  {
    id: PICKER_ID.archive,
    kind: 'codex',
    mode: 'auto',
    wrapper: 'codex-auto-archive',
    home: '/home/pilot/.ferretry/fleet/homes/codex-auto-archive',
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

/** What one press of “Check accounts” came back with. Two accounts are absent from it. */
const HARNESS_PICKER_HEALTH: ReadonlyMap<string, PickerAccountHealth> = new Map([
  [
    PICKER_ID.studio,
    {
      accountId: PICKER_ID.studio,
      kind: 'claude' as const,
      state: 'healthy' as const,
      cached: true,
      checkedAt: HARNESS_NOW - 120_000,
      ms: 1_840,
    },
  ],
  [
    PICKER_ID.atelier,
    {
      accountId: PICKER_ID.atelier,
      kind: 'claude' as const,
      state: 'down' as const,
      cached: false,
      checkedAt: HARNESS_NOW - 4_000,
      ms: 30_000,
      failureKind: 'timeout' as const,
      error: 'timed out after 30s waiting for the sentinel reply',
    },
  ],
  [
    PICKER_ID.loge,
    {
      accountId: PICKER_ID.loge,
      kind: 'claude' as const,
      state: 'unknown' as const,
      cached: false,
      checkedAt: HARNESS_NOW - 3_000,
      ms: 210,
      failureKind: 'authentication' as const,
      error: 'this wrapper is not signed in, so liveness could not be established',
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
    accountFieldOptions(accountPickerOptions(slice.catalog?.accounts ?? null, HARNESS_PICKER_USAGE, slice.health)),
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
            placeholder="claude-auto-studio"
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
      label: 'Setup — choose a connection',
      render: () => (
        <section aria-label="Setup connect step" id="harness-onboarding-connect">
          <OnboardingPage
            progress={HARNESS_ONBOARDING.connect}
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
                deviceToken: 'harness-archive-token',
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
      label: 'Warden attention',
      render: () => (
        <WardenAttention
          connection={daemon}
          now={HARNESS_NOW}
          state={{
            status: 'ready',
            view: {
              lastSweepAt: '2026-07-31T11:57:00.000Z',
              items: [
                {
                  id: 'A3',
                  sessionId: 'sess-1',
                  teammate: 'ms-98',
                  sessionStatus: 'awaiting_user',
                  subject: 'Approve this browser pairing request',
                  why: 'The device needs permission before it can read this daemon’s session ledger.',
                  context: 'The pairing link identifies this daemon at runtime; its credential is never bundled.',
                  waitingSince: '2026-07-31T11:30:00.000Z',
                  judgement: { state: 'pending', reportPath: 'warden/2026-07-31T11-58.md' },
                  recommendation: { action: 'nudge', reason: 'Ask the session to report its exact blocker.' },
                },
              ],
            },
          }}
          onOpenSession={() => {}}
          onOpenReport={() => {}}
          onRunAction={() => {}}
        />
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
      render: () => (
        <section
          aria-label="Session screen harness"
          className="grid gap-panel xl:grid-cols-[minmax(17rem,0.8fr)_minmax(0,1.4fr)_minmax(15rem,0.7fr)]"
          id="harness-session-screen"
        >
          <SessionList daemonId={daemon.daemonId} onOpenSession={() => {}} sessions={[harnessSession]} />
          <div className="flex min-h-[320px] flex-col rounded-panel border border-border bg-surface">
            <SessionHeader
              daemonId={daemon.daemonId}
              onBack={() => {}}
              onOpenDetails={() => {}}
              onOpenFleet={() => {}}
              session={harnessSession}
            />
            <Transcript
              busy
              daemonId={daemon.daemonId}
              asOf={LEDGER_AS_OF}
              entries={[
                { id: 'human', kind: 'user', text: 'Please port the session screen.', label: 'You' },
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
              onResend={async () => true}
              sessionId="harness-session"
            />
            <section aria-label="Send ledger rows" className="flex flex-col gap-2">
              <LedgerMessage
                asOf={LEDGER_AS_OF}
                record={{
                  sendId: 'send-queued',
                  acceptedAt: '2026-07-31T10:00:00.000Z',
                  message: 'Please run the full gate before pushing.',
                  attachmentIds: [],
                  fate: 'accepted',
                  path: 'native-inline',
                }}
              />
              <LedgerMessage
                asOf={LEDGER_AS_OF}
                placement="before-loaded"
                onResend={async () => true}
                record={{
                  sendId: 'send-unconfirmed',
                  acceptedAt: '2026-07-31T09:41:00.000Z',
                  message: '[peer message from teammate freddie]\nPARKED until 30m\n\nis CI green on your branch?',
                  attachmentIds: [],
                  fate: 'unaccounted',
                  unaccountedReason: 'timeout',
                }}
              />
              <LedgerMessage
                asOf={LEDGER_AS_OF}
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
              compact={phone}
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
            streamTicket="harness-ticket"
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
      render: () => <GlobalAnalyticsPage connection={daemon} requestAnalytics={HARNESS_GLOBAL_ANALYTICS_REQUEST} />,
    },
    {
      label: 'Session analytics',
      render: () => (
        <Card aria-label="Session analytics" className="min-w-0 overflow-hidden">
          <SessionAnalyticsSurface
            connection={daemon}
            scope={scope}
            requestAnalytics={HARNESS_SESSION_ANALYTICS_REQUEST}
          />
        </Card>
      ),
    },
    {
      label: 'Warden configuration',
      render: () => (
        <WardenConfigCard
          connection={daemon}
          view={WARDEN_CONFIG}
          failover={WARDEN.failover}
          availableAccounts={[{ agent: 'claude-auto-sonnet', model: 'claude-sonnet-4-5' }]}
          onSave={() => {}}
        />
      ),
    },
    {
      label: 'Analytics time series',
      render: () => (
        <Card aria-label="Analytics time series" className="min-w-0 overflow-hidden">
          <PanelHeader>
            <Label>Analytics — time series</Label>
          </PanelHeader>
          <PanelBody className="min-w-0">
            <AnalyticsTimeSeries response={ANALYTICS_TIME} />
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
      label: 'Learning header',
      render: () => (
        <Card aria-label="Learning header">
          <PanelHeader>
            <Label>Learning</Label>
          </PanelHeader>
          <PanelBody>
            <LearningHeader
              busy={false}
              canRun
              failed={false}
              now={HARNESS_NOW}
              onRunNow={() => {}}
              status={{ enabled: true, lastRunAt: '2026-07-31T11:58:00.000Z', pending: { total: 4, strong: 2 } }}
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
            <NotificationSettingsView
              permission="granted"
              enabled
              preferences={{
                events: { attention: true, question: true, failed: true, completed: false },
                interactiveOnly: false,
              }}
              delivery="active"
              devices={[]}
              onEnabled={() => {}}
              onPreferences={() => {}}
              onRevokeDevice={() => {}}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Settings page preview',
      render: () => <SettingsPageHarness />,
    },
    {
      label: 'Fleet inventory preview',
      render: () => (
        <Card id="harness-fleet-inventory" aria-label="Fleet inventory preview">
          <PanelBody>
            <FleetSurface daemonId={daemon.daemonId} state={HARNESS_FLEET} />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Fleet account list',
      render: () => (
        <Card id="harness-fleet-accounts" aria-label="Fleet account list" className="min-w-0 overflow-hidden">
          <PanelBody>
            <FleetLiveRoster
              accounts={HARNESS_FLEET_ACCOUNTS}
              generatedAt="2026-08-05T08:26:00.000Z"
              onEdit={() => {}}
              editable={true}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Fleet create account',
      render: () => (
        <Card id="harness-fleet-create" aria-label="Fleet create account" className="min-w-0 overflow-hidden">
          <PanelBody>
            <div className="kt-panel overflow-hidden">
              <FleetAccountForm
                draft={HARNESS_FLEET_DRAFT}
                onChange={() => {}}
                onSubmit={() => {}}
                onCancel={() => {}}
                problems={[]}
                disabled={false}
                loading={false}
                detection={HARNESS_FLEET_DETECTION}
                instructions={HARNESS_FLEET_INSTRUCTIONS}
                variants={['default', 'auto']}
              />
            </div>
          </PanelBody>
        </Card>
      ),
    },
    {
      /** Every layer concern at once, including an asset the browser could NOT read. */
      label: 'Fleet layer editor',
      render: () => (
        <Card id="harness-fleet-layer" aria-label="Fleet layer editor" className="min-w-0 overflow-hidden">
          <PanelBody>
            <div className="kt-panel overflow-hidden">
              <FleetLayerForm
                wrapper="claude-studio"
                layer={HARNESS_FLEET_LAYER}
                onChange={() => {}}
                onSubmit={() => {}}
                onCancel={() => {}}
                problems={[
                  '"skills/studio/huge.md" could not be read (over the 65536-byte limit for a single file), so staging a change would overwrite text this browser never saw',
                ]}
                disabled={false}
                loading={false}
              />
            </div>
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Fleet plan preview',
      render: () => (
        <Card id="harness-fleet-preview" aria-label="Fleet plan preview" className="min-w-0 overflow-hidden">
          <PanelBody>
            <FleetChangeReview
              proposal={HARNESS_FLEET_PROPOSAL}
              live={HARNESS_FLEET_ACCOUNTS}
              authority={{ kind: 'open' }}
              onApply={() => {}}
              onDiscard={() => {}}
              busy={false}
              refusal={null}
            />
          </PanelBody>
        </Card>
      ),
    },
    {
      /** The fail-closed frame: a host that changed and could not be verified back. */
      label: 'Fleet failed apply',
      render: () => (
        <Card id="harness-fleet-failed-apply" aria-label="Fleet failed apply" className="min-w-0 overflow-hidden">
          <PanelBody>
            <FleetApplyReport outcome={HARNESS_FLEET_FAILURE} />
          </PanelBody>
        </Card>
      ),
    },
    {
      label: 'Remote provider login',
      render: () => <RemoteLoginHarness />,
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
      label: 'Attention action modal',
      render: () => <AttentionActionHarness />,
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
        <LearningReview
          connection={daemon}
          status={LEARNING_STATUS}
          proposals={LEARNING_PROPOSALS}
          error={null}
          busy={false}
          now={HARNESS_NOW}
          onRun={() => {}}
          onAction={() => {}}
        />
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
            streamTicket={null}
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
            streamTicket="harness-ticket"
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
      // A cautious operator's machine: `terminal` switched off entirely, `warden` readable but not
      // configurable, and every other configure axis behind the operator password. Each disabled
      // control carries its own reason — that is the whole unit, in one frame.
      label: 'Capability limits — password set',
      render: () => (
        <div data-harness="grants-locked">
          <GrantsCard
            connection={daemon}
            view={HARNESS_GRANTS_LOCKED}
            nowMs={HARNESS_GRANT_NOW_MS}
            onChange={() => {}}
            onUnlock={() => {}}
            onSetPassword={() => {}}
          />
        </div>
      ),
    },
    {
      // The permissive default, and the sentence that is owed exactly once: nothing is standing
      // behind these configure controls. It is stated where the controls are, not as a modal.
      label: 'Capability limits — nothing behind them',
      render: () => (
        <div data-harness="grants-ungated">
          <GrantsCard
            connection={daemon}
            view={HARNESS_GRANTS_UNGATED}
            nowMs={HARNESS_GRANT_NOW_MS}
            onChange={() => {}}
            onUnlock={() => {}}
            onSetPassword={() => {}}
          />
        </div>
      ),
    },
    {
      // Five wrong passwords. No prompt is offered at all — one here would invite five more guesses
      // at a daemon that has already stopped listening — and the deadline is on screen instead.
      label: 'Capability limits — locked out',
      render: () => (
        <div data-harness="grants-rate-limited">
          <GrantsCard
            connection={daemon}
            view={HARNESS_GRANTS_RATE_LIMITED}
            nowMs={HARNESS_GRANT_NOW_MS}
            unlockFailure={{ message: 'too many wrong operator passwords', retryable: false, attemptsRemaining: 0 }}
            onChange={() => {}}
            onUnlock={() => {}}
            onSetPassword={() => {}}
          />
        </div>
      ),
    },
    {
      // A BROWSER ON THE MACHINE THAT HAS NOT UNLOCKED. The badge says "on this machine — locked", the
      // switches that would widen carry the password as their reason rather than a command to run on a
      // host the reader is already sitting at, and the password control states what it needs before
      // anybody taps it. The way back — a terminal that never asks for the old password — is on screen.
      label: 'Capability limits — local, not yet unlocked',
      render: () => (
        <div data-harness="grants-local-locked">
          <GrantsCard
            connection={daemon}
            view={HARNESS_GRANTS_LOCAL_LOCKED}
            nowMs={HARNESS_GRANT_NOW_MS}
            onChange={() => {}}
            onUnlock={() => {}}
            onSetPassword={() => {}}
          />
        </div>
      ),
    },
    {
      // The same browser one unlock later: ungoverned, full authority, and the password control live —
      // set, replace or remove, with the consequence of removing it beside the button.
      label: 'Capability limits — local, unlocked',
      render: () => (
        <div data-harness="grants-local-unlocked">
          <GrantsCard
            connection={daemon}
            view={HARNESS_GRANTS_LOCAL_UNLOCKED}
            nowMs={HARNESS_GRANT_NOW_MS}
            // The held token as well as the view, because they are separate inputs: `unlocked` is what the
            // DAEMON says and `held` is what this tab actually has. A frame with one and not the other
            // would show a prompt asking for a password the same card claims to be past.
            held={{
              daemonId: daemon.daemonId,
              token: `fy_unlock_${'a'.repeat(22)}`,
              expiresAtMs: HARNESS_GRANT_NOW_MS + 300_000,
            }}
            onChange={() => {}}
            onUnlock={() => {}}
            onSetPassword={() => {}}
          />
        </div>
      ),
    },
    {
      // A daemon that cannot read its own grant document. Denied loudly, and NOT rendered as
      // permissive: damaged state is not empty state, and unknown is never permitted.
      label: 'Capability limits — daemon cannot say',
      render: () => (
        <div data-harness="grants-undetermined">
          <GrantsCard
            connection={daemon}
            view={HARNESS_GRANTS_UNDETERMINED}
            nowMs={HARNESS_GRANT_NOW_MS}
            onChange={() => {}}
            onUnlock={() => {}}
            onSetPassword={() => {}}
          />
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
      // The capability list on a laptop talking straight to the machine: everything open, and open for
      // a REASON a person can act on — "you have this because you are standing here", not "granted".
      // The harness daemon's address is loopback in all three of these frames on purpose: the mark must
      // come from the daemon's account of the carrier, so the address must be unable to move it.
      label: 'Capability list — direct local',
      render: () => (
        <div data-harness="capability-list-local">
          <CapabilityList connection={daemon} capabilities={HARNESS_GRANTS_UNGATED.capabilities} governed={false} />
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
            gate={{ kind: 'open' }}
            invite={null}
            nowMs={HARNESS_PAIR_NOW_MS}
            onSetPassword={() => {}}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
          />
        </div>
      ),
    },
    {
      // THE FRAME THAT MATTERS. Same loopback-looking address, and the daemon said the connection is
      // governed — so this must read "Remote — governed". A screenshot showing "Direct" here would be
      // the inversion #289 exists to prevent, visible.
      label: 'Capability list — governed remote',
      render: () => (
        <div data-harness="capability-list-remote">
          <CapabilityList connection={daemon} capabilities={HARNESS_GRANTS_LOCKED.capabilities} governed />
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
            gate={{ kind: 'open' }}
            invite={HARNESS_INVITE}
            nowMs={HARNESS_PAIR_NOW_MS}
            onSetPassword={() => {}}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
          />
        </div>
      ),
    },
    {
      /**
       * No answer from the daemon. It says so rather than assuming the friendly reading: absence of
       * evidence is not evidence of loopback.
       *
       * THE FIXTURE HAS TO CARRY NO CAPABILITIES TO REACH THIS. The posture is derived from `mayGrant`,
       * so a list of capabilities always determines one — passing the locked fixture here rendered
       * "Remote — governed" under a frame labelled "cannot tell", which is a screenshot that quietly
       * documents the wrong thing. An empty list is the honest way to model a daemon that said nothing,
       * and it is also the real case: `unknown` is what a caller sees when the read produced no
       * capabilities to infer from.
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
            gate={{ kind: 'open' }}
            invite={HARNESS_INVITE}
            nowMs={Date.parse('2026-01-01T00:03:00.000Z')}
            onSetPassword={() => {}}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
          />
        </div>
      ),
    },
    {
      // Nothing but the machine itself can reach this daemon. Said as a fact with the way forward, never
      // as a bare empty list — an empty list reads as "something was removed".
      //
      // AND IT IS THE FIRST-PAIRING FRAME: no password is set, so there is no Add-a-device button yet —
      // the requirement and the control that satisfies it are what stand in its place.
      label: 'Add a device — nothing paired yet',
      render: () => (
        <div data-harness="pair-empty">
          <AddDeviceCard
            connection={daemon}
            view={{ devices: [], hostLocal: true }}
            gate={{ kind: 'needs-password', local: true }}
            invite={null}
            nowMs={HARNESS_PAIR_NOW_MS}
            onSetPassword={() => {}}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
          />
        </div>
      ),
    },
    {
      // The same requirement met by a reader who cannot satisfy it from where they are: an install with
      // devices already paired, no password, and a browser that is not on the machine. It names the two
      // places that can set one instead of offering a button that would be refused.
      label: 'Add a device — password needed, away from the machine',
      render: () => (
        <div data-harness="pair-needs-password-remote">
          <AddDeviceCard
            connection={daemon}
            // `hostLocal: false` deliberately: this reader is AWAY from the machine, and a frame whose
            // badge said "you are at this machine" beside "only the machine itself can set one" would be a
            // committed screenshot of two contradictory claims.
            view={{ ...HARNESS_PAIRED_DEVICES, hostLocal: false }}
            gate={{ kind: 'needs-password', local: false }}
            invite={null}
            nowMs={HARNESS_PAIR_NOW_MS}
            onSetPassword={() => {}}
            onMint={() => {}}
            onDiscardInvite={() => {}}
            onRevokeCode={() => {}}
            onRevokeDevice={() => {}}
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
const WORKSPACE_DRAFT = [
  'Two things before you push:',
  '',
  '- the `--app-h` fallback ladder has to stay `100vh -> 100dvh -> var(--app-h)`',
  '- `packages/pwa/src/shell/side-pane.tsx` still announces `Opened <tab>` without',
  '  the "beside the conversation" half',
].join('\n');
new DaemonDraftStore().save(WORKSPACE_SCOPE, WORKSPACE_DRAFT, HARNESS_NOW);

const WORKSPACE_SESSION = {
  config: {
    id: 'harness-workspace',
    name: 'Assemble the session workspace',
    teammate: 'mylie',
    label: 'Assemble the session workspace',
    model: 'claude-opus-5',
    modelHint: 'opus-5',
    agent: 'claude',
    harness: 'claude',
    mode: 'auto',
    cwd: '/work/ferretry',
    updatedAt: '2026-07-31T10:00:00.000Z',
  },
  state: {
    id: 'harness-workspace',
    status: 'running',
    turn: 12,
    lastActivityAt: '2026-07-31T10:00:00.000Z',
    contextPercent: 61,
    quota: { fiveHourPercent: 23, weeklyPercent: 41 },
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
 * rather than behind it. Every row kind the port renders appears once: prose,
 * a collapsed tool group with a failure in it, a notice, a durable ledger row,
 * and a tool still running.
 */
const WORKSPACE_ENTRIES: readonly TranscriptEntry[] = [
  {
    id: 'workspace-user-1',
    kind: 'user',
    text: 'Assemble the session workspace: header, transcript, composer and the side pane, on one page.',
    label: 'You',
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
  send: async () => ({ ...WORKSPACE_SESSION, disposition: 'queued' }) as never,
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
function SessionWorkspaceHarness() {
  useAppViewport();
  const presentation = useLayoutMode() === 'drawer' ? 'sheet' : 'pane';
  const [session, setSession] = useState(WORKSPACE_SESSION);
  return (
    <div className="kt-shell flex flex-col overflow-hidden" id="harness-session-workspace-page">
      <AppBar
        crumbs={[{ href: daemonSessionsPath(daemon.daemonId), label: 'Sessions' }, { label: 'harness-workspace' }]}
        daemon={daemon.daemonId}
        onOpenPalette={() => {}}
        onOpenSidebar={() => {}}
        sessionCount={7}
        connectionStatus="open"
        themeToggle={<Button size="sm">Theme</Button>}
        currentSessionSearch={<SessionSearchControl shortcutTarget />}
      />
      <div className="relative min-h-0 min-w-0 flex-1 px-1 sm:px-3">
        <SessionChatPage
          chatWidth="readable"
          client={WORKSPACE_CLIENT}
          connection={daemon}
          entries={WORKSPACE_ENTRIES}
          onBack={() => {}}
          onSessionChange={setSession}
          presentation={presentation}
          readSnapshot={HARNESS_PANE_SNAPSHOT}
          session={session}
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
              streamTicket="harness-ticket"
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

/**
 * The five fleet frames on a page of their own.
 *
 * They are in the gallery too, but three of them are taller than a desktop viewport, and an element
 * capture of a tall card inside the gallery's scroller clips to the wrong region. Starting at the real
 * top of a page with no sticky chrome is what makes the captures trustworthy.
 */
type HarnessFleetFrame =
  | 'accounts'
  | 'preview'
  | 'preview-confirm'
  | 'failed-apply'
  | 'create'
  | 'layer'
  | 'cockpit'
  | 'cockpit-staged'
  | 'states';

/**
 * The COCKPIT itself, driven by a stub daemon rather than by fixtures handed to a leaf.
 *
 * The five frames below exercise the components; this is the screen a person actually opens — the
 * header with the daemon id, the host-state verdict and the authority badge, the live-beside-proposed
 * grid, and the declared limits. Nothing here reaches a network: the client answers from constants and
 * every request stays inside this page.
 */
function fleetCockpitClient(answers: Readonly<Record<string, unknown>>) {
  return {
    request: async <T,>(path: string, schema: { parse: (value: unknown) => T }): Promise<T> => {
      const tail = path.slice('/v1/fleet'.length);
      const answer = answers[tail];
      if (answer === undefined) throw new FyHttpError(`this harness serves no ${tail}`, 409, 'fleet_not_applied');
      if (answer instanceof FyHttpError) throw answer;
      return schema.parse(answer);
    },
  };
}

const HARNESS_FLEET_COCKPIT_ANSWERS: Readonly<Record<string, unknown>> = {
  /**
   * The OWNER'S OWN CASE: a browser this daemon does not govern, which is every loopback caller and
   * every local one that has unlocked. One Apply, nothing else in the way.
   *
   * It used to be `mayApplyWithApproval` with a command for minting codes, so every fleet capture in
   * this gallery showed the two stacked gates this frame now exists to prove are gone.
   */
  '/permissions': {
    mayInspect: true,
    mayPropose: true,
    mayApply: true,
    applyRefusal: 'ungated',
    confirmation: 'none',
  },
  '/accounts': { version: 1, generatedAt: '2026-08-05T08:26:00.000Z', accounts: HARNESS_FLEET_ACCOUNTS },
  '/config': { variants: { default: {}, auto: {} }, agents: [] },
  // Every compose flow lists the asset tree, because a path the person types has to be judged against
  // what is already there. A daemon that cannot answer this is a daemon whose tree is unknown, and the
  // surface then refuses to stage anything — so a harness without this route would capture a blocked
  // screen rather than the change manifest these frames exist to show.
  '/assets': { files: [], complete: true },
};

/** The four states a host can be in that are NOT a published fleet. Each one is its own sentence. */
const HARNESS_FLEET_STAGED_ANSWERS: Readonly<Record<string, unknown>> = {
  ...HARNESS_FLEET_COCKPIT_ANSWERS,
  '/config': {
    variants: { default: {}, auto: {} },
    agents: [
      {
        name: 'studio',
        kind: 'claude',
        routes: { default: { id: HARNESS_FLEET_ACCOUNTS[0]?.id, wrapper: 'claude-studio' } },
      },
    ],
  },
  '/proposals': HARNESS_FLEET_PROPOSAL,
};

const HARNESS_FLEET_STATE_ANSWERS: readonly {
  readonly label: string;
  readonly answers: Readonly<Record<string, unknown>>;
}[] = [
  {
    label: 'uninitialized',
    answers: {
      '/permissions': HARNESS_FLEET_COCKPIT_ANSWERS['/permissions'],
      '/accounts': new FyHttpError(
        'no published fleet manifest at /home/pilot/.ferretry/fleet/manifest.json',
        409,
        'fleet_not_applied',
      ),
      '/config': new FyHttpError(
        'no fleet config at /home/pilot/.ferretry/fleet/config.yaml; write the declared config before applying the fleet',
        409,
        'fleet_config_missing',
      ),
    },
  },
  {
    label: 'not-applied',
    answers: {
      '/permissions': HARNESS_FLEET_COCKPIT_ANSWERS['/permissions'],
      '/accounts': new FyHttpError('no published fleet manifest', 409, 'fleet_not_applied'),
      '/config': HARNESS_FLEET_COCKPIT_ANSWERS['/config'],
    },
  },
  {
    label: 'damaged',
    answers: {
      '/permissions': HARNESS_FLEET_COCKPIT_ANSWERS['/permissions'],
      '/accounts': new FyHttpError(
        'fleet manifest at /home/pilot/.ferretry/fleet/manifest.json is unreadable or invalid',
        409,
        'fleet_manifest_invalid',
      ),
      '/config': HARNESS_FLEET_COCKPIT_ANSWERS['/config'],
    },
  },
  {
    label: 'forbidden',
    answers: {
      '/permissions': new FyHttpError('a paired device may inspect the fleet but may not apply it', 403, 'forbidden'),
      '/accounts': new FyHttpError('a paired device may inspect the fleet but may not apply it', 403, 'forbidden'),
      '/config': new FyHttpError('a paired device may inspect the fleet but may not apply it', 403, 'forbidden'),
    },
  },
  /**
   * THE OWNER'S COMPLAINT, as the panel answers it now: a published fleet whose apply is `locked`.
   *
   * The old panel showed a red refusal with no way out of it AND a terminal command underneath. This
   * frame is here so that the absence of both is a thing somebody can look at, and so the state is
   * captured beside the four read failures rather than only described in a report.
   */
  {
    label: 'locked',
    answers: {
      '/permissions': {
        mayInspect: true,
        mayPropose: true,
        mayApply: false,
        applyRefusal: 'locked',
        confirmation: 'operator-password',
      },
      '/accounts': HARNESS_FLEET_COCKPIT_ANSWERS['/accounts'],
      '/config': HARNESS_FLEET_COCKPIT_ANSWERS['/config'],
      '/assets': HARNESS_FLEET_COCKPIT_ANSWERS['/assets'],
    },
  },
];

function FleetCockpitHarness({ frame }: { readonly frame: HarnessFleetFrame }) {
  return (
    /* NOT `kt-content`: that is the app shell's inner scroller, and a frame taller than the screen
       would be clipped by it rather than growing the document a full-page capture measures. */
    <div className="mx-auto w-full max-w-[1400px] space-y-panel self-start p-panel" id="harness-fleet-cockpit">
      {frame !== 'accounts' ? null : (
        <section aria-label="Fleet account list" id="harness-fleet-accounts-page">
          <FleetLiveRoster
            accounts={HARNESS_FLEET_ACCOUNTS}
            generatedAt="2026-08-05T08:26:00.000Z"
            onEdit={() => {}}
            editable={true}
          />
        </section>
      )}
      {frame !== 'preview' ? null : (
        <section aria-label="Fleet plan preview" id="harness-fleet-preview-page">
          {/* `open` — the change manifest and ONE Apply, which is what the panel is for. The
              per-change confirmation has its own frame below, because the two look different and both
              are worth capturing. */}
          <FleetChangeReview
            proposal={HARNESS_FLEET_PROPOSAL}
            live={HARNESS_FLEET_ACCOUNTS}
            authority={{ kind: 'open' }}
            onApply={() => {}}
            onDiscard={() => {}}
            busy={false}
            refusal={null}
          />
        </section>
      )}
      {frame !== 'preview-confirm' ? null : (
        <section aria-label="Fleet plan preview, confirmation required" id="harness-fleet-preview-confirm-page">
          {/* `confirm` — a governed caller on a machine with an operator password, which is the one
              state where applying still asks for something. ONE field, the shared unlock limit note, and
              no second gate: the field is what proves the password AND what confirms this exact diff. */}
          <FleetChangeReview
            proposal={HARNESS_FLEET_PROPOSAL}
            live={HARNESS_FLEET_ACCOUNTS}
            authority={{ kind: 'confirm' }}
            onApply={() => {}}
            onDiscard={() => {}}
            busy={false}
            refusal={null}
          />
        </section>
      )}
      {frame !== 'failed-apply' ? null : (
        <section aria-label="Fleet failed apply" id="harness-fleet-failed-apply-page">
          <FleetApplyReport outcome={HARNESS_FLEET_FAILURE} />
        </section>
      )}
      {frame !== 'create' ? null : (
        <section aria-label="Fleet create account" className="kt-panel overflow-hidden" id="harness-fleet-create-page">
          <FleetAccountForm
            draft={HARNESS_FLEET_DRAFT}
            onChange={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            problems={[]}
            disabled={false}
            loading={false}
            detection={HARNESS_FLEET_DETECTION}
            instructions={HARNESS_FLEET_INSTRUCTIONS}
            variants={['default', 'auto']}
          />
        </section>
      )}
      {frame !== 'layer' ? null : (
        <section aria-label="Fleet layer editor" className="kt-panel overflow-hidden" id="harness-fleet-layer-page">
          <FleetLayerForm
            wrapper="claude-studio"
            layer={HARNESS_FLEET_LAYER}
            onChange={() => {}}
            onSubmit={() => {}}
            onCancel={() => {}}
            problems={[
              '"skills/studio/huge.md" could not be read (over the 65536-byte limit for a single file), so staging a change would overwrite text this browser never saw',
            ]}
            disabled={false}
            loading={false}
          />
        </section>
      )}
      {frame !== 'cockpit' ? null : (
        <section aria-label="Fleet cockpit" id="harness-fleet-cockpit-page">
          <FleetConfigurationSurface
            connection={daemon}
            createClient={async () => fleetCockpitClient(HARNESS_FLEET_COCKPIT_ANSWERS)}
          />
        </section>
      )}
      {frame !== 'cockpit-staged' ? null : (
        <section aria-label="Fleet cockpit, change staged" id="harness-fleet-cockpit-staged-page">
          <FleetConfigurationSurface
            connection={daemon}
            createClient={async () => fleetCockpitClient(HARNESS_FLEET_STAGED_ANSWERS)}
          />
        </section>
      )}
      {frame !== 'states' ? null : (
        <section aria-label="Fleet host states" className="space-y-panel" id="harness-fleet-states-page">
          {HARNESS_FLEET_STATE_ANSWERS.map(state => (
            <FleetConfigurationSurface
              key={state.label}
              connection={daemon}
              createClient={async () => fleetCockpitClient(state.answers)}
            />
          ))}
        </section>
      )}
    </div>
  );
}

/** Hash fragments that replace the whole gallery with one setup screen. */
const ONBOARDING_FRAGMENTS: Readonly<Record<string, HarnessOnboardingScreen>> = {
  '#onboarding-install': 'install',
  '#onboarding-keyboard': 'scan',
};

/**
 * One fleet frame per page, because three of them are taller than a desktop viewport and a tall
 * element capture inside a scroller clips to the wrong region — the first pass produced a fleet
 * "preview" image showing the secrets cards.
 */
const FLEET_FRAGMENTS: Readonly<Record<string, HarnessFleetFrame>> = {
  '#fleet-accounts': 'accounts',
  '#fleet-preview': 'preview',
  '#fleet-preview-confirm': 'preview-confirm',
  '#fleet-failed-apply': 'failed-apply',
  '#fleet-create': 'create',
  '#fleet-layer': 'layer',
  '#fleet-cockpit': 'cockpit',
  '#fleet-cockpit-staged': 'cockpit-staged',
  '#fleet-states': 'states',
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

const host = document.getElementById('root');
if (host) {
  const screen = ONBOARDING_FRAGMENTS[window.location.hash];
  const fleetFrame = FLEET_FRAGMENTS[window.location.hash];
  const pickerFrame = PICKER_FRAGMENTS[window.location.hash];
  const projectsFrame = PROJECTS_FRAGMENTS[window.location.hash];
  const settingsHarness = new URLSearchParams(window.location.search).has('settings-harness');
  createRoot(host).render(
    <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
      {settingsHarness ? (
        <StandaloneSettingsPageHarness />
      ) : window.location.hash === '#session-workspace' ? (
        <SessionWorkspaceHarness />
      ) : window.location.hash === '#session-search' ? (
        <SessionSearchHarness />
      ) : window.location.hash === '#browser-full-viewport' ? (
        <BrowserFullViewportHarness />
      ) : fleetFrame !== undefined ? (
        <FleetCockpitHarness frame={fleetFrame} />
      ) : pickerFrame !== undefined ? (
        <PickerFrameHarness frame={pickerFrame} />
      ) : projectsFrame !== undefined ? (
        <ProjectsFrameHarness frame={projectsFrame} />
      ) : screen === undefined ? (
        <Shell />
      ) : (
        <OnboardingStageHarness screen={screen} />
      )}
    </SessionSearchProvider>,
  );
}
