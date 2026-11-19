/**
 * One status, drawn the same everywhere on the CI pages: an icon with its own SHAPE, plus the word. Colour only
 * reinforces; a state is never told by colour alone (a passed and a failed run differ in shape and in text).
 */
import { useMotionAllowed } from '@ferretry/app/ui';
import { Ban, CheckCircle2, CircleDashed, Clock, Loader2, MinusCircle, XCircle } from 'lucide-react';
import type { CiStatus } from '../../../contract/wire.ts';
import { STATUS_WORD } from './ci-format.ts';

/** Text colour per status: the theme's own state tokens. */
export const STATUS_TEXT: Readonly<Record<CiStatus, string>> = {
  queued: 'text-pend',
  running: 'text-accent',
  passed: 'text-ok',
  failed: 'text-err',
  cancelled: 'text-muted',
  skipped: 'text-faint',
};

/** Bar fill per status. Skipped never has a bar. */
export const STATUS_FILL: Readonly<Record<CiStatus, string>> = {
  queued: 'bg-pend',
  running: 'bg-accent',
  passed: 'bg-ok',
  failed: 'bg-err',
  cancelled: 'bg-muted',
  skipped: 'bg-faint',
};

export function StatusIcon({ status, size = 16 }: { readonly status: CiStatus; readonly size?: number }) {
  const moving = useMotionAllowed();
  const common = { size, 'aria-hidden': true, className: `shrink-0 ${STATUS_TEXT[status]}` } as const;
  switch (status) {
    case 'passed':
      return <CheckCircle2 {...common} />;
    case 'failed':
      return <XCircle {...common} />;
    case 'running':
      // Still under reduced motion: a dashed ring that does not turn.
      return moving ? (
        <Loader2 {...common} className={`${common.className} animate-spin`} />
      ) : (
        <CircleDashed {...common} />
      );
    case 'queued':
      return <Clock {...common} />;
    case 'cancelled':
      return <Ban {...common} />;
    case 'skipped':
      return <MinusCircle {...common} />;
  }
}

/** Icon and word, one inline unit. `label` may be hidden visually when a row already says it. */
export function StatusMark({ status }: { readonly status: CiStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-meta font-medium ${STATUS_TEXT[status]}`}
      data-ci-status={status}
    >
      <StatusIcon status={status} />
      <span>{STATUS_WORD[status]}</span>
    </span>
  );
}
