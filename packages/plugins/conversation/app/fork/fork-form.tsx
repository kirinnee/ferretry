/**
 * Fork into a new ferret… — pick the message to fork through, optionally name the new ferret, and say where it works
 * (c58-37 PR11). A fork keeps the conversation through the end of the turn the picked message opens, answer included, and
 * starts a NEW ferret on that copy; the source is never changed.
 *
 * The form shows the daemon's own sentence when the fork is refused (a harness that was not tested, a cut inside a subagent
 * or a tool call, a folder that is not a Git checkout): it is the words the person can act on, never a generic error.
 */

import { FormFailure, FormField, FormFoot } from '@ferretry/app/ui';
import { type FormEvent, useId, useRef, useState } from 'react';
import { normalizeCallsign } from '@ferretry/core-ferrets/contract';
import { FORK_NAME_RULE, type ForkRequest, type ForkResult } from '../../contract/index.ts';
import type { ForkChoice } from './fork-api.ts';
import './fork.css';

export type ForkWhere = ForkRequest['worktree'];

const WHERE: ReadonlyArray<{ readonly value: ForkWhere; readonly label: string; readonly note: string }> = [
  {
    value: 'new',
    label: 'New worktree',
    note: 'The new ferret works in its own copy of this checkout, cut from its last commit. Changes you have not committed are not copied.',
  },
  {
    value: 'same',
    label: 'Same folder',
    note: 'Both ferrets work in this folder, on the same files.',
  },
];

/** The time a message was said, as a person reads it; nothing when the page carried none. */
const whenOf = (timestamp: string | undefined): string | undefined => {
  if (timestamp === undefined) return undefined;
  const at = new Date(timestamp);
  return Number.isNaN(at.getTime())
    ? undefined
    : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export interface ForkFormHost {
  readonly close: () => void;
  /** The fork was made: the dialog takes it from here. */
  readonly forked: (result: ForkResult) => void;
}

export function ForkForm({
  choices,
  older,
  initial,
  host,
  submit,
}: {
  /** What the person said, oldest first. */
  readonly choices: readonly ForkChoice[];
  /** The conversation has older messages than these. */
  readonly older: boolean;
  /** The message the form opens on; absent, the latest. */
  readonly initial?: string | undefined;
  readonly host: ForkFormHost;
  readonly submit: (request: ForkRequest) => Promise<ForkResult>;
}) {
  const id = useId();
  const [pick, setPick] = useState<string | undefined>(initial ?? choices[choices.length - 1]?.point);
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [where, setWhere] = useState<ForkWhere>('new');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);
  const picked = choices.find(choice => choice.point === pick);
  const place = WHERE.find(option => option.value === where);

  const send = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (picked === undefined || lock.current) return;
    // Said here, before anything is cut: Ferrets refuses a name that is not a callsign only after the conversation is copied.
    if (name.trim() !== '' && normalizeCallsign(name) === null) {
      setNameError(FORK_NAME_RULE);
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const trimmed = name.trim();
      host.forked(
        await submit({
          point: picked.point,
          selectionBinding: picked.selectionBinding,
          ...(trimmed === '' ? {} : { name: trimmed }),
          worktree: where,
        }),
      );
    } catch (reason) {
      setFailure(
        reason instanceof Error && reason.message.trim() !== '' ? reason.message : 'This machine did not answer.',
      );
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  };

  if (choices.length === 0)
    return (
      <div className="fy-action-form__body" data-fork-form="">
        <p className="fy-action-form__note">There is nothing to fork yet: this ferret has not been sent a message.</p>
        <div className="fy-action-form__foot">
          <button className="kt-btn kt-btn--sm" onClick={host.close} type="button">
            Close
          </button>
        </div>
      </div>
    );

  return (
    <form
      className="fy-action-form__body fy-fork-form"
      data-fork-form=""
      noValidate
      onSubmit={event => void send(event)}
    >
      {/* The fields scroll; the refusal and the buttons do not, so a person who must retry never has to hunt for them. */}
      <div className="fy-fork-scroll">
        <fieldset className="fy-action-form__fieldset">
          <legend className="fy-action-form__label">Fork through</legend>
          <ul className="fy-fork-picker" data-fork-picker="">
            {[...choices].reverse().map(choice => {
              const when = whenOf(choice.timestamp);
              return (
                <li key={choice.point}>
                  <label className="fy-fork-pick">
                    <input
                      checked={choice.point === pick}
                      disabled={submitting}
                      name={`${id}-through`}
                      onChange={() => {
                        setPick(choice.point);
                        setFailure(null);
                      }}
                      type="radio"
                      value={choice.point}
                    />
                    <span className="fy-fork-pick__body">
                      <span className="fy-fork-pick__text">{choice.text}</span>
                      {when === undefined ? null : <span className="fy-fork-pick__when">{when}</span>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <span className="fy-action-form__help">
            The new ferret keeps the conversation through this message and the answer to it. This ferret is not changed.
            {older ? ' Older messages are not listed here.' : ''}
          </span>
        </fieldset>
        <FormField
          error={nameError}
          help="Left empty, it is given a name like any new ferret."
          id={`${id}-name`}
          label="Name (optional)"
        >
          <input
            autoCapitalize="none"
            autoComplete="off"
            className="kt-input w-full"
            disabled={submitting}
            id={`${id}-name`}
            maxLength={120}
            onChange={event => {
              setName(event.target.value);
              setNameError(null);
            }}
            placeholder="try-the-other-way"
            spellCheck={false}
            value={name}
          />
        </FormField>
        <fieldset className="fy-action-form__fieldset">
          <legend className="fy-action-form__label">Where it works</legend>
          <div className="fy-segmented">
            {WHERE.map(option => (
              <label className="fy-segmented__option" key={option.value}>
                <input
                  checked={where === option.value}
                  disabled={submitting}
                  name={`${id}-where`}
                  onChange={() => {
                    setWhere(option.value);
                    setFailure(null);
                  }}
                  type="radio"
                  value={option.value}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
          <span className="fy-action-form__help" data-fork-where-note="">
            {place?.note}
          </span>
        </fieldset>
      </div>
      <FormFailure message={failure} />
      <FormFoot disabled={picked === undefined} onCancel={host.close} submitLabel="Fork" submitting={submitting} />
    </form>
  );
}
