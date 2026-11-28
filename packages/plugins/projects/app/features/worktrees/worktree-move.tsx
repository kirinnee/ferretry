import { Dialog, Spinner } from '@ferretry/app/ui';
import type { RepoWorktreeRow, WorktreeMoveOffer } from '@ferretry/core-ferrets/contract';
import { useState } from 'react';
import type { ProjectsClient } from '../../lib/client.ts';
import { reasonOf } from '../../lib/client.ts';
import { moveWorktree } from './worktrees-api.ts';

/** The daemon supplies both paths; opening, cancelling or dismissing the sheet never sends a move. */
export function WorktreeMove({
  row,
  project,
  client,
  onMoved,
}: {
  readonly row: RepoWorktreeRow;
  readonly project: string;
  readonly client: ProjectsClient;
  readonly onMoved: () => Promise<void>;
}) {
  const [reviewed, setReviewed] = useState<WorktreeMoveOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offer = row.move;
  const close = () => {
    if (!busy) {
      setReviewed(null);
      setError(null);
    }
  };
  const confirm = async () => {
    if (reviewed === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await moveWorktree(client, project, reviewed);
      await onMoved();
      setReviewed(null);
    } catch (cause) {
      setError(reasonOf(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {offer?.reason !== undefined && (
        <span className="text-meta leading-base text-muted" data-project-worktree-no-move={row.path}>
          {offer.reason}
        </span>
      )}
      {offer?.reason === undefined && offer?.destination !== undefined && offer.reviewedIdentity !== undefined && (
        <button
          type="button"
          className="kt-btn kt-btn--sm h-auto max-w-full justify-self-start whitespace-normal text-left"
          data-project-worktree-move={row.path}
          onClick={() => setReviewed(offer)}
        >
          Move to the project’s worktree root
        </button>
      )}
      <Dialog
        open={reviewed !== null}
        onClose={close}
        title="Move this worktree?"
        width="560px"
        footer={
          <>
            <button className="kt-btn" type="button" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              className="kt-btn kt-btn--primary"
              type="button"
              data-project-worktree-confirm-move=""
              onClick={() => void confirm()}
              disabled={busy}
            >
              {busy && <Spinner />}
              {busy ? 'Moving…' : 'Move worktree'}
            </button>
          </>
        }
      >
        <div className="grid min-w-0 gap-panel" data-project-worktree-move-sheet="">
          <p className="m-0 text-ui leading-base text-fg">
            This checkout stays part of the project. Its files and branch are kept.
          </p>
          <dl className="m-0 grid min-w-0 gap-sm">
            <div className="min-w-0">
              <dt className="text-meta text-muted">From</dt>
              <dd className="m-0 mono break-all text-ui text-fg">{row.path}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-meta text-muted">To</dt>
              <dd className="m-0 mono break-all text-ui text-fg">{reviewed?.destination}</dd>
            </div>
          </dl>
          {(row.ferrets ?? []).some(ferret => !ferret.active) && (
            <p className="m-0 text-meta leading-base text-muted">
              A stopped ferret last worked here. Its saved folder stays at the old path; it cannot resume there after
              this move.
            </p>
          )}
          <p className="m-0 text-meta leading-base text-muted">
            The daemon checks again before moving. A live ferret, live terminal or uncommitted files will stop the move.
          </p>
          {error !== null && (
            <p className="m-0 text-meta leading-base text-err" role="alert">
              This daemon refused it: {error}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
