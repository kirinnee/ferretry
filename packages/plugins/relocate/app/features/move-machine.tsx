/**
 * MOVE A FERRET TO ANOTHER MACHINE — the dialog (C-45): **Pick** a machine → **Review** what moves and what stays on both
 * machines → **Move** with progress → **Open on the other machine**. The app holds a session on each machine and carries
 * ciphertext between them (`lib/move.ts`); a device that wants a passkey is asked on each machine in turn, and the dialog says
 * which. Nothing is sent before the person presses Move, and nothing here can read what is sealed.
 */
import { type DaemonReach, useScreenHref } from '@ferretry/app';
import { Spinner, useDialogFocus } from '@ferretry/app/ui';
import { Check, Circle, X } from 'lucide-react';
import { type ReactNode, useId, useRef, useState } from 'react';
import {
  carry,
  type Machine,
  type Moved,
  MoveStopped,
  type Progress,
  review,
  type Review,
  sizeWords,
  type Step,
  tableOf,
} from '../lib/move.ts';

const machineOf = (reach: DaemonReach): Machine => ({
  daemon: reach.daemon,
  name: reach.machine,
  client: reach.client,
  press: reach.press,
});

type Phase =
  | { readonly kind: 'pick' }
  | { readonly kind: 'looking'; readonly to: DaemonReach }
  | { readonly kind: 'review'; readonly to: DaemonReach; readonly reviewed: Review }
  | { readonly kind: 'moving'; readonly to: DaemonReach; readonly reviewed: Review; readonly progress: Progress }
  | { readonly kind: 'done'; readonly to: DaemonReach; readonly moved: Moved }
  | { readonly kind: 'failed'; readonly message: string };

const STEPS: readonly { readonly step: Step; readonly label: string }[] = [
  { step: 'sealing', label: 'Stopping the ferret and sealing it' },
  { step: 'carrying', label: 'Carrying it across' },
  { step: 'receiving', label: 'Setting it up' },
  { step: 'finishing', label: 'Leaving a note on this machine' },
];

const messageOf = (error: unknown): string =>
  error instanceof MoveStopped || error instanceof Error ? error.message : 'The move stopped.';

export function MoveMachine({
  from,
  candidates,
  ferret,
  name,
  onClose,
  onMoved,
}: {
  readonly from: DaemonReach;
  readonly candidates: readonly DaemonReach[];
  readonly ferret: string;
  readonly name: string;
  readonly onClose: () => void;
  readonly onMoved: () => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(true, ref, onClose);
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [picked, setPicked] = useState<string | undefined>(candidates.find(each => each.online)?.daemon);
  const [folder, setFolder] = useState('');
  const hrefOf = useScreenHref();
  const busy = phase.kind === 'looking' || phase.kind === 'moving';

  const look = async (to: DaemonReach, cloneInto: string): Promise<void> => {
    setPhase({ kind: 'looking', to });
    try {
      const reviewed = await review(ferret, machineOf(from), machineOf(to), {
        ...(cloneInto.trim() === '' ? {} : { cloneInto: cloneInto.trim() }),
      });
      setPhase({ kind: 'review', to, reviewed });
    } catch (error) {
      setPhase({ kind: 'failed', message: messageOf(error) });
    }
  };

  const move = async (to: DaemonReach, reviewed: Review): Promise<void> => {
    const show = (progress: Progress): void => setPhase({ kind: 'moving', to, reviewed, progress });
    show({ step: 'sealing' });
    try {
      const moved = await carry(ferret, machineOf(from), machineOf(to), reviewed, {
        onProgress: show,
        ...(folder.trim() === '' ? {} : { cloneInto: folder.trim() }),
      });
      setPhase({ kind: 'done', to, moved });
      onMoved();
    } catch (error) {
      setPhase({ kind: 'failed', message: messageOf(error) });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute inset-0"
        disabled={busy}
        onClick={busy ? undefined : onClose}
      />
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative flex max-h-full w-full max-w-lg flex-col gap-md overflow-y-auto rounded-panel border border-border bg-surface p-panel"
        data-move-machine=""
        onKeyDown={onKeyDown}
        ref={ref}
        role="dialog"
      >
        <header className="flex items-center justify-between gap-sm">
          <h2 className="m-0 text-cell font-semibold" id={titleId}>
            Move {name} to another machine
          </h2>
          <button
            type="button"
            aria-label="Close"
            className="fy-dialog__close shrink-0"
            disabled={busy}
            onClick={onClose}
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>

        {phase.kind === 'pick' ? (
          <section className="flex flex-col gap-sm" data-move-step="pick">
            <p className="m-0 text-meta text-muted">
              {name} stops here, is sealed so only the other machine can open it, and starts there on that machine’s own
              login. This machine keeps every file and shows where it went.
            </p>
            <div role="radiogroup" aria-label="Machine to move to" className="flex flex-col gap-xs">
              {candidates.map(machine => (
                <label
                  className="flex items-center gap-sm rounded-control border border-border px-control-x py-2 text-cell"
                  key={machine.daemon}
                >
                  <input
                    checked={picked === machine.daemon}
                    disabled={!machine.online}
                    name="machine"
                    onChange={() => setPicked(machine.daemon)}
                    type="radio"
                  />
                  <span className="min-w-0 flex-1 truncate">{machine.machine}</span>
                  {machine.online ? null : <span className="text-meta text-muted">offline</span>}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-sm">
              <button type="button" className="kt-btn" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="kt-btn"
                data-variant="primary"
                disabled={picked === undefined}
                onClick={() => {
                  const to = candidates.find(each => each.daemon === picked);
                  if (to !== undefined) void look(to, folder);
                }}
              >
                Check what would move
              </button>
            </div>
          </section>
        ) : null}

        {phase.kind === 'looking' ? (
          <section className="flex items-center gap-sm text-cell" data-move-step="looking" role="status">
            <Spinner size={16} wait />
            <span>
              Asking {from.machine} and {phase.to.machine}. If this device asks for your passkey, confirm it on each.
            </span>
          </section>
        ) : null}

        {phase.kind === 'review' ? (
          <ReviewTable
            folder={folder}
            from={from}
            onBack={() => setPhase({ kind: 'pick' })}
            onFolder={setFolder}
            onMove={() => void move(phase.to, phase.reviewed)}
            onRecheck={() => void look(phase.to, folder)}
            reviewed={phase.reviewed}
            to={phase.to}
          />
        ) : null}

        {phase.kind === 'moving' ? (
          <section className="flex flex-col gap-sm" data-move-step="moving" role="status">
            <p className="m-0 text-meta text-muted">
              Keep this open. If this device asks for your passkey, confirm it on {from.machine} and on{' '}
              {phase.to.machine}.
            </p>
            <ol className="m-0 flex list-none flex-col gap-xs p-0">
              {STEPS.map(entry => {
                const at = STEPS.findIndex(each => each.step === phase.progress.step);
                const index = STEPS.indexOf(entry);
                const state = index < at ? 'done' : index === at ? 'now' : 'next';
                return (
                  <li
                    className="flex items-center gap-sm text-cell"
                    data-step={entry.step}
                    data-state={state}
                    key={entry.step}
                  >
                    {state === 'done' ? (
                      <Check aria-hidden="true" size={14} />
                    ) : state === 'now' ? (
                      <Spinner size={14} />
                    ) : (
                      <Circle aria-hidden="true" size={14} />
                    )}
                    <span className={state === 'next' ? 'text-muted' : undefined}>
                      {entry.label}
                      {entry.step === 'carrying' && phase.progress.chunk !== undefined && state === 'now'
                        ? ` (${String(phase.progress.chunk.done)} of ${String(phase.progress.chunk.of)})`
                        : ''}
                    </span>
                  </li>
                );
              })}
            </ol>
            {phase.progress.chunk === undefined ? null : (
              <div
                aria-label="Chunks carried"
                aria-valuemax={phase.progress.chunk.of}
                aria-valuemin={0}
                aria-valuenow={phase.progress.chunk.done}
                className="kt-meter__track"
                role="progressbar"
                style={{ width: '100%' }}
              >
                <div
                  className="kt-meter__fill bg-accent"
                  style={{
                    width: `${String((phase.progress.chunk.done / Math.max(1, phase.progress.chunk.of)) * 100)}%`,
                  }}
                />
              </div>
            )}
          </section>
        ) : null}

        {phase.kind === 'done' ? (
          <section className="flex flex-col gap-sm" data-move-step="done" role="status">
            <p className="m-0 text-cell">
              {name} is now running on {phase.to.machine}.
              {phase.moved.stub === 'marked'
                ? ` ${from.machine} keeps every file and shows where it went.`
                : ` ${from.machine} could not leave its note (${phase.moved.stubNote ?? 'no reason given'}); the ferret there is stopped.`}
            </p>
            <div className="flex justify-end gap-sm">
              <button type="button" className="kt-btn" onClick={onClose}>
                Close
              </button>
              {(() => {
                const href = hrefOf(phase.to.daemon, 'conversation', 'chat', { ferret: phase.moved.received.ferretId });
                return href === undefined ? null : (
                  <a className="kt-btn" data-variant="primary" href={href}>
                    Open on {phase.to.machine}
                  </a>
                );
              })()}
            </div>
          </section>
        ) : null}

        {phase.kind === 'failed' ? (
          <section className="flex flex-col gap-sm" data-move-step="failed" role="alert">
            <p className="m-0 text-cell text-err">{phase.message}</p>
            <p className="m-0 text-meta text-muted">
              Nothing was changed on {from.machine} that a restart of {name} does not undo; if it is stopped, use Resume
              ferret.
            </p>
            <div className="flex justify-end gap-sm">
              <button type="button" className="kt-btn" onClick={onClose}>
                Close
              </button>
              <button type="button" className="kt-btn" onClick={() => setPhase({ kind: 'pick' })}>
                Start over
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Rows({
  title,
  rows,
  tone,
}: {
  readonly title: string;
  readonly rows: readonly { readonly id: string; readonly label: string; readonly why?: string }[];
  readonly tone: 'moves' | 'stays';
}) {
  return (
    <div className="flex flex-col gap-xs" data-move-table={tone}>
      <h3 className="m-0 text-meta font-semibold">{title}</h3>
      <ul className="m-0 flex list-none flex-col gap-xs p-0">
        {rows.map(row => (
          <li className="text-cell" key={row.id}>
            <span>{row.label}</span>
            {row.why === undefined ? null : <span className="block text-meta text-muted">{row.why}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewTable({
  reviewed,
  from,
  to,
  folder,
  onFolder,
  onBack,
  onMove,
  onRecheck,
}: {
  readonly reviewed: Review;
  readonly from: DaemonReach;
  readonly to: DaemonReach;
  readonly folder: string;
  readonly onFolder: (folder: string) => void;
  readonly onBack: () => void;
  readonly onMove: () => void;
  readonly onRecheck: () => void;
}) {
  const table = tableOf(reviewed.source);
  const wantsFolder = reviewed.target.project === 'none' && reviewed.source.needs.remote !== undefined;
  return (
    <section className="flex flex-col gap-md" data-move-step="review">
      <p className="m-0 text-meta text-muted">
        {from.machine} → {to.machine}: {String(table.files)} file{table.files === 1 ? '' : 's'},{' '}
        {sizeWords(table.bytes)}
        {reviewed.source.branch === undefined ? '' : `, on branch ${reviewed.source.branch}`}.
      </p>
      {reviewed.refusals.length === 0 ? null : (
        <div className="flex flex-col gap-xs" data-move-refusals="" role="alert">
          <h3 className="m-0 text-meta font-semibold text-err">This cannot move yet</h3>
          <ul className="m-0 flex list-none flex-col gap-xs p-0">
            {reviewed.refusals.map(line => (
              <li className="text-cell" key={line}>
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      {reviewed.target.missingSecrets.length === 0 ? null : (
        <p className="m-0 text-meta" data-move-secrets="">
          {to.machine} needs these secrets by name before it can run {reviewed.source.needs.harness}:{' '}
          {reviewed.target.missingSecrets.join(', ')}. Copy them with “Copy secrets”, then check again.
        </p>
      )}
      <Rows rows={table.moves} title="Moves with it" tone="moves" />
      <Rows rows={table.stays} title="Stays on this machine" tone="stays" />
      {table.left.length === 0 ? null : (
        <p className="m-0 text-meta text-muted" data-move-left="">
          Left behind by name: {table.left.join(', ')}.
        </p>
      )}
      {wantsFolder ? (
        <label className="flex flex-col gap-xs text-meta">
          <span>Folder on {to.machine} to clone the project into</span>
          <input
            className="rounded-control border border-border bg-surface px-control-x py-2 text-cell"
            onChange={event => onFolder(event.target.value)}
            placeholder="/home/you/work"
            value={folder}
          />
        </label>
      ) : null}
      <div className="flex flex-wrap justify-end gap-sm">
        <button type="button" className="kt-btn" onClick={onBack}>
          Back
        </button>
        {reviewed.ok ? (
          <button type="button" className="kt-btn" data-variant="primary" onClick={onMove}>
            Move to {to.machine}
          </button>
        ) : (
          <button type="button" className="kt-btn" onClick={onRecheck}>
            Check again
          </button>
        )}
      </div>
    </section>
  );
}
