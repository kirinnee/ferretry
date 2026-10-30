/**
 * "Clear all from agent ferrets": the Inbox's bulk dismiss for the agenda items that non-interactive ferrets
 * raised (docs/agenda.md § Clearing the agent ferrets' backlog). A button under the Agents filter opens a
 * confirm that says how many open agenda items it would dismiss — counted per machine with a dry run — and,
 * once confirmed, a result that says how many it dismissed and which machines it could not reach.
 *
 * It decides nothing: `lib/agenda-clear-agents.ts` reads each machine's features and talks to the daemon.
 */

import { useRef, useState } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import {
  CLEAR_NEEDS_UPDATE,
  type ClearOutcome,
  type ClearPort,
  type ClearPreview,
  type ClearTarget,
  clearAgentsEverywhere,
  previewClearAgents,
} from '../../lib/agenda-clear-agents.ts';

type ClearPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'reading' }
  | { readonly kind: 'confirm'; readonly preview: ClearPreview }
  | { readonly kind: 'clearing'; readonly preview: ClearPreview }
  | { readonly kind: 'done'; readonly outcome: ClearOutcome };

const items = (count: number): string => `${count} agenda ${count === 1 ? 'item' : 'items'}`;

/** One line per machine that could not take part, with why. */
function MachineNotes({ names, why }: { readonly names: readonly string[]; readonly why: string }) {
  if (names.length === 0) return null;
  return (
    <ul aria-label={why} className="my-2 text-cell text-muted" data-clear-notes="">
      {names.map(name => (
        <li key={name}>
          {name} {why}
        </li>
      ))}
    </ul>
  );
}

function namesOf(preview: ClearPreview, kind: 'needs-update' | 'unreachable'): readonly string[] {
  return preview.rows.filter(row => row.kind === kind).map(row => row.name);
}

function ConfirmBody({ preview }: { readonly preview: ClearPreview }) {
  const lead =
    preview.total === 0
      ? 'No open agenda items from agent ferrets.'
      : `Dismiss ${items(preview.total)} from agent ferrets? Each is closed as "cleared: agent-ferret backlog".`;
  return (
    <div data-clear-confirm="">
      <p className="mt-1 text-cell text-muted">{lead}</p>
      <MachineNotes names={namesOf(preview, 'needs-update')} why={CLEAR_NEEDS_UPDATE} />
      <MachineNotes names={namesOf(preview, 'unreachable')} why="could not be reached" />
    </div>
  );
}

function ResultBody({ outcome }: { readonly outcome: ClearOutcome }) {
  return (
    <div data-clear-result="">
      <p className="mt-1 text-cell text-muted">
        Dismissed {items(outcome.cleared)} from {outcome.sessions} {outcome.sessions === 1 ? 'ferret' : 'ferrets'}.
      </p>
      <MachineNotes names={outcome.needsUpdate} why={CLEAR_NEEDS_UPDATE} />
      <MachineNotes names={outcome.unreachable} why="could not be reached" />
    </div>
  );
}

function DialogBody({ phase }: { readonly phase: ClearPhase }) {
  if (phase.kind === 'confirm' || phase.kind === 'clearing') return <ConfirmBody preview={phase.preview} />;
  if (phase.kind === 'done') return <ResultBody outcome={phase.outcome} />;
  return (
    <p className="mt-1 text-cell text-muted" role="status">
      Counting…
    </p>
  );
}

function ConfirmButton({
  phase,
  onConfirm,
}: {
  readonly phase: ClearPhase;
  readonly onConfirm: (preview: ClearPreview) => void;
}) {
  if (phase.kind === 'clearing')
    return (
      <button className="kt-btn min-h-[44px] flex-1 justify-center" data-variant="danger" disabled type="button">
        Clearing…
      </button>
    );
  if (phase.kind !== 'confirm' || phase.preview.total === 0) return null;
  const { preview } = phase;
  return (
    <button
      className="kt-btn min-h-[44px] flex-[2] justify-center"
      data-clear-confirm-button=""
      data-variant="danger"
      onClick={() => onConfirm(preview)}
      type="button"
    >
      Clear {items(preview.total)}
    </button>
  );
}

function DialogActions({
  phase,
  onClose,
  onConfirm,
}: {
  readonly phase: ClearPhase;
  readonly onClose: () => void;
  readonly onConfirm: (preview: ClearPreview) => void;
}) {
  const busy = phase.kind === 'reading' || phase.kind === 'clearing';
  return (
    <div className="mt-3 flex shrink-0 gap-sm">
      <button
        className="kt-btn min-h-[44px] flex-1 justify-center"
        data-clear-close=""
        disabled={busy}
        onClick={onClose}
        type="button"
      >
        {phase.kind === 'done' ? 'Close' : 'Cancel'}
      </button>
      <ConfirmButton onConfirm={onConfirm} phase={phase} />
    </div>
  );
}

function ClearDialog({
  phase,
  onClose,
  onConfirm,
}: {
  readonly phase: ClearPhase;
  readonly onClose: () => void;
  readonly onConfirm: (preview: ClearPreview) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const open = phase.kind !== 'idle';
  const busy = phase.kind === 'reading' || phase.kind === 'clearing';
  const { onKeyDown } = useDialogFocus(open, ref, () => {
    if (!busy) onClose();
  });
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button
        aria-label="Close clear confirmation"
        className="absolute inset-0"
        disabled={busy}
        onClick={onClose}
        type="button"
      />
      <div
        aria-labelledby="clear-agents-title"
        aria-modal="true"
        className="kt-panel relative flex w-full max-w-md flex-col px-cell-x py-3 shadow-popover focus:outline-none"
        data-clear-dialog=""
        onKeyDown={onKeyDown}
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className="text-ui font-semibold" id="clear-agents-title">
          {phase.kind === 'done' ? 'Agent ferrets cleared' : 'Clear all from agent ferrets'}
        </h2>
        <DialogBody phase={phase} />
        <DialogActions onClose={onClose} onConfirm={onConfirm} phase={phase} />
      </div>
    </div>
  );
}

export interface ClearAgentsControlProps {
  /** The machines the clear may reach: every one the Inbox shows rows from. */
  readonly targets: readonly ClearTarget[];
  readonly port: ClearPort;
}

/** The button under the Agents filter, and the confirm and result it opens. */
export function ClearAgentsControl({ targets, port }: ClearAgentsControlProps) {
  const [phase, setPhase] = useState<ClearPhase>({ kind: 'idle' });
  const begin = (): void => {
    setPhase({ kind: 'reading' });
    void previewClearAgents(targets, port).then(preview => setPhase({ kind: 'confirm', preview }));
  };
  const confirm = (preview: ClearPreview): void => {
    setPhase({ kind: 'clearing', preview });
    void clearAgentsEverywhere(preview, port).then(outcome => setPhase({ kind: 'done', outcome }));
  };
  return (
    <div className="fy-attn-inbox__bulk" data-agenda-clear-agents="">
      <button className="kt-btn" data-agenda-clear-agents-button="" onClick={begin} type="button">
        Clear all from agent ferrets
      </button>
      <ClearDialog onClose={() => setPhase({ kind: 'idle' })} onConfirm={confirm} phase={phase} />
    </div>
  );
}
