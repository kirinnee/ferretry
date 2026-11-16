/**
 * The pieces the Add MCP server form is built from: a labelled field, a one-line failure, and the foot with Cancel and the
 * form's one primary button (the same look as Ferrets' other action forms).
 */
import { Button } from '@ferretry/app/ui';
import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';

export function FormField({
  id,
  label,
  help,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly help?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="fy-action-form__field">
      <label className="fy-action-form__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {help === undefined ? null : <span className="fy-action-form__help">{help}</span>}
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
  disabled,
  icon,
}: {
  readonly onCancel: () => void;
  readonly submitLabel: string;
  readonly submitting: boolean;
  readonly disabled: boolean;
  readonly icon: ReactNode;
}) {
  return (
    <div className="fy-action-form__foot">
      <Button disabled={submitting} onClick={onCancel} size="sm" type="button" variant="ghost">
        Cancel
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
