/**
 * Rename and Remove for one runtime (docs/account-model.md "Renaming a runtime"): the two buttons a
 * runtime's row and page carry, and the dialog each opens.
 *
 * Rename is one reviewed change. Nothing restarts: the daemon moves the runtime's id to the new name,
 * re-points every session on it, and keeps the old name starting it.
 *
 * Remove shows its impact FIRST, from the daemon's dry run: the ferrets still running on the runtime,
 * by name. They keep running, but restarting one later needs another runtime, so the dialog offers to
 * move them before removing — each restarted on the chosen runtime with its conversation, resumed on
 * the same CLI or converted across. The machine's default runtime is refused until another is picked,
 * and the picker is right there.
 *
 * Both are `fleet.configure` acts (docs/grants.md): a browser that may not make them sees the buttons
 * disabled with the reason, and the daemon refuses an apply it may not make whatever the screen says.
 */

import type {
  FleetAccountChange,
  FleetAccountChangeView,
  FleetMachineView,
  FleetRunningSession,
  FleetRuntimeView,
} from '@ferretry/protocol';
import { Pencil, Trash2 } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../../../hooks/use-dialog-focus.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';
import { Button } from '../../../shell/primitives.tsx';
import { HARNESS_NAMES } from '../components/component-model.ts';
import type { FleetClientFactory } from '../fleet-client.ts';
import { machineSettings } from '../machine/settings-tab.tsx';
import { type AccountChanges, ChangeApplyPanel } from '../shell/apply-change-panel.tsx';
import { changeRefusalSentence } from '../shell/apply-change.ts';
import {
  blocksAsDefault,
  defaultCandidates,
  moveConversation,
  movePlanSentence,
  moveTargets,
  RENAME_KEEPS_RUNNING,
  removeLabel,
  renameProblem,
  runningOnRuntime,
} from './runtime-actions-model.ts';

// ── The buttons ──────────────────────────────────────────────────────────────────────────────────

export interface RuntimeActionButtonsProps {
  readonly runtime: FleetRuntimeView;
  /** Why this browser may not change runtimes here, or `null` when it may. */
  readonly refusal: string | null;
  readonly onRename: () => void;
  readonly onRemove: () => void;
}

/** Rename, and Remove in the destructive style. Disabled, with the reason, when the caller may not. */
export function RuntimeActionButtons({ runtime, refusal, onRename, onRemove }: RuntimeActionButtonsProps) {
  const reason = refusal ?? undefined;
  return (
    <span className="flex flex-wrap gap-2" data-runtime-actions={runtime.name}>
      <Button
        type="button"
        size="sm"
        disabled={refusal !== null}
        title={reason}
        aria-label={`Rename ${runtime.name}`}
        data-runtime-rename={runtime.name}
        onClick={onRename}
      >
        <Pencil size={14} aria-hidden="true" />
        Rename
      </Button>
      <Button
        type="button"
        size="sm"
        variant="danger"
        disabled={refusal !== null}
        title={reason}
        aria-label={`Remove ${runtime.name}`}
        data-runtime-remove={runtime.name}
        onClick={onRemove}
      >
        <Trash2 size={14} aria-hidden="true" />
        Remove
      </Button>
    </span>
  );
}

/** "Move 2 ferrets to claude-agent and remove codex-default" says exactly what it does, so it wraps rather than clips. */
const WRAPPING_SUBMIT = '!h-auto min-h-control !whitespace-normal py-2 text-center';

// ── The dialog frame ─────────────────────────────────────────────────────────────────────────────

interface RuntimeDialogProps {
  readonly title: string;
  readonly name: string;
  /** While a change or a move is in flight the dialog stays: closing it would hide its outcome. */
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}

/** A sheet at the bottom on a phone, in thumb reach, and a centred dialog from `sm` up. */
function RuntimeDialog({ title, name, busy, onClose, children }: RuntimeDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const dismiss = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  const { onKeyDown } = useDialogFocus(true, dialogRef, dismiss);
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button
        type="button"
        aria-label={name === 'rename' ? 'Close without renaming' : 'Close without removing'}
        disabled={busy}
        onClick={dismiss}
        className="absolute inset-0"
        data-runtime-dialog-scrim=""
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="kt-panel relative flex max-h-[min(86dvh,640px)] w-full max-w-md flex-col gap-3 overflow-y-auto p-panel shadow-popover focus:outline-none"
        data-runtime-dialog={name}
      >
        <h2 id={titleId} className="m-0 break-all text-ui font-semibold text-fg">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

// ── Rename ───────────────────────────────────────────────────────────────────────────────────────

export interface RenameRuntimeDialogProps {
  readonly runtime: FleetRuntimeView;
  readonly runtimes: readonly FleetRuntimeView[];
  readonly machineName: string;
  readonly changes: AccountChanges;
  readonly onClose: () => void;
  /** The rename applied; the runtime is now called `name`. */
  readonly onRenamed: (name: string) => void;
}

export function RenameRuntimeDialog({
  runtime,
  runtimes,
  machineName,
  changes,
  onClose,
  onRenamed,
}: RenameRuntimeDialogProps) {
  const [name, setName] = useState(runtime.name);
  const inputId = useId();
  const hintId = useId();
  const problem = renameProblem(name, runtime, runtimes, machineName);
  const unchanged = name === runtime.name;

  const rename = async (): Promise<void> => {
    const result = await changes.apply({ kind: 'runtime.rename', name: runtime.name, to: name });
    if (result.kind === 'refused') return;
    onRenamed(name);
  };

  return (
    <RuntimeDialog title={`Rename ${runtime.name}`} name="rename" busy={changes.busy} onClose={onClose}>
      <div className="flex flex-col gap-1">
        <label htmlFor={inputId} className="text-cell font-semibold text-fg">
          New name
        </label>
        <input
          id={inputId}
          className="kt-input font-mono"
          autoComplete="off"
          spellCheck={false}
          value={name}
          aria-invalid={problem !== null && !unchanged}
          aria-describedby={hintId}
          data-runtime-rename-input=""
          onChange={event => {
            setName(event.target.value.trim());
            changes.clear();
          }}
        />
        <span id={hintId} className="text-meta leading-base" aria-live="polite">
          {problem === null || unchanged ? (
            <span className="text-muted">Letters, digits and dashes. You type this to launch it.</span>
          ) : (
            <span className="text-err" data-runtime-rename-problem="">
              {problem.message}{' '}
              {problem.suggestion === undefined ? null : (
                <button
                  type="button"
                  className="font-semibold text-accent underline"
                  data-runtime-rename-suggestion=""
                  onClick={() => setName(problem.suggestion ?? name)}
                >
                  Use {problem.suggestion}
                </button>
              )}
            </span>
          )}
        </span>
      </div>
      <ul
        className="m-0 flex list-disc flex-col gap-1 pl-5 text-cell leading-base text-muted"
        data-runtime-rename-notes=""
      >
        <li className="font-semibold text-fg">{RENAME_KEEPS_RUNNING}</li>
        <li>
          The old name keeps starting it, so <span className="font-mono">--agent {runtime.name}</span> still works.
        </li>
      </ul>
      <ChangeApplyPanel
        machineName={machineName}
        authority={changes.authority}
        busy={changes.busy}
        refusal={changes.refusal}
        submitLabel={unchanged ? 'Rename' : `Rename to ${name}`}
        busyLabel="Renaming…"
        disabled={problem !== null}
        onSubmit={() => void rename()}
      >
        <Button type="button" variant="ghost" disabled={changes.busy} onClick={onClose} data-runtime-dialog-cancel="">
          Cancel
        </Button>
      </ChangeApplyPanel>
    </RuntimeDialog>
  );
}

// ── Remove ───────────────────────────────────────────────────────────────────────────────────────

export interface RemoveRuntimeDialogProps {
  readonly runtime: FleetRuntimeView;
  readonly runtimes: readonly FleetRuntimeView[];
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly changes: AccountChanges;
  readonly connection: DaemonConnection;
  readonly createClient: FleetClientFactory;
  readonly onClose: () => void;
  readonly onRemoved: () => void;
  /** The machine's settings changed here (a new default runtime): read the machine again. */
  readonly onMachineChanged: () => void;
}

/** A ferret that could not be moved, and why. */
interface MoveFailure {
  readonly session: FleetRunningSession;
  readonly sentence: string;
}

type RemovePhase =
  | { readonly kind: 'reading' }
  | { readonly kind: 'refused'; readonly sentence: string }
  | { readonly kind: 'staged'; readonly staged: FleetAccountChangeView };

export function RemoveRuntimeDialog({
  runtime,
  runtimes,
  machine,
  machineName,
  changes,
  connection,
  createClient,
  onClose,
  onRemoved,
  onMachineChanged,
}: RemoveRuntimeDialogProps) {
  const [defaultMoved, setDefaultMoved] = useState(false);
  const blocked = blocksAsDefault(runtime, machine) && !defaultMoved;
  const [phase, setPhase] = useState<RemovePhase>({ kind: 'reading' });
  const [canMove, setCanMove] = useState(false);
  const [target, setTarget] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [failures, setFailures] = useState<readonly MoveFailure[]>([]);
  // The change state's functions are made afresh on every render; the dry run reads them through a ref
  // so it runs once per runtime rather than once per render.
  const latest = useRef(changes);
  latest.current = changes;
  const change: FleetAccountChange = { kind: 'runtime.remove', name: runtime.name };

  // The dry run: what removing it would do, and who is running on it — read before anything is asked.
  useEffect(() => {
    if (blocked) return;
    let live = true;
    latest.current.clear();
    void latest.current.stage({ kind: 'runtime.remove', name: runtime.name }).then(result => {
      if (!live) return;
      setPhase(result.kind === 'staged' ? result : { kind: 'refused', sentence: result.sentence });
    });
    return () => {
      live = false;
    };
  }, [blocked, runtime.name]);

  useEffect(() => {
    let live = true;
    void createClient(connection)
      .then(client => typeof client.migrate === 'function')
      .catch(() => false)
      .then(offered => {
        if (live) setCanMove(offered);
      });
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const running = phase.kind === 'staged' ? runningOnRuntime(phase.staged) : [];
  const targets = moveTargets(runtime, runtimes);
  const chosen = targets.find(candidate => candidate.name === target) ?? null;
  const busy = changes.busy || moving;

  /** Move every ferret on it to `destination`, one at a time. Answers the ones that did not move. */
  const moveAll = async (destination: FleetRuntimeView): Promise<readonly MoveFailure[]> => {
    const client = await createClient(connection);
    const missed: MoveFailure[] = [];
    for (const session of running) {
      try {
        if (client.migrate === undefined) throw new Error('This app cannot move a ferret on this machine.');
        await client.migrate(
          session.id,
          destination.name,
          undefined,
          false,
          undefined,
          false,
          moveConversation(session, destination),
        );
      } catch (error) {
        missed.push({ session, sentence: changeRefusalSentence(error) });
      }
    }
    return missed;
  };

  const remove = async (): Promise<void> => {
    if (phase.kind !== 'staged') return;
    if (chosen !== null && running.length > 0) {
      setMoving(true);
      const missed = await moveAll(chosen).finally(() => setMoving(false));
      setFailures(missed);
      if (missed.length > 0) {
        // Nothing is removed while a ferret it was asked to move is still on it: the person decides again.
        setTarget(null);
        return;
      }
      // The moves took a while, so the removal is staged afresh rather than applying a preview that may
      // have expired; nothing runs on it any more.
      const result = await changes.apply(change);
      if (result.kind !== 'refused') onRemoved();
      return;
    }
    const result = await changes.applyStaged(phase.staged);
    if (result.kind !== 'refused') onRemoved();
  };

  return (
    <RuntimeDialog title={`Remove ${runtime.name}?`} name="remove" busy={busy} onClose={onClose}>
      {blocked ? (
        <DefaultPicker
          runtime={runtime}
          runtimes={runtimes}
          machine={machine}
          machineName={machineName}
          changes={changes}
          onClose={onClose}
          onPicked={() => {
            setDefaultMoved(true);
            onMachineChanged();
          }}
        />
      ) : phase.kind === 'reading' ? (
        <p role="status" className="m-0 text-cell text-muted" data-runtime-remove-reading="">
          Checking what runs on {runtime.name}…
        </p>
      ) : phase.kind === 'refused' ? (
        <>
          <p role="alert" className="m-0 text-cell leading-base text-err" data-runtime-remove-refused="">
            {phase.sentence}
          </p>
          <span>
            <Button type="button" variant="ghost" onClick={onClose} data-runtime-dialog-cancel="">
              Close
            </Button>
          </span>
        </>
      ) : (
        <>
          <ul
            className="m-0 flex list-none flex-col gap-1 p-0 text-cell leading-base text-fg"
            data-runtime-remove-impact=""
          >
            {phase.staged.consequences.map(sentence => (
              <li key={sentence}>{sentence}</li>
            ))}
          </ul>
          {running.length === 0 ? null : (
            <RunningFerrets
              running={running}
              targets={canMove ? targets : []}
              target={target}
              disabled={busy}
              onTarget={value => {
                setTarget(value);
                setFailures([]);
              }}
            />
          )}
          {failures.length === 0 ? null : (
            <div
              role="alert"
              className="flex flex-col gap-1 text-cell leading-base text-err"
              data-runtime-move-failed=""
            >
              <p className="m-0 font-semibold">
                {failures.length === 1 ? 'One ferret' : `${String(failures.length)} ferrets`} could not be moved, so{' '}
                {runtime.name} was not removed.
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {failures.map(failure => (
                  <li key={failure.session.id}>
                    <span className="font-semibold">{failure.session.name}</span>: {failure.sentence}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {moving ? (
            <p role="status" className="m-0 text-cell text-muted" data-runtime-moving="">
              Moving {running.length === 1 ? 'the ferret' : `${String(running.length)} ferrets`} to {chosen?.name}…
            </p>
          ) : null}
          <ChangeApplyPanel
            machineName={machineName}
            authority={changes.authority}
            busy={busy}
            refusal={changes.refusal}
            submitLabel={removeLabel(runtime, running.length, chosen?.name ?? null)}
            busyLabel={moving ? 'Moving…' : 'Removing…'}
            variant="danger"
            submitClassName={WRAPPING_SUBMIT}
            onSubmit={() => void remove()}
          >
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose} data-runtime-dialog-cancel="">
              Cancel
            </Button>
          </ChangeApplyPanel>
        </>
      )}
    </RuntimeDialog>
  );
}

function RunningFerrets({
  running,
  targets,
  target,
  disabled,
  onTarget,
}: {
  readonly running: readonly FleetRunningSession[];
  readonly targets: readonly FleetRuntimeView[];
  readonly target: string | null;
  readonly disabled: boolean;
  readonly onTarget: (target: string | null) => void;
}) {
  const selectId = useId();
  return (
    <div className="flex flex-col gap-2">
      <ul
        aria-label="Ferrets running on it"
        className="m-0 flex max-h-[30dvh] list-none flex-col divide-y divide-border-soft overflow-y-auto rounded-control border border-border-soft p-0"
        data-runtime-running=""
      >
        {running.map(session => (
          <li key={session.id} className="flex min-h-[44px] min-w-0 items-center gap-2 px-3 py-2 text-cell">
            <span className="min-w-0 flex-1 truncate font-semibold text-fg">{session.name}</span>
            <span className="shrink-0 text-meta text-muted">{HARNESS_NAMES[session.harness]}</span>
          </li>
        ))}
      </ul>
      {targets.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <label htmlFor={selectId} className="text-cell font-semibold text-fg">
            Move them to…
          </label>
          <select
            id={selectId}
            className="kt-input"
            value={target ?? ''}
            disabled={disabled}
            data-runtime-move-target=""
            onChange={event => onTarget(event.currentTarget.value === '' ? null : event.currentTarget.value)}
          >
            <option value="">Leave them running here</option>
            {targets.map(candidate => (
              <option key={candidate.name} value={candidate.name}>
                {candidate.name} · {HARNESS_NAMES[candidate.harness]}
              </option>
            ))}
          </select>
        </div>
      )}
      <p className="m-0 text-meta leading-base text-muted" data-runtime-move-plan="">
        {movePlanSentence(running.length, target)}
      </p>
    </div>
  );
}

function DefaultPicker({
  runtime,
  runtimes,
  machine,
  machineName,
  changes,
  onClose,
  onPicked,
}: {
  readonly runtime: FleetRuntimeView;
  readonly runtimes: readonly FleetRuntimeView[];
  readonly machine: FleetMachineView | null;
  readonly machineName: string;
  readonly changes: AccountChanges;
  readonly onClose: () => void;
  readonly onPicked: () => void;
}) {
  const candidates = defaultCandidates(runtime, runtimes);
  const [picked, setPicked] = useState(candidates[0]?.name ?? '');
  const selectId = useId();
  const pick = async (): Promise<void> => {
    if (machine === null || picked === '') return;
    const result = await changes.apply(machineSettings(machine, { defaultRuntime: picked }));
    if (result.kind !== 'refused') onPicked();
  };
  return (
    <>
      <p className="m-0 text-cell leading-base text-fg" data-runtime-remove-default="">
        {runtime.name} is {machineName}’s default runtime for new agents. Pick another default first.
      </p>
      {candidates.length === 0 ? (
        <>
          <p className="m-0 text-cell leading-base text-muted" data-runtime-remove-no-default="">
            There is no other agent runtime to make the default. Add one first.
          </p>
          <span>
            <Button type="button" variant="ghost" onClick={onClose} data-runtime-dialog-cancel="">
              Close
            </Button>
          </span>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor={selectId} className="text-cell font-semibold text-fg">
              New default runtime
            </label>
            <select
              id={selectId}
              className="kt-input"
              value={picked}
              data-runtime-default-picker=""
              onChange={event => {
                setPicked(event.currentTarget.value);
                changes.clear();
              }}
            >
              {candidates.map(candidate => (
                <option key={candidate.name} value={candidate.name}>
                  {candidate.name} · {HARNESS_NAMES[candidate.harness]}
                </option>
              ))}
            </select>
          </div>
          <ChangeApplyPanel
            machineName={machineName}
            authority={changes.authority}
            busy={changes.busy}
            refusal={changes.refusal}
            submitLabel={`Make ${picked} the default`}
            disabled={machine === null}
            onSubmit={() => void pick()}
          >
            <Button
              type="button"
              variant="ghost"
              disabled={changes.busy}
              onClick={onClose}
              data-runtime-dialog-cancel=""
            >
              Cancel
            </Button>
          </ChangeApplyPanel>
        </>
      )}
    </>
  );
}
