/**
 * The two answer cards. Each shows what the pane showed (the harness's own words, one button per row in the harness's
 * order, the cursor row marked), answers through the daemon, and says out loud the four outcomes:
 *   GONE: the pane no longer shows it; nothing was typed.   NOT CLEARED: the key landed and the same prompt is still
 *   up, never re-sent by itself.   REFUSED: the daemon's sentence.   ANSWERED: the card waits for the ferret to move on.
 * A row that TRUSTS something is never the primary action, even when the harness's cursor sits on it.
 */

import { useId, useRef, useState } from 'react';
import './prompt-cards.css';
import type { HarnessDialog, PermissionRequest } from '../../contract/index.ts';
import type { ClaudeCodeClient } from '../lib/client.ts';
import {
  HarnessDialogGone,
  answerHarnessDialog,
  harnessDialogSentence,
  harnessTrustNote,
} from '../lib/harness-dialogs.ts';
import {
  PermissionPromptGone,
  answerPermissionRequest,
  permissionOptionWords,
  permissionWords,
} from '../lib/permission-requests.ts';

type Phase = 'idle' | 'sending' | 'answered' | 'gone' | 'stuck' | { readonly refused: string };

const phaseText = (phase: Phase, agent: string, what: 'prompt' | 'dialog'): string | null => {
  if (phase === 'idle') return null;
  if (phase === 'sending') return 'Sending…';
  if (phase === 'answered') return `Answered, waiting for ${agent} to continue.`;
  if (phase === 'gone') return `This ${what} is gone: it changed on the ferret’s screen. Nothing was sent.`;
  if (phase === 'stuck')
    return `The answer was typed, but the same ${what} is still on the ferret’s screen. Check the Console before answering again.`;
  return phase.refused;
};

function useAnswer(
  gone: (error: unknown) => boolean,
  onSettled: (() => void) | undefined,
): { phase: Phase; run: (go: () => Promise<{ readonly cleared: boolean }>) => Promise<void> } {
  const [phase, setPhase] = useState<Phase>('idle');
  const lock = useRef(false);
  const run = async (go: () => Promise<{ readonly cleared: boolean }>): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setPhase('sending');
    try {
      const result = await go();
      setPhase(result.cleared ? 'answered' : 'stuck');
      if (result.cleared) onSettled?.();
    } catch (cause) {
      if (gone(cause)) {
        setPhase('gone');
        onSettled?.();
      } else setPhase({ refused: cause instanceof Error ? cause.message : 'The answer could not be sent.' });
    } finally {
      lock.current = false;
    }
  };
  return { phase, run };
}

export interface CardProps {
  readonly client: ClaudeCodeClient;
  readonly ferret: string;
  readonly agentName: string;
  readonly onSettled?: () => void;
}

export function PermissionCard({
  client,
  ferret,
  agentName,
  request,
  onSettled,
}: CardProps & { readonly request: PermissionRequest }) {
  const headingId = useId();
  const { phase, run } = useAnswer(cause => cause instanceof PermissionPromptGone, onSettled);
  const busy = phase === 'sending' || phase === 'answered' || phase === 'gone';
  const words = permissionWords(agentName, request);
  const text = phaseText(phase, agentName, 'prompt');
  return (
    <section
      aria-labelledby={headingId}
      className="fy-prompt-card"
      data-permission-request={request.id}
      data-permission-phase={typeof phase === 'string' ? phase : 'refused'}
    >
      <p id={headingId}>
        {words.lead}
        {words.what === undefined ? null : <code> {words.what}</code>}
      </p>
      <div className="fy-prompt-card__options">
        {request.options.map(option => {
          const label = permissionOptionWords(option);
          return (
            <button
              data-kind={option.kind}
              data-permission-option={option.number}
              disabled={busy}
              key={option.number}
              onClick={() =>
                void run(() =>
                  answerPermissionRequest(client, ferret, {
                    kind: 'choice',
                    requestId: request.id,
                    number: option.number,
                  }),
                )
              }
              title={label.harness}
              type="button"
            >
              {label.label}
              {label.secondary === undefined ? null : <small> {label.secondary}</small>}
            </button>
          );
        })}
      </div>
      {text === null ? null : <p role="status">{text}</p>}
    </section>
  );
}

export function DialogCard({
  client,
  ferret,
  agentName,
  dialog,
  onSettled,
}: CardProps & { readonly dialog: HarnessDialog }) {
  const headingId = useId();
  const { phase, run } = useAnswer(cause => cause instanceof HarnessDialogGone, onSettled);
  const busy = phase === 'sending' || phase === 'answered' || phase === 'gone';
  const text = phaseText(phase, agentName, 'dialog');
  return (
    <section
      aria-labelledby={headingId}
      className="fy-prompt-card"
      data-harness-dialog={dialog.id}
      data-dialog-kind={dialog.kind}
    >
      <p id={headingId}>{harnessDialogSentence(agentName, dialog)}</p>
      {dialog.body === undefined ? null : <p>{dialog.body}</p>}
      <div className="fy-prompt-card__options">
        {dialog.options.map(option => (
          <button
            data-dialog-option={option.number}
            data-trust={option.grantsTrust ? 'true' : undefined}
            disabled={busy}
            key={option.number}
            onClick={() =>
              void run(() =>
                answerHarnessDialog(client, ferret, { kind: 'choice', dialogId: dialog.id, number: option.number }),
              )
            }
            title={option.label}
            type="button"
          >
            {option.label}
            {option.number === dialog.selected ? ' · default' : ''}
            {option.grantsTrust ? <small> {harnessTrustNote(dialog)}</small> : null}
          </button>
        ))}
        {dialog.escape === undefined ? null : (
          <button
            data-dialog-escape=""
            disabled={busy}
            onClick={() => void run(() => answerHarnessDialog(client, ferret, { kind: 'escape', dialogId: dialog.id }))}
            title="Esc"
            type="button"
          >
            {dialog.escape.charAt(0).toUpperCase()}
            {dialog.escape.slice(1)}
          </button>
        )}
      </div>
      {text === null ? null : <p role="status">{text}</p>}
    </section>
  );
}
