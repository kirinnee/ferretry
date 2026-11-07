/**
 * The last thing every change shows before it is sent (today's `ChangeApplyPanel`): the button that makes the
 * change, a plain sentence when this device will be asked for its passkey, the grant guidance when it will not be
 * allowed at all, and what went wrong as one sentence.
 *
 * The passkey itself is asked for by the carrier when the daemon wants it; nothing here holds or sees a credential.
 * What the caller may do comes from {@link useChangeAuthority}.
 */
import { type FormEvent, type ReactNode } from 'react';
import { Button } from './primitives.tsx';
import { type ChangeAuthority, changeRefusalExplanation } from './change-authority.ts';

export interface ChangeApplyPanelProps {
  readonly machineName: string;
  readonly authority: ChangeAuthority | null;
  readonly busy: boolean;
  readonly refusal: string | null;
  /** "Create runtime", "Sign out". */
  readonly submitLabel: string;
  /** Shown while busy; defaults to "Saving…". */
  readonly busyLabel?: string;
  readonly variant?: 'primary' | 'danger';
  /** The step's own answer is not ready yet (an invalid name). */
  readonly disabled?: boolean;
  readonly onSubmit: () => void;
  /** Buttons that sit beside the submit button ("Keep signed in"). */
  readonly children?: ReactNode;
  /** Extra classes for the submit button: a label long enough to need two lines on a phone wraps. */
  readonly submitClassName?: string;
}

export function ChangeApplyPanel({
  machineName,
  authority,
  busy,
  refusal,
  submitLabel,
  busyLabel = 'Saving…',
  variant = 'primary',
  disabled = false,
  onSubmit,
  children,
  submitClassName,
}: ChangeApplyPanelProps) {
  const ready = authority !== null && authority.kind !== 'refused' && !disabled && !busy;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (ready) onSubmit();
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit} data-change-apply={authority?.kind ?? 'reading'}>
      {authority?.kind === 'refused' ? (
        <p role="status" className="m-0 text-cell leading-base text-warn" data-change-grant-refused="">
          {changeRefusalExplanation(authority.refusal)}
        </p>
      ) : null}
      {authority?.kind === 'step-up' ? (
        <p className="m-0 text-meta leading-base text-muted" data-change-step-up="">
          {machineName} will ask you to confirm with your passkey when you save.
        </p>
      ) : null}
      {refusal === null ? null : (
        <p role="alert" className="m-0 text-cell leading-base text-err" data-change-refusal="">
          {refusal}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={variant} disabled={!ready} className={submitClassName} data-change-submit="">
          {busy ? busyLabel : submitLabel}
        </Button>
        {children}
      </div>
    </form>
  );
}
