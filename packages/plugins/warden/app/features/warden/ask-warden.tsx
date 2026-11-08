/**
 * Actions › Warden › "Ask the Warden to investigate now…" — the Warden's one row in a ferret's Actions
 * menu, offered through Ferrets' `ferrets.actions-row` slot (views/warden-ferret.tsx) rather than written into it.
 *
 * The row opens a small form (a dialog): what the
 * investigator should look at, optional notes, and the cost line read from the Warden's own status. The
 * request is P5's `POST /v1/warden/investigate`; once the daemon has taken it, a toast says where the
 * report will land, because nothing on this screen changes until it does.
 *
 * HIDDEN, NOT DIMMED, FOR A CALLER WHO MAY NOT. The row is offered only to a caller whose grants view
 * opens `warden.use` (a passkey step-up counts as open: the carrier asks for it at the request) and who
 * may control this ferret. The grants are read once per machine and never reused for another one.
 */

import type { WardenInvestigateRequest, WardenInvestigateView, WardenStatusView } from '../../wire.ts';
import { Shield } from 'lucide-react';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import type { FerretActionFormHost } from '../../lib/ferret-actions.ts';
import { failureMessage, FormFailure, FormField, FormFoot } from '../../lib/form-parts.tsx';
import {
  ASK_WARDEN_FOCI,
  ASK_WARDEN_NOTES_MAX,
  type AskWardenFocus,
  askWardenBlocker,
  askWardenCostLine,
  askWardenInvestigatorLine,
  askWardenNote,
  askWardenQueuedSentence,
} from './ask-warden-model.ts';

export const ASK_WARDEN_ACTION_ID = 'warden-investigate';

/** The two Warden calls the form makes, bound to one machine. */
export interface AskWardenPorts {
  readonly status: () => Promise<WardenStatusView>;
  readonly investigate: (request: WardenInvestigateRequest) => Promise<WardenInvestigateView>;
}

type StatusRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: WardenStatusView }
  | { readonly kind: 'failed'; readonly reason: string };

export function AskWardenForm({
  ferret,
  name,
  host,
  ports,
}: {
  readonly ferret: string;
  /** The ferret's display name, for the toast. */
  readonly name: string;
  readonly host: FerretActionFormHost;
  readonly ports: AskWardenPorts;
}) {
  const id = useId();
  const [focus, setFocus] = useState<AskWardenFocus>('stuck');
  const [notes, setNotes] = useState('');
  const [read, setRead] = useState<StatusRead>({ kind: 'loading' });
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const lock = useRef(false);

  // One read when the form opens: the cost line and any refusal the status already knows about.
  useEffect(() => {
    let live = true;
    ports.status().then(
      status => {
        if (live) setRead({ kind: 'ready', status });
      },
      (reason: unknown) => {
        if (live) setRead({ kind: 'failed', reason: failureMessage(reason) });
      },
    );
    return () => {
      live = false;
    };
  }, [ports]);

  const blocker = read.kind === 'ready' ? askWardenBlocker(read.status) : null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (lock.current || blocker !== null) return;
    lock.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const answer = await ports.investigate({ ferret, note: askWardenNote(focus, notes) });
      host.close();
      host.notify(askWardenQueuedSentence(name, answer.state));
    } catch (reason) {
      setFailure(`No investigation: ${failureMessage(reason)}`);
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  };

  return (
    <form className="fy-action-form__body" noValidate onSubmit={event => void submit(event)}>
      <FormField id={`${id}-focus`} label="What should it look at?">
        <select
          className="kt-input w-full"
          disabled={submitting}
          id={`${id}-focus`}
          onChange={event => setFocus(event.target.value as AskWardenFocus)}
          value={focus}
        >
          {ASK_WARDEN_FOCI.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FormField>
      <FormField id={`${id}-notes`} label="Notes for the investigator (optional)">
        <textarea
          className="kt-input w-full"
          disabled={submitting}
          id={`${id}-notes`}
          maxLength={ASK_WARDEN_NOTES_MAX}
          onChange={event => setNotes(event.target.value)}
          placeholder="e.g. CI went red after the last push"
          rows={2}
          value={notes}
        />
      </FormField>
      <p className="fy-action-form__note" data-ask-warden-estimate="">
        {read.kind === 'loading'
          ? 'Reading the Warden’s status…'
          : read.kind === 'failed'
            ? `Couldn’t read the Warden’s status: ${read.reason}. The daemon still checks the cap when you ask.`
            : `${askWardenInvestigatorLine(read.status)} ${askWardenCostLine(read.status)}`}
      </p>
      <FormFailure message={blocker ?? failure} />
      <FormFoot
        disabled={blocker !== null}
        icon={<Shield aria-hidden="true" size={14} />}
        onCancel={host.close}
        submitLabel="Investigate"
        submitting={submitting}
      />
    </form>
  );
}
