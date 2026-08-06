import type { AttentionId, AttentionItem, AttentionSnapshot, IFyApiClient, SessionView } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Composer } from '../../components/composer.tsx';
import type { ComposerSuggestionSwitches } from '../../components/composer-autocomplete.ts';
import { ComposerRuntime } from '../../components/composer-runtime.tsx';
import { FileInstanceSurface } from '../../components/file-instance-surface.tsx';
import { FilesTab } from '../../components/files-tab.tsx';
import { MigrateSheet } from '../../components/migrate-sheet.tsx';
import { type QuestionAnswerApi, QuestionForm } from '../../components/question-form.tsx';
import {
  type ReferenceSurface,
  ReferenceSurfaceProvider,
  sessionReferenceSurface,
} from '../../components/reference-surface.tsx';
import {
  isPromptKnownBusy,
  type RuntimeControlApi,
  RuntimeEffortControls,
  RuntimeModelControls,
} from '../../components/runtime-controls.tsx';
import { SessionDetails } from '../../components/session-details.tsx';
import { SessionHeader } from '../../components/session-header.tsx';
import { SessionTerminalSurface } from '../../components/session-terminal-surface.tsx';
import type { TerminalDeckDependencies } from '../../components/session-terminal-deck.tsx';
import type { PaneSnapshotReader } from '../../components/terminal-snapshot.tsx';
import { Transcript } from '../../components/transcript.tsx';
import { SessionAnalyticsSurface } from '../../features/analytics/session-analytics-surface.tsx';
import {
  type AttentionActionClient,
  AttentionActionModal,
  AttentionActionTrigger,
} from '../../features/attention/attention-action-modal.tsx';
import { LineageSurfaceContent } from '../../features/lineage/lineage-surface.tsx';
import { SessionTasksSearchSurface, useSessionSearch } from '../../features/session-search/session-search.tsx';
import { useSessionSkills } from '../../features/skills/session-skills-store.ts';
import { SessionSkillsSurface } from '../../features/skills/session-skills-surface.tsx';
import type { SkillsCatalogLoader } from '../../features/skills/skills-api.ts';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Button } from '../../shell/primitives.tsx';
import { type SessionAction, sessionActionSpecs } from '../../shell/session-actions.ts';
import { type SidePaneSurfaceProps, SidePaneWorkspace, useSidePane } from '../../shell/side-pane.tsx';
import {
  openSidePaneFileTab,
  type SidePaneTabDefinition,
  type SidePaneTabPresentation,
} from '../../shell/side-pane-tab-model.ts';
import { statusMark, TERMINAL_STATUSES } from '../../shell/status-mark.tsx';
import type { DaemonAccountPickerStore } from '../account-picker-store.ts';
import type { AttentionLoadStatus } from '../attention-store.ts';
import { agentReferenceIdentityKey } from '../agent-references.ts';
import type { DaemonBrowserLoginStore } from '../browser-login.ts';
import type { ComposerEnterKeyPreference } from '../composer-keybinding.ts';
import { useComposerReferenceCatalogs } from '../composer-reference-catalogs.ts';
import type { ChatWidthPreference } from '../controls.ts';
import type { DaemonConnection } from '../daemon-connection.ts';
import { sameDaemonConnection } from '../daemon-connection.ts';
import { daemonSessionScope } from '../daemon-scope.ts';
import type { DaemonPinClient } from '../pin-client.ts';
import { DaemonRuntimeModelCatalogStore } from '../runtime-models.ts';
import type { TranscriptEntry } from '../session-screens.ts';
import type { SttSettings } from '../stt/stt-settings.ts';
import type { DaemonUsageStore } from '../usage-store.ts';

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
  readonly onBack: (daemonId: string) => void;
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
}

const actionFailureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const sessionWorkspaceTab = (tab: SidePaneTabDefinition): boolean =>
  tab.id !== 'browser' && tab.instance?.kind !== 'browser';

/**
 * The pane openers — ONE compact row, on a phone as well as a desktop.
 *
 * `<fieldset>` rather than `role="toolbar"`: a toolbar promises single-tab-stop
 * roving arrow navigation, and these are plain buttons with none of it, so the
 * role was a claim the markup did not keep. A fieldset carries the same implicit
 * grouping, takes an accessible name, and Tailwind's preflight zeroes its box —
 * so nothing moves.
 *
 * Browser automation is stated, not implied. It used to be a DISABLED button
 * whose only explanation lived in a `title`: unreachable by keyboard, invisible
 * on touch, and unread by most screen readers on a disabled control. The reason
 * is now ordinary visible text in the row, which is what makes absence legible.
 */
function PaneLaunchers() {
  const pane = useSidePane();
  if (pane === null) return null;
  return (
    <fieldset aria-label="Workspace panes" className="flex min-w-0 flex-wrap items-center gap-1">
      <Button size="sm" onClick={event => pane.open('files', event.currentTarget)} type="button">
        Files
      </Button>
      <Button size="sm" onClick={event => pane.open('terminals', event.currentTarget)} type="button">
        Terminal
      </Button>
      <span className="min-w-0 text-2xs text-muted" data-pane-unavailable="browser">
        No browser pane: this daemon runs no browser worker.
      </span>
    </fieldset>
  );
}

/**
 * Codex's native model picker lives in the Terminal view, and the runtime sheet
 * can only offer it if something actually navigates there.
 *
 * This is a child component rather than a hook call in the page BECAUSE the page
 * renders `SidePaneWorkspace` — it is the context's parent, so its own body can
 * never read it. A `false` answer is honest: with no pane host mounted the sheet
 * keeps its own explanation on screen instead of closing over a navigation that
 * did not happen. `paneHost` below is the ref this capture writes into.
 */
function SidePaneCapture({ onHost }: { readonly onHost: (host: ReturnType<typeof useSidePane>) => void }) {
  const pane = useSidePane();
  useEffect(() => {
    onHost(pane);
    return () => onHost(null);
  }, [onHost, pane]);
  return null;
}

/** Gives the app-bar search real current-workspace destinations without ever
 * retaining a callback across a daemon/session change. */
function SessionSearchWorkspaceActions({ scope }: { readonly scope: ReturnType<typeof daemonSessionScope> }) {
  const pane = useSidePane();
  const search = useSessionSearch();
  useEffect(() => {
    if (
      pane === null ||
      search.scope === null ||
      search.scope.daemonId !== scope.daemonId ||
      search.scope.sessionId !== scope.sessionId
    )
      return;
    search.setOpeners({
      openFile: path => {
        pane.open('files');
        openSidePaneFileTab(scope, path);
      },
      openTasks: () => pane.open('tasks'),
    });
    return () => search.setOpeners(null);
  }, [pane, scope, search]);
  return null;
}

interface WorkspaceSurfaceProps extends SidePaneSurfaceProps {
  readonly connection: DaemonConnection;
  readonly session: SessionView;
  readonly daemonSessions?: readonly SessionView[];
  readonly onNavigate?: (to: string) => void;
  readonly readSnapshot?: PaneSnapshotReader;
  /**
   * The terminal deck's dependencies, bound to this daemon's carrier by the composition root.
   *
   * Threaded rather than defaulted inside the deck because the carrier lives in the app store, and a
   * component that reached for the store itself could not be mounted by a test without one. Absent
   * here means the deck's own browser default — direct-only, which is what a suite wants.
   */
  readonly deck?: TerminalDeckDependencies;
  /** The one reference surface this session reads with, files included. */
  readonly references: ReferenceSurface;
  /**
   * The session's ONE skills catalog read, threaded down rather than started
   * here: the page already holds it, because the reference surface proves an
   * inserted `/floop` from the same names this pane lists.
   */
  readonly skills: SkillsCatalogLoader;
}

function WorkspaceSurface({
  connection,
  session,
  daemonSessions,
  onNavigate,
  readSnapshot,
  deck,
  references,
  skills,
  scope,
  tab,
  presentation,
  titleId,
  onClose,
  isActive,
}: WorkspaceSurfaceProps) {
  let body: ReactNode;
  if (tab.instance?.kind === 'file') {
    // ONE TAB PER FILE (#35): this tab renders ITS file, not the picker. Two
    // open files are two tabs, each with its own raw/diff choice and its own
    // reading position.
    body = <FileInstanceSurface daemon={connection} scope={scope} instance={tab.instance} markdown={references} />;
  } else if (tab.id === 'tasks') {
    body = <SessionTasksSearchSurface />;
  } else if (tab.id === 'skills') {
    // #43. The loader comes from the page's own read, so opening this pane
    // JOINS that read instead of asking the daemon a second time.
    body = <SessionSkillsSurface connection={connection} loadCatalog={skills} scope={scope} />;
  } else if (tab.id === 'lineage') {
    body =
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
      );
  } else if (tab.id === 'analytics') {
    body = <SessionAnalyticsSurface connection={connection} scope={scope} />;
  } else if (tab.id === 'files') {
    // The picker: tree, listing, breadcrumbs. Every open it produces becomes a
    // file tab in the pane's own strip, so this surface holds no second strip.
    // Markdown a file preview renders is the SAME reference surface the
    // transcript reads with, so a path in a README behaves like a path in a
    // message rather than being inert text in a viewer.
    body = (
      <FilesTab
        daemon={connection}
        scope={scope}
        cwd={session.config.cwd}
        markdown={references}
        onOpenFile={(path, selection) => openSidePaneFileTab(scope, path, selection)}
      />
    );
  } else if (tab.id === 'terminals' || tab.instance?.kind === 'terminal') {
    // The deck is still ONE surface (DESIGN-side-pane-tabs.md assigns its
    // per-terminal split to the deck's own owner). A `terminal:<id>` tab is
    // therefore addressable rather than separate: it selects ITS shell in the
    // deck, and says nothing if that shell is not in the listing.
    body = (
      <SessionTerminalSurface
        connection={connection}
        scope={scope}
        {...(readSnapshot === undefined ? {} : { readSnapshot })}
        {...(deck === undefined ? {} : { deck })}
        {...(tab.instance?.kind === 'terminal' ? { focusTerminalId: tab.instance.key } : {})}
      />
    );
  } else if (tab.render !== undefined) {
    body = tab.render({
      scope,
      presentation,
      titleId,
      onClose,
      cwd: session.config.cwd,
      isActive,
      ...(tab.instance === undefined ? {} : { instance: tab.instance }),
    });
  } else {
    body = (
      <p className="m-3 text-ui text-muted" role="status">
        {tab.unavailableReason ?? `${tab.label} is ported but is not connected to this session workspace yet.`}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 className="sr-only" id={titleId}>
        {tab.label}
      </h2>
      {presentation === 'pane' ? (
        <div className="flex shrink-0 items-center justify-end border-b border-border-soft px-2 py-1">
          <Button aria-label={`Close ${tab.label}`} onClick={onClose} size="sm" type="button" variant="ghost">
            Close
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
    </div>
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
  chatWidth = 'full',
  composerEnterKey,
  composerSuggestions,
  composerVimMode = false,
  dictationSettings,
  onBack,
  onSessionChange,
  onRefresh,
  readSnapshot,
  deck,
  daemonSessions,
  onNavigate,
  attention,
}: SessionChatPageProps) {
  const scope = useMemo(() => daemonSessionScope(connection, session.config.id), [connection, session.config.id]);
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
  const skills = useSessionSkills(connection, scope);
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
  /** Written by `SidePaneCapture`, which owns the explanation for why the host
   *  can only be read from a child. */
  const paneHost = useRef<ReturnType<typeof useSidePane>>(null);
  const captureSidePane = useCallback((host: ReturnType<typeof useSidePane>) => {
    paneHost.current = host;
  }, []);
  const openTerminalPane = useCallback(() => {
    if (paneHost.current === null) return false;
    paneHost.current.open('terminals');
    return true;
  }, []);
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
        // Both halves or neither. The ledger alone proves `!A3` without giving
        // it anywhere to go, and an opener alone would link an unproved id — so
        // a host that has not subscribed leaves the token as prose, which the
        // reference standard calls the only honest state.
        ...(attention === undefined ? {} : { attentionIds, onAttentionOpen: openAttention }),
      }),
    [
      connection,
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
  const runtimeApi = useMemo<RuntimeControlApi | null>(() => {
    const runtime = client.runtime;
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
  }, [client.runtime, publish]);

  // `<fieldset>`, not `role="toolbar"`: these are plain wrapping buttons with no
  // roving tabindex and no arrow handling, and a toolbar role promises both.
  // Rendered in exactly ONE place per presentation — the row on a desktop, the
  // details sheet on a phone — so there is never a second copy of a control that
  // mutates the session.
  const lifecycleActions = (
    <fieldset aria-label="Session lifecycle" className="flex min-w-0 flex-wrap items-center gap-1">
      {actions.map(spec => (
        <Button
          disabled={pendingAction !== null}
          key={spec.action}
          onClick={() => void runAction(spec.action)}
          size="sm"
          type="button"
          variant={spec.danger ? 'danger' : 'outline'}
        >
          {pendingAction === spec.action
            ? `${spec.label.replace(/…$/u, '')}…`
            : spec.action === 'stop' && confirmStop
              ? 'Confirm stop'
              : spec.label}
        </Button>
      ))}
      {confirmStop ? (
        <Button onClick={() => setConfirmStop(false)} size="sm" type="button" variant="ghost">
          Cancel
        </Button>
      ) : null}
    </fieldset>
  );
  const actionAlert = (
    <p className={actionError === null ? 'sr-only' : 'm-0 px-3 py-1 text-ui text-err'} role="alert">
      {actionError === null ? '' : `Session action failed: ${actionError}`}
    </p>
  );

  return (
    <SidePaneWorkspace
      active
      presentation={presentation}
      scope={scope}
      shouldIncludeTab={sessionWorkspaceTab}
      renderSurface={props => (
        <WorkspaceSurface
          {...props}
          connection={connection}
          references={references}
          session={session}
          skills={skills.load}
          {...(daemonSessions === undefined ? {} : { daemonSessions })}
          {...(onNavigate === undefined ? {} : { onNavigate })}
          {...(readSnapshot === undefined ? {} : { readSnapshot })}
          {...(deck === undefined ? {} : { deck })}
        />
      )}
    >
      <SessionSearchWorkspaceActions scope={scope} />
      {/* Every Markdown reader inside the conversation — transcript prose,
          notices, and whatever a later item renders here — reads references
          through this one surface. */}
      <ReferenceSurfaceProvider surface={references}>
        <main
          className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          data-daemon={connection.daemonId}
          data-session={session.config.id}
        >
          <SessionHeader
            daemonId={connection.daemonId}
            session={session}
            onBack={onBack}
            onOpenFleet={onBack}
            onOpenDetails={() => setDetailsOpen(true)}
          />
          {/* One compact row. On a phone it carries the pane openers ONLY: the
            lifecycle buttons wrapped to four bands here — 149px of an 844px
            screen, measured — and they are reachable in Session Details
            instead, which is where the source keeps them on compact. */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-soft px-2 py-1">
            {compact ? null : lifecycleActions}
            <PaneLaunchers />
            {/* THE Attention entry point, in the one row that exists on a phone
                as well as a desktop. It is deliberately NOT a side-pane tab
                (#35): an item opens the focused modal below. */}
            {attention === undefined ? null : (
              <AttentionActionTrigger
                id={`${attentionId}-trigger`}
                controls={attentionId}
                count={attentionItems.length}
                expanded={attentionOpen}
                loading={attention.snapshot === null && attention.status !== 'error'}
                onOpen={opener => openAttention(null, opener)}
              />
            )}
            <SidePaneCapture onHost={captureSidePane} />
          </div>
          {/* NOT a live region. App.tsx owns the single announcement for a refresh
            failure and hands down a finished sentence; a second `role=status`
            here made assistive tech say it twice, and a prefix added here would
            have made the two disagree. Rendered only when there is something to
            render, precisely because it announces nothing. */}
          {refreshError === null ? null : <p className="m-0 px-3 py-1 text-ui text-warn">{refreshError}</p>}
          {/* The action alert belongs beside the actions, so it is rendered inside
            the details sheet on compact — one alert region either way. */}
          {compact ? null : actionAlert}
          {/* THE CHAT MEASURE, applied to transcript and composer TOGETHER so the
            two never disagree about where the column ends. `full` is the shipped
            default and is deliberately uncapped, exactly as the source is; the
            reader's `balanced`/`readable` choice now actually narrows this page,
            which it could not do before because nothing here carried the
            surface class. The side pane is a sibling of `<main>`, so a max-width
            here cannot touch the split. */}
          <div className="kt-chat-surface flex min-h-0 min-w-0 flex-1 flex-col" data-chat-width={chatWidth}>
            <div className="grid min-h-0 flex-1">
              <Transcript busy={busy} daemonId={connection.daemonId} entries={entries} sessionId={session.config.id} />
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
                    This session reports a structured question, but its complete validated prompt is unavailable. No
                    answer can be sent safely; refresh the session or interrupt the turn to abandon it.
                  </p>
                </section>
              ) : (
                <>
                  {runtimeApi === null ? null : (
                    <ComposerRuntime
                      busy={runtimeSwitchBusy}
                      canControl={canControl}
                      renderEffortControls={lifecycle => (
                        <RuntimeEffortControls
                          api={runtimeApi}
                          canControl={canControl}
                          catalogs={runtimeModelCatalogs}
                          daemon={connection}
                          onOpenTerminal={openTerminalPane}
                          view={session}
                          {...lifecycle}
                        />
                      )}
                      renderModelControls={lifecycle => (
                        <RuntimeModelControls
                          api={runtimeApi}
                          canControl={canControl}
                          catalogs={runtimeModelCatalogs}
                          daemon={connection}
                          onOpenTerminal={openTerminalPane}
                          view={session}
                          {...lifecycle}
                          open={lifecycle.open}
                        />
                      )}
                      view={session}
                    />
                  )}
                  <Composer
                    api={client}
                    {...(daemonSessions === undefined ? {} : { autocompleteSessions: daemonSessions })}
                    {...(composerCatalogs.tasks === undefined ? {} : { autocompleteTasks: composerCatalogs.tasks })}
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
                    enterKeyPreference={composerEnterKey}
                    daemon={connection}
                    disabled={TERMINAL_STATUSES.has(session.state.status) || !canControl}
                    onSent={onRefresh}
                    quota={session.state.quota}
                    sessionId={session.config.id}
                  />
                </>
              )}
            </div>
          </div>
          <BottomSheet
            ariaLabel="Session details"
            closeLabel="Close session details"
            id={detailsId}
            onClose={() => setDetailsOpen(false)}
            open={detailsOpen}
            panelClassName="kt-details bg-surface"
          >
            <SessionDetails daemonId={connection.daemonId} onClose={() => setDetailsOpen(false)} session={session} />
            {/* Compact's home for the lifecycle controls. The sheet is already a
              focus-trapped dialog with an Escape path and restored focus, so the
              controls keep a robust home instead of a wrapped row that cost a
              sixth of the screen on every session. */}
            {compact ? (
              <div className="flex flex-col gap-2 px-4 pb-4">
                {lifecycleActions}
                {actionAlert}
              </div>
            ) : null}
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
    </SidePaneWorkspace>
  );
}
