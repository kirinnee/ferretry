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
  ProposalView,
  SessionView,
  TaskLive,
  TaskStatus,
  TaskSummary,
  WardenConfigView,
  WardenStatusView,
} from '@ferretry/protocol';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AttachmentUnlockPrompt } from '../src/components/attachment-unlock-prompt.tsx';
import { Composer } from '../src/components/composer.tsx';
import { QuestionForm } from '../src/components/question-form.tsx';
import { SessionCommandControls } from '../src/components/session-command-controls.tsx';
import { SessionDetails } from '../src/components/session-details.tsx';
import { SessionHeader } from '../src/components/session-header.tsx';
import { SessionList } from '../src/components/session-list.tsx';
import { SessionTaskKanban } from '../src/components/session-tasks.tsx';
import { Transcript } from '../src/components/transcript.tsx';
import { AnalyticsResponseView } from '../src/features/analytics/analytics-response-view.tsx';
import type { AnalyticsAggregateResponse } from '../src/features/analytics/analytics-result-table.tsx';
import { AnalyticsResultTable } from '../src/features/analytics/analytics-result-table.tsx';
import { AnalyticsTimeSeries } from '../src/features/analytics/analytics-time-series.tsx';
import { BrowserLoginBanner, type BrowserLoginView } from '../src/features/browser/browser-login-banner.tsx';
import { AttentionBoard } from '../src/features/attention/attention-board.tsx';
import {
  RemoteBrowserControls,
  RemoteBrowserGovernor,
  RemoteBrowserNavigation,
  RemoteBrowserPageTabs,
  RemoteBrowserStatusBar,
} from '../src/features/browser/remote-browser-chrome.tsx';
import { type RemoteBrowserSocket, RemoteBrowserViewer } from '../src/features/browser/remote-browser-viewer.tsx';
import { LearningHeader } from '../src/features/learning/learning-header.tsx';
import { LearningReview } from '../src/features/learning/learning-page.tsx';
import { PinsTrigger } from '../src/features/pins/pins-trigger.tsx';
import { MarkdownComposerSettings } from '../src/features/settings/markdown-composer-settings.tsx';
import { NotificationSettingsView } from '../src/features/settings/notification-settings.tsx';
import { filterTaskDag, taskDag } from '../src/features/tasks/task-dag.ts';
import { TaskDagGraph } from '../src/features/tasks/task-dag-graph.tsx';
import { taskStatusCounts, toggleTaskStatusFilter } from '../src/features/tasks/task-presentation.ts';
import { TaskQuickSummary, TaskRow } from '../src/features/tasks/task-row.tsx';
import { TaskStatusFilter } from '../src/features/tasks/task-status-filter.tsx';
import { WardenConfigCard } from '../src/features/warden/warden-config-card.tsx';
import { WardenStrip } from '../src/features/warden/warden-strip.tsx';
import { WardenVerdicts } from '../src/features/warden/warden-verdicts.tsx';
import { DETAILS_TAB_ORDER, type DetailsTab } from '../src/hooks/use-details-tab.ts';
import { daemonConnection } from '../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../src/lib/daemon-scope.ts';
import { SIDE_PANE_DEFAULT_WIDTH } from '../src/lib/side-pane-preferences.ts';
import { AppBar } from '../src/shell/app-bar.tsx';
import { BottomSheet } from '../src/shell/bottom-sheet.tsx';
import { type ChatWidth, ChatWidthControl } from '../src/shell/chat-width-control.tsx';
import { ChunkErrorBoundary } from '../src/shell/chunk-error-boundary.tsx';
import { ContextMenu } from '../src/shell/context-menu.tsx';
import { MarkerLine, MarkerSeparator } from '../src/shell/marker.tsx';
import { ModeBadge } from '../src/shell/mode-badge.tsx';
import { ActionGroup, Badge, Button, Card, Label, PanelBody, PanelHeader, Textarea } from '../src/shell/primitives.tsx';
import { type Quota, QuotaReadout } from '../src/shell/quota-readout.tsx';
import { RcBadge } from '../src/shell/rc-badge.tsx';
import { SheetTabs } from '../src/shell/sheet-tabs.tsx';
import { SidePaneResizeHandle } from '../src/shell/side-pane-resize-handle.tsx';
import { SidePaneSearch } from '../src/shell/side-pane-search.tsx';
import {
  getSidePaneTabDefinitions,
  openSidePaneFileTab,
  openSidePaneTab,
  readSidePaneTabsState,
  resolveSidePaneTab,
  type SidePaneTabDefinition,
} from '../src/shell/side-pane-tab-model.ts';
import { SidePaneTabs } from '../src/shell/side-pane-tabs.tsx';
import { CommandPalette } from '../src/shell/command-palette.tsx';
import { paletteSessionEntries } from '../src/shell/palette-model.ts';
import { StatusMark } from '../src/shell/status-mark.tsx';
import { ViewTabs } from '../src/shell/view-tabs.tsx';

const daemon = daemonConnection({
  daemonId: 'harness-daemon',
  baseUrl: 'https://daemon.invalid/',
  deviceToken: 'harness-token',
});
const scope = daemonSessionScope(daemon, 'harness-session');

const harnessSession = {
  config: {
    id: 'harness-session',
    name: 'Transcript scrolling',
    teammate: 'Fable',
    label: 'Port the session screen',
    model: 'gpt-5.6-sol',
    modelHint: 'gpt-5.6',
    agent: 'codex',
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

openSidePaneTab(scope, 'pins');
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

const WARDEN_CONFIG: WardenConfigView = {
  config: WARDEN.config,
  accounts: WARDEN.config.accounts,
  warnings: ['Account order takes effect on the next sweep.'],
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

/** Attention fixture exercises a type-specific action and a deliberately long
 * background, so both the rail treatment and the phone disclosure are visible. */
const ATTENTION: AttentionSnapshot = {
  v: 1,
  sessionId: 'harness-session',
  count: 1,
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
  ],
  resolved: [],
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

/** A daemon response fixture: the unpriced row is deliberate and must stay
 * visible rather than being treated as a zero-cost result. */
const ANALYTICS = {
  kind: 'aggregate',
  aggregation: 'sum',
  query: 'sum by (model)',
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
      frame.set([0x4b, 0x42, 0x52, 0x46, 1, 0, id.length]);
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
function Shell() {
  const [version, bump] = useState(0);
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [statuses, setStatuses] = useState<ReadonlySet<TaskStatus> | null>(null);
  const [detailsTab, setDetailsTab] = useState<DetailsTab>('identity');
  const [paneWidth, setPaneWidth] = useState(SIDE_PANE_DEFAULT_WIDTH);
  const [paneQuery, setPaneQuery] = useState('');
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const state = readSidePaneTabsState(scope);
  const phone = viewport.width <= PHONE_MAX;
  const menuOpen = window.location.hash === '#menu';
  const paletteOpen = window.location.hash === '#palette';
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
              entries={[
                { id: 'human', kind: 'user', text: 'Please port the session screen.', label: 'You' },
                { id: 'assistant', kind: 'assistant', text: 'I am adding rendered component tests.', label: 'Codex' },
                { id: 'notice', kind: 'notice', text: 'Drafts remain scoped to this paired daemon.' },
              ]}
              sessionId="harness-session"
            />
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
        <Card className="flex min-h-0 flex-col overflow-hidden">
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
            <WardenStrip status={WARDEN} now={HARNESS_NOW} />
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
          <RemoteBrowserStatusBar status={REMOTE_BROWSER} connection="connected" />
          <RemoteBrowserPageTabs status={REMOTE_BROWSER} onAction={() => {}} />
          <RemoteBrowserNavigation status={REMOTE_BROWSER} onAction={() => {}} />
          <RemoteBrowserControls
            status={REMOTE_BROWSER}
            connection="connected"
            fit
            viewportMode="responsive"
            onAction={() => {}}
            onToggleFit={() => {}}
            onToggleViewportMode={() => {}}
            onPasteFromClipboard={() => {}}
          />
          <RemoteBrowserViewer
            daemon={daemon}
            scope={scope}
            status={REMOTE_BROWSER}
            streamTicket="harness-ticket"
            interactive
            socketFactory={() => new HarnessBrowserSocket()}
            createObjectUrl={() => harnessFrame}
            revokeObjectUrl={() => undefined}
          />
          <RemoteBrowserGovernor status={REMOTE_BROWSER} />
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
        // Desktop only, and deliberately: at 390 the chip and the destination
        // selector together squeeze the centred palette entry out of the bar.
        // That is the original's own layout, inherited rather than introduced —
        // showing the chip here would only hide the palette in every phone
        // screenshot. The chip is exercised at desktop width and in unit tests.
        updateReady={phone ? null : 'update'}
        active="warden"
        themeToggle={<Button size="sm">Theme</Button>}
      />

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

        <BottomSheet
          id="harness-sheet"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          ariaLabel="Harness sheet"
          closeLabel="Close the sheet"
        >
          <div className="p-panel text-ui">The shared modal shell, swipe handle and all.</div>
        </BottomSheet>
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

const host = document.getElementById('root');
if (host) createRoot(host).render(<Shell />);
