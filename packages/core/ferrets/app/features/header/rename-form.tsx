/**
 * Rename… — the ferret's name (its callsign) and its task title, in the Actions popover or sheet.
 *
 * The same patch and the same field-placed refusals however a rename is reached, so two ways to rename a ferret cannot
 * disagree about what a rename sends. The ferret id never changes, and the form says so.
 */

import { type FormEvent, useId, useRef, useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import { shortFerretId } from '../../lib/callsign.ts';
import { FormFailure, FormField, FormFoot } from './form-parts.tsx';
import { renameErrorsFor, renamePatch } from './rename-model.ts';
import type { FerretActionFormHost } from './registry.ts';

export type RenameFerret = (patch: ReturnType<typeof renamePatch>) => Promise<unknown>;

export function RenameForm({
  ferret,
  host,
  rename,
}: {
  readonly ferret: FerretSummary;
  readonly host: FerretActionFormHost;
  readonly rename: RenameFerret;
}) {
  const id = useId();
  const [name, setName] = useState(ferret.name);
  const [title, setTitle] = useState(ferret.title ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<ReturnType<typeof renameErrorsFor>>({});
  const lock = useRef(false);
  const patch = renamePatch(ferret, title, name);
  const changed = Object.keys(patch).length > 0;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!changed || lock.current) return;
    if (name.trim() === '') {
      setErrors({ name: 'A ferret needs a name.' });
      return;
    }
    // A ferret that had a task keeps one; one that never had a task may stay without.
    if (title.trim() === '' && (ferret.title ?? '') !== '') {
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
      <FormField error={errors.name} id={`${id}-name`} label="Name">
        <input
          autoCapitalize="none"
          autoComplete="off"
          className="kt-input w-full"
          disabled={submitting}
          id={`${id}-name`}
          maxLength={32}
          onChange={event => setName(event.target.value.toLowerCase())}
          spellCheck={false}
          value={name}
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
        The ferret id stays <span className="font-mono">{shortFerretId(ferret.id)}</span>
      </p>
      <FormFailure message={errors.form ?? null} />
      <FormFoot disabled={!changed} onCancel={host.close} submitLabel="Save" submitting={submitting} />
    </form>
  );
}
