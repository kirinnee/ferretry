/**
 * The pieces every Actions form is built from: a labelled field, a one-line error, and the foot with
 * Cancel and the form's one primary button. Shared so a popover on a desktop and a sheet on a phone
 * draw the same form, and so the rename, fork and Add MCP server forms cannot drift into three
 * spacings and three error styles.
 */

import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../shell/primitives.tsx';

export function FormField({
  id,
  label,
  help,
  error,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly help?: ReactNode;
  readonly error?: string | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="fy-action-form__field">
      <label className="fy-action-form__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {help === undefined ? null : <span className="fy-action-form__help">{help}</span>}
      {error === undefined || error === null ? null : (
        <span className="fy-action-form__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** A form-level failure, in the daemon's own words. */
export function FormFailure({ message }: { readonly message: string | null }) {
  return message === null ? null : (
    <p className="fy-action-form__failure" role="alert">
      {message}
    </p>
  );
}

export function FormFoot({
  onCancel,
  submitLabel,
  submitting,
  disabled = false,
  cancelLabel = 'Cancel',
  icon,
}: {
  readonly onCancel: () => void;
  readonly submitLabel: string;
  readonly submitting: boolean;
  readonly disabled?: boolean;
  readonly cancelLabel?: string;
  readonly icon?: ReactNode;
}) {
  return (
    <div className="fy-action-form__foot">
      <Button disabled={submitting} onClick={onCancel} size="sm" type="button" variant="ghost">
        {cancelLabel}
      </Button>
      <Button data-action-submit="" disabled={submitting || disabled} size="sm" type="submit" variant="primary">
        {submitting ? (
          <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
        ) : (
          icon
        )}
        {submitLabel}
      </Button>
    </div>
  );
}

export const failureMessage = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));
