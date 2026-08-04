import type { IFyApiClient, SessionView } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Composer } from '../../components/composer.tsx';
import { FileInstanceSurface } from '../../components/file-instance-surface.tsx';
import { FilesTab } from '../../components/files-tab.tsx';
import { MigrateSheet } from '../../components/migrate-sheet.tsx';
import {
  type ReferenceSurface,
  ReferenceSurfaceProvider,
  sessionReferenceSurface,
} from '../../components/reference-surface.tsx';
import { SessionDetails } from '../../components/session-details.tsx';
import { SessionHeader } from '../../components/session-header.tsx';
import { SessionTerminalSurface } from '../../components/session-terminal-surface.tsx';
import type { PaneSnapshotReader } from '../../components/terminal-snapshot.tsx';
import { Transcript } from '../../components/transcript.tsx';
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
import { agentReferenceIdentityKey } from '../agent-references.ts';
import type { ChatWidthPreference } from '../controls.ts';
import type { DaemonConnection } from '../daemon-connection.ts';
import { sameDaemonConnection } from '../daemon-connection.ts';
import { daemonSessionScope } from '../daemon-scope.ts';
import type { TranscriptEntry } from '../session-screens.ts';

/** Only daemon operations this workspace can truthfully invoke. */
export type SessionChatClient = Pick<IFyApiClient, 'interrupt' | 'resume' | 'send' | 'stop'>;

export interface SessionChatPageProps {
  readonly connection: DaemonConnection;
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
  readonly onBack: (daemonId: string) => void;
  readonly onSessionChange: (view: SessionView) => void;
  readonly onRefresh?: () => void;
  /** Test seam for the read-only terminal fallback. */
  readonly readSnapshot?: PaneSnapshotReader;
  /**
   * This daemon's own fleet slice, for proving `:callsign` references.
   * `undefined` means the fleet has not been read yet — deliberately NOT an
   * empty array, because an unread fleet is not a fleet with nobody in it, and
   * the difference decides whether a callsign is unproved or absent.
   */
  readonly daemonSessions?: readonly SessionView[];
  /** In-app navigation for a proved agent reference. */
  readonly onNavigate?: (to: string) => void;
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

interface WorkspaceSurfaceProps extends SidePaneSurfaceProps {
  readonly connection: DaemonConnection;
  readonly session: SessionView;
  readonly readSnapshot?: PaneSnapshotReader;
  /** The one reference surface this session reads with, files included. */
  readonly references: ReferenceSurface;
}

function WorkspaceSurface({
  connection,
  session,
  readSnapshot,
  references,
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
    body = (
      <SessionTerminalSurface
        connection={connection}
        scope={scope}
        {...(readSnapshot === undefined ? {} : { readSnapshot })}
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
  session,
  entries,
  client,
  presentation,
  canControl = true,
  refreshError = null,
  chatWidth = 'full',
  onBack,
  onSessionChange,
  onRefresh,
  readSnapshot,
  daemonSessions,
  onNavigate,
}: SessionChatPageProps) {
  const scope = useMemo(() => daemonSessionScope(connection, session.config.id), [connection, session.config.id]);
  // THE session's one reference surface. The memo key over the fleet is the
  // identity of the fields the resolver actually copies, so status and activity
  // churn cannot rebuild the surface and re-parse every rendered Markdown block
  // in the transcript (`agentReferenceIdentityKey`).
  const fleetIdentity =
    daemonSessions === undefined ? null : agentReferenceIdentityKey(connection.daemonId, daemonSessions);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fleetIdentity is the stable memo key for daemonSessions
  const references = useMemo(
    () =>
      sessionReferenceSurface({
        connection,
        scope,
        ...(session.config.cwd === undefined ? {} : { cwd: session.config.cwd }),
        ...(daemonSessions === undefined ? {} : { sessions: daemonSessions }),
        ...(onNavigate === undefined ? {} : { onNavigate }),
      }),
    [connection, scope, session.config.cwd, fleetIdentity, onNavigate],
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
  const question = TERMINAL_STATUSES.has(session.state.status) ? null : (session.state.pendingQuestion ?? null);
  const awaitingAnswer = question !== null || session.state.status === 'awaiting_question';
  const compact = presentation === 'sheet';

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
          {...(readSnapshot === undefined ? {} : { readSnapshot })}
        />
      )}
    >
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
              {awaitingAnswer ? (
                /* THE ANSWER ROUTE IS NOT MOUNTED on this daemon, so no form here
                 could submit. Rendering one anyway would be a control that looks
                 live, takes a choice, and throws — so the state says what it is
                 and points at the one action that DOES work. Interrupt stays
                 reachable: in the row on a desktop, in Session Details on a
                 phone. */
                <section
                  aria-label="Structured question"
                  className="fy-question-form"
                  data-question-unavailable=""
                  role="status"
                >
                  <p className="m-0">
                    This session is waiting on a structured question. This build cannot answer one — the paired daemon
                    does not serve the answer route — so the question can only be cleared by interrupting the turn.
                  </p>
                </section>
              ) : (
                <Composer
                  api={client}
                  busy={busy}
                  compact={compact}
                  daemon={connection}
                  disabled={TERMINAL_STATUSES.has(session.state.status) || !canControl}
                  onSent={onRefresh}
                  quota={session.state.quota}
                  sessionId={session.config.id}
                />
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
          <MigrateSheet
            canMutate={canControl}
            connection={connection}
            onClose={() => setMigrateOpen(false)}
            onMigrated={(_daemon, _scope, view) => publish(view)}
            open={migrateOpen}
            scope={scope}
            view={session}
          />
        </main>
      </ReferenceSurfaceProvider>
    </SidePaneWorkspace>
  );
}
