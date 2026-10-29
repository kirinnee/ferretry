import type { AttentionId, AttentionSnapshot, IFyApiClient, SessionView } from '@ferretry/protocol';
import { WorktreeListResponseSchema } from '@ferretry/protocol';
import { Pause, Play } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { CacheUpdating } from '../../components/cache-updating.tsx';
import { CompactionChip } from '../../components/compaction-card.tsx';
import { Composer } from '../../components/composer.tsx';
import type { ComposerSuggestionSwitches } from '../../components/composer-autocomplete.ts';
import { FastToggle } from '../../components/composer-fast.tsx';
import { ComposerRuntime } from '../../components/composer-runtime.tsx';
import { FilesTab } from '../../components/files-tab.tsx';
import { HandoffSourceProvider } from '../../components/handoff-message.tsx';
import type { SendCancel, SendRetry, SendSubmit } from '../../components/ledger-message.tsx';
import { type PaneFrameReader, usePaneActivity } from '../../components/live-activity.tsx';
import { LiveStreamIndicator, type LiveStreamIndicatorProps } from '../../components/live-stream-indicator.tsx';
import { MigrateSheet } from '../../components/migrate-sheet.tsx';
import { PackSessionsProvider } from '../../components/pack-call.tsx';
import { type QuestionAnswerApi, QuestionForm } from '../../components/question-form.tsx';
import { ReferenceSurfaceProvider, sessionReferenceSurface } from '../../components/reference-surface.tsx';
import {
  isPromptKnownBusy,
  type RuntimeControlApi,
  RuntimeEffortControls,
  type RuntimeModelCatalogSource,
  RuntimeModelControls,
} from '../../components/runtime-controls.tsx';
import type { TerminalDeckDependencies } from '../../components/session-terminal-deck.tsx';
import { SessionTopBar, sessionDisplayName } from '../../components/session-top-bar.tsx';
import type { SendDismiss, SendExpand } from '../../components/settled-send-note.tsx';
import { SubFerretIndicator } from '../../components/sub-ferrets.tsx';
import type { PaneSnapshotReader } from '../../components/terminal-snapshot.tsx';
import { readPaneSnapshot } from '../../components/terminal-snapshot-model.ts';
import { Transcript } from '../../components/transcript.tsx';
import { TranscriptUnboundNotice } from '../../components/transcript-unbound-notice.tsx';
import { fetchSessionAnalytics } from '../../features/analytics/analytics-api.ts';
import { analyticsIdQuery } from '../../features/analytics/session-analytics-query.ts';
import { SessionAnalyticsSurface } from '../../features/analytics/session-analytics-surface.tsx';
import {
  type AttentionActionClient,
  AttentionPanel,
  type AttentionPanelFocus,
  attentionLedgerIds,
  shownAttentionItem,
} from '../../features/attention/attention-panel.tsx';
import { AttentionRepliesNotice } from '../../features/attention/attention-replies-notice.tsx';
import {
  ATTENTION_RESOLVED_ACTION_ID,
  resolvedActionContribution,
} from '../../features/attention/attention-resolved.tsx';
import { browserPageLabel } from '../../features/browser/browser-surface-list.tsx';
import { InAppBrowserWorkspace } from '../../features/browser/in-app-browser.tsx';
import type { UnifiedBrowserDependencies } from '../../features/browser/unified-browser-surface.tsx';
import { browserPageForKey, useSessionBrowser } from '../../features/browser/use-session-browser.ts';
import {
  attentionSignalsPort,
  instructionDocsLoader,
  sessionMcpLoader,
  sessionSkillsInventoryLoader,
  skillFileLoader,
} from '../../features/context-rail/context-rail-ports.ts';
import type { FleetClientFactory } from '../../features/fleet/fleet-client.ts';
import { DialogCard, type HarnessDialogAnswerApi } from '../../features/harness-dialog/dialog-card.tsx';
import { ApprovalCard, type PermissionAnswerApi } from '../../features/permission-request/approval-card.tsx';
import { ActionToast } from '../../features/session-actions/action-toast.tsx';
import { ActionsMenu } from '../../features/session-actions/actions-menu.tsx';
import { AddMcpForm, type AddMcpPorts } from '../../features/session-actions/add-mcp-form.tsx';
import {
  CORE_SESSION_ACTIONS,
  type CoreActionContext,
  SESSION_ACTION_IDS,
} from '../../features/session-actions/core-actions.ts';
import { ForkForm } from '../../features/session-actions/fork-form.tsx';
import { type SessionActionContribution, sessionActionSections } from '../../features/session-actions/registry.ts';
import { RenameForm } from '../../features/session-actions/rename-form.tsx';
import { useRestartRefusal } from '../../features/session-actions/restart-refusal.tsx';
import { addSessionMcp, previewSessionMcp, readSessionMcp } from '../../features/session-actions/session-mcp-api.ts';
import {
  forkThroughLatest,
  restartOnEarlierConversation,
  restartWithResume,
} from '../../features/session-actions/session-operations.ts';
import { useConvertAction } from '../../features/session-actions/use-convert-action.tsx';
import type { InfoTab } from '../../features/session-info/info-model.ts';
import { readRelaunchSettings } from '../../features/session-info/relaunch-settings-api.ts';
import { SessionInfo, type SessionInfoPorts } from '../../features/session-info/session-info.tsx';
import type { SwitchSection } from '../../features/session-info/switch-marks.tsx';
import { useInfoPlacement } from '../../features/session-info/use-info-placement.ts';
import { SessionTasksSearchSurface, useSessionSearch } from '../../features/session-search/session-search.tsx';
import { useSessionSkills } from '../../features/skills/session-skills-store.ts';
import { addSkillInvocationToComposer } from '../../features/skills/skills-composer.ts';
import type { ConsoleTyper } from '../../features/workspace/console-surface.tsx';
import type { WorkspaceFormFactor } from '../../features/workspace/phone/phone-tab.ts';
import { type SessionInfoSlot, SessionWorkspace } from '../../features/workspace/session-workspace.tsx';
import { useAgentSurfaceTabs } from '../../features/workspace/use-agent-surface-tabs.ts';
import { useSessionWorkspace } from '../../features/workspace/use-session-workspace.ts';
import { type SurfaceEventFeed, useSurfaceDriving } from '../../features/workspace/use-surface-driving.ts';
import { useSessionTerminals, useWorkspaceFormFactor } from '../../features/workspace/use-workspace-environment.ts';
import type { AttentionReplies } from '../../hooks/use-attention-replies.ts';
import { useChatScrollbarGutter } from '../../hooks/use-chat-scrollbar-gutter.ts';
import { conversationFromTranscript } from '../../hooks/use-dictation.ts';
import { useLiveActivity } from '../../hooks/use-live-counter.ts';
import { useOptionalSessionQuota } from '../../hooks/use-usage.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Button } from '../../shell/primitives.tsx';
import { type SessionAction, type SessionActionSpec, sessionActionSpecs } from '../../shell/session-actions.ts';
import type { SidePaneTabPresentation } from '../../shell/side-pane-tab-model.ts';
import { statusMark, TERMINAL_STATUSES } from '../../shell/status-mark.tsx';
import type { DaemonAccountPickerStore } from '../account-picker-store.ts';
import { agentReferenceIdentityKey } from '../agent-references.ts';
import { withAnswerPrefix } from '../answer-chip.ts';
import type { DaemonAttentionClient } from '../attention-client.ts';
import type { AttentionLoadStatus } from '../attention-store.ts';
import type { DaemonBrowserLoginStore } from '../browser-login.ts';
import type { ComposerEnterKeyPreference } from '../composer-keybinding.ts';
import { useComposerReferenceCatalogs } from '../composer-reference-catalogs.ts';
import type { ConnectionHealthState } from '../connection-health.ts';
import type { ChatWidthPreference } from '../controls.ts';
import type { DaemonConnection } from '../daemon-connection.ts';
import { sameDaemonConnection } from '../daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../daemon-scope.ts';
import { answerHarnessDialog } from '../harness-dialogs.ts';
import { lineageLabel } from '../lineage.ts';
import type { LiveActivityFeed } from '../live-activity-feed.ts';
import { answerPermissionRequest } from '../permission-requests.ts';
import type { DaemonPinClient } from '../pin-client.ts';
import type { DaemonFetch } from '../runtime-models.ts';
import { DaemonRuntimeModelCatalogStore } from '../runtime-models.ts';
import type { ChatScrollSlot } from '../scroll-memory.ts';
import { sessionTurn } from '../session-activity.ts';
import type { TranscriptEntry } from '../session-screens.ts';
import { useDaemonClient, useDaemonFetch } from '../store.tsx';
import type { SttSettings } from '../stt/stt-settings.ts';
import { subFerretsOf } from '../sub-ferret-state.ts';
import { terminalIdForSurfaceKey } from '../surface-references.ts';
import type { DaemonUsageStore } from '../usage-store.ts';
import { WorkspaceLayoutStore } from '../workspace-layout-store.ts';
import { type WorkspaceRailPreferenceStore, workspaceRailPreferences } from '../workspace-rail-preferences.ts';
import { daemonSessionPath } from './routes.ts';

/** Only daemon operations this workspace can truthfully invoke. */
export type SessionChatClient = Pick<IFyApiClient, 'answer' | 'interrupt' | 'resume' | 'send' | 'stop'> &
  Partial<Pick<IFyApiClient, 'history' | 'request' | 'runtime'>>;

/** One scoped cache is safe because every key carries its daemon id. Keeping it
 * outside the page also avoids re-reading a live account catalog whenever the
 * transcript refreshes. */
const runtimeModelCatalogs = new DaemonRuntimeModelCatalogStore();

/**
 * What this workspace needs to show and answer its session's Attention.
 *
 * It is OPTIONAL, and its absence is honest rather than empty: a host that has
 * not subscribed supplies no ledger, so no `!A3` in the transcript is proved and
 * no trigger is rendered. That is also what keeps every existing caller — the
 * harness, the page-host tests — working unchanged.
 */
export interface SessionAttentionModel {
  /** The one canonical client; the page never opens its own transport. */
  readonly client: AttentionActionClient;
  readonly snapshot: AttentionSnapshot | null;
  readonly status: AttentionLoadStatus;
}

export interface SessionChatPageProps {
  readonly connection: DaemonConnection;
  /** Daemon-scoped account roster used only when the migration sheet opens. */
  readonly accountPicker?: DaemonAccountPickerStore;
  /** Cached daemon usage feed; never the live fleet-usage probe. */
  readonly usage?: DaemonUsageStore;
  /** Document-lifetime daemon-scoped pin boards. */
  readonly pins?: DaemonPinClient;
  /** Daemon-global browser-login state, invalidated with its pairing. */
  readonly browserLogin?: DaemonBrowserLoginStore;
  readonly session: SessionView;
  readonly entries: readonly TranscriptEntry[];
  readonly client: SessionChatClient;
  readonly presentation: SidePaneTabPresentation;
  readonly canControl?: boolean;
  /**
   * A ready-to-read sentence, or null. It is rendered VERBATIM and NOT as a live
   * region: App.tsx owns the one announcement for a refresh failure, and a
   * second `role=status` here made assistive tech say it twice.
   */
  readonly refreshError?: string | null;
  /**
   * The daemon can prove no transcript is this session's own. Shown as its own notice with its
   * remedies in place of the one-line issue, because waiting never fixes it and re-sending makes it worse.
   */
  readonly transcriptUnbound?: boolean;
  /**
   * The transcript on screen is this device's cached copy and the first live read has not answered:
   * the page says "Updating…" over it until it does.
   */
  readonly updating?: boolean;
  /** Where this session's reading position is kept, so Back and a reload return to it. */
  readonly readingPosition?: ChatScrollSlot;
  /**
   * This machine's connection health, from the shell. While it is `reconnecting` the page says nothing
   * about the outage itself — the shell's connection notice says it once — and keeps what it last showed.
   */
  readonly connectionState?: ConnectionHealthState;
  /** The reader's chat measure. `full` is the shipped default and is uncapped. */
  readonly chatWidth?: ChatWidthPreference;
  /** Browser-local transcript composer key preference. */
  readonly composerEnterKey?: ComposerEnterKeyPreference | null;
  /** Browser-local return-key preference on a phone. */
  readonly composerPhoneEnterKey?: ComposerEnterKeyPreference | null;
  /** Browser-local dictation settings; supplied by the application store. */
  readonly dictationSettings?: SttSettings;
  /**
   * Which composer suggestion families this reader still wants offered, mapped
   * from `DeviceControls` exactly once, by `App.tsx`. Absent means all of them.
   * A suppressed family changes menus only: every reference in this transcript
   * and in the draft still parses, proves and links.
   */
  readonly composerSuggestions?: ComposerSuggestionSwitches;
  /** Browser-local modal-editing preference for the composer textarea. */
  readonly composerVimMode?: boolean;
  /** Carrier-bound transport for the composer's daemon-backed autocomplete. */
  readonly composerFetch?: DaemonFetch;
  readonly onSessionChange: (view: SessionView) => void;
  readonly onRefresh?: () => void;
  /** Re-sends a send under its original id from its row in the transcript. */
  readonly onRetry?: SendRetry;
  /** Takes a send back from its row in the transcript. */
  readonly onCancel?: SendCancel;
  /** Presses Enter once for a send typed in the agent's composer, from its row. */
  readonly onSubmit?: SendSubmit;
  /** Puts a send that is not delivered away on this device. */
  readonly onDismiss?: SendDismiss;
  /** Opens or folds a settled send's one-line note. */
  readonly onExpand?: SendExpand;
  /** Test seam for the Console's live capture of the agent's pane. */
  readonly readSnapshot?: PaneSnapshotReader;
  /** Test seam for typing into the Console; absent, it types through the daemon's own route. */
  readonly typeIntoConsole?: ConsoleTyper;
  /**
   * The terminal deck's dependencies, bound to this daemon's carrier by the composition root.
   *
   * Threaded rather than defaulted inside the deck because the carrier lives in the app store, and a
   * component that reached for the store itself could not be mounted by a test without one. Absent
   * here means the deck's own browser default — direct-only, which is what a suite wants.
   */
  readonly deck?: TerminalDeckDependencies;
  /**
   * This daemon's own fleet slice, for proving `:callsign` references.
   * `undefined` means the fleet has not been read yet — deliberately NOT an
   * empty array, because an unread fleet is not a fleet with nobody in it, and
   * the difference decides whether a callsign is unproved or absent.
   */
  readonly daemonSessions?: readonly SessionView[];
  /** In-app navigation for a proved agent reference. */
  readonly onNavigate?: (to: string) => void;
  /** This session's live Attention, when the host has subscribed to it. */
  readonly attention?: SessionAttentionModel;
  /** Answers the machine is holding before it tells the ferret: counted down above the composer. */
  readonly attentionReplies?: AttentionReplies;
  /**
   * The item the conversation was opened AT (`?attention=A3`, from a notification or an unread row):
   * the Attention panel opens, scrolls to it and rings it. A new value re-targets; a session change
   * forgets it. Absent or `null`, the panel starts folded.
   */
  readonly attentionTarget?: AttentionId | null;
  /**
   * Which navigation named `attentionTarget` (the router's entry key). A new key re-targets even the
   * SAME item — tapping its notification a second time, after the panel was folded, opens it again.
   */
  readonly attentionTargetKey?: string;
  /**
   * This session's live-feed state and the reader's manual reconnect.
   *
   * Absent means the host is not subscribed to a live feed at all, which is what every test mount
   * and every embedding short of the composition root actually is — and it renders nothing rather
   * than a chip claiming a state nobody is measuring.
   */
  readonly liveStream?: LiveStreamIndicatorProps;
  /** The project this session's folder belongs to, named the way the sessions bar groups it. */
  readonly project?: string | null;
  /** Phone only: opens the sessions drawer the bar's ☰ stands for. */
  readonly onOpenSessions?: () => void;
  /** Writes the session id to the clipboard. Absent: the browser's own clipboard. */
  readonly copyText?: (text: string) => Promise<void>;
  /**
   * Every agent's remembered split workspace. The app store owns it so an unpair forgets that
   * machine's layouts; absent, a page-local default serves a harness or a test.
   */
  readonly workspaceLayouts?: WorkspaceLayoutStore;
  /** The reader's rail widths. Absent: a page-local default. */
  readonly workspaceRails?: WorkspaceRailPreferenceStore;
  /** Phone, tablet split or desktop. Absent: measured from the window. */
  readonly formFactor?: WorkspaceFormFactor;
  /**
   * What the "This folder" context reads through. Absent: the host has none to offer, so the page
   * shows no rail and no ◧ rather than four sub-tabs that can only fail.
   */
  readonly context?: SessionContextDependencies;
  /** The remote browser's engine, for a harness that scripts it. Absent: the real one. */
  readonly browser?: UnifiedBrowserDependencies;
  /**
   * This session's live journal, as the host already subscribes to it: `surface.*` events move the
   * AGENT marker and Take over / Hand back at once. Absent, the page still reads them on a poll.
   */
  readonly surfaceEvents?: SurfaceEventFeed;
  /** This session's live readout (`live` frames off the same stream), for the working line's token counts. */
  readonly liveActivity?: LiveActivityFeed;
  /**
   * More rows for Actions ▾, from features that are not the page's: the Warden's "Ask the Warden to
   * investigate", Learning's "Passive learning" and "Scan this ferret". Each is a registry contribution
   * built against the same context the core actions read; absent, Actions offers the core set only.
   */
  readonly actionContributions?: readonly SessionActionContribution<CoreActionContext>[];
  /**
   * The model and effort pickers for Info › Runtime, when the host has them. Absent, Runtime shows the
   * requested and observed model and the effort as facts, and the composer's chips stay the way to
   * change them.
   */
  readonly infoRuntimeControls?: ReactNode;
  /**
   * Whether this ferret is instructed to file lessons, for Info › Runtime's Learning row: the host's own
   * passive-learning read (the one Actions toggles), `null` while unread. Absent: no row.
   */
  readonly infoLearning?: boolean | null;
  /**
   * The header's Hypermedia and Pack mode marks: the switches' latest answers for this ferret, and the tap
   * that switches one (the host's own Actions toggles). Absent: read from the record, marks only.
   */
  readonly switches?: {
    readonly hypermedia: boolean;
    readonly pack: boolean;
    readonly onToggle: (section: SwitchSection, next: boolean) => void;
  };
  /** Info open on this tab from the first frame. Absent: Info starts shut. */
  readonly initialInfo?: InfoTab;
}

/** The app-store bindings the context rail needs, beyond what the page already holds. */
interface SessionContextDependencies {
  readonly attention: DaemonAttentionClient;
  readonly createFleetClient: FleetClientFactory;
  /** The machine's own name, as the MCP sign-in sheet says it. */
  readonly machineName: string;
}

const defaultWorkspaceLayouts = new WorkspaceLayoutStore();
const defaultWorkspaceRails = workspaceRailPreferences;

/** The two tools Info opens in a sheet of their own: this ferret's tasks and its full analytics. */
type SessionUtility = 'tasks' | 'analytics';

const UTILITY_LABEL: Readonly<Record<SessionUtility, string>> = {
  tasks: 'Tasks',
  analytics: 'Analytics for this session',
};

const NO_CONTRIBUTIONS: readonly SessionActionContribution<CoreActionContext>[] = [];

/** The browser's clipboard, or a refusal a reader can be told about. */
const browserCopyText = async (text: string): Promise<void> => {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) throw new Error('this browser offers no clipboard here');
  await clipboard.writeText(text);
};

const actionFailureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/** Gives the app-bar search real current-workspace destinations without ever
 * retaining a callback across a daemon/session change. */
function SessionSearchWorkspaceActions({
  scope,
  openFile,
  openTasks,
}: {
  readonly scope: DaemonSessionScope;
  readonly openFile: (path: string) => void;
  readonly openTasks: () => void;
}) {
  const search = useSessionSearch();
  useEffect(() => {
    if (search.scope === null || search.scope.daemonId !== scope.daemonId || search.scope.sessionId !== scope.sessionId)
      return;
    search.setOpeners({ openFile, openTasks });
    return () => search.setOpeners(null);
  }, [openFile, openTasks, scope, search]);
  return null;
}

/**
 * A refresh failure that is NOT an outage, said in one line. The whole sentence is one tap away, because
 * a clipped error with no way to read the rest is worse than a long one.
 */
function CompactIssue({ sentence }: { readonly sentence: string }) {
  return (
    <details className="group min-w-0 px-3 py-1 text-meta text-warn" data-session-issue="">
      <summary className="cursor-pointer truncate group-open:whitespace-normal">{sentence}</summary>
    </details>
  );
}

/**
 * Pure session-workspace composition. Runtime/store ownership remains in
 * App.tsx; this page receives one explicit daemon, one session view and one
 * client bound to that same live pairing.
 */
export function SessionChatPage({
  connection,
  accountPicker,
  usage,
  session,
  entries,
  client,
  presentation,
  canControl = true,
  refreshError = null,
  transcriptUnbound = false,
  updating = false,
  readingPosition,
  connectionState,
  chatWidth = 'readable',
  composerEnterKey,
  composerPhoneEnterKey = null,
  composerSuggestions,
  composerVimMode = false,
  composerFetch,
  dictationSettings,
  onSessionChange,
  onRefresh,
  onRetry,
  onCancel,
  onSubmit,
  onDismiss,
  onExpand,
  readSnapshot,
  typeIntoConsole,
  deck,
  daemonSessions,
  onNavigate,
  attention,
  attentionReplies,
  attentionTarget = null,
  attentionTargetKey,
  liveStream,
  project = null,
  onOpenSessions,
  copyText = browserCopyText,
  workspaceLayouts = defaultWorkspaceLayouts,
  workspaceRails = defaultWorkspaceRails,
  formFactor: formFactorOverride,
  context: contextDependencies,
  browser,
  surfaceEvents,
  liveActivity,
  actionContributions = NO_CONTRIBUTIONS,
  infoRuntimeControls,
  infoLearning,
  switches,
  initialInfo,
}: SessionChatPageProps) {
  const scope = useMemo(() => daemonSessionScope(connection, session.config.id), [connection, session.config.id]);
  const measuredFormFactor = useWorkspaceFormFactor();
  // A drawer layout is a phone whatever the window measures: the app shell has already decided so.
  const formFactor = formFactorOverride ?? (presentation === 'sheet' ? 'phone' : measuredFormFactor);
  const workspace = useSessionWorkspace(workspaceLayouts, scope);
  const info = useInfoPlacement(initialInfo);
  const [actionForm, setActionForm] = useState<string | null>(null);
  // Who drives which terminal and page, and the session's pages: both through the daemon client, so a
  // relay-only machine answers them as surely as one on the LAN.
  const daemonClient = useDaemonClient();
  const driving = useSurfaceDriving(scope, connection, {
    client: daemonClient,
    ...(surfaceEvents === undefined ? {} : { events: surfaceEvents }),
  });
  const agentSurfaces = useAgentSurfaceTabs({
    store: workspaceLayouts,
    scope,
    layout: workspace.layout,
    opened: driving.opened,
    asked: driving.asked,
  });
  const browserPages = useSessionBrowser(scope, connection, {
    client: daemonClient,
    ...(surfaceEvents === undefined ? {} : { events: surfaceEvents }),
  });
  const handoffs = useMemo(
    () => ({
      daemon: connection,
      sessionId: session.config.id,
      read: async (name: string) => await (await daemonClient(connection)).handoff(session.config.id, name),
    }),
    [connection, session.config.id, daemonClient],
  );
  const terminals = useSessionTerminals(deck, connection, scope, surfaceEvents);
  const [utility, setUtility] = useState<SessionUtility | null>(null);
  const utilityId = useId();
  const search = useSessionSearch();
  const referenceTasks =
    search.scope?.daemonId === scope.daemonId &&
    search.scope.sessionId === scope.sessionId &&
    search.taskState === 'ready'
      ? search.tasks
      : undefined;
  // #43. The session's ONE skills read, owned here for the same reason the task
  // snapshot is: both the pane and the reference surface need it, and two reads
  // would be two owners that disagree after a refresh. `names` is undefined
  // until a catalog has actually been read — unread, never "no skills".
  // The carrier router: the `@file` proof and the skills read both reach a relay-only daemon.
  const referenceFetch = useDaemonFetch();
  // The model catalog is read through the same routed fetch: a paired device has no bearer value.
  const routedRuntimeCatalogs = useMemo<RuntimeModelCatalogSource>(
    () => ({ load: async (daemon, scope) => await runtimeModelCatalogs.load(daemon, scope, referenceFetch) }),
    [referenceFetch],
  );
  const skills = useSessionSkills(connection, scope, referenceFetch);
  const attentionId = useId();
  // THE ATTENTION PANEL'S TWO FACTS: whether it is unfolded, and the latest request to be shown
  // somewhere in it (a `?attention=` link, a `!A3` click, the header's count). Both belong to this
  // session and reset with it.
  const [attentionSelected, setAttentionSelected] = useState<AttentionId | null>(null);
  const [answerChipOn, setAnswerChipOn] = useState(true);
  const [attentionFocus, setAttentionFocus] = useState<AttentionPanelFocus | null>(null);
  const showAttention = useCallback((target: AttentionId | null): void => {
    if (target !== null) setAttentionSelected(target);
    setAttentionFocus(current => ({ target, seq: (current?.seq ?? 0) + 1 }));
  }, []);
  // The resolved item a link named, so the list the header menu opens rings it. Cleared with the form.
  const [resolvedTarget, setResolvedTarget] = useState<AttentionId | null>(null);
  const chipRef = useRef<{ id: AttentionId | null; on: boolean }>({ id: null, on: false });
  const openAttentionReference = useCallback((id: AttentionId): void => showAttention(id), [showAttention]);
  // Dictation clean-up reads the conversation on screen instead of fetching the session's history again.
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const readDictationConversation = useCallback(() => conversationFromTranscript(entriesRef.current), []);
  const composerCatalogs = useComposerReferenceCatalogs(client, session.config.id, {
    tasks: referenceTasks,
    skills: skills.catalog,
    waitForTasks: search.waitForTasks,
    waitForSkills: skills.settled,
    ...(search.taskState === 'unavailable' && search.taskError !== null ? { taskFailure: search.taskError } : {}),
    // The `!` menu reads the SAME live board the panel draws, so an item raised a moment ago is offered
    // without a reload — and the page asks the daemon for this board once, not twice.
    ...(attention === undefined
      ? {}
      : {
          attention: {
            items: attention.snapshot?.items,
            ...(attention.status === 'error' && attention.snapshot === null
              ? { failure: 'this session’s Attention could not be read' }
              : {}),
          },
        }),
  });
  /** Codex's native model picker is in the agent's own pane: the runtime sheet's way there is the Console. */
  const { showAgentTab, openFile, openSurface } = workspace;
  const openConsole = useCallback((): boolean => {
    showAgentTab('console');
    return true;
  }, [showAgentTab]);
  const openTasks = useCallback(() => setUtility('tasks'), []);
  const { show: showInfo } = info;
  // Where a proved reference opens: the workspace's tabs, and the context rail for a skill. ONE click
  // behaviour still — Markdown calls the surface — with these as its destinations.
  const referenceDestinations = useMemo(
    () => ({
      openFile: (path: string, selection?: Parameters<typeof openFile>[1]) => openFile(path, selection),
      // A tab is keyed the way its body finds the surface: a terminal by the daemon's id (the deck
      // shows one shell by id), a page by its name when it has one. The tab is labelled with the name.
      openSurface: (reference: { readonly surface: 'terminal' | 'browser'; readonly key: string }) => {
        if (reference.surface === 'terminal') {
          const id = terminalIdForSurfaceKey(terminals, reference.key) ?? reference.key;
          openSurface('terminal', id, id === reference.key ? undefined : reference.key);
          return;
        }
        const page = browserPageForKey(browserPages.status, reference.key);
        if (page === undefined) openSurface('browser', reference.key);
        else openSurface('browser', page.name ?? page.id, browserPageLabel(page));
      },
      openTasks,
      openSkills: () => showInfo('folder', 'skills'),
    }),
    [openFile, openSurface, openTasks, showInfo, terminals, browserPages.status],
  );
  // THE session's one reference surface. The memo key over the fleet is the
  // identity of the fields the resolver actually copies, so status and activity
  // churn cannot rebuild the surface and re-parse every rendered Markdown block
  // in the transcript (`agentReferenceIdentityKey`).
  const fleetIdentity =
    daemonSessions === undefined ? null : agentReferenceIdentityKey(connection.daemonId, daemonSessions);
  // THE LEDGER proves a `!A3` — open AND resolved — so a reference in older chat stays a link after
  // the item is answered and opens its resolved entry. A host with no live board falls back to the
  // catalog's one read; a board not yet read proves nothing (unread is not empty).
  const attentionProof =
    attention === undefined
      ? composerCatalogs.attention?.map(item => item.id)
      : attention.snapshot === null
        ? undefined
        : attentionLedgerIds(attention.snapshot);
  // The ledger's IDENTITY, not its array identity: a re-hydration that returns
  // the same ids must not rebuild the reference surface and re-parse every
  // Markdown block in the transcript.
  const attentionKey = attentionProof?.join(',') ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: fleetIdentity and attentionKey are the stable memo keys for daemonSessions and the attention ledger
  const references = useMemo(
    () =>
      sessionReferenceSurface({
        connection,
        fetcher: referenceFetch,
        scope,
        ...(session.config.cwd === undefined ? {} : { cwd: session.config.cwd }),
        ...(daemonSessions === undefined ? {} : { sessions: daemonSessions }),
        ...(composerCatalogs.tasks === undefined ? {} : { tasks: composerCatalogs.tasks }),
        ...(attentionProof === undefined ? {} : { attentionIds: attentionProof }),
        ...(composerCatalogs.skills?.skills === undefined
          ? {}
          : { skills: composerCatalogs.skills.skills.map(skill => skill.name) }),
        ...(onNavigate === undefined ? {} : { onNavigate }),
        ...(terminals === null ? {} : { terminals }),
        ...(browserPages.status === null ? {} : { browser: browserPages.status }),
        destinations: referenceDestinations,
        // Both halves or neither. The ledger alone proves `!A3` without giving
        // it anywhere to go, and an opener alone would link an unproved id — so
        // a host that has not subscribed leaves the token as prose, which the
        // reference standard calls the only honest state. A proved click opens
        // the Attention panel at that item.
        ...(attention === undefined ? {} : { onAttentionOpen: openAttentionReference }),
      }),
    [
      connection,
      referenceFetch,
      scope,
      session.config.cwd,
      fleetIdentity,
      composerCatalogs.tasks,
      composerCatalogs.skills,
      onNavigate,
      attention === undefined,
      attentionKey,
      openAttentionReference,
      terminals,
      browserPages.status,
      referenceDestinations,
    ],
  );
  // Bumped when the reader sends: they want to watch the reply arrive, so the transcript returns to
  // the tail and follows again even if they had scrolled up to re-read while composing.
  const [pinSignal, setPinSignal] = useState(0);
  const onSent = useCallback(() => {
    setPinSignal(signal => signal + 1);
    onRefresh?.();
  }, [onRefresh]);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pendingAction, setPendingAction] = useState<SessionAction | null>(null);
  const [actionFailure, setActionFailure] = useState<{ readonly sentence: string; readonly detail?: string } | null>(
    null,
  );
  const actionError = actionFailure?.sentence ?? null;
  const setActionError = useCallback(
    (sentence: string | null): void => setActionFailure(sentence === null ? null : { sentence }),
    [],
  );
  const reconnecting = connectionState?.kind === 'reconnecting';
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const dismissActionNotice = useCallback(() => setActionNotice(null), []);
  const live = useRef({ connection, sessionId: session.config.id });
  live.current = { connection, sessionId: session.config.id };

  // Pairing/session identity is deliberately the reset trigger for local sheet
  // and action state, even though the body only writes React state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger
  useEffect(() => {
    setActionForm(null);
    setMigrateOpen(false);
    setConfirmStop(false);
    setPendingAction(null);
    setActionError(null);
    setActionNotice(null);
    // Attention belongs to the session that raised it. Carrying an unfolded
    // panel — or worse, a requested `!A3` — across a navigation would ring one
    // session's id on another session's board, so both reset with the pairing
    // and the session id.
    setAttentionSelected(null);
    setAttentionFocus(null);
    setResolvedTarget(null);
  }, [connection, session.config.id]);

  // `?attention=A3` opens the conversation AT that item. Declared after the reset above so that, on a
  // navigation that carries a target, the reset runs first and the new target wins.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pairing, the session id and the navigation re-arm the same target
  useEffect(() => {
    if (attentionTarget !== null) showAttention(attentionTarget);
  }, [attentionTarget, attentionTargetKey, showAttention, connection, session.config.id]);

  const publish = useCallback(
    (view: SessionView): void => {
      if (
        live.current.sessionId !== session.config.id ||
        !sameDaemonConnection(live.current.connection, connection) ||
        view.config.id !== session.config.id
      )
        return;
      onSessionChange(view);
      onRefresh?.();
    },
    [connection, onRefresh, onSessionChange, session.config.id],
  );
  const restartRefusal = useRestartRefusal(publish, session.config.id);
  const convert = useConvertAction({
    connection,
    scope,
    view: session,
    canControl,
    accountPicker,
    onMoved: (moved, sentence) => {
      publish(moved);
      setActionNotice(sentence);
    },
  });
  const questionApi = useMemo<QuestionAnswerApi>(
    () => ({
      answer: async (daemon, sessionId, toolUseId, labels, other, responses, answers, requestId) => {
        if (!sameDaemonConnection(daemon, connection))
          throw new Error('the structured answer belongs to a different daemon pairing');
        const view = await client.answer(
          sessionId,
          toolUseId,
          [...labels],
          other,
          responses === undefined ? undefined : [...responses],
          answers === undefined ? undefined : [...answers],
          requestId,
        );
        publish(view);
        return view;
      },
    }),
    [client, connection, publish],
  );

  // A harness permission prompt is answered through the daemon's own route; the deny note rides the
  // Composer's send, so the agent reads it as an ordinary message.
  const permissionApi = useMemo<PermissionAnswerApi>(
    () => ({
      answer: async (daemon, at, answer) => await answerPermissionRequest(daemon, at, answer, referenceFetch),
      note: async (daemon, at, message) => {
        if (!sameDaemonConnection(daemon, connection))
          throw new Error('the note belongs to a different daemon pairing');
        return await client.send(at.sessionId, { message, now: false });
      },
    }),
    [client, connection, referenceFetch],
  );

  const dialogApi = useMemo<HarnessDialogAnswerApi>(
    () => ({ answer: async (daemon, at, answer) => await answerHarnessDialog(daemon, at, answer, referenceFetch) }),
    [referenceFetch],
  );

  const runAction = async (action: SessionAction): Promise<void> => {
    if (action === 'stop' && !confirmStop) {
      setConfirmStop(true);
      return;
    }
    setPendingAction(action);
    setActionError(null);
    try {
      const next =
        action === 'interrupt'
          ? await client.interrupt(session.config.id)
          : action === 'resume'
            ? await client.resume(session.config.id)
            : await client.stop(session.config.id, 'stopped from the PWA session workspace');
      publish(next);
      setConfirmStop(false);
    } catch (reason) {
      setActionError(actionFailureMessage(reason));
    } finally {
      setPendingAction(null);
    }
  };

  // RENAME IS NOT OFFERED, because `/rename` is not mounted on the daemon this
  // build talks to. An action that opens a sheet whose submit can only fail is
  // worse than no action: it spends the reader's attention to tell them no.
  // Migrate stays — its route IS mounted. The filter lives here rather than in
  // `sessionActionSpecs`, which is shared with surfaces that may reach a daemon
  // where rename works.
  const actions = useMemo(
    () => sessionActionSpecs(session, canControl).filter(spec => spec.action !== 'rename'),
    [canControl, session],
  );
  // LIVE is not WORKING. `running` means the agent's terminal is up — a brand-new session is
  // `running` before anything is sent. Whose turn it is comes from the daemon's turn watcher
  // (`state.turnState`, read through `lib/session-activity.ts`), the same field the status dots and
  // the notifications read. The pane is read only to print the harness's own working line — and, for
  // a daemon that sends no `turnState`, as the fallback evidence.
  const working = session.state.turnState === 'working';
  const legacyLive = session.state.turnState === undefined && statusMark(session).klass === 'active';
  const readActivityFrame = useCallback<PaneFrameReader>(
    async signal => await readPaneSnapshot(connection, scope, signal, referenceFetch, true, 'screen'),
    [connection, referenceFetch, scope],
  );
  const pane = usePaneActivity(readActivityFrame, working || legacyLive);
  const liveSample = useLiveActivity(liveActivity);
  const turn = sessionTurn(session, pane);
  const busy = turn === 'working' || (turn === null && legacyLive);
  // The account's quota for this session, from the daemon's passive usage feed. The session document
  // itself never carries one, so reading `state.quota` showed "—" for every window, always.
  const quota = useOptionalSessionQuota(usage, connection, session);
  /**
   * THE RUNTIME CHIPS ASK A DIFFERENT QUESTION THAN THE TRANSCRIPT DOES.
   *
   * `busy` above is whether work is HAPPENING — and that is the
   * right fact for a transcript tail and for a composer that keeps accepting
   * text while a turn runs. A runtime switch is not about liveness at all: the
   * daemon refuses one unless the harness is sitting at an idle prompt
   * (`paneRefusal` in `session/runtime-control/policy.ts`), because `/model`
   * typed behind a running turn either vanishes or arrives as conversation.
   *
   * Reading `statusMark(...).klass === 'active'` here substituted the first
   * question for the second, and `statusMark` answers `active` for EVERY
   * non-terminal, non-waiting session. So both chips were disabled on every
   * ordinary `running` session no matter how ready its prompt was, and the only
   * way to reach a live sheet was a session that happened to be `waiting` — a
   * reader could never open the model or reasoning sheet on the sessions they
   * actually work in.
   *
   * What readiness MEANS is not decided here. `isPromptKnownBusy` owns that
   * tri-state and explains it; this trigger and the submissions inside the
   * sheets read the one predicate, so a chip can never open onto a sheet that
   * could only refuse, or refuse what a sheet would have sent.
   */
  const runtimeSwitchBusy = isPromptKnownBusy(session.state);
  const question = TERMINAL_STATUSES.has(session.state.status) ? null : (session.state.pendingQuestion ?? null);
  const awaitingAnswer = question !== null || session.state.status === 'awaiting_question';
  // The tool-permission prompt the agent's pane is parked on, answerable only while the session is live.
  const permissionRequest = TERMINAL_STATUSES.has(session.state.status) ? undefined : session.state.permissionRequest;
  // The harness's own dialog (hooks to review, a sign-in) — the same pane, so never beside a permission prompt.
  const harnessDialog =
    TERMINAL_STATUSES.has(session.state.status) || permissionRequest !== undefined
      ? undefined
      : session.state.harnessDialog;
  const compact = presentation === 'sheet';
  const chatSurface = useRef<HTMLDivElement | null>(null);
  useChatScrollbarGutter(chatSurface, session.config.id);
  /**
   * BOUND, BECAUSE THE SHIPPED CLIENT IS AN OBJECT AND NOT A BAG OF FUNCTIONS.
   *
   * The feature check has to read `client.runtime` — the route is optional and a
   * daemon that lacks it must render no controls at all. Reading it into a local
   * and calling THAT is what broke: `DaemonApiClient.runtime` is a prototype
   * method over private fields, so an unbound call has no receiver and dies on
   * the first field it touches. In a minified build that surfaced as
   * `Cannot read properties of undefined (reading 'e')` — a handler that ran,
   * showed a stack, and sent no request. `bind` keeps the check and restores the
   * receiver in one step.
   *
   * NO TEST COULD HAVE SEEN IT FROM A MOCK. An arrow function ignores its
   * receiver entirely, so every unit client here kept working while the real one
   * threw; the regression beside this one uses a class with private state for
   * exactly that reason.
   *
   * The dependency is the CLIENT, not `client.runtime`. A prototype method is
   * the same reference on every instance of that class, so keying on the method
   * would hold a binding to the first client forever and quietly send this
   * session's commands through a replaced one.
   */
  const runtimeApi = useMemo<RuntimeControlApi | null>(() => {
    const runtime = client.runtime?.bind(client);
    if (runtime === undefined) return null;
    return {
      runtime: async (daemon, sessionId, command, requestId) => {
        // The controls were rendered for this exact pairing. Retain the guard
        // here too: a stale React continuation must not use a control from one
        // daemon to mutate an identically named session on another.
        if (!sameDaemonConnection(daemon, live.current.connection) || sessionId !== live.current.sessionId)
          throw new Error('runtime control belongs to a session that is no longer active');
        const next = await runtime(sessionId, command, requestId);
        publish(next);
      },
    };
  }, [client, publish]);

  /**
   * THE BAR'S LIFECYCLE BUTTONS: Interrupt and Stop while a session runs, Start once it has stopped.
   *
   * Short words, because they sit beside the agent's name rather than in a row of their own. A phone
   * keeps ONE of them — the one a reader reaches for mid-turn — and Stop moves into ⋯, which is also
   * where moving to another login lives on every width. Stop still asks first: choosing it, from either
   * place, turns the bar's buttons into Confirm stop and Cancel.
   */
  const barActions = actions.filter(
    spec => spec.action === 'interrupt' || spec.action === 'resume' || (spec.action === 'stop' && !compact),
  );
  const barLabel = (spec: SessionActionSpec): string =>
    spec.action === 'interrupt' ? 'Interrupt' : spec.action === 'resume' ? 'Start' : 'Stop';
  const lifecycleActions = confirmStop ? (
    <>
      <Button
        data-session-action="confirm-stop"
        disabled={pendingAction !== null}
        onClick={() => void runAction('stop')}
        size="sm"
        type="button"
        variant="danger"
      >
        {pendingAction === 'stop' ? 'Stopping…' : 'Confirm stop'}
      </Button>
      <Button onClick={() => setConfirmStop(false)} size="sm" type="button" variant="ghost">
        Cancel
      </Button>
    </>
  ) : compact ? (
    // A PHONE'S LIFECYCLE BUTTON IS AN ICON, the same size and weight as ⓘ and Actions beside it: the
    // outlined "Interrupt" box was the fattest thing in the bar and pushed the agent's name aside. The
    // word moves to the label and the tooltip; the glyph (⏸ / ▶) carries the action.
    barActions.map(spec => {
      const Icon = spec.action === 'resume' ? Play : Pause;
      return (
        <button
          aria-label={pendingAction === spec.action ? `${barLabel(spec)}…` : spec.label}
          className="fy-session-bar__icon"
          data-session-action={spec.action}
          disabled={pendingAction !== null}
          key={spec.action}
          onClick={() => void runAction(spec.action)}
          title={spec.label}
          type="button"
        >
          <Icon aria-hidden="true" size={18} />
        </button>
      );
    })
  ) : (
    barActions.map(spec => (
      <Button
        aria-label={spec.label}
        data-session-action={spec.action}
        disabled={pendingAction !== null}
        key={spec.action}
        onClick={() => void runAction(spec.action)}
        size="sm"
        type="button"
        variant={spec.danger ? 'danger' : 'outline'}
      >
        {pendingAction === spec.action ? `${barLabel(spec)}…` : barLabel(spec)}
      </Button>
    ))
  );
  const actionAlert = (
    <div className={actionError === null ? 'sr-only' : 'm-0 px-3 py-1 text-ui text-err'} role="alert">
      {actionError === null ? '' : `Session action failed: ${actionError}`}
      {actionFailure?.detail === undefined ? null : (
        <details className="mt-1 text-meta text-muted">
          <summary className="cursor-pointer">Details</summary>
          <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono">{actionFailure.detail}</pre>
        </details>
      )}
    </div>
  );
  const copySessionId = (): void => {
    setActionError(null);
    copyText(session.config.id).catch((reason: unknown) =>
      setActionError(`could not copy the session id: ${actionFailureMessage(reason)}`),
    );
  };
  const agentName = sessionDisplayName(session);
  const runtime = session.config.agent;
  const routedClient = useDaemonClient();

  /**
   * ACTIONS ▾ — every DO for this ferret, from the registry. The core rows are the page's own daemon
   * calls; a host adds more (`actionContributions`) without the menu learning anything new.
   */
  const restart = useCallback(async (): Promise<void> => {
    const daemon = await routedClient(connection);
    publish(
      await restartWithResume(daemon, session, `restart-${session.config.id}-${session.state.turn}-${Date.now()}`),
    );
  }, [connection, publish, routedClient, session]);
  // For callers that report their own failure (Info, the transcript notice, Add MCP): the refusal still
  // reaches the page's confirm, and is rethrown so none of them claims a restart that did not happen.
  const restartSurfacingRefusal = useCallback(async (): Promise<void> => {
    try {
      await restart();
    } catch (reason) {
      restartRefusal.capture(reason);
      throw reason;
    }
  }, [restart, restartRefusal]);
  const mcpPorts = useMemo<AddMcpPorts>(
    () => ({
      listing: signal => readSessionMcp(connection, scope, referenceFetch, signal),
      preview: (mcpScope, request) => previewSessionMcp(connection, scope, mcpScope, request, referenceFetch),
      add: (mcpScope, request) => addSessionMcp(connection, scope, mcpScope, request, referenceFetch),
      reload: restartSurfacingRefusal,
      ...(daemonSessions === undefined
        ? {}
        : {
            reloadOthers: async () => {
              const daemon = await routedClient(connection);
              const others = daemonSessions.filter(
                other =>
                  other.config.id !== session.config.id &&
                  other.config.agent === runtime &&
                  !TERMINAL_STATUSES.has(other.state.status),
              );
              for (const other of others)
                await restartWithResume(daemon, other, `restart-${other.config.id}-${other.state.turn}-${Date.now()}`);
            },
          }),
      ...(contextDependencies === undefined
        ? {}
        : {
            signIn: {
              connection,
              createClient: contextDependencies.createFleetClient,
              machineName: contextDependencies.machineName,
            },
          }),
    }),
    [
      connection,
      scope,
      referenceFetch,
      restartSurfacingRefusal,
      daemonSessions,
      routedClient,
      session.config.id,
      runtime,
      contextDependencies,
    ],
  );
  const coreContext: CoreActionContext = {
    view: session,
    name: agentName,
    canControl,
    copyId: copySessionId,
    openMigrate: () => setMigrateOpen(true),
    ...(convert.openConvert === undefined ? {} : { openConvert: convert.openConvert }),
    restart,
    restartOnEarlierConversation: async () => {
      publish(
        await restartOnEarlierConversation(
          await routedClient(connection),
          session,
          `earlier-${session.config.id}-${session.state.turn}-${Date.now()}`,
        ),
      );
    },
    stop: async () => {
      publish(await client.stop(session.config.id, 'stopped from the PWA session workspace'));
    },
    resume: async () => {
      publish(await client.resume(session.config.id));
    },
    renderRename: host => (
      <RenameForm
        host={host}
        rename={async patch => {
          const daemon = await routedClient(connection);
          const renamed = await daemon.rename(session.config.id, patch.name, patch.teammate, patch.clearParent);
          publish(renamed);
          return renamed;
        }}
        view={session}
      />
    ),
    renderFork: host => (
      <ForkForm
        fork={async teammate =>
          await forkThroughLatest(
            await routedClient(connection),
            session,
            teammate,
            `fork-${session.config.id}-${Date.now()}`,
          )
        }
        host={host}
        onForked={outcome => onNavigate?.(daemonSessionPath(connection.daemonId, outcome.session.id))}
        view={session}
      />
    ),
    renderAddMcp: host => (
      <AddMcpForm agentName={agentName} host={host} login={runtime} ports={mcpPorts} project={project} />
    ),
  };
  const openResolved = useCallback((id: AttentionId): void => {
    setResolvedTarget(id);
    setActionForm(ATTENTION_RESOLVED_ACTION_ID);
  }, []);
  const changeActionForm = useCallback((next: string | null): void => {
    setActionForm(next);
    if (next !== ATTENTION_RESOLVED_ACTION_ID) setResolvedTarget(null);
  }, []);
  const contributions: readonly SessionActionContribution<CoreActionContext>[] = [
    ...CORE_SESSION_ACTIONS,
    resolvedActionContribution(attention?.snapshot?.resolved ?? [], attentionId, resolvedTarget),
    ...actionContributions,
  ];
  const actionSections = sessionActionSections(contributions, coreContext);
  const actionsMenu = (
    <ActionsMenu
      compact={compact}
      form={actionForm}
      name={agentName}
      onFailure={(sentence, detail, reason) => {
        if (restartRefusal.capture(reason)) setActionFailure(null);
        else setActionFailure(detail === undefined ? { sentence } : { sentence, detail });
      }}
      onNotice={setActionNotice}
      onFormChange={changeActionForm}
      sections={actionSections}
    />
  );

  /**
   * THE MODEL AND EFFORT PICKERS (#525), drawn in two places by one builder: the composer's status
   * line, and Info › Runtime's "Change" row. Both are the same compact chips — a small menu at the chip
   * wherever there is a pointer and room, the thumb-reach sheet on a phone — sending through the same
   * runtime route, so Info never grows a second picker that could disagree with the composer's. A host
   * that hands Info its own (`infoRuntimeControls`) wins; a daemon without the runtime route gets none.
   * Info's copy draws its popover or sheet at the document root: on a phone Info is itself a moving
   * sheet, and a sheet opened inside it would be placed against Info instead of the screen.
   */
  const runtimePickers = (portalOverlays: boolean): ReactNode =>
    runtimeApi === null ? null : (
      <ComposerRuntime
        portalOverlays={portalOverlays}
        busy={runtimeSwitchBusy}
        canControl={canControl}
        // A phone keeps the thumb-reach sheet; anything with a pointer and room
        // gets a small menu at the chip instead of a window-wide panel.
        presentation={formFactor === 'phone' ? 'sheet' : 'popover'}
        renderEffortControls={lifecycle => (
          <RuntimeEffortControls
            api={runtimeApi}
            canControl={canControl}
            catalogs={routedRuntimeCatalogs}
            daemon={connection}
            onOpenTerminal={openConsole}
            view={session}
            {...lifecycle}
          />
        )}
        renderFast={() => (
          <FastToggle
            api={runtimeApi}
            busy={runtimeSwitchBusy}
            canControl={canControl}
            catalogs={routedRuntimeCatalogs}
            daemon={connection}
            view={session}
          />
        )}
        renderModelControls={lifecycle => (
          <RuntimeModelControls
            api={runtimeApi}
            canControl={canControl}
            catalogs={routedRuntimeCatalogs}
            daemon={connection}
            onOpenTerminal={openConsole}
            view={session}
            {...lifecycle}
            open={lifecycle.open}
          />
        )}
        view={session}
      />
    );
  const infoControls = infoRuntimeControls ?? runtimePickers(true) ?? undefined;

  /**
   * INFO — every LOOK for this ferret. The Context tab is the old "This folder" rail (Files, Instructions,
   * Skills and MCP, each server and skill with its scope), and Signals adds the Warden's verdicts to its
   * attention.
   * Keyed on the session's NAME and RUNTIME rather than the view: a status tick rebuilds the view, and a
   * fresh loader identity would re-read every tab for nothing.
   */
  const infoPorts = useMemo<SessionInfoPorts | undefined>(() => {
    if (contextDependencies === undefined) return undefined;
    const createClient = contextDependencies.createFleetClient;
    return {
      worktrees: async signal =>
        (await (await routedClient(connection)).request('/v1/worktrees', WorktreeListResponseSchema, { signal }))
          .worktrees,
      verdicts: async () => await (await routedClient(connection)).wardenVerdicts(),
      analytics: async () =>
        await fetchSessionAnalytics(connection, scope, `sum ${analyticsIdQuery(scope.sessionId)}`, referenceFetch),
      relaunch: async signal => await readRelaunchSettings(connection, scope, referenceFetch, signal),
      folder: {
        agentName,
        sessionId: scope.sessionId,
        machineName: contextDependencies.machineName,
        signals: attentionSignalsPort(contextDependencies.attention, connection, scope),
        loadMcp: sessionMcpLoader(connection, createClient, scope.sessionId),
        loadSkills: sessionSkillsInventoryLoader(connection, createClient, scope.sessionId),
        loadSkillFile: skillFileLoader(connection, createClient, scope.sessionId),
        loadDocs: instructionDocsLoader(connection, scope, referenceFetch),
        onInsertSkill: invocation => {
          addSkillInvocationToComposer(invocation, scope);
        },
        onOpenFile: path => openFile(path),
        mcpSignIn: { connection, createClient, machineName: contextDependencies.machineName },
        onAddMcp: () => setActionForm(SESSION_ACTION_IDS.addMcp),
      },
    };
  }, [contextDependencies, connection, scope, referenceFetch, openFile, agentName, routedClient]);
  const infoSlot: SessionInfoSlot | undefined =
    infoPorts === undefined
      ? undefined
      : {
          open: info.open,
          onClose: info.close,
          sheetSize: info.sheetSize,
          render: (presentation, titleId) => (
            <SessionInfo
              browser={browserPages.status}
              driving={driving}
              name={agentName}
              onOpenAnalytics={() => setUtility('analytics')}
              onOpenPage={page => openSurface('browser', page.name ?? page.id, browserPageLabel(page))}
              onOpenTasks={openTasks}
              onOpenTerminal={(id, label) => openSurface('terminal', id, label)}
              placement={info}
              ports={{
                ...infoPorts,
                folder: {
                  ...infoPorts.folder,
                  renderFiles: () => (
                    <FilesTab
                      daemon={connection}
                      markdown={references}
                      onOpenFile={(path, selection) => openFile(path, selection)}
                      scope={scope}
                      {...(session.config.cwd === undefined ? {} : { cwd: session.config.cwd })}
                    />
                  ),
                },
              }}
              presentation={presentation}
              project={project}
              quota={quota}
              terminals={terminals}
              titleId={titleId}
              view={session}
              write={copyText}
              {...(daemonSessions === undefined ? {} : { sessions: daemonSessions })}
              {...(canControl ? { onRename: () => setActionForm(SESSION_ACTION_IDS.rename) } : {})}
              {...(onNavigate === undefined
                ? {}
                : { onOpenSession: (id: string) => onNavigate(daemonSessionPath(connection.daemonId, id)) })}
              {...(infoControls === undefined ? {} : { runtimeControls: infoControls })}
              {...(infoLearning === undefined ? {} : { learning: infoLearning })}
              {...(canControl && !TERMINAL_STATUSES.has(session.state.status)
                ? { onRestart: restartSurfacingRefusal }
                : {})}
            />
          ),
        };

  const parentSession = daemonSessions?.find(candidate => candidate.config.id === session.config.parent);
  const startedBy =
    parentSession === undefined || onNavigate === undefined
      ? undefined
      : {
          name: lineageLabel(parentSession).text,
          onOpen: () => onNavigate(daemonSessionPath(connection.daemonId, parentSession.config.id)),
        };

  const header = (): ReactNode => (
    <>
      <SessionTopBar
        actions={lifecycleActions}
        attentionOpen={attention?.snapshot?.items.length ?? session.state.attention?.open ?? 0}
        turn={turn}
        compact={compact}
        infoOpen={info.open}
        menu={actionsMenu}
        project={project}
        session={session}
        status={
          <>
            {liveSample?.compaction?.phase === 'running' ? <CompactionChip compaction={liveSample.compaction} /> : null}
            {/* THE LIVE FEED'S OWN STATE, folded into the status dot: nothing visible while it is
                healthy, a word and Reconnect once it is not — on a phone too, which is where a screen
                lock or a Wi-Fi roam most often drops the socket. */}
            {liveStream === undefined ? null : <LiveStreamIndicator {...liveStream} compact={compact} quiet />}
          </>
        }
        {...(infoSlot === undefined ? {} : { onToggleInfo: info.toggle })}
        {...(onOpenSessions === undefined ? {} : { onOpenSessions })}
        {...(startedBy === undefined ? {} : { startedBy })}
        {...(switches === undefined
          ? {}
          : {
              switches: {
                learning: infoLearning === true,
                hypermedia: switches.hypermedia,
                pack: switches.pack,
                ...(canControl ? { onToggle: switches.onToggle } : {}),
              },
            })}
        subFerrets={
          <SubFerretIndicator
            sessions={subFerretsOf(session.config.id, daemonSessions ?? [])}
            {...(onNavigate === undefined
              ? {}
              : { onOpenSession: (id: string) => onNavigate(daemonSessionPath(connection.daemonId, id)) })}
          />
        }
      />
      {/* NOT a live region. App.tsx owns the single announcement for a refresh
        failure and hands down a finished sentence; a second `role=status`
        here made assistive tech say it twice, and a prefix added here would
        have made the two disagree. Rendered only when there is something to
        render, precisely because it announces nothing. */}
      {reconnecting ? null : transcriptUnbound ? (
        <TranscriptUnboundNotice
          onCheckAgain={() => onRefresh?.()}
          {...(canControl ? { onRestart: restartSurfacingRefusal } : {})}
        />
      ) : refreshError === null ? null : (
        <CompactIssue sentence={refreshError} />
      )}
      {actionAlert}
      {restartRefusal.panel}
    </>
  );
  // The text column and the composer share one measure (`.kt-chat-surface`, styles/index.css); the
  // composer's row reserves the transcript scrollbar's width so both centre on one axis.
  const shownAttention = shownAttentionItem(attention?.snapshot ?? null, attentionSelected);
  chipRef.current = { id: shownAttention?.id ?? null, on: answerChipOn };
  const composerClient = useMemo(() => withAnswerPrefix(client, () => chipRef.current), [client]);
  const chat = (
    <div className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col" data-chat-width={chatWidth} ref={chatSurface}>
      {/* A zero-height row, so the pill overlays the top of the transcript without moving a line of it. */}
      {updating ? (
        <div className="relative h-0">
          <CacheUpdating className="absolute left-1/2 top-2 z-10 -translate-x-1/2" />
        </div>
      ) : null}
      <div className="fy-chat-log">
        <Transcript
          activity={pane.activity}
          activityFallback={session.state.activity ?? null}
          live={liveSample}
          turnStartedAt={working ? (session.state.turnStateAt ?? null) : null}
          agentName={agentName}
          busy={busy}
          daemonId={connection.daemonId}
          entries={entries}
          {...(onRetry === undefined ? {} : { onRetry })}
          {...(onCancel === undefined ? {} : { onCancel })}
          {...(onSubmit === undefined ? {} : { onSubmit })}
          {...(onDismiss === undefined ? {} : { onDismiss })}
          {...(onExpand === undefined ? {} : { onExpand })}
          pinSignal={pinSignal}
          {...(readingPosition === undefined ? {} : { readingPosition })}
          sessionId={session.config.id}
        />
      </div>
      <div className="fy-chat-input" data-safe-bottom="" data-session-input="">
        <div className="fy-chat-input__column">
          {/* THE PINNED ASK, above the composer: the open item as a block, always visible. Keyed on the
              scope, so a card busy state or refusal never survives into another session. */}
          {attention === undefined ? null : (
            <AttentionPanel
              chip={{ on: answerChipOn, onChange: setAnswerChipOn }}
              client={attention.client}
              connection={connection}
              focus={attentionFocus}
              id={attentionId}
              repliesSlot={
                attentionReplies === undefined ? undefined : (
                  <AttentionRepliesNotice
                    ferret={sessionDisplayName(session)}
                    onSendNow={attentionReplies.sendNow}
                    secondsLeft={attentionReplies.secondsLeft}
                    sending={attentionReplies.sending}
                  />
                )
              }
              key={`${connection.daemonId}:${session.config.id}`}
              onOpenResolved={openResolved}
              onSelect={setAttentionSelected}
              scope={scope}
              selectedId={attentionSelected}
              snapshot={attention.snapshot}
              status={attention.status}
            />
          )}
          {permissionRequest === undefined || !canControl ? null : (
            <ApprovalCard
              agentName={sessionDisplayName(session)}
              api={permissionApi}
              daemon={connection}
              key={`${connection.daemonId}:${session.config.id}:${permissionRequest.id}`}
              onSettled={onRefresh}
              request={permissionRequest}
              scope={scope}
            />
          )}
          {harnessDialog === undefined || !canControl ? null : (
            <DialogCard
              agentName={sessionDisplayName(session)}
              api={dialogApi}
              daemon={connection}
              key={`${connection.daemonId}:${session.config.id}:${harnessDialog.id}`}
              dialog={harnessDialog}
              onSettled={onRefresh}
              scope={scope}
            />
          )}
          {question !== null && canControl ? (
            <QuestionForm
              api={questionApi}
              daemon={connection}
              key={`${connection.daemonId}:${session.config.id}:${question.toolUseId}`}
              onOpenConsole={openConsole}
              question={question}
              sessionId={session.config.id}
            />
          ) : awaitingAnswer ? (
            /* Status without a validated payload is damaged or incomplete
           evidence, never an empty question. Keep the recovery action
           visible, but do not invent options or send an unbound answer. */
            <section
              aria-label="Structured question"
              className="fy-question-form"
              data-question-unavailable=""
              role="status"
            >
              <p className="m-0">
                This session reports a structured question, but its complete validated prompt is unavailable. No answer
                can be sent safely; refresh the session or interrupt the turn to abandon it.
              </p>
            </section>
          ) : (
            <Composer
              api={composerClient}
              {...(composerFetch === undefined ? {} : { autocompleteFetcher: composerFetch })}
              {...(daemonSessions === undefined ? {} : { autocompleteSessions: daemonSessions })}
              {...(composerCatalogs.attention === undefined
                ? {}
                : { autocompleteAttention: composerCatalogs.attention })}
              {...(composerCatalogs.skills?.skills === undefined
                ? {}
                : { autocompleteSkills: composerCatalogs.skills })}
              // The in-flight owner reads: a menu opened before they settle waits
              // instead of inventing an empty family or fetching a fact twice.
              autocompleteReady={composerCatalogs.settled}
              busy={busy}
              compact={compact}
              {...(composerSuggestions === undefined ? {} : { suggestions: composerSuggestions })}
              vimMode={composerVimMode}
              {...(dictationSettings === undefined ? {} : { dictationSettings })}
              dictationConversation={readDictationConversation}
              enterKeyPreference={composerEnterKey}
              phoneEnterKeyPreference={composerPhoneEnterKey}
              daemon={connection}
              disabled={TERMINAL_STATUSES.has(session.state.status) || !canControl}
              onSent={onSent}
              connectionLive={connectionState?.kind === 'connected'}
              quota={quota}
              sessionId={session.config.id}
              {...(session.state.contextPercent === undefined ? {} : { contextPercent: session.state.contextPercent })}
              // The model and effort chips ride the composer's own status line, so the
              // runtime costs no row of its own above the message box.
              statusSlot={runtimePickers(false)}
            />
          )}
        </div>
      </div>
    </div>
  );

  return (
    // Every Markdown reader inside the conversation — transcript prose, notices, file previews in the
    // workspace and whatever a later item renders here — reads references through this one surface.
    <ReferenceSurfaceProvider surface={references}>
      {/* The cards a ferret's Pack commands become say how each sub-ferret is doing NOW, from this list. */}
      <PackSessionsProvider sessions={daemonSessions}>
        {/* A message handed to the agent through a file is read back through the same daemon client, so the
          transcript shows what the person sent rather than the pointer the agent was typed. */}
        <HandoffSourceProvider source={handoffs}>
          <SessionSearchWorkspaceActions openFile={openFile} openTasks={openTasks} scope={scope} />
          {/* `overflow-clip`, not `-hidden`: a hidden box is still a scroll container, so focusing the
          composer could scroll the whole session sideways and leave the header off the left edge. */}
          <main
            className="flex h-full min-h-0 min-w-0 flex-col overflow-clip"
            data-daemon={connection.daemonId}
            data-session={session.config.id}
          >
            <SessionWorkspace
              agentSurfaces={agentSurfaces}
              // The in-app browser host around the chat: under Settings › Appearance › "Open links in" ›
              // Ferretry side panel, a tapped link opens BESIDE the conversation on a desktop, and as a
              // sheet over it on a tablet or phone, where two columns would leave the chat unreadable.
              chat={<InAppBrowserWorkspace compact={formFactor !== 'desktop'}>{chat}</InAppBrowserWorkspace>}
              connection={connection}
              driving={driving}
              formFactor={formFactor}
              references={references}
              renderHeader={header}
              rails={workspaceRails}
              session={session}
              workspace={workspace}
              {...(infoSlot === undefined ? {} : { info: infoSlot })}
              {...(deck === undefined ? {} : { deck })}
              {...(readSnapshot === undefined ? {} : { readSnapshot })}
              {...(typeIntoConsole === undefined ? {} : { typeIntoConsole })}
              {...(browser === undefined ? {} : { browser })}
              browserPages={browserPages}
            />
            <ActionToast notice={actionNotice} onDismiss={dismissActionNotice} />
            <BottomSheet
              ariaLabel={utility === null ? 'Session tool' : UTILITY_LABEL[utility]}
              closeLabel="Close"
              id={utilityId}
              onClose={() => setUtility(null)}
              open={utility !== null}
              panelClassName="bg-surface"
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-session-utility={utility ?? ''}>
                {utility === 'tasks' ? <SessionTasksSearchSurface /> : null}
                {utility === 'analytics' ? <SessionAnalyticsSurface connection={connection} scope={scope} /> : null}
              </div>
            </BottomSheet>
            {convert.sheet}
            <MigrateSheet
              {...(accountPicker === undefined ? {} : { accountPicker })}
              canMutate={canControl}
              connection={connection}
              onClose={() => setMigrateOpen(false)}
              onMigrated={(_daemon, _scope, view) => publish(view)}
              open={migrateOpen}
              scope={scope}
              {...(usage === undefined ? {} : { usage })}
              view={session}
            />
          </main>
        </HandoffSourceProvider>
      </PackSessionsProvider>
    </ReferenceSurfaceProvider>
  );
}
