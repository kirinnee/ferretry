/** STEP 2: NAME IT, then register. A refusal is the daemon's own sentence and keeps everything typed. */
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import type { ProjectRegistrationStatus } from '../../lib/registration-model.ts';
import { CLONE_PATIENCE } from '../../lib/registration-model.ts';
import { type CreateDraft, createVerdict, defaultProjectName, projectFolder } from './create-project-model.ts';

export interface NameStepProps {
  readonly draft: CreateDraft;
  readonly onDraftChange: (draft: CreateDraft) => void;
  readonly status: ProjectRegistrationStatus | null;
  readonly onBack: () => void;
  readonly onCreate: () => void;
}

export function NameStep({ draft, onDraftChange, status, onBack, onCreate }: NameStepProps) {
  const nameId = useId();
  const verdict = createVerdict(draft);
  const busy = status?.phase === 'submitting';
  return (
    <form
      className="grid gap-md"
      data-create-step="name"
      onSubmit={event => {
        event.preventDefault();
        if (verdict.request !== null && !busy) onCreate();
      }}
    >
      <p className="m-0 text-meta text-muted" data-create-chosen="">
        {draft.source === 'clone' ? 'Will be cloned to' : 'Folder'}:{' '}
        <span className="mono break-all text-fg">{projectFolder(draft)}</span>
      </p>
      <label className="grid min-w-0 gap-1 text-ui text-muted" htmlFor={nameId}>
        Project name
        <input
          id={nameId}
          className="kt-input min-h-control w-full"
          value={draft.name}
          placeholder={defaultProjectName(draft)}
          autoComplete="off"
          disabled={busy}
          onChange={event => onDraftChange({ ...draft, name: event.target.value })}
        />
      </label>
      {draft.source === 'clone' && <p className="m-0 text-meta leading-base text-warn">{CLONE_PATIENCE}</p>}
      {status?.phase === 'refused' && (
        <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
          <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          <span className="grid gap-0.5">
            <span>This daemon refused it: {status.message}</span>
            <span className="text-muted">Your entries are still here — go back or send it again.</span>
          </span>
        </p>
      )}
      {verdict.problem !== null && (
        <p className="m-0 text-meta text-err" data-create-problem="">
          {verdict.problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-sm">
        <button type="button" className="kt-btn min-h-control" onClick={onBack} disabled={busy}>
          Back
        </button>
        <button
          type="submit"
          className="kt-btn min-h-control"
          data-variant="primary"
          disabled={verdict.request === null || busy}
        >
          {busy && <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />}
          {busy ? 'Creating…' : 'Create project'}
        </button>
      </div>
    </form>
  );
}
