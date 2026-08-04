import type { IFyApiClient, SessionView } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Composer } from '../../components/composer.tsx';
import { FilesTab } from '../../components/files-tab.tsx';
import { MigrateSheet } from '../../components/migrate-sheet.tsx';
import { type QuestionAnswerApi, QuestionForm } from '../../components/question-form.tsx';
import { RenameSheet } from '../../components/rename-sheet.tsx';
import { SessionDetails } from '../../components/session-details.tsx';
import { SessionHeader } from '../../components/session-header.tsx';
import { SessionTerminalSurface } from '../../components/session-terminal-surface.tsx';
import type { PaneSnapshotReader } from '../../components/terminal-snapshot.tsx';
import { Transcript } from '../../components/transcript.tsx';
import { BottomSheet } from '../../shell/bottom-sheet.tsx';
import { Button } from '../../shell/primitives.tsx';
import { type SessionAction, sessionActionSpecs } from '../../shell/session-actions.ts';
import { type SidePaneSurfaceProps, SidePaneWorkspace, useSidePane } from '../../shell/side-pane.tsx';
import type { SidePaneTabDefinition, SidePaneTabPresentation } from '../../shell/side-pane-tab-model.ts';
import { statusMark, TERMINAL_STATUSES } from '../../shell/status-mark.tsx';
import type { DaemonConnection } from '../daemon-connection.ts';
import { sameDaemonConnection } from '../daemon-connection.ts';
import { daemonSessionScope } from '../daemon-scope.ts';
import type { TranscriptEntry } from '../session-screens.ts';

export type SessionChatClient = Pick<IFyApiClient, 'answer' | 'interrupt' | 'resume' | 'send' | 'stop'>;

export interface SessionChatPageProps {
  readonly connection: DaemonConnection;
  readonly session: SessionView;
  readonly entries: readonly TranscriptEntry[];
  readonly client: SessionChatClient;
  readonly presentation: SidePaneTabPresentation;
  readonly canControl?: boolean;
  readonly refreshError?: string | null;
  readonly onBack: (daemonId: string) => void;
  readonly onSessionChange: (view: SessionView) => void;
  readonly onRefresh?: () => void;
  /** Test seam for the read-only terminal fallback. */
  readonly readSnapshot?: PaneSnapshotReader;
}

const actionFailureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const sessionWorkspaceTab = (tab: SidePaneTabDefinition): boolean =>
  tab.id !== 'browser' && tab.instance?.kind !== 'browser';

function PaneLaunchers() {
  const pane = useSidePane();
  if (pane === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Workspace panes">
      <Button size="sm" onClick={event => pane.open('files', event.currentTarget)} type="button">
        Files
      </Button>
      <Button size="sm" onClick={event => pane.open('terminals', event.currentTarget)} type="button">
        Terminal
      </Button>
      <Button
        size="sm"
        disabled
        title="Browser automation is unavailable because this daemon has no browser worker."
        type="button"
      >
        Browser unavailable
      </Button>
    </div>
  );
}

interface WorkspaceSurfaceProps extends SidePaneSurfaceProps {
  readonly connection: DaemonConnection;
  readonly session: SessionView;
  readonly readSnapshot?: PaneSnapshotReader;
}

function WorkspaceSurface({
  connection,
  session,
  readSnapshot,
  scope,
  tab,
  presentation,
  titleId,
  onClose,
  isActive,
}: WorkspaceSurfaceProps) {
  let body: ReactNode;
  if (tab.id === 'files' || tab.instance?.kind === 'file') {
    body = <FilesTab daemon={connection} scope={scope} cwd={session.config.cwd} />;
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
  onBack,
  onSessionChange,
  onRefresh,
  readSnapshot,
}: SessionChatPageProps) {
  const scope = useMemo(() => daemonSessionScope(connection, session.config.id), [connection, session.config.id]);
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
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
    setRenameOpen(false);
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
    if (action === 'rename') {
      setRenameOpen(true);
      return;
    }
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

  const questionApi = useMemo<QuestionAnswerApi>(
    () => ({
      answer: async (daemon, sessionId, toolUseId, labels, other, responses) => {
        if (!sameDaemonConnection(daemon, connection) || sessionId !== session.config.id) {
          throw new Error('question scope must belong to the visible session');
        }
        const next = await client.answer(
          sessionId,
          toolUseId,
          [...labels],
          other,
          responses ? [...responses] : undefined,
        );
        publish(next);
        return next;
      },
    }),
    [client, connection, publish, session.config.id],
  );

  const actions = sessionActionSpecs(session, canControl);
  const busy = statusMark(session).klass === 'active';
  const question = TERMINAL_STATUSES.has(session.state.status) ? null : (session.state.pendingQuestion ?? null);
  const waitingForQuestion = session.state.status === 'awaiting_question' && question === null;

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
          session={session}
          {...(readSnapshot === undefined ? {} : { readSnapshot })}
        />
      )}
    >
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
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-soft px-2 py-1">
          <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Session controls">
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
          </div>
          <PaneLaunchers />
        </div>
        <p className={refreshError === null ? 'sr-only' : 'm-0 px-3 py-1 text-ui text-warn'} role="status">
          {refreshError === null ? '' : `Workspace refresh issue: ${refreshError}`}
        </p>
        <p className={actionError === null ? 'sr-only' : 'm-0 px-3 py-1 text-ui text-err'} role="alert">
          {actionError === null ? '' : `Session action failed: ${actionError}`}
        </p>
        <div className="grid min-h-0 flex-1">
          <Transcript busy={busy} daemonId={connection.daemonId} entries={entries} sessionId={session.config.id} />
        </div>
        <div className="shrink-0 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" data-session-input="">
          {question !== null ? (
            <QuestionForm
              api={questionApi}
              compact={presentation === 'sheet'}
              daemon={connection}
              onAnswered={onRefresh}
              question={question}
              sessionId={session.config.id}
            />
          ) : waitingForQuestion ? (
            <section aria-label="Answer session questions" className="fy-question-form" role="status">
              <p className="m-0">Question details have not loaded yet. The workspace is refreshing them.</p>
            </section>
          ) : (
            <Composer
              api={client}
              busy={busy}
              daemon={connection}
              disabled={TERMINAL_STATUSES.has(session.state.status) || !canControl}
              onSent={onRefresh}
              quota={session.state.quota}
              sessionId={session.config.id}
            />
          )}
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
        </BottomSheet>
        <RenameSheet
          connection={connection}
          onClose={() => setRenameOpen(false)}
          onRenamed={publish}
          open={renameOpen}
          view={session}
        />
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
    </SidePaneWorkspace>
  );
}
