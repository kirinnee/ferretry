/**
 * Fork into a new ferret… — a fresh ferret that starts with this one's conversation.
 *
 * The fork is cut through this ferret's latest message, on the same login and in the same folder; the
 * daemon's fork route owns everything else (what is carried, what is not, the new id). The only choice
 * here is the new ferret's name, and leaving it empty lets the daemon name it the way it names every
 * new ferret.
 */

import type { ForkSessionOutcome, SessionView } from '@ferretry/protocol';
import { GitFork } from 'lucide-react';
import { type FormEvent, useId, useRef, useState } from 'react';
import { displayCallsign } from '../../lib/callsign.ts';
import { failureMessage, FormFailure, FormField, FormFoot } from './form-parts.tsx';
import type { SessionActionFormHost } from './registry.ts';

export type ForkSession = (teammate: string | undefined) => Promise<ForkSessionOutcome>;

export function ForkForm({
  view,
  host,
  fork,
  onForked,
}: {
  readonly view: SessionView;
  readonly host: SessionActionFormHost;
  readonly fork: ForkSession;
  /** Goes to the new ferret. */
  readonly onForked: (outcome: ForkSessionOutcome) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);
  const source = displayCallsign(view.config.teammate) || view.config.name;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const outcome = await fork(name.trim() === '' ? undefined : name);
      host.close();
      onForked(outcome);
    } catch (reason) {
      setFailure(failureMessage(reason));
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form className="fy-action-form__body" noValidate onSubmit={event => void submit(event)}>
      <FormField
        help="Leave it empty and Ferretry picks a name."
        id={`${id}-name`}
        label="Name for the new ferret"
      >
        <input
          autoCapitalize="none"
          autoComplete="off"
          className="kt-input w-full"
          disabled={submitting}
          id={`${id}-name`}
          maxLength={32}
          onChange={event => setName(event.target.value.toLowerCase())}
          spellCheck={false}
          value={name}
        />
      </FormField>
      <p className="fy-action-form__note">
        It starts with {source}’s conversation up to its latest message, on the same login (
        <span className="font-mono">{view.config.agent}</span>), in the same folder, as a new ferret of its own.
      </p>
      <FormFailure message={failure} />
      <FormFoot
        icon={<GitFork aria-hidden="true" size={14} />}
        onCancel={host.close}
        submitLabel="Fork"
        submitting={submitting}
      />
    </form>
  );
}
