/** "+ CARD": the owner writes a card straight onto a machine's board, for a ferret that exists or for one started on it. */

import { type BoardTaskView, formatTaskRef, type TaskKind } from '@ferretry/protocol';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import type { BoardActions } from '../../../lib/board-actions.ts';
import {
  assignedMessage,
  kindLabel,
  NEW_CARD_PROBLEM_TEXT,
  type NewCardDraft,
  newCardProblems,
  OWNER_CARD_SOURCE,
  startBrief,
} from '../../../lib/board-detail.ts';
import type { DaemonConnection } from '../../../lib/daemon-connection.ts';

const KINDS: readonly TaskKind[] = ['feature', 'bug', 'infra', 'chore'];
const NOBODY = '';

/** What starting a ferret and speaking to one need from outside. */
export interface NewCardPorts {
  /** Starts a ferret with the brief and answers its session id. */
  readonly startFerret: (daemon: DaemonConnection, prompt: string) => Promise<string>;
  readonly sendMessage: (daemon: DaemonConnection, sessionId: string, message: string) => Promise<void>;
}

export interface BoardNewCardProps {
  readonly connection: DaemonConnection;
  readonly machineName: string;
  readonly actions: Pick<BoardActions, 'create'>;
  readonly ports: NewCardPorts;
  /** The ferrets a card can be handed to. */
  readonly assignees: readonly { readonly sessionId: string; readonly name: string }[];
  /** The machine's boards; empty lets the daemon choose. */
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly onCancel: () => void;
  /** Called with the card the daemon now holds. */
  readonly onCreated: (task: BoardTaskView) => void;
}

export function BoardNewCard({
  connection,
  machineName,
  actions,
  ports,
  assignees,
  projects,
  onCancel,
  onCreated,
}: BoardNewCardProps) {
  const [draft, setDraft] = useState<NewCardDraft>({ title: '', ask: '' });
  const [kind, setKind] = useState<TaskKind>('feature');
  const [assignee, setAssignee] = useState(NOBODY);
  const [project, setProject] = useState(projects[0]?.id ?? NOBODY);
  const [startOne, setStartOne] = useState(false);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = useRef<HTMLInputElement>(null);
  const headingId = useId();
  useEffect(() => title.current?.focus(), []);

  const chosen = startOne ? 'new' : assignee === NOBODY ? null : assignee;
  const problems = newCardProblems(draft, chosen);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setShown(true);
    if (problems.length > 0 || busy) return;
    setBusy(true);
    setError(null);
    let owner = assignee;
    if (startOne) {
      try {
        owner = await ports.startFerret(connection, startBrief(draft));
      } catch (reason) {
        setBusy(false);
        setError(`The ferret did not start: ${reason instanceof Error ? reason.message : String(reason)}`);
        return;
      }
    }
    const made = await actions.create(connection.daemonId, {
      kind,
      title: draft.title.trim(),
      ask: { text: draft.ask.trim(), source: OWNER_CARD_SOURCE },
      assignee: owner,
      ...(project === NOBODY ? {} : { projectId: project }),
    });
    if (!made.ok) {
      setBusy(false);
      setError(
        startOne ? `${made.error.message} The ferret is already running; assign it from the chat.` : made.error.message,
      );
      return;
    }
    if (startOne) {
      try {
        await ports.sendMessage(connection, owner, assignedMessage(made.value));
      } catch (reason) {
        setBusy(false);
        setError(
          `${formatTaskRef({ id: made.value.id })} was created, but the ferret was not told: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
        onCreated(made.value);
        return;
      }
    }
    setBusy(false);
    onCreated(made.value);
  };

  return (
    <form
      aria-labelledby={headingId}
      aria-modal="true"
      className="fy-board-newcard"
      onKeyDown={event => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onCancel();
      }}
      onSubmit={event => void submit(event)}
      role="dialog"
    >
      <p className="fy-board-reason__heading" id={headingId}>
        New card on {machineName}
      </p>
      <label>
        Title (five words at most)
        <input
          className="fy-board-reason__input"
          onChange={event => setDraft({ ...draft, title: event.target.value })}
          ref={title}
          type="text"
          value={draft.title}
        />
      </label>
      <label>
        What you want done
        <textarea
          className="fy-board-reason__input"
          onChange={event => setDraft({ ...draft, ask: event.target.value })}
          rows={4}
          value={draft.ask}
        />
      </label>
      <label>
        Kind
        <select
          className="fy-board-reason__input"
          onChange={event => setKind(KINDS.find(value => value === event.target.value) ?? 'feature')}
          value={kind}
        >
          {KINDS.map(value => (
            <option key={value} value={value}>
              {kindLabel(value)}
            </option>
          ))}
        </select>
      </label>
      {projects.length === 0 ? null : (
        <label>
          Project
          <select className="fy-board-reason__input" onChange={event => setProject(event.target.value)} value={project}>
            {projects.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Assign to
        <select
          className="fy-board-reason__input"
          disabled={startOne}
          onChange={event => setAssignee(event.target.value)}
          value={startOne ? NOBODY : assignee}
        >
          <option value={NOBODY}>Pick a ferret…</option>
          {assignees.map(entry => (
            <option key={entry.sessionId} value={entry.sessionId}>
              {entry.name}
            </option>
          ))}
        </select>
      </label>
      <label className="fy-board-newcard__check">
        <input checked={startOne} onChange={event => setStartOne(event.target.checked)} type="checkbox" />
        Start a ferret on this
      </label>
      {shown && problems.length > 0 ? (
        <ul className="fy-board-reason__error" role="alert">
          {problems.map(problem => (
            <li key={problem}>{NEW_CARD_PROBLEM_TEXT[problem]}</li>
          ))}
        </ul>
      ) : null}
      {error === null ? null : (
        <p className="fy-board-reason__error" role="alert">
          {error}
        </p>
      )}
      <div className="fy-board-reason__actions">
        <button className="kt-btn" data-variant="ghost" onClick={onCancel} type="button">
          Cancel
        </button>
        <button className="kt-btn" data-variant="primary" disabled={busy} type="submit">
          {busy ? 'Creating…' : 'Create card'}
        </button>
      </div>
    </form>
  );
}
