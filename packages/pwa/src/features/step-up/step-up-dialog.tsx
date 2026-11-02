/**
 * THE PASSKEY PROMPT: "confirm it's you", raised when an act on a machine needs it.
 *
 * It appears because the DAEMON refused a request for want of a recent step-up, and it says in ONE
 * sentence which machine is asking and which act is being approved — code in the page cannot be stopped
 * from asking, but a person can refuse a prompt for an act they did not start. The ceremony starts on the button, never on its own — a passkey sheet nobody asked
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

/** What a confirmation bound to one staged thing buys: that thing, once. */
export const STEP_UP_BOUND_SCOPE_NOTE =
  'This one confirmation covers exactly what is listed here, once. Nothing else, and not a later change.';

/** What a confirmation does when a bound request shares its prompt with others: it is stamped for none of them, and buys the ordinary window. */
export const sharedBoundNote = (scope: string): string =>
  `More than one request is waiting on this machine, so this confirmation is not tied to the staged request. ${scope} Then confirm the staged request again.`;

/** Several acts waiting on one machine are named together: "open a terminal and add or manage a paired device". */
const ACT_LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

/** How one passkey prompt names what it is for. Step-up names the acts waiting; unlock names none. */
type PasskeyPromptKind = 'step-up' | 'unlock';

/** The words one passkey prompt says: what it is for and what a confirmation buys. */
export interface PasskeyPromptCopy {
  readonly kind: PasskeyPromptKind;
  readonly title: string;
  /** What a confirmation buys, or `null` when only the machine can say (the unlock: its own number of hours). */
  readonly scope: string | null;
  readonly confirm: string;
}

const STEP_UP_COPY: PasskeyPromptCopy = {
  kind: 'step-up',
  title: 'Confirm it\u2019s you',
  scope: STEP_UP_SCOPE_NOTE,
  confirm: 'Use passkey',
};

/** What the unlock prompt leads with for a device that may add its first passkey now. */
export const FIRST_PASSKEY_TITLE = 'Set up Face ID for this device';
const FIRST_PASSKEY_CONFIRM = 'Set up passkey';

/** The unlock that opens the app: one sentence, one line on how long it stays, one button. */
export const UNLOCK_COPY: PasskeyPromptCopy = {
  kind: 'unlock',
  title: 'Unlock',
  scope: null,
  confirm: 'Unlock',
};

export interface StepUpDialogProps {
  readonly gate: StepUpGate;
  /** The words to use. Defaults to the step-up prompt's; the unlock prompt passes its own. */
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
  const acts = ACT_LIST.format(prompt.acts);
  const stepUp = copy.kind === 'step-up';
  const scope =
    prompt.bound === true && stepUp
      ? STEP_UP_BOUND_SCOPE_NOTE
      : prompt.shared === true && stepUp
        ? sharedBoundNote(prompt.scope ?? STEP_UP_SCOPE_NOTE)
        : (prompt.scope ?? copy.scope);
  // A confirmation bound to a staged thing lists what it approves, one line each (a task plan brings the daemon's own
  // words).
  // A standing sign-in rule brings its words as STRUCTURE (`prompt.words`): its rows and its red block are separate
  // lists, so a row can never be drawn as a warning. Other acts bring text, split here.
  const structured = prompt.words;
  const lines = prompt.acts.flatMap(act => act.split('\n'));
  const listed = prompt.bound === true && stepUp;
  // A device with no passkey yet, inside its window: the way in is to set one up, so the prompt says so
  // first — the other remedies are for after the window has closed, and its failure sentence names them.
  const setup = copy.kind === 'unlock' && prompt.firstPasskey === true;

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
          {setup ? FIRST_PASSKEY_TITLE : copy.title}
        </h2>
        <p id={`${uid}-purpose`} className="m-0 mt-2 text-ui leading-base text-muted">
          {setup ? (
            <>
              This device has no passkey for{' '}
              <span className="font-semibold text-fg" data-step-up-machine="">
                {machine}
              </span>{' '}
              yet, and it can add one now: Face ID, a fingerprint or this device&rsquo;s PIN. Then it unlocks.
            </>
          ) : copy.kind === 'unlock' ? (
            <>
              Unlock{' '}
              <span className="font-semibold text-fg" data-step-up-machine="">
                {machine}
              </span>{' '}
              with your passkey.
            </>
          ) : listed ? (
            <>
              Confirm with your passkey on{' '}
              <span className="font-semibold text-fg" data-step-up-machine="">
                {machine}
              </span>
              . This approves exactly:
            </>
          ) : (
            <>
              Confirm with your passkey to <span data-step-up-act="">{acts}</span> on{' '}
              <span className="font-semibold text-fg" data-step-up-machine="">
                {machine}
              </span>
              .
            </>
          )}
        </p>
        {listed && structured !== undefined ? (
          <>
            <p className="m-0 mt-2 break-words text-ui font-medium leading-base text-fg" data-step-up-does="">
              {structured.does}
            </p>
            <dl
              className="m-0 mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui leading-base"
              data-step-up-summary=""
            >
              {structured.rows.map(row => (
                <div className="contents" data-step-up-row={row.label} key={`${row.label}\n${row.value}`}>
                  <dt className="text-muted">{row.label}</dt>
                  <dd className="m-0 min-w-0 break-words text-fg">{row.value}</dd>
                </div>
              ))}
            </dl>
            {structured.warnings.length > 0 ? (
              <div
                className="mt-2 flex flex-col gap-1 rounded-control border border-err-border bg-err-bg px-2 py-1.5 text-meta leading-base text-err"
                data-step-up-warnings=""
                role="note"
              >
                {structured.warnings.map(line => (
                  <p className="m-0 break-words" key={line}>
                    {line}
                  </p>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {listed && structured === undefined ? (
          <ul
            className="m-0 mt-2 flex list-disc flex-col gap-1 pl-5 text-ui leading-base text-fg"
            data-step-up-summary=""
          >
            {lines.map(line => (
              <li className="break-words" key={line}>
                {line}
              </li>
            ))}
          </ul>
        ) : null}
        {scope === null ? null : (
          <p className="m-0 mt-2 text-meta leading-base text-muted" data-step-up-scope="">
            {scope}
          </p>
        )}
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
            {...(setup ? { 'data-step-up-first-passkey': '' } : {})}
            disabled={prompt.busy}
            onClick={() => void gate.confirm()}
          >
            <Fingerprint size={15} aria-hidden="true" />
            {prompt.busy ? 'Waiting for your passkey…' : setup ? FIRST_PASSKEY_CONFIRM : copy.confirm}
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
