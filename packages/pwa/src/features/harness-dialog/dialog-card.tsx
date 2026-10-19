/**
 * THE DIALOG CARD — a harness's own screen, answered from Chat.
 *
 * Besides tool permissions, Codex and Claude Code stop on screens of their own: "Hooks need review",
 * "Update available", a sign-in, "New MCP server found". Each is a choice list nothing moves past until
 * somebody answers it. This card shows the dialog the daemon read off the pane — the harness's title and
 * body, one button per row in the harness's order with its exact label, its cursor row marked "default",
 * and the footer's Esc as a button — and answers it through the daemon, which types the key only while the
 * pane still shows the very dialog this card was drawn from.
 *
 * A choice that TRUSTS something (hooks run outside the sandbox, an MCP server, a folder) is drawn in the
 * warning tone with what it grants, and is never the primary action even when the harness's cursor sits on
 * it: trust is a person's decision, not the page's default.
 *
 * The same four outcomes as the approval card are said out loud:
 *   - GONE: the pane no longer shows this dialog. Nothing was typed; the page re-reads the session.
 *   - NOT CLEARED: the key landed and the same dialog is still up. Never re-sent by itself.
 *   - REFUSED: a grant refusal in the grant's own words, or the daemon's message.
 *   - ANSWERED: the card waits for the session view to drop the dialog.
 */

import type { HarnessDialog, HarnessDialogAnswerRequest, HarnessDialogAnswerResult } from '@ferretry/protocol';
import { useId, useRef, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { grantRefusalNotice } from '../../lib/grants.ts';
import {
  HarnessDialogGone,
  harnessDialogHint,
  harnessDialogSentence,
  harnessTrustNote,
} from '../../lib/harness-dialogs.ts';
import { Button } from '../../shell/primitives.tsx';

/** The daemon call the card makes, bound by the page to its own pairing. */
export interface HarnessDialogAnswerApi {
  answer(
    daemon: DaemonConnection,
    scope: DaemonSessionScope,
    answer: HarnessDialogAnswerRequest,
  ): Promise<HarnessDialogAnswerResult>;
}

export interface DialogCardProps {
  readonly api: HarnessDialogAnswerApi;
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly dialog: HarnessDialog;
  /** Who is waiting, as the page names the agent. */
  readonly agentName: string;
  /** The dialog is answered or gone: the page re-reads the session. */
  readonly onSettled?: () => void;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'answered' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'stuck' }
  | { readonly kind: 'refused'; readonly text: string };

/** A refusal in the grant's own words when it is one; the daemon's message otherwise. */
const refusalText = (error: unknown): string => {
  const grant = grantRefusalNotice(error);
  if (grant !== null)
    return grant.detail === '' ? grant.guidance.explanation : `${grant.guidance.explanation} ${grant.detail}`;
  return error instanceof Error ? error.message : 'The answer could not be sent.';
};

/** The footer's word as a button label: "skip" → "Skip". */
const escapeLabel = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

export function DialogCard({ api, daemon, scope, dialog, agentName, onSettled }: DialogCardProps) {
  const headingId = useId();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const lock = useRef(false);
  const busy = phase.kind === 'sending' || phase.kind === 'answered' || phase.kind === 'gone';
  const hint = harnessDialogHint(dialog);
  // The hook list is read, not chosen from: its rows are not answers, so only the way out is offered.
  const rows = dialog.kind === 'hooks-list' && dialog.escape !== undefined ? [] : dialog.options;

  const send = async (answer: HarnessDialogAnswerRequest): Promise<void> => {
    if (lock.current) return;
    lock.current = true;
    setPhase({ kind: 'sending' });
    try {
      const result = await api.answer(daemon, scope, answer);
      if (!result.cleared) {
        setPhase({ kind: 'stuck' });
        return;
      }
      setPhase({ kind: 'answered' });
      onSettled?.();
    } catch (cause) {
      if (cause instanceof HarnessDialogGone) {
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
      className="fy-dialog-card"
      data-daemon-id={daemon.daemonId}
      data-dialog-kind={dialog.kind}
      data-harness-dialog={dialog.id}
      data-dialog-phase={phase.kind}
    >
      <p className="fy-dialog-card__ask" id={headingId}>
        {harnessDialogSentence(agentName, dialog)}
      </p>
      {dialog.body === undefined ? null : <p className="fy-dialog-card__body">{dialog.body}</p>}
      {hint === undefined ? null : <p className="fy-dialog-card__hint">{hint}</p>}
      <fieldset className="fy-dialog-card__options">
        <legend className="sr-only">{dialog.title}</legend>
        {rows.map(option => {
          const preferred = option.number === dialog.selected;
          return (
            <Button
              className="fy-dialog-card__option"
              data-default={preferred ? '' : undefined}
              data-dialog-option={option.number}
              data-grants-trust={option.grantsTrust ? '' : undefined}
              disabled={busy}
              key={option.number}
              onClick={() => void send({ kind: 'choice', dialogId: dialog.id, number: option.number })}
              title={option.label}
              type="button"
              variant={preferred && !option.grantsTrust ? 'primary' : 'outline'}
            >
              <span className="fy-dialog-card__label">
                {option.label}
                {preferred ? <span className="fy-dialog-card__default"> · default</span> : null}
              </span>
              {option.detail === undefined ? null : <span className="fy-dialog-card__secondary">{option.detail}</span>}
              {option.grantsTrust ? (
                <span className="fy-dialog-card__trust" data-dialog-trust="">
                  {harnessTrustNote(dialog)}
                </span>
              ) : null}
            </Button>
          );
        })}
        {dialog.escape === undefined ? null : (
          <Button
            aria-label={`${escapeLabel(dialog.escape)} (Esc)`}
            className="fy-dialog-card__option"
            data-dialog-escape=""
            disabled={busy}
            onClick={() => void send({ kind: 'escape', dialogId: dialog.id })}
            title="Esc"
            type="button"
            variant="outline"
          >
            <span className="fy-dialog-card__label">{escapeLabel(dialog.escape)}</span>
          </Button>
        )}
      </fieldset>
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
        <p className="fy-dialog-card__status" role="status">
          Sending…
        </p>
      );
    case 'answered':
      return (
        <p className="fy-dialog-card__status" role="status">
          Answered — waiting for {agentName} to continue.
        </p>
      );
    case 'gone':
      return (
        <p className="fy-dialog-card__status" data-dialog-gone="" role="alert">
          This dialog is gone — it changed on the agent’s screen. Nothing was sent.
        </p>
      );
    case 'stuck':
      return (
        <p className="fy-dialog-card__status" data-dialog-stuck="" role="alert">
          The answer was typed, but the same dialog is still on the agent’s screen. Check the Console before answering
          again.
        </p>
      );
    case 'refused':
      return (
        <p className="fy-dialog-card__status" data-dialog-refused="" role="alert">
          {phase.text}
        </p>
      );
  }
}
