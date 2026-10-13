/**
 * THE PASSKEY PROMPT: "confirm it's you", raised when an act on a machine needs it.
 *
 * It appears because the DAEMON refused a request for want of a recent step-up, and it says which
 * machine is asking. The ceremony starts on the button, never on its own — a passkey sheet nobody asked
 * for is exactly the prompt a person must learn to refuse, and Safari would refuse it anyway.
 *
 * What a confirmation buys is stated once, here: fifteen minutes on this machine, for this open copy of
 * the app, ended by closing the page. It holds no value — the daemon remembers the step-up, the browser
 * keeps nothing.
 *
 * NOT A BOTTOM SHEET, for the reason the shell gives elsewhere: a dismiss swipe that is not portalled
 * collides with the shell's own gesture. A centred dialog with a scrim has nothing to collide with.
 */

import { Fingerprint, ShieldCheck } from 'lucide-react';
import { useId, useRef, useSyncExternalStore } from 'react';
import { useDialogFocus } from '../../hooks/use-dialog-focus.ts';
import type { StepUpGate } from '../../lib/step-up-gate.ts';

/** What one confirmation covers, said where the person decides. */
export const STEP_UP_SCOPE_NOTE =
  'This covers changes on this machine for 15 minutes, in this open copy of the app. Closing the page ends it.';

/** The words one passkey prompt says: what it is for and what a confirmation buys. */
export interface PasskeyPromptCopy {
  /** The sentence after the machine's name. */
  readonly purpose: string;
  readonly scope: string;
}

export const STEP_UP_COPY: PasskeyPromptCopy = {
  purpose: 'needs your passkey before it makes this change.',
  scope: STEP_UP_SCOPE_NOTE,
};

/** What one confirmation on opening buys, said where the person decides. */
export const PRESENCE_SCOPE_NOTE =
  'This covers opening this machine on this device, including after a reload. How long it lasts is the machine\u2019s setting. Changes still ask for their own confirmation.';

export const PRESENCE_COPY: PasskeyPromptCopy = {
  purpose: 'asks for your passkey before it shows anything.',
  scope: PRESENCE_SCOPE_NOTE,
};

export interface StepUpDialogProps {
  readonly gate: StepUpGate;
  /** The words to use. Defaults to the step-up prompt's; the presence prompt passes its own. */
  readonly copy?: PasskeyPromptCopy;
  /** How the machine is named to a person: its label, or its address. */
  readonly machineName: (daemonId: string) => string;
}

export function StepUpDialog({ gate, machineName, copy = STEP_UP_COPY }: StepUpDialogProps) {
  const uid = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const prompt = useSyncExternalStore(
    listener => gate.subscribe(listener),
    () => gate.snapshot(),
    () => gate.snapshot(),
  );
  const open = prompt !== null;
  const dismiss = (): void => gate.dismiss();
  const { onKeyDown } = useDialogFocus(open, dialogRef, dismiss);
  if (prompt === null) return null;
  const machine = machineName(prompt.daemon.daemonId);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button
        type="button"
        aria-label="Cancel the passkey confirmation"
        disabled={prompt.busy}
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
        data-step-up-dialog=""
        className="kt-panel relative flex max-h-[min(82dvh,620px)] w-full max-w-md flex-col overflow-y-auto px-cell-x py-3 shadow-popover focus:outline-none"
      >
        <h2 id={`${uid}-title`} className="m-0 flex min-w-0 items-center gap-2 text-title font-semibold text-fg">
          <ShieldCheck size={16} className="shrink-0 text-accent" aria-hidden="true" />
          Confirm it’s you
        </h2>
        <p id={`${uid}-purpose`} className="m-0 mt-2 text-ui leading-base text-muted">
          <span className="font-semibold text-fg">{machine}</span> {copy.purpose}
        </p>
        <p className="m-0 mt-2 text-meta leading-base text-muted" data-step-up-scope="">
          {copy.scope}
        </p>
        {prompt.failure === undefined ? null : (
          <p
            role="alert"
            className="m-0 mt-3 rounded-control border border-err-border bg-err-bg px-2 py-1 text-meta leading-base text-err"
            data-step-up-failure=""
          >
            {prompt.failure}
          </p>
        )}
        {/* Stacked on a phone, side by side from `sm:` up — a caps label in a half-width button clips. */}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            className="kt-btn min-h-[44px] flex-1 justify-center"
            data-variant="primary"
            data-step-up-confirm=""
            disabled={prompt.busy}
            onClick={() => void gate.confirm()}
          >
            <Fingerprint size={15} aria-hidden="true" />
            {prompt.busy ? 'Waiting for your passkey…' : 'Use passkey'}
          </button>
          <button
            type="button"
            className="kt-btn min-h-[44px] flex-1 justify-center"
            data-variant="ghost"
            disabled={prompt.busy}
            onClick={dismiss}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
