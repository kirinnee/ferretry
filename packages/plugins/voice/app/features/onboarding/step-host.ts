/**
 * THE STEP HOST THIS PLUGIN'S PAGES TALK TO — the contract of docs `r10-PLAN.md` §2.1, copied structurally.
 *
 * O1 defines `StepHost` in `onboarding/contract/step-host.ts` and adds `step?: StepHost` to `PanelProps`. Voice may not
 * import another plugin's contract for this (a plugin never reaches into another's step), and O1 had not landed when this
 * was written, so the shape lives here, field for field. TODO(r10-o1): once `PanelProps.step` is in the kernel, delete
 * this file and read `props.step` straight off the panel's props; the pages already take exactly these fields.
 *
 * A page with no host (rendered by itself, in a test or an old shell) simply draws: every call below is optional.
 */

export interface StepHost {
  readonly phase: 'daemon' | 'client';
  /** I have decided to show: the shell lifts its loading cover. */
  ready(): void;
  /** I decided not to show: the shell moves on and nothing is drawn. */
  skip(why: 'not-needed' | 'already-set'): void;
  /** The person answered: a client step writes the device ledger. */
  done(): void;
  /** A long act is running (an install): the shell shows the label and locks Next. `null` when it is over. */
  busy(label: string | null): void;
  next(): void;
  back(): void;
}
