/**
 * THE PROCESSES TAB: what is running under this ferret, one row each, and what each is printing.
 *
 * The daemon reads the list from the operating system, never from the agent, so a row is a fact: a
 * command the agent is waiting on, something it left running, a server a command started, a helper the
 * harness keeps. Rows are grouped by what they are to the agent; a process another started rides under
 * it; what has ended is kept for a while under "Recently ended" so its last words can still be read.
 *
 * This surface owns no polling of the LIST — the page does, because the tab's count must stay honest
 * while another tab is on screen — and polls the OUTPUT only of the row that is open. Stopping goes
 * through a confirmation that says plainly what will happen to what the process started.
 */

import type { SessionProcess } from '@ferretry/protocol';
import { ChevronRight, ListTree } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import {
  groupProcesses,
  PROCESSES_FORBIDDEN_TEXT,
  type ProcessRow,
  processElapsedText,
  processErrorText,
  processTitle,
  stopSessionProcess,
} from '../../lib/session-processes.ts';
import { useDaemonFetch } from '../../lib/store.tsx';
import { browserClipboardWriter, type ClipboardWriter } from '../onboarding/copy-button.tsx';
import { ActionToast } from '../session-actions/action-toast.tsx';
import { ProcessDetail } from './process-detail.tsx';
import { dotTone, KIND_LABEL, KIND_MEANING, STATE_LABEL } from './process-vocabulary.ts';
import { type ProcessListState, type ProcessOutputReader, processListOf } from './use-session-processes.ts';

/** Sends the stop. Injected so tests and the harness never reach a daemon. */
export type ProcessStopper = (
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  processId: string,
) => Promise<{ readonly signalled: number }>;

export interface ProcessesSurfaceProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly state: ProcessListState;
  /** The row that is open, held by the page so it survives the tab being switched away from. */
  readonly openId: string | null;
  readonly onOpenChange: (id: string | null) => void;
  /** Read the list again now (after a stop). */
  readonly onRefresh?: () => void;
  /** Switch to the Console tab: where a process that writes to the terminal can be seen. */
  readonly onShowConsole: () => void;
  /** A phone: the list collapses to the open row, with a way back. */
  readonly compact?: boolean;
  readonly now?: () => number;
  readonly readOutput?: ProcessOutputReader;
  readonly stopProcess?: ProcessStopper;
  readonly writeClipboard?: ClipboardWriter;
  readonly outputPollMs?: number;
}

/** The clock the elapsed times read, ticking once a second while the surface is mounted. */
const useNow = (clock: () => number): number => {
  const [now, setNow] = useState(clock);
  useEffect(() => {
    const timer = setInterval(() => setNow(clock()), 1_000);
    return () => clearInterval(timer);
  }, [clock]);
  return now;
};

const stoppedText = (count: number): string => `Stopped (${String(count)} ${count === 1 ? 'process' : 'processes'})`;

const DIALOG_COMMAND_MAX = 120;

const shortCommand = (text: string): string =>
  text.length <= DIALOG_COMMAND_MAX ? text : `${text.slice(0, DIALOG_COMMAND_MAX - 1)}…`;

function StopDialog({
  process,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly process: SessionProcess;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => {
    if (!busy) onCancel();
  }, [busy, onCancel]);
  const { onKeyDown } = useDialogFocus(true, dialogRef, dismiss);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button
        aria-label="Close stop confirmation"
        className="absolute inset-0"
        disabled={busy}
        onClick={dismiss}
        type="button"
      />
      <div
        aria-labelledby="process-stop-title"
        aria-modal="true"
        className="kt-panel relative flex w-full max-w-md flex-col px-cell-x py-3 shadow-popover focus:outline-none"
        onKeyDown={onKeyDown}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="text-ui font-semibold" id="process-stop-title">
          Stop this process?
        </h2>
        <p className="my-3 text-cell text-muted" data-stop-sentence="">
          Stop <code className="mono text-fg break-all">{shortCommand(processTitle(process))}</code>? It and anything it
          started will be asked to quit (SIGTERM).
        </p>
        <div className="flex shrink-0 gap-sm">
          <button className="kt-btn min-h-[44px] flex-1 justify-center" disabled={busy} onClick={dismiss} type="button">
            Cancel
          </button>
          <button
            className="kt-btn min-h-[44px] flex-1 justify-center"
            data-variant="danger"
            disabled={busy}
            onClick={onConfirm}
            type="button"
          >
            {busy ? 'Stopping…' : 'Stop'}
          </button>
        </div>
      </div>
    </div>
  );
}

function KindChip({ kind }: { readonly kind: SessionProcess['kind'] }) {
  return (
    <span className="fy-proc-chip" data-kind={kind} title={KIND_MEANING[kind]}>
      {KIND_LABEL[kind]}
      <span className="sr-only"> — {KIND_MEANING[kind]}</span>
    </span>
  );
}

function ProcessLine({
  process,
  now,
  open,
  child,
  childCount,
  expanded,
  onOpen,
  onToggle,
}: {
  readonly process: SessionProcess;
  readonly now: number;
  readonly open: boolean;
  readonly child: boolean;
  readonly childCount: number;
  readonly expanded: boolean;
  readonly onOpen: () => void;
  readonly onToggle: () => void;
}) {
  const title = processTitle(process);
  const failed = process.state === 'exited' && process.exit?.failed === true;
  return (
    <li className="fy-proc-item" data-child={child ? '' : undefined} data-process-id={process.id}>
      <div className="fy-proc-row" data-open={open ? '' : undefined}>
        {childCount > 0 ? (
          <button
            aria-expanded={expanded}
            aria-label={`${expanded ? 'Hide' : 'Show'} ${String(childCount)} started by ${title}`}
            className="fy-proc-expander"
            data-expanded={expanded ? '' : undefined}
            onClick={onToggle}
            type="button"
          >
            <ChevronRight aria-hidden="true" size={14} />
            <span className="fy-proc-expander__count">{childCount}</span>
          </button>
        ) : (
          <span aria-hidden="true" className="fy-proc-expander fy-proc-expander--none" />
        )}
        <button aria-current={open ? 'true' : undefined} className="fy-proc-select" onClick={onOpen} type="button">
          <span aria-hidden="true" className="fy-proc-dot" data-tone={dotTone(process)} />
          <span className="sr-only">
            {STATE_LABEL[process.state]}
            {failed ? ', failed' : ''}:{' '}
          </span>
          <span className="fy-proc-command mono" title={process.command}>
            {title}
          </span>
          <span className="fy-proc-meta text-meta text-muted">
            <KindChip kind={process.kind} />
            <span className="fy-proc-elapsed" data-failed={failed ? '' : undefined}>
              {processElapsedText(process, now)}
            </span>
          </span>
        </button>
      </div>
    </li>
  );
}

export function ProcessesSurface({
  connection,
  scope,
  state,
  openId,
  onOpenChange: setOpenId,
  onRefresh,
  onShowConsole,
  compact = false,
  now: clock,
  readOutput,
  stopProcess,
  writeClipboard,
  outputPollMs,
}: ProcessesSurfaceProps) {
  const fetcher = useDaemonFetch();
  const wall = useMemo(() => clock ?? Date.now, [clock]);
  const now = useNow(wall);
  const stopper = useMemo<ProcessStopper>(
    () => stopProcess ?? ((daemon, at, id) => stopSessionProcess(daemon, at, id, fetcher)),
    [fetcher, stopProcess],
  );
  const clipboard = useMemo(() => writeClipboard ?? browserClipboardWriter(), [writeClipboard]);

  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const [stopping, setStopping] = useState<{ readonly process: SessionProcess; readonly busy: boolean } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const list = processListOf(state);
  const groups = useMemo(() => (list === null ? [] : groupProcesses(list)), [list]);
  const byId = useMemo(() => new Map((list?.processes ?? []).map(process => [process.id, process] as const)), [list]);
  const open = openId === null ? undefined : byId.get(openId);

  // A process the daemon has stopped listing has nothing left to show; the detail goes with it.
  useEffect(() => {
    if (openId !== null && list !== null && !byId.has(openId)) setOpenId(null);
  }, [openId, list, byId, setOpenId]);

  // Opening a child shows it under its parent, whatever the reader had collapsed.
  const shown = useMemo(() => {
    const ids = new Set(expandedIds);
    for (let at = open; at?.parentId !== undefined; ) {
      ids.add(at.parentId);
      at = byId.get(at.parentId);
    }
    return ids;
  }, [expandedIds, open, byId]);

  const toggle = (id: string): void =>
    setExpandedIds(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirmStop = (): void => {
    if (stopping === null || stopping.busy) return;
    const target = stopping.process;
    setStopping({ process: target, busy: true });
    stopper(connection, scope, target.id).then(
      result => {
        setStopping(null);
        setNotice(stoppedText(result.signalled));
        onRefresh?.();
      },
      (error: unknown) => {
        setStopping(null);
        setNotice(processErrorText(error));
        onRefresh?.();
      },
    );
  };

  const renderRow = (row: ProcessRow): React.ReactNode => {
    const expanded = shown.has(row.process.id);
    return (
      <div key={row.process.id} className="contents">
        <ProcessLine
          child={false}
          childCount={row.children.length}
          expanded={expanded}
          now={now}
          onOpen={() => setOpenId(row.process.id === openId ? null : row.process.id)}
          onToggle={() => toggle(row.process.id)}
          open={row.process.id === openId}
          process={row.process}
        />
        {expanded
          ? row.children.map(child => (
              <ProcessLine
                child
                childCount={0}
                expanded={false}
                key={child.id}
                now={now}
                onOpen={() => setOpenId(child.id === openId ? null : child.id)}
                onToggle={() => undefined}
                open={child.id === openId}
                process={child}
              />
            ))
          : null}
      </div>
    );
  };

  const body = (): React.ReactNode => {
    if (state.status === 'loading') return <p className="fy-proc-empty text-muted">Loading processes…</p>;
    if (state.status === 'forbidden')
      return (
        <p className="fy-proc-empty text-err" data-processes-forbidden="" role="alert">
          {PROCESSES_FORBIDDEN_TEXT}
        </p>
      );
    if (state.status === 'error')
      return (
        <p className="fy-proc-empty text-err" role="alert">
          Could not read the processes — {state.reason}
        </p>
      );
    if (list === null) return null;
    if (!list.available)
      return (
        <p className="fy-proc-empty text-muted" data-processes-unavailable="">
          {list.reason ?? 'The processes cannot be listed right now.'}
        </p>
      );
    if (groups.length === 0) return <p className="fy-proc-empty text-muted">Nothing running right now.</p>;
    return groups.map(group => (
      <section
        aria-labelledby={`fy-proc-group-${group.key}`}
        className="fy-proc-group"
        data-group={group.key}
        key={group.key}
      >
        <h3
          className="fy-proc-group__heading text-meta"
          data-quiet={group.key === 'ended' ? '' : undefined}
          id={`fy-proc-group-${group.key}`}
        >
          {group.heading}
        </h3>
        <ul className="fy-proc-list">{group.rows.map(renderRow)}</ul>
      </section>
    ));
  };

  return (
    <div className="fy-proc" data-compact={compact ? '' : undefined} data-open={open === undefined ? undefined : ''}>
      <div className="fy-proc-listpane">
        {state.status === 'stale' ? (
          <p className="fy-proc-banner text-meta" role="status">
            Showing the last answer — {state.reason}
          </p>
        ) : null}
        {compact && open !== undefined ? (
          <ul className="fy-proc-list fy-proc-list--solo">
            <ProcessLine
              child={open.parentId !== undefined}
              childCount={0}
              expanded={false}
              now={now}
              onOpen={() => setOpenId(null)}
              onToggle={() => undefined}
              open
              process={open}
            />
          </ul>
        ) : (
          body()
        )}
        {list === null && state.status === 'loading' ? <ListTree aria-hidden="true" className="sr-only" /> : null}
      </div>
      {open === undefined ? null : (
        <ProcessDetail
          compact={compact}
          connection={connection}
          now={now}
          onClose={() => setOpenId(null)}
          onNotice={setNotice}
          onShowConsole={onShowConsole}
          onStop={process => setStopping({ process, busy: false })}
          process={open}
          scope={scope}
          writeClipboard={clipboard}
          {...(readOutput === undefined ? {} : { readOutput })}
          {...(outputPollMs === undefined ? {} : { outputPollMs })}
        />
      )}
      {stopping === null ? null : (
        <StopDialog
          busy={stopping.busy}
          onCancel={() => setStopping(null)}
          onConfirm={confirmStop}
          process={stopping.process}
        />
      )}
      <ActionToast notice={notice} onDismiss={dismissNotice} />
    </div>
  );
}
