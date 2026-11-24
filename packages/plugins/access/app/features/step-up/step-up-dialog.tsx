/**
 * THE PASSKEY PROMPT: "confirm it's you", raised when an act on a machine needs it.
 *
 * It appears because the DAEMON refused a request for want of a recent step-up, and it says in ONE
 * sentence which machine is asking and which act is being approved — code in the page cannot be stopped
 * from asking, but a person can refuse a prompt for an act they did not start. The ceremony starts on the button, never on its own — a passkey sheet nobody asked
 * for is exactly the prompt a person must learn to refuse, and Safari would refuse it anyway.
 *
 * What a confirmation buys is stated once, here: the window this machine is set to, for this open copy of
 * the app, ended by closing the page — or, for an act that takes its own passkey once, that one act. It holds no value — the daemon remembers the step-up, the browser
 * keeps nothing.
 *
 * NOT A BOTTOM SHEET, for the reason the shell gives elsewhere: a dismiss swipe that is not portalled
 * collides with the shell's own gesture. A centred dialog with a scrim has nothing to collide with.
 */

import { Button } from '@ferretry/app';
import { ActionRow, browserClipboardWriter, CopyButton } from '@ferretry/app/ui';
import { Fingerprint, ShieldCheck } from 'lucide-react';
import { useId, useRef, useSyncExternalStore } from 'react';
import { useDialogFocus } from '../../shell-grants.ts';
import { AFTER_WINDOW_SENTENCE, NO_WINDOW_SENTENCE } from '../../lib/passkey-panel.ts';
import type { StepUpGate } from '../../lib/step-up-gate.ts';

const copyWriter = browserClipboardWriter();

/** The one line the owner runs at the machine, with the one control that copies it. */
export function OwnerCommand({ command }: { readonly command: string }) {
  return (
    <div
      className="mt-2 flex min-w-0 items-center gap-1 rounded-control border border-border-strong bg-surface-2 py-1 pl-2 pr-1"
      data-passkey-owner-command=""
    >
      <code className="min-w-0 flex-1 select-all break-all font-mono text-meta leading-base text-fg">{command}</code>
      <CopyButton text={command} label="Copy the command" write={copyWriter} touch />
    </div>
  );
}

/**
 * What one confirmation covers, said where the person decides, until the machine says its own window
 * (`stepUpStaysSentence`, read as the prompt opens): no number is written here, because the window is a setting.
 */
export const STEP_UP_SCOPE_NOTE =
  'This covers changes on this machine for the time it is set to, in this open copy of the app. Closing the page ends it.';

/** What a confirmation bound to one staged thing buys: that thing, once. */
export const STEP_UP_BOUND_SCOPE_NOTE =
  'This one confirmation covers exactly what is listed here, once. Nothing else, and not a later change.';

/**
 * What a confirmation stamped for one act buys (an import's `loosen-config`, adding a device): that act, once. The
 * daemon spends the proof on it, so a second import asks again; promising the window here was the O12 S4 lie.
 */
export const STEP_UP_ONCE_SCOPE_NOTE =
  'This confirms this one change. The next change like it asks for your passkey again.';

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
export const FIRST_PASSKEY_TITLE = 'Add a passkey to this device';
const FIRST_PASSKEY_CONFIRM = 'Add a passkey';

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
        : prompt.once === true && stepUp
          ? STEP_UP_ONCE_SCOPE_NOTE
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
  const setup = prompt.firstPasskey === true;
  // No passkey and no window: the person cannot fix it here, so the prompt says the owner's exact command instead.
  // Both prompts (the unlock and the step-up) say it the same way: a device with no passkey is never left at a dead end.
  const ownerCommand = setup ? undefined : prompt.ownerCommand;

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
          {setup || ownerCommand !== undefined ? FIRST_PASSKEY_TITLE : copy.title}
        </h2>
        <p id={`${uid}-purpose`} className="m-0 mt-2 text-ui leading-base text-muted">
          {setup ? (
            <>
              This device has no passkey for{' '}
              <span className="font-semibold text-fg" data-step-up-machine="">
                {machine}
              </span>{' '}
              yet, and it can add one now: Face ID, a fingerprint or this device&rsquo;s PIN.{' '}
              {copy.kind === 'unlock' ? 'Then it unlocks.' : 'Then it confirms.'}
            </>
          ) : ownerCommand !== undefined ? (
            <>
              This device has no passkey yet for{' '}
              <span className="font-semibold text-fg" data-step-up-machine="">
                {machine}
              </span>
              . {NO_WINDOW_SENTENCE}
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
        {ownerCommand === undefined ? null : (
          <>
            <OwnerCommand command={ownerCommand} />
            <p className="m-0 mt-2 text-meta leading-base text-muted" data-passkey-after-window="">
              {AFTER_WINDOW_SENTENCE}
            </p>
          </>
        )}
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
            {(structured.cautions ?? []).map(line => (
              <p
                className="m-0 mt-2 break-words text-meta font-medium leading-base text-warn"
                data-step-up-caution=""
                key={line}
                role="note"
              >
                {line}
              </p>
            ))}
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
        {/* The shared answer row: content-sized, never the full width of the sheet (C-6), the way on first on a phone. */}
        <ActionRow
          className="mt-3"
          primary={
            <Button
              type="button"
              variant="primary"
              data-step-up-confirm=""
              {...(setup ? { 'data-step-up-first-passkey': '' } : {})}
              disabled={prompt.busy}
              onClick={() => void gate.confirm()}
            >
              <Fingerprint size={15} aria-hidden="true" />
              {prompt.busy
                ? 'Waiting for your passkey…'
                : setup || ownerCommand !== undefined
                  ? FIRST_PASSKEY_CONFIRM
                  : copy.confirm}
            </Button>
          }
          secondary={
            <Button type="button" disabled={prompt.busy} onClick={dismiss}>
              Cancel
            </Button>
          }
        />
      </div>
    </div>
  );
}
