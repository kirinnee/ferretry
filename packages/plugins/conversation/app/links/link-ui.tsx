/**
 * The small pieces the links surfaces draw with: one note (today's `SetupNote`, Ferrets' setup UI) and the guarded
 * call that turns a refusal into the sentence a person reads (today's `useSetupAccess` and `changeRefusalSentence`,
 * narrowed to what a links read or keep can meet). GAP(ferrets): the setup UI is Ferrets' until its app half ports.
 */

import { DaemonCallError } from '@ferretry/app';
import { cn } from '@ferretry/app/ui';
import type { ReactNode } from 'react';
import { z } from 'zod';

export function LinkNote({
  tone = 'pend',
  title,
  children,
  name,
  live = false,
}: {
  readonly tone?: 'ok' | 'warn' | 'err' | 'pend';
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  readonly name?: string;
  /** Spoken when it appears: a result or a state change the person is waiting for. */
  readonly live?: boolean;
}) {
  return (
    <div
      role={live ? 'status' : undefined}
      data-setup-note={name}
      data-tone={tone}
      className={cn(
        'kt-panel flex min-w-0 flex-col gap-1 p-panel',
        tone === 'ok' && 'border-ok',
        tone === 'warn' && 'border-warn',
        tone === 'err' && 'border-err',
      )}
    >
      {title === undefined ? null : <p className="m-0 text-row font-semibold text-fg">{title}</p>}
      {children === undefined ? null : (
        <div className="flex min-w-0 flex-col gap-1 text-cell leading-base text-muted">{children}</div>
      )}
    </div>
  );
}

const NO_ANSWER = 'This machine didn’t answer. Check it is awake and try again.';

/** A failed links read or keep, in words a person can act on: the daemon's own sentence when it gave one. */
export const linkRefusalSentence = (error: unknown): string => {
  if (error instanceof DaemonCallError)
    return error.message.trim() === '' ? `This machine refused the change (${String(error.status)}).` : error.message;
  if (error instanceof z.ZodError)
    return 'This machine answered in a form this copy of the app doesn’t understand, so the two are probably on different versions. Reload the app, and update Ferretry on the machine if it still happens.';
  if (!(error instanceof Error)) return NO_ANSWER;
  return error.message.trim() === ''
    ? NO_ANSWER
    : `This machine didn’t answer (${error.message}). Check it is awake and try again.`;
};

export type Guarded<T> =
  | { readonly kind: 'done'; readonly value: T }
  | { readonly kind: 'refused'; readonly sentence: string };

/** Runs one call and answers its value, or the sentence for its refusal; never throws. */
export const guarded = async <T,>(work: () => Promise<T>): Promise<Guarded<T>> => {
  try {
    return { kind: 'done', value: await work() };
  } catch (error) {
    return { kind: 'refused', sentence: linkRefusalSentence(error) };
  }
};
