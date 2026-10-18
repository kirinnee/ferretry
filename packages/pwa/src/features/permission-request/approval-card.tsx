/**
 * THE APPROVAL CARD — a harness permission prompt, answered from Chat.
 *
 * Claude Code and Codex stop before a tool they have not been allowed to run and draw a numbered list in
 * their own pane. Until now the only way to answer one from a browser was the Console. This card shows
 * the same prompt in plain words, one button per choice the harness drew, in the harness's order and
 * with the harness's default marked, and answers it through the daemon — which types the key only while
 * the pane still shows the very request this card was drawn from.
 *
 * Four outcomes are said out loud, because each needs a different next step from the reader:
 *   - GONE: the pane no longer shows this request. Nothing was typed; the page re-reads the session.
 *   - NOT CLEARED: the key landed and the same prompt is still up. Never re-sent by itself.
 *   - REFUSED: a grant refusal in the grant's own words, or the daemon's message.
 *   - ANSWERED: the card waits for the session view to drop the request.
 *
 * Deny is the harness's own Esc. A note for the agent is not part of that answer: it is sent afterwards
 * as an ordinary message, and only once the prompt has cleared — a message typed into a pane still
 * showing the prompt would land in the prompt.
 */

import type { PermissionAnswerRequest, PermissionAnswerResult, PermissionRequest } from '@ferretry/protocol';
import { useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { grantRefusalNotice } from '../../lib/grants.ts';
import { PermissionPromptGone, permissionOptionWords, permissionWords } from '../../lib/permission-requests.ts';
import { Button, Textarea } from '../../shell/primitives.tsx';

/** The two daemon calls the card makes, bound by the page to its own pairing. */
export interface PermissionAnswerApi {
  answer(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    answer: PermissionAnswerRequest,
  ): Promise<PermissionAnswerResult>;
  /** The deny note, sent as an ordinary chat message. */
  note(daemon: DaemonConnection, scope: DaemonSessionScope, message: string): Promise<unknown>;
}

export interface ApprovalCardProps {
  readonly api: PermissionAnswerApi;
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly request: PermissionRequest;
  /** Who is asking, as the page names the agent. */
  readonly agentName: string;
  /** The prompt is answered or gone: the page re-reads the session. */
  readonly onSettled?: () => void;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'answered' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'stuck' }
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'note-failed'; readonly text: string };

/** A refusal in the grant's own words when it is one; the daemon's message otherwise. */
const refusalText = (error: unknown): string => {
  const grant = grantRefusalNotice(error);
  if (grant !== null)
    return grant.detail === '' ? grant.guidance.explanation : `${grant.guidance.explanation} ${grant.detail}`;
  return error instanceof Error ? error.message : 'The answer could not be sent.';
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'unknown error');

export function ApprovalCard({ api, daemon, scope, request, agentName, onSettled }: ApprovalCardProps) {
  const headingId = useId();
  const noteId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const lock = useRef(false);
  const words = permissionWords(agentName, request);
  // The first refusal is the harness's Esc; any further one the harness drew is picked by its number.
  const escNumber = request.options.find(option => option.kind === 'deny')?.number;
  const busy = phase.kind === 'sending' || phase.kind === 'answered' || phase.kind === 'gone';

  const send = async (number: number): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setPhase({ kind: 'sending' });
    const denying = number === escNumber;
    const answer: PermissionAnswerRequest = denying
      ? { kind: 'deny', requestId: request.id }
      : { kind: 'choice', requestId: request.id, number };
    try {
      const result = await api.answer(daemon, scope, answer);
      if (!result.cleared) {
        setPhase({ kind: 'stuck' });
        return;
      }
      const message = note.trim();
      if (denying && message !== '') {
        try {
          await api.note(daemon, scope, message);
        } catch (cause) {
          setPhase({ kind: 'note-failed', text: errorMessage(cause) });
          onSettled?.();
          return;
        }
      }
      setPhase({ kind: 'answered' });
      onSettled?.();
    } catch (cause) {
      if (cause instanceof PermissionPromptGone) {
        setPhase({ kind: 'gone' });
        onSettled?.();
        return;
      }
      setPhase({ kind: 'refused', text: refusalText(cause) });
    } finally {
      lock.current = false;
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      className="fy-approval-card"
      data-daemon-id={daemon.daemonId}
      data-permission-request={request.id}
      data-permission-phase={phase.kind}
    >
      <p className="fy-approval-card__ask" id={headingId}>
        <span className="fy-approval-card__lead">{words.lead}</span>
        {words.what === undefined ? null : (
          <>
            {' '}
            <code className="fy-approval-card__what" data-permission-what="">
              {words.what}
            </code>
          </>
        )}
      </p>
      {request.detail === undefined ? null : <p className="fy-approval-card__detail">{request.detail}</p>}
      <fieldset className="fy-approval-card__options">
        <legend className="sr-only">{request.question}</legend>
        {request.options.map(option => {
          const label = permissionOptionWords(option);
          const preferred = option.number === request.selected;
          return (
            <Button
              aria-label={`${label.label}: ${label.harness}${preferred ? ' (default)' : ''}`}
              className="fy-approval-card__option"
              data-default={preferred ? '' : undefined}
              data-permission-kind={option.kind}
              data-permission-option={option.number}
              disabled={busy}
              key={option.number}
              onClick={() => void send(option.number)}
              title={label.harness}
              type="button"
              variant={preferred && option.kind !== 'deny' ? 'primary' : 'outline'}
            >
              <span className="fy-approval-card__label">{label.label}</span>
              {label.secondary === undefined ? null : (
                <span className="fy-approval-card__secondary">{label.secondary}</span>
              )}
            </Button>
          );
        })}
      </fieldset>
      {escNumber === undefined ? null : noteOpen ? (
        <div className="fy-approval-card__note">
          <label className="fy-approval-card__note-label" htmlFor={noteId}>
            Note for {agentName}, sent after Deny
          </label>
          <Textarea
            disabled={busy}
            id={noteId}
            onChange={event => setNote(event.currentTarget.value)}
            placeholder="What should it do instead?"
            rows={2}
            value={note}
          />
        </div>
      ) : (
        <button
          className="fy-approval-card__note-toggle"
          disabled={busy}
          onClick={() => setNoteOpen(true)}
          type="button"
        >
          Add a note
        </button>
      )}
      <PhaseLine agentName={agentName} phase={phase} />
    </section>
  );
}

function PhaseLine({ phase, agentName }: { readonly phase: Phase; readonly agentName: string }) {
  switch (phase.kind) {
    case 'idle':
      return null;
    case 'sending':
      return (
        <p className="fy-approval-card__status" role="status">
          Sending…
        </p>
      );
    case 'answered':
      return (
        <p className="fy-approval-card__status" role="status">
          Answered — waiting for {agentName} to continue.
        </p>
      );
    case 'gone':
      return (
        <p className="fy-approval-card__status" data-permission-gone="" role="alert">
          This prompt is gone — it changed on the agent’s screen. Nothing was sent.
        </p>
      );
    case 'stuck':
      return (
        <p className="fy-approval-card__status" data-permission-stuck="" role="alert">
          The answer was typed, but the same prompt is still on the agent’s screen. Check the Console before answering
          again.
        </p>
      );
    case 'refused':
      return (
        <p className="fy-approval-card__status" data-permission-refused="" role="alert">
          {phase.text}
        </p>
      );
    case 'note-failed':
      return (
        <p className="fy-approval-card__status" role="alert">
          Denied, but the note could not be sent: {phase.text}
        </p>
      );
  }
}
