/**
 * WHAT AN OWNER-ONLY PAGE DRAWS WHEN ITS READ WAS REFUSED FOR WANT OF THE PASSKEY STEP-UP, and the person has not (yet)
 * confirmed — most often because they cancelled the prompt. The page must not stay on "Reading…", and it must never show
 * data without the step-up: it offers ONE button, "Confirm it's you to see this", and pressing it is the owner's act, so
 * the passkey is asked for again then and only then (the page reads again, not quietly).
 *
 * The same words and button the ask cards draw (`accounts/app/features/confirm-to-see.tsx`).
 */
import { Button } from './primitives.tsx';

/** The words on the button. */
export const CONFIRM_TO_SEE_WORDS = 'Confirm it’s you to see this';

/**
 * Gate's wire code for "this read wants the passkey step-up" (`STEP_UP_REQUIRED_CODE` in `@ferretry/core-gate/contract`).
 * The app cannot import Gate, and a plugin half may not consume Gate's contract unless it declares it, so the spelling is
 * here; Access's `step-up-code.test.ts` pins the two equal.
 */
export const STEP_UP_REFUSAL_CODE = 'grant_step_up_required';

/** Whether a failed read was refused only for want of the step-up (a `403` carrying Gate's step-up code), not outright. */
export const isStepUpRefusal = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  'status' in cause &&
  cause.status === 403 &&
  'code' in cause &&
  cause.code === STEP_UP_REFUSAL_CODE;

/** The button, with a short line saying why it is there. `onConfirm` reads the page's data again. */
export function ConfirmToSee({ onConfirm, line }: { readonly onConfirm: () => void; readonly line?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-confirm-to-see="">
      {line === undefined ? null : <p className="m-0 text-cell leading-base text-muted">{line}</p>}
      <Button className="min-h-[44px] self-start" variant="primary" onClick={onConfirm} type="button">
        {CONFIRM_TO_SEE_WORDS}
      </Button>
    </div>
  );
}
