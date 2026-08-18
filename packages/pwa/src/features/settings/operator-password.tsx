/**
 * SETTING THE OPERATOR PASSWORD — the one control that decides whether the security layer exists.
 *
 * ## IT IS RENDERED ONLY WHERE IT CAN SUCCEED, AND EXPLAINED EVERYWHERE ELSE
 *
 * `PUT /v1/grants/password` is refused to every caller that did not ARRIVE on the host, and a local
 * browser is a paired device that must unlock before it may move an existing password. Both facts come
 * from the daemon's own view through `passwordControlState`, so this component never guesses and never
 * renders a control that fails on press. Where it cannot succeed, the REASON and the alternative take
 * the control's place — a greyed button with nothing beside it is the dead end these panels exist to
 * remove, and this is the panel that can strand somebody hardest.
 *
 * ## THE WAY BACK IS ON THE SCREEN, NOT IN A DOCUMENT
 *
 * A person who has forgotten the password is exactly the person this control refuses, so the escape
 * hatch — a terminal on the machine, which never asks for the old one — is printed at the point of
 * decision rather than left for somebody to find later. Nothing about this password can lock anybody
 * out of their own machine, and that is said where the doubt occurs.
 *
 * ## THE VALUE LIVES FOR ONE CALL
 *
 * It is held in a `useState` for as long as it takes to type it, sent in a BODY, and cleared on submit.
 * There is no store, no `localStorage`, no URL and no log — a query parameter would reach every proxy's
 * access log, and a value in a log outlives every reason it was worth protecting. It is never rendered
 * back: no masked form, no length, no fingerprint. There is no reader for it anywhere in this system.
 */

import { CircleAlert, KeyRound, Lock, ShieldCheck, Trash2, TriangleAlert } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';

import { cn } from '../../lib/class-names.ts';
import {
  OPERATOR_PASSWORD_RULE_NOTE,
  operatorPasswordMismatch,
  operatorPasswordProblem,
  PASSWORD_ARRIVAL_VS_CREDENTIAL,
  PASSWORD_CLEAR_WARNING,
  PASSWORD_RECOVERY_NOTE,
  PASSWORD_REMOTE_UNAVAILABLE,
  type PasswordControlState,
} from '../../lib/grants.ts';

/** One tone per role, so this panel and the grant rows cannot paint the same meaning two ways. */
const TONE_CLASS = {
  ok: 'border-ok-border bg-ok-bg text-ok',
  disclosure: 'border-border-strong bg-surface-2 text-muted',
  limit: 'border-warn-border bg-warn-bg text-warn',
  fault: 'border-err-border bg-err-bg text-err',
} as const;

/** The state chip: the most legible thing on the header row, because it is what a reader came for. */
function PasswordStateChip({ set }: { readonly set: boolean }) {
  return (
    <span
      className={cn(
        'rounded-control border px-2 py-0.5 text-meta font-semibold',
        set ? TONE_CLASS.ok : TONE_CLASS.limit,
      )}
      data-password-state={set ? 'set' : 'unset'}
    >
      {set ? 'Set' : 'Not set'}
    </span>
  );
}

/**
 * The heading, which is about the ACT rather than the noun.
 *
 * "Operator password" is what the unlock prompt directly above this is called, and two adjacent panels
 * under one name is a screen a reader has to disambiguate for themselves. This one names what pressing
 * something here would do, which is also the more useful label.
 */
function defaultHeading(state: PasswordControlState): string {
  if (state.kind === 'remote') return 'Setting the operator password';
  if (state.kind === 'locked') return 'Change the operator password';
  return state.first ? 'Set an operator password' : 'Change the operator password';
}

export interface OperatorPasswordCardProps {
  /** What this browser may do about the password, as the daemon's view reports it. */
  readonly state: PasswordControlState;
  readonly busy?: boolean;
  /** The daemon's own sentence when a call was refused, rendered whole. */
  readonly failure?: string | null;
  /** Overridden by the pairing flow, which asks for the same control under its own heading. */
  readonly heading?: string;
  /** The lead sentence, when the surface around this control needs to say why it is being asked. */
  readonly intro?: string;
  readonly onSet: (password: string) => void;
  /**
   * Removing the password, when the surface offering this control is a place that may.
   *
   * OPTIONAL, AND ABSENT MEANS THE ROW IS NOT DRAWN. The pairing flow renders this card to satisfy a
   * requirement — "no code until a password exists" — so offering "remove the password" inside it would
   * put the undo for the requirement beside the requirement. A no-op handler would be worse: a control
   * that silently does nothing is exactly the dead end this panel exists to remove.
   */
  readonly onClear?: () => void;
}

/**
 * The render-only control.
 *
 * It reports intent and holds nothing but the value being typed, so the same component is what a test
 * drives and what the harness screenshots.
 */
export function OperatorPasswordCard({
  state,
  busy = false,
  failure = null,
  heading,
  intro,
  onSet,
  onClear,
}: OperatorPasswordCardProps) {
  const headingId = useId();
  const fieldId = useId();
  const confirmId = useId();
  const clearNoteId = useId();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const exists = state.kind === 'locked' || (state.kind === 'ready' && !state.first);
  const problem = password === '' ? undefined : operatorPasswordProblem(password);
  const mismatched = operatorPasswordMismatch(password, confirmation);
  const submittable = password !== '' && problem === undefined && !mismatched && confirmation === password && !busy;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!submittable) return;
    onSet(password);
    // Cleared at submit rather than on success: a value left in a field is one more place it sits while
    // somebody walks away from the screen, and a refusal is retyped rather than resent.
    setPassword('');
    setConfirmation('');
  };

  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-3 p-panel"
      aria-labelledby={headingId}
      data-operator-password={state.kind}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 id={headingId} className="m-0 flex min-w-0 items-center gap-1.5 text-title font-semibold text-fg">
          <ShieldCheck size={15} className="shrink-0 text-accent" aria-hidden="true" />
          {heading ?? defaultHeading(state)}
        </h4>
        {state.kind === 'remote' ? null : <PasswordStateChip set={exists} />}
      </div>

      <p className="m-0 text-ui leading-base text-muted">
        {intro ??
          'It gates changes made from any device that is not this machine, and it is what this browser proves before it can change anything here. It is not your computer’s login: nothing in Ferretry uses it to run anything as another user.'}
      </p>

      {/* ARRIVAL VERSUS CREDENTIAL, before the tap rather than as a refusal afterwards. A phone on the
          same desk is not at the machine, and somebody who reads "local" as "same network" needs to be
          told which one the daemon means. */}
      <p className="m-0 text-meta leading-base text-faint" data-password-arrival-note="">
        {PASSWORD_ARRIVAL_VS_CREDENTIAL}
      </p>

      {state.kind === 'remote' ? (
        <p
          role="status"
          className={cn('m-0 rounded-control border px-3 py-2 text-ui leading-base', TONE_CLASS.limit)}
          data-password-unavailable=""
        >
          <TriangleAlert size={14} className="mr-1 inline" aria-hidden="true" />
          {PASSWORD_REMOTE_UNAVAILABLE}
        </p>
      ) : null}

      {state.kind === 'locked' ? (
        <p
          role="status"
          className={cn('m-0 rounded-control border px-3 py-2 text-ui leading-base', TONE_CLASS.limit)}
          data-password-locked=""
        >
          <Lock size={14} className="mr-1 inline" aria-hidden="true" />
          Changing it needs the password this machine already has. Enter it in the unlock above, and this control opens
          for five minutes.
        </p>
      ) : null}

      {state.kind === 'ready' ? (
        <form className="flex min-w-0 flex-col gap-2" onSubmit={submit}>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label className="text-meta font-medium text-muted" htmlFor={fieldId}>
                {exists ? 'New password' : 'Password'}
              </label>
              <input
                id={fieldId}
                type="password"
                value={password}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                data-password-field=""
                onChange={event => setPassword(event.target.value)}
                className="h-control w-full min-w-0 rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label className="text-meta font-medium text-muted" htmlFor={confirmId}>
                Again
              </label>
              <input
                id={confirmId}
                type="password"
                value={confirmation}
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                data-password-confirm-field=""
                onChange={event => setConfirmation(event.target.value)}
                className="h-control w-full min-w-0 rounded-control border border-border bg-surface-2 px-control-x text-ui text-fg disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
          </div>
          {/* The rule and the typo, said at the field. Checked here so a person is told before a call
              rather than by a 400, and the minimum comes from the protocol schema rather than a second
              copy of the number. */}
          {problem === undefined && !mismatched ? (
            <p className="m-0 text-meta leading-base text-faint">{OPERATOR_PASSWORD_RULE_NOTE}</p>
          ) : (
            <p
              role="alert"
              className={cn('m-0 rounded-control border px-2 py-1 text-meta leading-base', TONE_CLASS.limit)}
              data-password-problem=""
            >
              {mismatched ? 'The two entries do not match.' : problem}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" className="kt-btn shrink-0" disabled={!submittable} data-password-submit="">
              <KeyRound size={14} aria-hidden="true" />
              {exists ? 'Replace the password' : 'Set the password'}
            </button>
            {exists ? null : (
              <span className="text-meta leading-base text-faint">
                Once one is set, this browser is asked for it before it changes anything here.
              </span>
            )}
          </div>
        </form>
      ) : null}

      {/* THE WAY BACK, on the screen and not in a document. Rendered for every state that can leave
          somebody stuck: a locked browser, a remote one, and a live control that is about to replace a
          password the reader may not have. */}
      <p className="m-0 text-meta leading-base text-muted" data-password-recovery="">
        {PASSWORD_RECOVERY_NOTE}
      </p>

      {/* Removing it is the one action here that makes the machine less protected, so the consequence is
          in the same breath as the button — the treatment a device revoke already gets — rather than in
          a confirmation somebody clicks through. */}
      {state.kind === 'ready' && exists && onClear !== undefined ? (
        <div className="flex min-w-0 flex-col gap-1 border-t border-border-strong pt-3">
          <button
            type="button"
            disabled={busy}
            data-variant="danger"
            data-password-clear=""
            aria-describedby={clearNoteId}
            onClick={onClear}
            className="kt-btn self-start disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 size={14} aria-hidden="true" />
            Remove the password
          </button>
          <p id={clearNoteId} className="m-0 text-meta leading-base text-warn" data-password-clear-warning="">
            {PASSWORD_CLEAR_WARNING}
          </p>
        </div>
      ) : null}

      {failure === null ? null : (
        <p
          role="alert"
          className={cn('m-0 rounded-control border px-3 py-2 text-ui leading-base', TONE_CLASS.fault)}
          data-password-failure=""
        >
          <CircleAlert size={14} className="mr-1 inline" aria-hidden="true" />
          {/* The daemon's own sentence, whole. It already names the command a human runs, composed by the
              layer that knows what this product's client is called. */}
          {failure}
        </p>
      )}
    </section>
  );
}
