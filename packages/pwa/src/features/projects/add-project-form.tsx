/**
 * THE THREE WRITE JOURNEYS, IN ONE FORM.
 *
 * Point at a folder, create one, or clone one. They are one form rather than
 * three because they differ in exactly two fields and one consequence, and three
 * separate screens would make a reader choose a route before they have been told
 * what each route does to their disk. The mode segments therefore carry that
 * consequence as their own second line — "nothing is written", "creates the
 * folder", "runs git clone" — which is the sentence somebody actually needs
 * before they commit.
 *
 * THE DRAFT SURVIVES A REFUSAL. Nothing here clears a field; the caller clears
 * the draft only when the daemon has accepted it. A 422 that ate a pasted clone
 * URL would make the honest error message worthless, because the reader would
 * have to reconstruct the input before they could act on it. Switching modes
 * keeps every field too, for the same reason.
 *
 * ONE VERDICT DRIVES BOTH the submit button and the sentence beside it
 * (`projectDraftVerdict`), so "why is this disabled" is always answerable on
 * screen. An unfinished draft says nothing at all — a reader three characters
 * into a path is not making a mistake.
 *
 * NATIVE RADIOS, NOT BUTTONS WITH ROLES. A `<fieldset>` of visually-hidden
 * radios gets arrow-key selection from the browser and satisfies the a11y gate,
 * the way `chat-width-control.tsx` and `view-tabs.tsx` already do. The fieldset
 * is `relative` because `sr-only` is `position: absolute`: inside a static
 * scrollport a hidden radio escapes to the fixed app shell, and focusing it then
 * scrolls the whole app out of frame.
 */

import type { RegisterProjectRequest } from '@ferretry/protocol';
import { FolderPlus, LoaderCircle, TriangleAlert } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef } from 'react';
import { cn } from '../../lib/class-names.ts';
import {
  CLONE_PATIENCE,
  NEW_FOLDER_ONE_LEVEL,
  PROJECT_REGISTRATION_MODES,
  type ProjectRegistrationDraft,
  type ProjectRegistrationMode,
  type ProjectRegistrationStatus,
  projectDraftVerdict,
  projectModeDescriptor,
} from './project-registration-model.ts';

interface AddProjectFormProps {
  readonly draft: ProjectRegistrationDraft;
  readonly onDraftChange: (draft: ProjectRegistrationDraft) => void;
  /** Sends the request this form parsed. The caller decides whether the draft clears. */
  readonly onSubmit: (request: RegisterProjectRequest) => void;
  readonly onCancel: () => void;
  /** The one shared registration status; a discovery's own write disables this too. */
  readonly status: ProjectRegistrationStatus | null;
}

/**
 * What the daemon refused, verbatim.
 *
 * Its own component so the refusal is a branch the test tier can see executed,
 * and so the message is never paraphrased: `mkdir` reporting a missing parent and
 * `git clone` reporting a bad credential are different problems with different
 * remedies, and only the daemon knows which happened.
 */
function Refusal({ status }: { readonly status: ProjectRegistrationStatus | null }) {
  if (status?.phase !== 'refused') return null;
  return (
    <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
      <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
      {/* Two lines, because the daemon's sentence is quoted verbatim and may not
          end in punctuation — running our own sentence onto the end of it read as
          one broken sentence. */}
      <span className="grid gap-0.5">
        <span>This daemon refused it: {status.message}</span>
        <span className="text-muted">Your entries are still here — correct one and send it again.</span>
      </span>
    </p>
  );
}

export function AddProjectForm({ draft, onDraftChange, onSubmit, onCancel, status }: AddProjectFormProps) {
  const pathId = useId();
  const urlId = useId();
  const nameId = useId();
  const gitId = useId();
  const pathField = useRef<HTMLInputElement>(null);
  // This form is MOUNTED by the disclosure that reveals it, so a mount is the
  // reader having just asked for it. Focusing here rather than through
  // `autoFocus` keeps the focus move tied to that action instead of to every
  // render of the page, and leaves the attribute the a11y gate rejects out of it.
  useEffect(() => {
    pathField.current?.focus();
  }, []);
  const verdict = projectDraftVerdict(draft);
  const descriptor = projectModeDescriptor(draft.mode);
  const busy = status?.phase === 'submitting';
  const cloning = busy && status.request.kind === 'clone';
  const ready = verdict.request !== null && !busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (verdict.request === null || busy) return;
    onSubmit(verdict.request);
  };

  const setMode = (mode: ProjectRegistrationMode) => onDraftChange({ ...draft, mode });

  return (
    <form
      className="grid gap-md border-t border-border-soft pt-panel"
      onSubmit={submit}
      aria-label="Register a project"
      data-add-project-form={draft.mode}
    >
      <fieldset className="relative m-0 grid gap-xs border-0 p-0 sm:grid-cols-3" disabled={busy}>
        <legend className="sr-only">How to add the project</legend>
        {PROJECT_REGISTRATION_MODES.map(option => {
          const checked = draft.mode === option.mode;
          return (
            <label
              key={option.mode}
              data-project-mode={option.mode}
              data-project-mode-selected={checked ? 'true' : 'false'}
              className={cn(
                'flex min-h-control min-w-0 cursor-pointer flex-col justify-center gap-0.5 rounded-control border px-control-x py-2 text-left transition-colors',
                'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus',
                checked
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-border bg-surface-2 text-fg hover:border-accent',
              )}
            >
              <input
                type="radio"
                name="add-project-mode"
                className="sr-only"
                value={option.mode}
                checked={checked}
                onChange={() => setMode(option.mode)}
              />
              <span className="text-ui font-semibold">{option.label}</span>
              <span className="text-meta leading-tight text-muted">{option.detail}</span>
            </label>
          );
        })}
      </fieldset>

      <div className="grid gap-md sm:grid-cols-2">
        {draft.mode === 'clone' && (
          <label className="grid min-w-0 gap-1 text-ui text-muted sm:col-span-2" htmlFor={urlId}>
            Repository URL
            <input
              id={urlId}
              className="kt-input mono min-h-control w-full"
              value={draft.url}
              placeholder="https://github.com/you/project.git"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              onChange={event => onDraftChange({ ...draft, url: event.target.value })}
            />
          </label>
        )}
        <label className="grid min-w-0 gap-1 text-ui text-muted" htmlFor={pathId}>
          {descriptor.pathLabel}
          <input
            id={pathId}
            ref={pathField}
            className="kt-input mono min-h-control w-full"
            value={draft.path}
            placeholder={descriptor.pathPlaceholder}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={event => onDraftChange({ ...draft, path: event.target.value })}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-ui text-muted" htmlFor={nameId}>
          {/* One grid row, not two: a bare text node beside a <span> inside a
              `grid` makes the qualifier its own row and pushes this field's input
              a line below the one next to it. */}
          <span>
            Display name <span className="text-faint">(optional)</span>
          </span>
          <input
            id={nameId}
            className="kt-input min-h-control w-full"
            value={draft.name}
            placeholder="the folder’s own name"
            autoComplete="off"
            disabled={busy}
            onChange={event => onDraftChange({ ...draft, name: event.target.value })}
          />
        </label>
      </div>

      {draft.mode === 'new-folder' && (
        <div className="grid gap-xs">
          <label className="flex min-h-control items-center gap-sm text-ui text-fg" htmlFor={gitId}>
            <input
              id={gitId}
              type="checkbox"
              className="size-4 shrink-0 accent-accent"
              checked={draft.initializeGit}
              disabled={busy}
              onChange={event => onDraftChange({ ...draft, initializeGit: event.target.checked })}
            />
            Run <span className="mono">git init</span> in the new folder
          </label>
          <p className="m-0 text-meta leading-base text-muted">{NEW_FOLDER_ONE_LEVEL}</p>
        </div>
      )}

      {draft.mode === 'clone' && <p className="m-0 text-meta leading-base text-warn">{CLONE_PATIENCE}</p>}

      <Refusal status={status} />

      {verdict.problem !== null && (
        <p className="m-0 text-meta leading-base text-err" data-project-draft-problem="">
          {verdict.problem}
        </p>
      )}

      {cloning && (
        <p className="m-0 text-meta text-muted" role="status">
          Cloning on the daemon — this can take minutes. Leaving this screen does not stop it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-sm">
        <button type="submit" className="kt-btn min-h-control" data-variant="primary" disabled={!ready}>
          {busy ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />
          ) : (
            <FolderPlus size={14} aria-hidden="true" />
          )}
          {busy ? 'Registering…' : 'Register project'}
        </button>
        <button type="button" className="kt-btn min-h-control" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
