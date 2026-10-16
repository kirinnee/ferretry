import type { AttentionId, AttentionItem, AttentionSnapshot, IFyApiClient, SessionView } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Composer } from '../../components/composer.tsx';
import type { ComposerSuggestionSwitches } from '../../components/composer-autocomplete.ts';
import { ComposerRuntime } from '../../components/composer-runtime.tsx';
import { type PaneFrameReader, usePaneActivity } from '../../components/live-activity.tsx';
import { LiveStreamIndicator, type LiveStreamIndicatorProps } from '../../components/live-stream-indicator.tsx';
import { MigrateSheet } from '../../components/migrate-sheet.tsx';
import { type QuestionAnswerApi, QuestionForm } from '../../components/question-form.tsx';
import { ReferenceSurfaceProvider, sessionReferenceSurface } from '../../components/reference-surface.tsx';
import {
  isPromptKnownBusy,
  type RuntimeControlApi,
  RuntimeEffortControls,
  type RuntimeModelCatalogSource,
  RuntimeModelControls,
} from '../../components/runtime-controls.tsx';
import { SessionDetails } from '../../components/session-details.tsx';
import { SessionSurfaceReferences } from '../../components/session-surface-references.tsx';
import type { TerminalDeckDependencies } from '../../components/session-terminal-deck.tsx';
import { SessionTopBar, sessionDisplayName } from '../../components/session-top-bar.tsx';
import type { PaneSnapshotReader } from '../../components/terminal-snapshot.tsx';
import { readPaneSnapshot } from '../../components/terminal-snapshot-model.ts';
import { Transcript } from '../../components/transcript.tsx';
import { SessionAnalyticsSurface } from '../../features/analytics/session-analytics-surface.tsx';
import { type AttentionActionClient, AttentionActionModal } from '../../features/attention/attention-action-modal.tsx';
import type { UnifiedBrowserDependencies } from '../../features/browser/unified-browser-surface.tsx';
import {
  attentionSignalsPort,
  fleetMcpLoader,
  instructionDocsLoader,
  sessionSkillsLoader,
} from '../../features/context-rail/context-rail-ports.ts';
import type { FleetClientFactory } from '../../features/fleet/fleet-client.ts';
import { LineageSurfaceContent } from '../../features/lineage/lineage-surface.tsx';
import { SessionTasksSearchSurface, useSessionSearch } from '../../features/session-search/session-search.tsx';
import { useSessionSkills } from '../../features/skills/session-skills-store.ts';
import { addSkillInvocationToComposer } from '../../features/skills/skills-composer.ts';
import type { WorkspaceFormFactor } from '../../features/workspace/phone/phone-tab.ts';
import {
  type SessionContextRailProps,
  SessionWorkspace,
  useContextPlacement,
} from '../../features/workspace/session-workspace.tsx';
import { useSessionWorkspace } from '../../features/workspace/use-session-workspace.ts';
import { useSurfaceDriving } from '../../features/workspace/use-surface-driving.ts';
import { useSessionTerminals, useWorkspaceFormFactor } from '../../features/workspace/use-workspace-environment.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import type { ContextMenuItem } from '../../shell/context-menu.tsx';
import { Button } from '../../shell/primitives.tsx';
import { type SessionAction, type SessionActionSpec, sessionActionSpecs } from '../../shell/session-actions.ts';
import type { SidePaneTabPresentation } from '../../shell/side-pane-tab-model.ts';
import { statusMark, TERMINAL_STATUSES } from '../../shell/status-mark.tsx';
import type { DaemonAccountPickerStore } from '../account-picker-store.ts';
import { agentReferenceIdentityKey } from '../agent-references.ts';
import type { DaemonAttentionClient } from '../attention-client.ts';
import type { AttentionLoadStatus } from '../attention-store.ts';
import type { DaemonBrowserLoginStore } from '../browser-login.ts';
import type { ComposerEnterKeyPreference } from '../composer-keybinding.ts';
import { useComposerReferenceCatalogs } from '../composer-reference-catalogs.ts';
import type { ChatWidthPreference } from '../controls.ts';
import type { DaemonConnection } from '../daemon-connection.ts';
import { sameDaemonConnection } from '../daemon-connection.ts';
import { type DaemonSessionScope, daemonSessionScope } from '../daemon-scope.ts';
import type { DaemonPinClient } from '../pin-client.ts';
import type { DaemonFetch } from '../runtime-models.ts';
import { DaemonRuntimeModelCatalogStore } from '../runtime-models.ts';
import type { TranscriptEntry } from '../session-screens.ts';
import { useDaemonFetch } from '../store.tsx';
import type { SttSettings } from '../stt/stt-settings.ts';
import type { DaemonUsageStore } from '../usage-store.ts';
import { WorkspaceLayoutStore } from '../workspace-layout-store.ts';
import { WorkspaceRailPreferenceStore } from '../workspace-rail-preferences.ts';

/** Only daemon operations this workspace can truthfully invoke. */
export type SessionChatClient = Pick<IFyApiClient, 'answer' | 'interrupt' | 'resume' | 'send' | 'stop'> &
  Partial<Pick<IFyApiClient, 'history' | 'request' | 'runtime'>>;

/** One scoped cache is safe because every key carries its daemon id. Keeping it
 * outside the page also avoids re-reading a live account catalog whenever the
 * transcript refreshes. */
const runtimeModelCatalogs = new DaemonRuntimeModelCatalogStore();

/** One array for "this host passed no Attention model", so the memos below hold. */
const NO_ATTENTION_ITEMS: readonly AttentionItem[] = [];

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
  /** The reader's chat measure. `full` is the shipped default and is uncapped. */
  readonly chatWidth?: ChatWidthPreference;
  /** Browser-local transcript composer key preference. */
  readonly composerEnterKey?: ComposerEnterKeyPreference | null;
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
  /** Test seam for the read-only terminal fallback. */
  readonly readSnapshot?: PaneSnapshotReader;
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
}

/** The app-store bindings the context rail needs, beyond what the page already holds. */
interface SessionContextDependencies {
  readonly attention: DaemonAttentionClient;
  readonly createFleetClient: FleetClientFactory;
  /** The machine's own name, as the MCP sign-in sheet says it. */
  readonly machineName: string;
}

const defaultWorkspaceLayouts = new WorkspaceLayoutStore();
const defaultWorkspaceRails = new WorkspaceRailPreferenceStore();

/** The tools that used to live in the side pane and are not workspace tabs: each opens in a sheet. */
type SessionUtility = 'tasks' | 'terminals' | 'lineage' | 'analytics';

const UTILITY_LABEL: Readonly<Record<SessionUtility, string>> = {
  tasks: 'Tasks',
  terminals: 'Terminal references',
  lineage: 'Lineage',
  analytics: 'Analytics for this session',
};

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
  chatWidth = 'full',
  composerEnterKey,
  composerSuggestions,
  composerVimMode = false,
  composerFetch,
  dictationSettings,
  onSessionChange,
  onRefresh,
  readSnapshot,
  deck,
  daemonSessions,
  onNavigate,
  attention,
  liveStream,
  project = null,
  onOpenSessions,
  copyText = browserCopyText,
  workspaceLayouts = defaultWorkspaceLayouts,
  workspaceRails = defaultWorkspaceRails,
  formFactor: formFactorOverride,
  context: contextDependencies,
  browser,
}: SessionChatPageProps) {
  const scope = useMemo(() => daemonSessionScope(connection, session.config.id), [connection, session.config.id]);
  const measuredFormFactor = useWorkspaceFormFactor();
  // A drawer layout is a phone whatever the window measures: the app shell has already decided so.
  const formFactor = formFactorOverride ?? (presentation === 'sheet' ? 'phone' : measuredFormFactor);
  const workspace = useSessionWorkspace(workspaceLayouts, scope);
  const placement = useContextPlacement(formFactor);
  const driving = useSurfaceDriving(scope);
  const terminals = useSessionTerminals(deck, connection, scope);
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
  const [attentionOpen, setAttentionOpen] = useState(false);
  const [attentionTarget, setAttentionTarget] = useState<AttentionId | null>(null);
  const attentionOpener = useRef<HTMLElement | null>(null);
  const attentionItems = attention?.snapshot?.items ?? NO_ATTENTION_ITEMS;
  const attentionIds = useMemo(() => attentionItems.map(item => item.id), [attentionItems]);
  // The ledger's IDENTITY, not its array identity: a re-hydration that returns
  // the same unresolved ids must not rebuild the reference surface and re-parse
  // every Markdown block in the transcript.
  const attentionKey = attentionIds.join(',');
  const openAttention = useCallback((id: AttentionId | null, opener?: HTMLElement | null): void => {
    attentionOpener.current = opener ?? null;
    setAttentionTarget(id);
    setAttentionOpen(true);
  }, []);
  const closeAttention = useCallback((): void => {
    setAttentionOpen(false);
    setAttentionTarget(null);
    // A reference link can be scrolled out of the transcript, or re-rendered
    // into a different node, while the sheet is open — so the element that
    // opened it may simply not be there to return to. The trigger always is.
    const opener = attentionOpener.current;
    attentionOpener.current = null;
    if (opener?.isConnected) opener.focus();
    // No document at all in a renderer or SSR pass: there is nothing to focus
    // and nothing to fail about, so the fallback simply does not apply.
    else if (typeof document !== 'undefined') document.getElementById(`${attentionId}-trigger`)?.focus();
  }, [attentionId]);
  const composerCatalogs = useComposerReferenceCatalogs(client, session.config.id, {
    tasks: referenceTasks,
    skills: skills.catalog,
    waitForTasks: search.waitForTasks,
    waitForSkills: skills.settled,
    ...(search.taskState === 'unavailable' && search.taskError !== null ? { taskFailure: search.taskError } : {}),
  });
  /** Codex's native model picker is in the agent's own pane: the runtime sheet's way there is the Console. */
  const { showAgentTab, openFile, openSurface } = workspace;
  const openConsole = useCallback((): boolean => {
    showAgentTab('console');
    return true;
  }, [showAgentTab]);
  const openTasks = useCallback(() => setUtility('tasks'), []);
  const { reveal } = placement;
  // Where a proved reference opens: the workspace's tabs, and the context rail for a skill. ONE click
  // behaviour still — Markdown calls the surface — with these as its destinations.
  const referenceDestinations = useMemo(
    () => ({
      openFile: (path: string, selection?: Parameters<typeof openFile>[1]) => openFile(path, selection),
      openSurface: (reference: { readonly surface: 'terminal' | 'browser'; readonly key: string }) =>
        openSurface(reference.surface, reference.key),
      openTasks,
      openSkills: () => reveal('skills'),
    }),
    [openFile, openSurface, openTasks, reveal],
  );
  // THE session's one reference surface. The memo key over the fleet is the
  // identity of the fields the resolver actually copies, so status and activity
  // churn cannot rebuild the surface and re-parse every rendered Markdown block
  // in the transcript (`agentReferenceIdentityKey`).
  const fleetIdentity =
    daemonSessions === undefined ? null : agentReferenceIdentityKey(connection.daemonId, daemonSessions);
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
        ...(composerCatalogs.attention === undefined
          ? {}
          : { attentionIds: composerCatalogs.attention.map(item => item.id) }),
        ...(composerCatalogs.skills?.skills === undefined
          ? {}
          : { skills: composerCatalogs.skills.skills.map(skill => skill.name) }),
        ...(onNavigate === undefined ? {} : { onNavigate }),
        ...(terminals === null ? {} : { terminals }),
        destinations: referenceDestinations,
        // Both halves or neither. The ledger alone proves `!A3` without giving
        // it anywhere to go, and an opener alone would link an unproved id — so
        // a host that has not subscribed leaves the token as prose, which the
        // reference standard calls the only honest state.
        ...(attention === undefined ? {} : { attentionIds, onAttentionOpen: openAttention }),
      }),
    [
      connection,
      referenceFetch,
      scope,
      session.config.cwd,
      fleetIdentity,
      composerCatalogs.tasks,
      composerCatalogs.attention,
      composerCatalogs.skills,
      onNavigate,
      attention === undefined,
      attentionKey,
      openAttention,
      terminals,
      referenceDestinations,
    ],
  );
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pendingAction, setPendingAction] = useState<SessionAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const live = useRef({ connection, sessionId: session.config.id });
  live.current = { connection, sessionId: session.config.id };

  // Pairing/session identity is deliberately the reset trigger for local sheet
  // and action state, even though the body only writes React state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger
  useEffect(() => {
    setDetailsOpen(false);
    setMigrateOpen(false);
    setConfirmStop(false);
    setPendingAction(null);
    setActionError(null);
    // Attention belongs to the session that raised it. Carrying an open modal —
    // or worse, a requested `!A3` — across a navigation would offer one
    // session's ask over another session's board, so the whole trio resets with
    // the pairing and the session id.
    setAttentionOpen(false);
    setAttentionTarget(null);
    attentionOpener.current = null;
  }, [connection, session.config.id]);

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

  const runAction = async (action: SessionAction): Promise<void> => {
    if (action === 'migrate') {
      setMigrateOpen(true);
      return;
    }
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
  const busy = statusMark(session).klass === 'active';
  // The harness's own status line, read off its pane while — and only while — the session works.
  const readActivityFrame = useCallback<PaneFrameReader>(
    async signal => await readPaneSnapshot(connection, scope, signal, referenceFetch, true),
    [connection, referenceFetch, scope],
  );
  const paneActivity = usePaneActivity(readActivityFrame, busy);
  /**
   * THE RUNTIME CHIPS ASK A DIFFERENT QUESTION THAN THE TRANSCRIPT DOES.
   *
   * `busy` above is session LIVENESS — is there work happening — and that is the
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
  const compact = presentation === 'sheet';
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
    <p className={actionError === null ? 'sr-only' : 'm-0 px-3 py-1 text-ui text-err'} role="alert">
      {actionError === null ? '' : `Session action failed: ${actionError}`}
    </p>
  );
  const copySessionId = (): void => {
    setActionError(null);
    copyText(session.config.id).catch((reason: unknown) =>
      setActionError(`could not copy the session id: ${actionFailureMessage(reason)}`),
    );
  };
  /**
   * ⋯ — everything that used to sit on screen permanently. Files opens the workspace's Files picker and
   * Console shows the agent's own pane; the tools that are not workspace tabs (tasks, lineage,
   * analytics) open in a sheet. Stop is here on a phone only, where the bar keeps one button.
   */
  const menuItems: readonly ContextMenuItem[] = [
    { key: 'files', label: 'Files', onSelect: workspace.openFilePicker },
    { key: 'console', label: 'Console', onSelect: () => showAgentTab('console') },
    ...(['tasks', 'terminals', 'lineage', 'analytics'] as const).map(key => ({
      key,
      label: UTILITY_LABEL[key],
      onSelect: () => setUtility(key),
    })),
    ...(attention === undefined ? [] : [{ key: 'attention', label: 'Attention', onSelect: () => openAttention(null) }]),
    ...actions
      .filter(spec => spec.action === 'migrate')
      .map(spec => ({
        key: spec.action,
        label: 'Move to another login…',
        onSelect: () => void runAction(spec.action),
      })),
    { key: 'copy-id', label: 'Copy session id', onSelect: copySessionId },
    { key: 'details', label: 'Session details', onSelect: () => setDetailsOpen(true) },
    ...(compact
      ? actions
          .filter(spec => spec.action === 'stop')
          .map(spec => ({
            key: spec.action,
            label: spec.label,
            danger: true,
            onSelect: () => void runAction(spec.action),
          }))
      : []),
  ];
  const needsYou =
    attention === undefined || attentionItems.length === 0 ? null : (
      <button
        aria-controls={attentionId}
        aria-expanded={attentionOpen}
        aria-label={`Needs you: ${attentionItems.length} unanswered`}
        className="fy-needs-you"
        data-needs-you={attentionItems.length}
        id={`${attentionId}-trigger`}
        onClick={event => openAttention(null, event.currentTarget)}
        type="button"
      >
        needs you
      </button>
    );

  // Keyed on the session's NAME and RUNTIME rather than the view: a status tick rebuilds the view, and
  // a fresh loader identity would re-read every sub-tab of the rail for nothing.
  const agentName = sessionDisplayName(session);
  const runtime = session.config.agent;
  const rail = useMemo<SessionContextRailProps | undefined>(
    () =>
      contextDependencies === undefined
        ? undefined
        : {
            agentName,
            signals: attentionSignalsPort(contextDependencies.attention, connection, scope),
            loadMcp: fleetMcpLoader(connection, contextDependencies.createFleetClient, runtime),
            loadSkills: sessionSkillsLoader(skills.load, scope),
            loadDocs: instructionDocsLoader(connection, scope, referenceFetch),
            onInsertSkill: invocation => {
              addSkillInvocationToComposer(invocation, scope);
            },
            onOpenFile: path => openFile(path),
            mcpSignIn: {
              connection,
              createClient: contextDependencies.createFleetClient,
              machineName: contextDependencies.machineName,
            },
          },
    [contextDependencies, connection, scope, skills.load, referenceFetch, openFile, agentName, runtime],
  );
  const header = (contextButton: ReactNode): ReactNode => (
    <>
      <SessionTopBar
        actions={
          <>
            {lifecycleActions}
            {contextButton}
          </>
        }
        compact={compact}
        menuItems={menuItems}
        project={project}
        session={session}
        status={
          <>
            {needsYou}
            {/* THE LIVE FEED'S OWN STATE, folded into the status dot: nothing visible while it is
                healthy, a word and Reconnect once it is not — on a phone too, which is where a screen
                lock or a Wi-Fi roam most often drops the socket. */}
            {liveStream === undefined ? null : <LiveStreamIndicator {...liveStream} quiet />}
          </>
        }
        {...(onOpenSessions === undefined ? {} : { onOpenSessions })}
      />
      {/* NOT a live region. App.tsx owns the single announcement for a refresh
        failure and hands down a finished sentence; a second `role=status`
        here made assistive tech say it twice, and a prefix added here would
        have made the two disagree. Rendered only when there is something to
        render, precisely because it announces nothing. */}
      {refreshError === null ? null : <p className="m-0 px-3 py-1 text-ui text-warn">{refreshError}</p>}
      {actionAlert}
    </>
  );
  const chat = (
    <div className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col" data-chat-width={chatWidth}>
      <div className="grid min-h-0 flex-1">
        <Transcript
          activity={paneActivity}
          activityFallback={session.state.activity ?? null}
          busy={busy}
          daemonId={connection.daemonId}
          entries={entries}
          sessionId={session.config.id}
        />
      </div>
      <div className="shrink-0 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" data-session-input="">
        {question !== null && canControl ? (
          <QuestionForm
            api={questionApi}
            compact={compact}
            daemon={connection}
            key={`${connection.daemonId}:${session.config.id}:${question.toolUseId}`}
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
            api={client}
            {...(composerFetch === undefined ? {} : { autocompleteFetcher: composerFetch })}
            {...(daemonSessions === undefined ? {} : { autocompleteSessions: daemonSessions })}
            {...(composerCatalogs.attention === undefined ? {} : { autocompleteAttention: composerCatalogs.attention })}
            {...(composerCatalogs.skills?.skills === undefined ? {} : { autocompleteSkills: composerCatalogs.skills })}
            // The in-flight owner reads: a menu opened before they settle waits
            // instead of inventing an empty family or fetching a fact twice.
            autocompleteReady={composerCatalogs.settled}
            busy={busy}
            compact={compact}
            {...(composerSuggestions === undefined ? {} : { suggestions: composerSuggestions })}
            vimMode={composerVimMode}
            {...(dictationSettings === undefined ? {} : { dictationSettings })}
            enterKeyPreference={composerEnterKey}
            daemon={connection}
            disabled={TERMINAL_STATUSES.has(session.state.status) || !canControl}
            onSent={onRefresh}
            quota={session.state.quota}
            sessionId={session.config.id}
            {...(session.state.contextPercent === undefined ? {} : { contextPercent: session.state.contextPercent })}
            // The model and effort chips ride the composer's own status line, so the
            // runtime costs no row of its own above the message box.
            statusSlot={
              runtimeApi === null ? null : (
                <ComposerRuntime
                  busy={runtimeSwitchBusy}
                  canControl={canControl}
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
              )
            }
          />
        )}
      </div>
    </div>
  );

  return (
    // Every Markdown reader inside the conversation — transcript prose, notices, file previews in the
    // workspace and whatever a later item renders here — reads references through this one surface.
    <ReferenceSurfaceProvider surface={references}>
      <SessionSearchWorkspaceActions openFile={openFile} openTasks={openTasks} scope={scope} />
      <main
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
        data-daemon={connection.daemonId}
        data-session={session.config.id}
      >
        <SessionWorkspace
          chat={chat}
          connection={connection}
          context={placement}
          driving={driving}
          formFactor={formFactor}
          references={references}
          renderHeader={header}
          rails={workspaceRails}
          session={session}
          workspace={workspace}
          {...(rail === undefined ? {} : { rail })}
          {...(deck === undefined ? {} : { deck })}
          {...(readSnapshot === undefined ? {} : { readSnapshot })}
          {...(browser === undefined ? {} : { browser })}
        />
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
            {/* Every shell this session holds, with the token that names it and Add to chat. */}
            {utility === 'terminals' ? (
              <div className="p-panel">
                <SessionSurfaceReferences connection={connection} scope={scope} />
              </div>
            ) : null}
            {utility === 'analytics' ? <SessionAnalyticsSurface connection={connection} scope={scope} /> : null}
            {utility === 'lineage' ? (
              daemonSessions === undefined ? (
                <p className="m-3 text-ui text-muted" role="status">
                  Loading lineage…
                </p>
              ) : (
                <LineageSurfaceContent
                  daemonId={connection.daemonId}
                  sessionId={session.config.id}
                  sessions={daemonSessions}
                  {...(onNavigate === undefined ? {} : { onNavigate })}
                />
              )
            ) : null}
          </div>
        </BottomSheet>
        <BottomSheet
          ariaLabel="Session details"
          closeLabel="Close session details"
          id={detailsId}
          onClose={() => setDetailsOpen(false)}
          open={detailsOpen}
          panelClassName="kt-details bg-surface"
        >
          <SessionDetails daemonId={connection.daemonId} onClose={() => setDetailsOpen(false)} session={session} />
        </BottomSheet>
        {/* Inside the reference provider, so Attention prose reads the SAME
            grammar the transcript does — including a `!A3` that re-targets
            this very sheet. */}
        {attention === undefined ? null : (
          <AttentionActionModal
            client={attention.client}
            connection={connection}
            id={attentionId}
            onClose={closeAttention}
            open={attentionOpen}
            scope={scope}
            snapshot={attention.snapshot}
            status={attention.status}
            swipeEnabled={compact}
            targetId={attentionTarget}
          />
        )}
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
    </ReferenceSurfaceProvider>
  );
}
