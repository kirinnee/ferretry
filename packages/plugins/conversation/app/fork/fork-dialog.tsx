/**
 * The Fork form in a dialog (Escape and a click outside close it; focus stays inside while it is open), for the ferret the
 * header row or a message's "Fork from here…" belongs to. It reads the messages a fork can be cut at, asks the daemon to
 * fork, and then offers the new ferret.
 */

import { controlState, useOptionalRouter, useScreenHref, useViewPlace } from '@ferretry/app';
import { Button, Loading, useDialogFocus } from '@ferretry/app/ui';
import { GitFork, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { ForkResult } from '../../contract/index.ts';
import { useConversationClient, useConversationDaemon } from '../client.ts';
import { type ForkChoices, postFork, readForkChoices } from './fork-api.ts';
import { ForkForm } from './fork-form.tsx';

/** The route the fork is sent to: what this device may do with it is the form's whole authority. */
const FORK_ROUTE = 'POST /v1/ferrets/:ferretId/fork';

/** What a fork says when the person dismissed the machine's unlock, so nothing was sent. */
const NOT_UNLOCKED = 'Nothing was forked: this machine wants your passkey first.';

/** What the control for the fork route may do on this device: absent a place (a suite), the daemon's own answer decides. */
export function useForkControl(): { readonly shown: boolean; readonly enabled: boolean; readonly note?: string } {
  const place = useViewPlace();
  return place === null ? { shown: true, enabled: true } : controlState(place.authorityOf(FORK_ROUTE));
}

export function ForkDialog({
  ferret,
  initial,
  onClose,
}: {
  readonly ferret: string;
  /** The text of the message the form opens on; absent, the latest. */
  readonly initial?: string | undefined;
  readonly onClose: () => void;
}) {
  const client = useConversationClient();
  const daemon = useConversationDaemon();
  const router = useOptionalRouter();
  const href = useScreenHref();
  const place = useViewPlace();
  const ref = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const { onKeyDown } = useDialogFocus(true, ref, onClose);
  const [read, setRead] = useState<ForkChoices | 'pending' | string>('pending');
  const [made, setMade] = useState<ForkResult | null>(null);

  useEffect(() => {
    let live = true;
    readForkChoices(client, ferret).then(
      choices => live && setRead(choices),
      (reason: unknown) =>
        live &&
        setRead(
          reason instanceof Error && reason.message.trim() !== ''
            ? reason.message
            : 'The conversation could not be read, so there is nothing to choose from.',
        ),
    );
    return () => {
      live = false;
    };
  }, [client, ferret]);

  const open = (): void => {
    if (made === null || daemon === undefined) return;
    const to = href(daemon, 'conversation', 'chat', { ferret: made.ferret });
    if (to !== undefined) router?.navigate(to);
    onClose();
  };
  const initialPoint =
    typeof read === 'object' && initial !== undefined
      ? [...read.choices].reverse().find(choice => choice.text.trim() === initial.trim())?.point
      : undefined;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      <button aria-label="Close" className="absolute inset-0" onClick={onClose} type="button" />
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative flex max-h-full min-h-0 w-full max-w-md flex-col gap-md overflow-hidden rounded-panel border border-border bg-surface p-4"
        data-fork-dialog=""
        onKeyDown={onKeyDown}
        ref={ref}
        role="dialog"
      >
        <header className="flex items-center justify-between gap-sm">
          <h2 className="m-0 text-cell font-semibold" id={titleId}>
            Fork into a new ferret
          </h2>
          <button aria-label="Close" className="kt-btn h-11 w-11 shrink-0 p-0" onClick={onClose} type="button">
            <X aria-hidden="true" size={15} />
          </button>
        </header>
        {made !== null ? (
          <div className="fy-action-form__body" data-fork-done="">
            <p className="fy-action-form__ok" role="status">
              <GitFork aria-hidden="true" size={14} />
              <span>
                Forked into a new ferret
                {made.worktree === undefined ? '' : `, working on the branch ${made.worktree.branch}`}.
                {made.attachments === 0
                  ? ''
                  : ` ${String(made.attachments)} attachment${made.attachments === 1 ? '' : 's'} came with it.`}
              </span>
            </p>
            {made.notice === undefined ? null : <p className="fy-action-form__failure">{made.notice}</p>}
            <div className="fy-action-form__foot">
              <Button onClick={onClose} size="sm" type="button" variant="ghost">
                Stay here
              </Button>
              <Button onClick={open} size="sm" type="button" variant="primary">
                Open it
              </Button>
            </div>
          </div>
        ) : read === 'pending' ? (
          <Loading compact kind="page" label="Reading the conversation…" />
        ) : typeof read === 'string' ? (
          <div className="fy-action-form__body">
            <p className="fy-action-form__failure" role="alert">
              {read}
            </p>
            <div className="fy-action-form__foot">
              <button className="kt-btn kt-btn--sm" onClick={onClose} type="button">
                Close
              </button>
            </div>
          </div>
        ) : (
          <ForkForm
            choices={read.choices}
            host={{ close: onClose, forked: setMade }}
            initial={initialPoint}
            older={read.older}
            submit={async request => {
              const run = place?.press ?? (<T,>(act: () => Promise<T>) => act());
              const result = await run(() => postFork(client, ferret, request));
              if (result === undefined) throw new Error(NOT_UNLOCKED);
              return result;
            }}
          />
        )}
      </div>
    </div>
  );
}
