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
  LearningStatus,
  PinSnapshot,
  ProposalView,
  SecretList,
  SessionView,
  TaskLive,
  TaskStatus,
  TaskSummary,
  TerminalListView,
  WardenConfigView,
  WardenStatusView,
} from '@ferretry/protocol';
import { SECRET_SCHEMA_VERSION } from '@ferretry/protocol';
import { chooseConnection } from '@ferretry/relay';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  type AttachmentBlobLoader,
  AttachmentGalleryProvider,
  TranscriptAttachmentGallery,
} from '../src/components/attachment-gallery.tsx';
import { AttachmentUnlockPrompt } from '../src/components/attachment-unlock-prompt.tsx';
import { Composer } from '../src/components/composer.tsx';
import { DictationControl } from '../src/components/dictation-control.tsx';
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
import { SessionTaskKanban } from '../src/components/session-tasks.tsx';
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
import { SecretsCard } from '../src/features/secrets/secrets-card.tsx';
import { SecretsSurface } from '../src/features/secrets/secrets-surface.tsx';
import { SessionSearchControl, SessionSearchProvider } from '../src/features/session-search/session-search.tsx';
import { DictationSettings } from '../src/features/settings/dictation-settings.tsx';
import { DEFAULT_DICTATION_SHORTCUT } from '../src/features/settings/dictation-shortcut.ts';
import { DictationShortcutPicker } from '../src/features/settings/dictation-shortcut-picker.tsx';
import { MarkdownComposerSettings } from '../src/features/settings/markdown-composer-settings.tsx';
import { NotificationSettingsView } from '../src/features/settings/notification-settings.tsx';
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
import type { DaemonConnectionRecord } from '../src/lib/connections.ts';
import { type ControlsStorage, DaemonControlsStore } from '../src/lib/controls.ts';
import { type DaemonConnection, daemonConnection } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';
import { DaemonDraftStore } from '../src/lib/drafts.ts';
import type { SessionGroup } from '../src/lib/fleet-grouping.ts';
import { type DaemonFleetPort, DaemonFleetStore } from '../src/lib/fleet-store.ts';
import { buildLineage } from '../src/lib/lineage.ts';
import { writeMdComposePref } from '../src/lib/md-compose.ts';
import { daemonSessionsPath } from '../src/lib/pages/routes.ts';
import { type SessionChatClient, SessionChatPage } from '../src/lib/pages/session-chat-page.tsx';
import type { QrScanHost } from '../src/lib/pair-scan.ts';
import type { PairingArrival } from '../src/lib/pairing.ts';
import { type DaemonProjectsPort, DaemonProjectsStore } from '../src/lib/projects-store.ts';
import type { TranscriptEntry } from '../src/lib/session-screens.ts';
import { SIDE_PANE_DEFAULT_WIDTH } from '../src/lib/side-pane-preferences.ts';
import type { CaptureHost } from '../src/lib/stt/audio-capture.ts';
import type { FetchLike } from '../src/lib/stt/daemon-engine.ts';
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
import { CommandPalette } from '../src/shell/command-palette.tsx';
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
 * The dictation fixtures. The harness never reaches the network, so the daemon's
 * speech status is answered here and the capture host is a silent stand-in: the
 * point of these cards is what the strip and the settings surface LOOK like, at
 * both widths, not whether a microphone exists in headless Chrome.
 */
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
 * A microphone that is asked for and never answers. Headless Chrome has no
 * device, and the point of the mic-button card is the button's two layouts, not
 * a capture: the panel's own card covers what recording looks like.
 */
const harnessCaptureHost: CaptureHost = {
  openMicrophone: () => new Promise(() => undefined),
  buildGraph: () => new Promise(() => undefined),
  watchHidden: () => () => undefined,
};

const harnessSttFetch: FetchLike = async url =>
  url.includes('/v1/stt/status')
    ? new Response(
        JSON.stringify({
          available: true,
          streaming: false,
          worker: { phase: 'ready', modelId: 'parakeet-tdt-0.6b' },
          languages: ['en'],
          models: {
            daemon: {
              id: 'parakeet-tdt-0.6b',
              kind: 'daemon',
              label: 'Parakeet TDT 0.6B',
              state: 'ready',
              languages: ['en'],
              costs: {
                downloadBytes: 652_000_000,
                diskBytes: 652_000_000,
                ramBytesApprox: 1_100_000_000,
                summary: 'Parakeet TDT 0.6B — 652 MB on disk, about 1.1 GB of RAM while transcribing.',
              },
              install: { phase: 'ready', receivedBytes: 652_000_000, totalBytes: 652_000_000 },
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    : new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });

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
  const activeConnection = connections.find(connection => connection.daemonId === activeDaemonId) ?? daemon;

  const page = (
    <SettingsPage
      daemonId={activeDaemonId}
      connections={connections}
      controls={settingsControls}
      dictation={{
        daemon: activeConnection,
        settings,
        update: patch => setSettings(current => ({ ...current, ...patch })),
        persisted: true,
        fetchImpl: harnessSttFetch,
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
      carrier={HARNESS_RELAYED_CARRIER}
      relayAdvertised
      readWardenStatus={async connection => {
        if (connection.daemonId === unreachableDaemon.daemonId) throw new Error('offline harness daemon');
        return WARDEN;
      }}
      createWardenClient={HARNESS_WARDEN_CLIENT}
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

/** A local family keeps the Tree card readable at both required widths. */
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
      name: 'Render the Lineage tree',
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
  title: 'Port the remaining PWA feature components',
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
const HARNESS_FS_LISTINGS: Readonly<Record<string, unknown>> = {
  '': {
    entries: [
      { name: 'docs', type: 'dir' },
      { name: 'packages', type: 'dir' },
      { name: 'node_modules', type: 'dir', ignored: true },
      { name: 'CLAUDE.md', type: 'file', size: 4_812 },
      { name: 'Taskfile.yaml', type: 'file', size: 9_233 },
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
};

const harnessFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input), window.location.href);
  if (url.hostname !== 'daemon.invalid' || !url.pathname.includes('/fs')) return await harnessFetch(input, init);
  const body = url.pathname.endsWith('/fs/changes')
    ? HARNESS_FS_CHANGES
    : url.pathname.endsWith('/fs/file')
      ? (HARNESS_FS_FILES[url.searchParams.get('path') ?? ''] ?? { path: url.searchParams.get('path') ?? '' })
      : (HARNESS_FS_LISTINGS[url.searchParams.get('path') ?? ''] ?? { entries: [] });
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
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
  streamUrl: async () => 'wss://harness.invalid/stream',
  openSocket: () => ({ binaryType: 'arraybuffer', addEventListener() {}, close() {}, send() {} }) as never,
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

const PALETTE_SETTINGS = [
  { id: 'setting-density', label: 'Density', description: 'How tightly rows pack', settingId: 'density' },
  { id: 'setting-theme', label: 'Theme', description: 'Pick a colour family and mode', settingId: 'theme' },
];

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
      label: 'Lineage tree',
      render: () => (
        <section aria-label="Lineage tree preview" className="min-h-[360px]" id="harness-lineage">
          <Card className="h-full overflow-hidden">
            <LineageSurfaceContent daemonId={daemon.daemonId} sessionId="harness-session" sessions={LINEAGE_SESSIONS} />
          </Card>
        </section>
      ),
    },
    {
      label: 'Session task board',
      render: () => (
        <SessionTaskKanban
          compact={phone}
          daemonId={daemon.daemonId}
          onOpen={() => {}}
          tasks={[
            { ...TASKS[0]!, phase: 'build', status: 'in_progress' },
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
            <MarkdownComposerSettings />
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
                  captureHost={harnessCaptureHost}
                  layout={layout}
                />
              </div>
            ))}
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
              daemon={daemon}
              settings={sttSettings}
              update={patch => setSttSettings(current => ({ ...current, ...patch }))}
              persisted
              fetchImpl={harnessSttFetch}
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
        <Card aria-label="File tab body" className="min-w-0 overflow-hidden" id="harness-file-instance">
          <div className="flex h-[26rem] flex-col" data-harness="file-instance-surface">
            <FileInstanceSurface
              daemon={daemon}
              scope={scope}
              instance={{
                id: 'file:CLAUDE.md',
                kind: 'file',
                key: 'CLAUDE.md',
                label: 'CLAUDE.md',
                title: 'CLAUDE.md',
                order: 1,
                revision: 1,
              }}
            />
          </div>
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
        currentSessionSearch={<SessionSearchControl />}
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

/** Hash fragments that replace the whole gallery with one setup screen. */
const ONBOARDING_FRAGMENTS: Readonly<Record<string, HarnessOnboardingScreen>> = {
  '#onboarding-install': 'install',
  '#onboarding-keyboard': 'scan',
};

const host = document.getElementById('root');
if (host) {
  const screen = ONBOARDING_FRAGMENTS[window.location.hash];
  const settingsHarness = new URLSearchParams(window.location.search).has('settings-harness');
  createRoot(host).render(
    <SessionSearchProvider connection={daemon} focusSignal={0} scope={scope}>
      {settingsHarness ? (
        <StandaloneSettingsPageHarness />
      ) : window.location.hash === '#session-workspace' ? (
        <SessionWorkspaceHarness />
      ) : window.location.hash === '#browser-full-viewport' ? (
        <BrowserFullViewportHarness />
      ) : screen === undefined ? (
        <Shell />
      ) : (
        <OnboardingStageHarness screen={screen} />
      )}
    </SessionSearchProvider>,
  );
}
