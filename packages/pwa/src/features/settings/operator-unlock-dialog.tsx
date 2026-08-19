/**
 * THE ONE PLACE THIS BROWSER ASKS FOR THE OPERATOR PASSWORD.
 *
 * ## WHY A DIALOG, WHEN THE MECHANISM WAS ALREADY RIGHT
 *
 * `#362` made the mechanism behave like `sudo`: one typed password mints the unlock, rides the request
 * that needed it, and is not asked for again while the unlock is held. What a person MET was an inline
 * password field inside a staged-change card, under an EXPIRES timestamp and a CONFIG REVISION, beside
 * Confirm-and-Apply. So the shape on screen said *authorisation for this one action* — the exact thing
 * that week of work removed — while the code underneath said *unlock this machine*. This is the
 * presentation catching up: raised at the moment authority is needed, saying what it unlocks, and gone
 * afterwards, so the panel behind it is an ordinary settings screen rather than an approval form.
 *
 * ## IT WIDENS NOTHING
 *
 * The unlock is still held by ONE screen and dies with it, which `src/lib/grants.ts` states as a rule:
 * "a token that outlived the browser tab it was minted in is a standing configure grant nobody
 * re-consented to". This component holds no token, mints nothing, and stores nothing — it takes a typed
 * string, hands it to the caller that asked, and forgets it. What it decides is where the question is
 * asked and what the question claims to be.
 *
 * ## ONE COMPONENT FOR BOTH PANELS, DELIBERATELY
 *
 * The grants surface and the fleet cockpit both need it, and two implementations of one concept is how
 * the fleet came to describe its own authority in words no other capability used. The caller supplies
 * the sentence saying what the password does — `grantGuidance` and `fleetApplyCopy` already own that
 * vocabulary — and everything true of every unlock is said here, once: the limiter, and the lifetime.
 *
 * NOT A BOTTOM SHEET. `shell/bottom-sheet.tsx` carries a dismiss swipe, and those are not portalled, so
 * the shell's own gesture fires for the same drag. A centred dialog with a scrim has no gesture to
 * collide with, which is what `shell/bulk-stop-confirmation.tsx` already does for the same reason.
 */

import { KeyRound, Lock } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import { FIELD_LABEL } from '../../shell/panel-typography.tsx';
import { type OperatorUnlockFailure, UNLOCK_HOLDING_NOTE, UNLOCK_LIMIT_NOTE } from '../../lib/grants.ts';
import { cn } from '../../lib/class-names.ts';

export interface OperatorUnlockDialogProps {
  readonly open: boolean;
  /**
   * What this password does, in the caller's own words.
   *
   * Passed rather than written here because the two vocabularies that answer it already exist and are
   * pinned by their own tests: `grantGuidance` for a refused capability, `fleetApplyCopy` for a change.
   * A sentence of this component's own would be a third one, drifting from both.
   */
  readonly purpose: string;
  /**
   * Whether the typed value MINTS AN UNLOCK this screen then holds.
   *
   * It decides the lifetime sentence, and getting it wrong would be a lie in the dangerous direction:
   * a per-change confirmation mints nothing and is spent inside the one request that carries it, so
   * promising five ungoverned minutes there would tell somebody a window is open when none is.
   */
  readonly holding: boolean;
  readonly busy: boolean;
  readonly failure: OperatorUnlockFailure | null;
  /** The action the password is about to unblock, so the button says what happens next. */
  readonly submitLabel: string;
  readonly onSubmit: (password: string) => void;
  readonly onClose: () => void;
}

export function OperatorUnlockDialog({
  open,
  purpose,
  holding,
  busy,
  failure,
  submitLabel,
  onSubmit,
  onClose,
}: OperatorUnlockDialogProps) {
  const uid = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [password, setPassword] = useState('');
  /** Leaving takes the typed value with it. A secret must not survive a dismissal. */
  const dismiss = (): void => {
    if (busy) return;
    setPassword('');
    onClose();
  };
  const { onKeyDown } = useDialogFocus(open, dialogRef, dismiss);
  if (!open) return null;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (password === '' || busy) return;
    onSubmit(password);
    // Cleared on submit rather than on success: a wrong password is retyped, and holding the last
    // attempt in a field is one more place the value sits while somebody walks away from the screen.
    setPassword('');
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      {/* Phone-first: the sheet sits at the BOTTOM under `items-end` so the field and its button stay in
          thumb reach, and only centres from `sm:` up. */}
      <button
        type="button"
        aria-label="Cancel the operator password"
        disabled={busy}
        onClick={dismiss}
        className="absolute inset-0"
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-purpose`}
        data-operator-unlock-dialog={holding ? 'unlock' : 'confirm'}
        className="kt-panel relative flex max-h-[min(82dvh,620px)] w-full max-w-md flex-col overflow-y-auto px-cell-x py-3 shadow-popover focus:outline-none"
      >
        <h2 id={`${uid}-title`} className="m-0 flex min-w-0 items-center gap-2 text-title font-semibold text-fg">
          <Lock size={16} className="shrink-0 text-accent" aria-hidden="true" />
          {holding ? 'Unlock settings on this machine' : 'Confirm with the operator password'}
        </h2>
        <p id={`${uid}-purpose`} className="m-0 mt-2 text-ui leading-base text-muted" data-operator-unlock-purpose="">
          {purpose}
        </p>
        {/* THE SCOPE AND THE LIFETIME, ONCE. It belongs in the one place the password is typed rather
            than beside every control the unlock then covers — a note repeated at each control is what
            made this read as per-action authorisation in the first place. */}
        {holding ? (
          <p className="m-0 mt-2 text-meta leading-base text-muted" data-operator-unlock-holding="">
            {UNLOCK_HOLDING_NOTE}
          </p>
        ) : null}
        <form className="mt-3 flex flex-col gap-2" onSubmit={submit}>
          {/* FIELD_LABEL, not the `.kt-label` eyebrow: that one is small caps for a section head, and a
              form label wearing it reads as a heading rather than as the name of the box under it. */}
          <label className={FIELD_LABEL} htmlFor={`${uid}-password`}>
            Operator password for this machine
          </label>
          <input
            id={`${uid}-password`}
            type="password"
            className="kt-input"
            value={password}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            data-grant-unlock-field=""
            onChange={event => setPassword(event.target.value)}
          />
          {failure === null ? (
            <p className="m-0 text-meta leading-base text-faint">{UNLOCK_LIMIT_NOTE}</p>
          ) : (
            <p
              role="alert"
              className={cn(
                'm-0 rounded-control border px-2 py-1 text-meta leading-base',
                failure.retryable ? 'border-warn-border bg-warn-bg text-warn' : 'border-err-border bg-err-bg text-err',
              )}
              data-grant-unlock-failure={failure.retryable ? 'retryable' : 'final'}
            >
              {failure.message}
            </p>
          )}
          <div className="mt-1 flex flex-wrap gap-2">
            {/* 44px is the touch floor, not a look: this is the last control between a finger and a
                change to somebody's machine. */}
            <button
              type="submit"
              className="kt-btn min-h-[44px] flex-1 justify-center"
              data-variant="primary"
              data-operator-unlock-submit=""
              disabled={busy || password === ''}
            >
              <KeyRound size={15} aria-hidden="true" />
              {busy ? 'Working…' : submitLabel}
            </button>
            <button
              type="button"
              className="kt-btn min-h-[44px] flex-1 justify-center"
              data-variant="ghost"
              disabled={busy}
              onClick={dismiss}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
