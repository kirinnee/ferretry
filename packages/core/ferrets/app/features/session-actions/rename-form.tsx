/**
 * Rename… — the ferret's name (its callsign) and its task title, in the Actions popover or sheet.
 *
 * The same patch and the same field-placed refusals as the sidebar's rename sheet (`renamePatch`,
 * `renameErrorsFor`), so the two ways to rename a ferret cannot disagree about what a rename sends.
 * The session id never changes, and the form says so.
 */

import type { SessionView } from '@ferretry/protocol';
import { type FormEvent, useId, useRef, useState } from 'react';
import { renameErrorsFor, renamePatch } from '../../components/rename-sheet.tsx';
import { FormFailure, FormField, FormFoot } from './form-parts.tsx';
import type { SessionActionFormHost } from './registry.ts';

export type RenameSession = (patch: ReturnType<typeof renamePatch>) => Promise<SessionView>;

export function RenameForm({
  view,
  host,
  rename,
}: {
  readonly view: SessionView;
  readonly host: SessionActionFormHost;
  readonly rename: RenameSession;
}) {
  const id = useId();
  const [teammate, setTeammate] = useState(view.config.teammate ?? '');
  const [title, setTitle] = useState(view.config.name);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ReturnType<typeof renameErrorsFor>>({});
  const lock = useRef(false);
  const patch = renamePatch(view, title, teammate, false);
  const changed = Object.keys(patch).length > 0;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!changed || lock.current) return;
    if (teammate.trim() === '') {
      setErrors({ teammate: 'A ferret needs a name.' });
      return;
    }
    if (title.trim() === '') {
      setErrors({ title: 'The task title cannot be empty.' });
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setErrors({});
    try {
      await rename(patch);
      host.close();
    } catch (reason) {
      setErrors(renameErrorsFor(reason));
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form className="fy-action-form__body" noValidate onSubmit={event => void submit(event)}>
      <FormField error={errors.teammate} id={`${id}-name`} label="Name">
        <input
          autoCapitalize="none"
          autoComplete="off"
          className="kt-input w-full"
          disabled={submitting}
          id={`${id}-name`}
          maxLength={32}
          onChange={event => setTeammate(event.target.value.toLowerCase())}
          spellCheck={false}
          value={teammate}
        />
      </FormField>
      <FormField error={errors.title} id={`${id}-task`} label="Task">
        <input
          className="kt-input w-full"
          disabled={submitting}
          id={`${id}-task`}
          maxLength={120}
          onChange={event => setTitle(event.target.value)}
          value={title}
        />
      </FormField>
      <p className="fy-action-form__note">
        The session id stays <span className="font-mono">{view.config.id.slice(0, 8)}…</span>
      </p>
      <FormFailure message={errors.form ?? null} />
      <FormFoot disabled={!changed} onCancel={host.close} submitLabel="Save" submitting={submitting} />
    </form>
  );
}
